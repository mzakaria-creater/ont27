import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requireAnyPerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const webhookRoutes = new Hono<AuthEnv>()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const endpointColumns = 'id,name,direction,merchant_id,url,event_types,is_active,created_by_name,created_at,updated_at'

webhookRoutes.post('/in/:token', async (c) => {
  const started = Date.now()
  const token = c.req.param('token')
  const { data: endpoint } = await db.from('webhook_endpoints').select('id,name,is_active,event_types,signing_secret').eq('direction','inbound').eq('inbound_token_hash',digest(token)).maybeSingle()
  if (!endpoint?.is_active) return c.json({ error: 'webhook_not_found' }, 404)
  const raw = await c.req.text()
  const supplied = c.req.header('x-ontarget-signature') ?? ''
  const expected = createHmac('sha256',endpoint.signing_secret).update(raw).digest('hex')
  const signatureOk = supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))
  // The inbound token is already a high-entropy secret in the URL. Accepting
  // it without a second HMAC makes MacroDroid/n8n posting practical, while a
  // supplied signature is still verified when the sender supports HMAC.
  if (supplied && !signatureOk) {
    await db.from('webhook_delivery_log').insert({endpoint_id:endpoint.id,direction:'inbound',event_type:'signature.invalid',status_code:401,success:false,latency_ms:Date.now()-started,request_id:c.req.header('x-request-id')??randomUUID(),error:'invalid_signature'})
    return c.json({error:'invalid_signature'},401)
  }
  const payload = (()=>{try{return JSON.parse(raw)}catch{return null}})()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return c.json({ error: 'json_object_required' }, 400)
  const body = payload as Record<string, unknown>
  const eventType = String(body.event ?? c.req.header('x-ontarget-event') ?? 'inbound.received').slice(0,120)
  const requestId = c.req.header('x-request-id') ?? randomUUID()
  const category = String(body.category ?? body.sms_category ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  let sms: Record<string, unknown> | null = null
  if (category === 'smslive') {
    const textValue = (['message', 'sms', 'text', 'body', 'raw_sms', 'sms_text'].map((key) => body[key]).find((value) => typeof value === 'string' && value.trim()) as string | undefined)?.trim().slice(0, 10_000) ?? ''
    if (!textValue) return c.json({ error: 'sms_message_required' }, 400)
    const stringValue = (...keys: string[]) => { const value = keys.map((key) => body[key]).find((item) => typeof item === 'string' && item.trim()); return typeof value === 'string' ? value.trim().slice(0, 500) || null : null }
    const numberValue = (...keys: string[]) => { const value = keys.map((key) => body[key]).find((item) => item != null && item !== ''); const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
    const receivedRaw = stringValue('received_at', 'timestamp', 'time', 'date')
    const receivedAt = receivedRaw && Number.isFinite(Date.parse(receivedRaw)) ? new Date(receivedRaw).toISOString() : new Date().toISOString()
    const rawPayload = { ...body, _source: 'webhook', _request_id: requestId, _received_at: new Date().toISOString() }
    const duplicate = await db.from('inbound_sms').select('id').eq('webhook_name', endpoint.name).contains('raw_payload', { _request_id: requestId }).maybeSingle()
    if (!duplicate.data) {
      const { data: inserted, error: smsError } = await db.from('inbound_sms').insert({
        message: textValue, raw_sms: textValue, sms_first_line: textValue.split(/\r?\n/)[0]?.slice(0, 500),
        sender: stringValue('sender', 'sender_name', 'from_name', 'from') ?? stringValue('sender_number', 'from_number', 'phone'),
        sender_name: stringValue('sender_name', 'from_name', 'sender'), sender_number: stringValue('sender_number', 'from_number', 'phone', 'sender_phone'),
        receiver_number: stringValue('receiver_number', 'receiver', 'to_number', 'wallet_number', 'wallet'), wallet_number: stringValue('wallet_number', 'receiver_number', 'receiver', 'to_number', 'wallet'),
        amount: numberValue('amount', 'value', 'sms_amount'), balance_after: numberValue('balance_after', 'balance', 'current_balance'),
        provider: stringValue('provider', 'network', 'operator'), sms_category: 'smslive', match_status: 'unmatched', matched: false, review_required: true,
        status: 'received', suspicious: false, raw_payload: rawPayload, webhook_name: endpoint.name, import_source: 'webhook', received_at: receivedAt,
      }).select('id,received_at,sms_category,amount,sender_number,receiver_number').single()
      if (smsError) {
        await db.from('webhook_delivery_log').insert({ endpoint_id:endpoint.id,direction:'inbound',event_type:eventType,status_code:500,success:false,latency_ms:Date.now()-started,request_id:requestId,error:smsError.message,payload })
        return c.json({ error: 'sms_insert_failed' }, 500)
      }
      sms = inserted as Record<string, unknown>
    } else sms = { id: duplicate.data.id, duplicate: true }
  }
  await db.from('webhook_delivery_log').insert({ endpoint_id:endpoint.id,direction:'inbound',event_type:eventType,status_code:202,success:true,latency_ms:Date.now()-started,request_id:requestId,payload })
  await db.from('audit_log').insert({ actor_type:'webhook',actor_name:endpoint.name,action:'webhook.inbound_received',entity:'webhook_endpoint',entity_id:endpoint.id,after:{event_type:eventType,request_id:requestId} })
  return c.json({ accepted:true, request_id:requestId, sms }, 202)
})

