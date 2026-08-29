import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const revenueRoutes = new Hono<AuthEnv>()
revenueRoutes.use('*', requireAuth)

const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const number = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? n : null }
const paid = (status: string | null) => status === 'PAID' || status === 'APPROVED'

async function snapshot(from: string, to: string, merchant = '') {
  const since = `${from}T00:00:00+03:00`; const until = `${to}T23:59:59.999+03:00`
  let deposits = db.from('maven_transactions').select('amount,status,merchant,master_merchant,payment_method,gateway,fees,commission,first_seen_at').gte('first_seen_at', since).lte('first_seen_at', until).limit(20000)
  let payouts = db.from('maven_payout_transactions').select('amount,status,merchant,commission,first_seen_at').gte('first_seen_at', since).lte('first_seen_at', until).limit(20000)
  let ledger = db.from('financial_ledger_entries').select('*').gte('entry_date', from).lte('entry_date', to).neq('status', 'void').order('entry_date', { ascending: false }).limit(2000)
  if (merchant) ledger = ledger.eq('merchant', merchant)
  const [dep, pay, book, shares] = await Promise.all([deposits, payouts, ledger, db.from('revenue_share_rules').select('*').eq('active', true).lte('effective_from', to).or(`effective_to.is.null,effective_to.gte.${from}`).order('beneficiary_name')])
  for (const result of [dep,pay,book,shares]) if (result.error) throw new Error(result.error.message)
  const allDeposits = dep.data ?? []; const allPayouts = pay.data ?? []
  const scopedDeposits = merchant ? allDeposits.filter((r) => r.merchant === merchant || r.master_merchant === merchant) : allDeposits
  const scopedPayouts = merchant ? allPayouts.filter((r) => r.merchant === merchant) : allPayouts
  const approvedDep = scopedDeposits.filter((r) => paid(r.status)); const approvedPay = scopedPayouts.filter((r) => paid(r.status))
  const paymentRevenue = approvedDep.reduce((s,r) => s + Number(r.fees ?? 0) + Number(r.commission ?? 0), 0) + approvedPay.reduce((s,r) => s + Number(r.commission ?? 0), 0)
  const entries = book.data ?? []; const egpEntries = entries.filter((r) => r.currency === 'EGP')
  const otherIncome = egpEntries.filter((r) => r.entry_type === 'income').reduce((s,r) => s + Number(r.amount), 0)
  const expenses = egpEntries.filter((r) => r.entry_type === 'expense').reduce((s,r) => s + Number(r.amount), 0)
  const capital = egpEntries.filter((r) => r.entry_type === 'capital_injection').reduce((s,r) => s + Number(r.amount), 0)
  const distributionsPaid = egpEntries.filter((r) => r.entry_type === 'distribution').reduce((s,r) => s + Number(r.amount), 0)
  const netProfit = paymentRevenue + otherIncome - expenses
  const activeShares = (shares.data ?? []).filter((r) => !r.merchant || r.merchant === merchant)
  const allocations = activeShares.map((r) => ({ ...r, calculated_amount: Math.max(netProfit,0) * Number(r.share_percent) / 100 }))
  const sharePercent = allocations.reduce((s,r) => s + Number(r.share_percent),0)
  const merchants = [...new Set(allDeposits.map((r) => r.master_merchant ?? r.merchant).filter((value): value is string => !!value))].sort()
  const byMerchant = new Map<string,{merchant:string;volume:number;revenue:number;count:number}>()
  for (const r of approvedDep) { const key=r.master_merchant ?? r.merchant ?? 'Unassigned'; const b=byMerchant.get(key)??{merchant:key,volume:0,revenue:0,count:0}; b.volume+=Number(r.amount??0); b.revenue+=Number(r.fees??0)+Number(r.commission??0); b.count++; byMerchant.set(key,b) }
  return { range:{from,to}, filters:{merchant:merchant||null}, options:{merchants}, summary:{depositVolume:approvedDep.reduce((s,r)=>s+Number(r.amount??0),0),payoutVolume:approvedPay.reduce((s,r)=>s+Number(r.amount??0),0),paymentRevenue,otherIncome,expenses,netProfit,capital,distributionsPaid,cashMovement:capital+otherIncome+paymentRevenue-expenses-distributionsPaid,approvedTransactions:approvedDep.length+approvedPay.length,marginPct:approvedDep.reduce((s,r)=>s+Number(r.amount??0),0)>0?paymentRevenue/approvedDep.reduce((s,r)=>s+Number(r.amount??0),0)*100:0,sharePercent,unallocatedPercent:Math.max(100-sharePercent,0)},allocations,ledger:entries,shares:shares.data??[],byMerchant:[...byMerchant.values()].sort((a,b)=>b.revenue-a.revenue),generatedAt:new Date().toISOString() }
}

revenueRoutes.get('/', requirePerm('revenue_center','can_view'), async (c) => {
  const from=date(c.req.query('from'))??new Date(Date.now()-29*86400000).toISOString().slice(0,10); const to=date(c.req.query('to'))??new Date().toISOString().slice(0,10)
  if(from>to) return c.json({error:'invalid_date_range'},400)
  try { return c.json(await snapshot(from,to,text(c.req.query('merchant'),160))) } catch(e) { return c.json({error:'db_error',detail:e instanceof Error?e.message:'query_failed'},500) }
})

revenueRoutes.post('/shares', requirePerm('revenue_center','can_edit'), async (c) => {
  const body=await c.req.json().catch(()=>null); const pct=number(body?.share_percent); const name=text(body?.beneficiary_name,160); const type=['team','partner','owner'].includes(body?.beneficiary_type)?body.beneficiary_type:null
  if(!type||name.length<2||pct==null||pct<=0||pct>100) return c.json({error:'invalid_share'},400)
  const merchant=text(body?.merchant,160)||null
  let activeQuery=db.from('revenue_share_rules').select('share_percent').eq('active',true)
  activeQuery=merchant?activeQuery.eq('merchant',merchant):activeQuery.is('merchant',null)
  const {data:active}=await activeQuery; const total=(active??[]).reduce((s,r)=>s+Number(r.share_percent),0)
  if(total+pct>100) return c.json({error:'share_total_exceeded',used:total},422)
  const actor=c.get('actor'); const record={beneficiary_type:type,beneficiary_name:name,share_percent:pct,merchant,effective_from:date(body?.effective_from)??new Date().toISOString().slice(0,10),notes:text(body?.notes)||null,created_by:actor.sub,created_by_name:actor.username}
  const {data,error}=await db.from('revenue_share_rules').insert(record).select().single(); if(error)return c.json({error:'db_error',detail:error.message},500)
  await db.from('audit_log').insert({actor_type:'manual_panel',actor_id:actor.sub,actor_name:actor.username,action:'revenue.share_created',entity_type:'revenue_share_rules',entity_id:data.id,after:record}); return c.json({row:data},201)
})

revenueRoutes.patch('/shares/:id', requirePerm('revenue_center','can_edit'), async (c) => {
  const body=await c.req.json().catch(()=>null); const active=typeof body?.active==='boolean'?body.active:null; if(active==null)return c.json({error:'invalid_body'},400)
  const {data:before}=await db.from('revenue_share_rules').select('*').eq('id',c.req.param('id')).maybeSingle(); if(!before)return c.json({error:'not_found'},404)
  if(active&&!before.active){let q=db.from('revenue_share_rules').select('share_percent').eq('active',true);q=before.merchant?q.eq('merchant',before.merchant):q.is('merchant',null);const {data:current}=await q;const used=(current??[]).reduce((s,r)=>s+Number(r.share_percent),0);if(used+Number(before.share_percent)>100)return c.json({error:'share_total_exceeded',used},422)}
  const {data,error}=await db.from('revenue_share_rules').update({active,updated_at:new Date().toISOString()}).eq('id',before.id).select().single(); if(error)return c.json({error:'db_error'},500)
  const actor=c.get('actor'); await db.from('audit_log').insert({actor_type:'manual_panel',actor_id:actor.sub,actor_name:actor.username,action:'revenue.share_status_changed',entity_type:'revenue_share_rules',entity_id:before.id,before:{active:before.active},after:{active}}); return c.json({row:data})
})