webhookRoutes.use('*', requireAuth)
webhookRoutes.get('/', requireAnyPerm(['webhooks','developers'],'can_view'), async (c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')
  const direction = c.req.query('direction')
  const [endpointRes, merchantRes] = await Promise.all([
    db.from('webhook_endpoints').select(endpointColumns).order('created_at',{ascending:false}),
    db.from('merchants').select('id,name').order('name'),
  ])
  let logs = db.from('webhook_delivery_log').select('id,endpoint_id,direction,event_type,status_code,success,latency_ms,request_id,error,created_at').order('created_at',{ascending:false}).limit(250)
  if (from) logs = logs.gte('created_at',`${from}T00:00:00Z`)
  if (to) logs = logs.lte('created_at',`${to}T23:59:59.999Z`)
  if (direction === 'inbound' || direction === 'outbound') logs = logs.eq('direction',direction)
  const logRes = await logs
  if (endpointRes.error || logRes.error) return c.json({error:'db_error',detail:endpointRes.error?.message ?? logRes.error?.message},500)
  const rows = logRes.data ?? []
  return c.json({ endpoints:endpointRes.data ?? [], merchants:merchantRes.data ?? [], logs:rows, kpis:{ endpoints:(endpointRes.data??[]).length, active:(endpointRes.data??[]).filter(x=>x.is_active).length, deliveries:rows.length, successRate:rows.length?Math.round(rows.filter(x=>x.success).length/rows.length*1000)/10:0, failed:rows.filter(x=>!x.success).length } })
})

webhookRoutes.post('/', requireAnyPerm(['webhooks','developers'],'can_edit'), async (c) => {
  const actor = c.get('actor')
  const body = await c.req.json().catch(()=>null)
  const name = String(body?.name ?? '').trim()
  const direction = body?.direction === 'inbound' ? 'inbound' : body?.direction === 'outbound' ? 'outbound' : null
  const url = String(body?.url ?? '').trim()
  if (name.length < 2 || !direction) return c.json({error:'invalid_webhook'},400)
  if (direction === 'outbound') { try { const parsed=new URL(url); if(parsed.protocol!=='https:') throw new Error() } catch { return c.json({error:'https_url_required'},400) } }
  const secret = `whsec_${randomBytes(24).toString('hex')}`
  const token = direction === 'inbound' ? `whin_${randomBytes(24).toString('hex')}` : null
  const { data,error } = await db.from('webhook_endpoints').insert({ name,direction,merchant_id:body?.merchant_id||null,url:direction==='outbound'?url:null,event_types:Array.isArray(body?.event_types)?body.event_types.slice(0,20):[],signing_secret:secret,inbound_token_hash:token?digest(token):null,created_by:actor.sub,created_by_name:actor.username }).select(endpointColumns).single()
  if(error) return c.json({error:'db_error',detail:error.message},500)
  await db.from('audit_log').insert({actor_type:'panel_user',actor_id:actor.sub,actor_name:actor.username,action:'webhook.created',entity:'webhook_endpoint',entity_id:data.id,after:{name,direction,url:direction==='outbound'?new URL(url).host:null}})
  const origin = new URL(c.req.url).origin
  return c.json({ endpoint:data, signing_secret:secret, inbound_url:token?`${origin}/api/webhooks/in/${token}`:null },201)
})

webhookRoutes.post('/:id/toggle', requireAnyPerm(['webhooks','developers'],'can_edit'), async (c) => {
  const actor=c.get('actor'); const body=await c.req.json().catch(()=>null)
  const {data,error}=await db.from('webhook_endpoints').update({is_active:Boolean(body?.is_active),updated_at:new Date().toISOString()}).eq('id',c.req.param('id')).select(endpointColumns).maybeSingle()
  if(error)return c.json({error:'db_error',detail:error.message},500); if(!data)return c.json({error:'not_found'},404)
  await db.from('audit_log').insert({actor_type:'panel_user',actor_id:actor.sub,actor_name:actor.username,action:data.is_active?'webhook.activated':'webhook.deactivated',entity:'webhook_endpoint',entity_id:data.id})
  return c.json({endpoint:data})
})

webhookRoutes.post('/:id/test', requireAnyPerm(['webhooks','developers'],'can_edit'), async (c) => {
  const {data:endpoint}=await db.from('webhook_endpoints').select('id,name,direction,url,signing_secret,is_active').eq('id',c.req.param('id')).maybeSingle()
  if(!endpoint?.is_active || endpoint.direction!=='outbound' || !endpoint.url)return c.json({error:'active_outbound_required'},409)
  const payload={event:'webhook.test',endpoint_id:endpoint.id,created_at:new Date().toISOString()}; const raw=JSON.stringify(payload); const started=Date.now(); let status:number|null=null; let failure:string|null=null
  try{const res=await fetch(endpoint.url,{method:'POST',headers:{'content-type':'application/json','x-ontarget-signature':createHmac('sha256',endpoint.signing_secret).update(raw).digest('hex'),'x-ontarget-event':'webhook.test'},body:raw,signal:AbortSignal.timeout(10000)});status=res.status;if(!res.ok)failure=`HTTP ${res.status}`}catch(error){failure=error instanceof Error?error.message:'network_error'}
  const success=status!==null&&status>=200&&status<300; const latency=Date.now()-started
  await db.from('webhook_delivery_log').insert({endpoint_id:endpoint.id,direction:'outbound',event_type:'webhook.test',status_code:status,success,latency_ms:latency,request_id:randomUUID(),error:failure,payload})
  return c.json({success,status_code:status,latency_ms:latency,error:failure},success?200:502)
})