revenueRoutes.post('/ledger', requirePerm('revenue_center','can_edit'), async (c) => {
  const body=await c.req.json().catch(()=>null); const amount=number(body?.amount); const type=['income','expense','capital_injection','distribution'].includes(body?.entry_type)?body.entry_type:null
  if(!type||amount==null||amount<=0||text(body?.category,100).length<2||text(body?.description).length<2)return c.json({error:'invalid_entry'},400)
  const actor=c.get('actor'); const record={entry_date:date(body?.entry_date)??new Date().toISOString().slice(0,10),entry_type:type,category:text(body.category,100),description:text(body.description),amount,currency:['EGP','USD','EUR','USDT'].includes(body?.currency)?body.currency:'EGP',merchant:text(body?.merchant,160)||null,beneficiary:text(body?.beneficiary,160)||null,reference:text(body?.reference,160)||null,status:'posted',created_by:actor.sub,created_by_name:actor.username}
  const {data,error}=await db.from('financial_ledger_entries').insert(record).select().single(); if(error)return c.json({error:'db_error',detail:error.message},500)
  await db.from('audit_log').insert({actor_type:'manual_panel',actor_id:actor.sub,actor_name:actor.username,action:'revenue.ledger_posted',entity_type:'financial_ledger_entries',entity_id:data.id,after:record}); return c.json({row:data},201)
})

revenueRoutes.post('/ask', requirePerm('revenue_center','can_view'), async (c) => {
  const body=await c.req.json().catch(()=>null); const question=text(body?.question,1000); const from=date(body?.from)??new Date(Date.now()-29*86400000).toISOString().slice(0,10); const to=date(body?.to)??new Date().toISOString().slice(0,10)
  if(question.length<3)return c.json({error:'question_required'},400)
  try { const s=await snapshot(from,to,text(body?.merchant,160)); const q=question.toLowerCase(); const n=(v:number)=>v.toLocaleString('en-US',{maximumFractionDigits:2}); let answer=''
    if(/runway|مدة.*تشغيل|مدرج/.test(q)) answer='Runway cannot be calculated truthfully yet because the ledger has no verified opening cash balance and recurring monthly cost classification. Add those fundamentals first; no estimate was invented.'
    else if(/revenue|commission|fee|إيراد|عمول/.test(q)) answer=`Recorded payment revenue is ${n(s.summary.paymentRevenue)} EGP. Other posted income is ${n(s.summary.otherIncome)} EGP and the payment revenue margin is ${n(s.summary.marginPct)}%.`
    else if(/profit|expense|cost|ربح|مصروف|تكلف/.test(q)) answer=`Net book profit is ${n(s.summary.netProfit)} EGP: payment revenue ${n(s.summary.paymentRevenue)} + other income ${n(s.summary.otherIncome)} − expenses ${n(s.summary.expenses)}.`
    else if(/partner|team|share|partner|فريق|شريك|توزيع/.test(q)) answer=`Active shares total ${n(s.summary.sharePercent)}%. Calculated allocations are ${n(s.allocations.reduce((x,r)=>x+Number(r.calculated_amount),0))} EGP, leaving ${n(s.summary.unallocatedPercent)}% unallocated.`
    else if(/cash|fund|capital|سيول|رأس|تمويل/.test(q)) answer=`Recorded cash movement is ${n(s.summary.cashMovement)} EGP. Capital injections: ${n(s.summary.capital)}; distributions already posted: ${n(s.summary.distributionsPaid)}.`
    else if(/merchant|تاجر/.test(q)) { const top=s.byMerchant[0]; answer=top?`Top recorded merchant is ${top.merchant}: ${n(top.volume)} EGP paid volume and ${n(top.revenue)} EGP recorded revenue.`:'No paid merchant activity exists in this scope.' }
    else answer=`For ${from} to ${to}: paid volume is ${n(s.summary.depositVolume)} EGP, payouts are ${n(s.summary.payoutVolume)} EGP, recorded revenue is ${n(s.summary.paymentRevenue)} EGP, and net book profit is ${n(s.summary.netProfit)} EGP. Ask about revenue, margin, expenses, cash, merchants, team, or partner shares.`
    return c.json({answer,generatedAt:s.generatedAt,scope:s.range,disclaimer:'Read-only data analysis. No payment or accounting action was executed.'})
  } catch(e){return c.json({error:'analysis_failed',detail:e instanceof Error?e.message:'query_failed'},500)}
})
