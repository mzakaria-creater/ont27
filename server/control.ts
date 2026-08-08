import { Hono } from 'hono'
import { db } from './db.js'
import { oldDb } from './oldDb.js'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// التحكم السريع — the control-room quick actions, executed through the OLD
// DB's SECURITY DEFINER RPCs (that's where the automation actually runs).
// Restricted to management roles; every action is audited in panel-v2.

export const controlRoutes = new Hono<AuthEnv>()

controlRoutes.use('*', requireAuth)

const CONTROL_ROLES = new Set(['owner', 'admin', 'super_admin'])

controlRoutes.use('*', async (c, next) => {
  if (!CONTROL_ROLES.has(c.get('actor').role)) return c.json({ error: 'forbidden' }, 403)
  await next()
})

const audit = (actor: { sub: string; username: string }, action: string, after: Record<string, unknown>) =>
  db.from('audit_log').insert({
    actor_type: 'manual_panel',
    actor_id: actor.sub,
    actor_name: actor.username,
    action,
    entity: 'automation',
    entity_id: 'control',
    after,
  })

controlRoutes.get('/status', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const [settings, stats, queue] = await Promise.all([
    old.from('automation_settings').select('automation_enabled, max_auto_amount, turbo_mode, updated_at').limit(1).maybeSingle(),
    old.rpc('dashboard_stats').then(({ data, error }) => (error ? { error: error.message } : data)),
    old.rpc('pending_queue_list', { p_limit: 50 }).then(({ data, error }) => (error ? [] : (data ?? []))),
  ])
  return c.json({
    settings: settings.data ?? null,
    stats,
    queue,
  })
})

// Cron-health monitor for the OLD project's pg_cron jobs (two critical
// breakages were found there by manual inspection — job 36's pg_sleep(30)
// and job 61's wrong function name). Read-only SECURITY DEFINER RPC.
controlRoutes.get('/crons', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const { data, error } = await old.rpc('panel_cron_health')
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  return c.json({ jobs: data ?? [] })
})

// ---------------------------------------------------------------------------
// Automation templates — one-switch posture presets over the ~21 automation
// settings. Defined SERVER-SIDE so the client only ever sends a template id,
// never a raw settings map. Applied through the old project's automation-panel
// edge function (save_settings) — the same tested path the standalone tool
// used — so the live workers pick them up immediately.
// ---------------------------------------------------------------------------

type Posture = {
  automation_enabled: boolean
  security_rules_enabled: boolean
  balance_check_enabled: boolean
  above_limit_to_manual: boolean
  sms_feed_circuit_breaker_enabled: boolean
  wallet_switch_auto_enabled: boolean
  turbo_mode: boolean
  max_auto_amount: number
  decline_grace_minutes: number
  score_threshold: number
}

const AUTOMATION_TEMPLATES: { id: string; label: string; desc: string; settings: Posture }[] = [
  {
    id: 'conservative', label: 'محافظ', desc: 'أقل مخاطرة: حد أقل، مهلة أطول، ثقة أعلى، قاطع الأمان مفعّل.',
    settings: { automation_enabled: true, security_rules_enabled: true, balance_check_enabled: true, above_limit_to_manual: true, sms_feed_circuit_breaker_enabled: true, wallet_switch_auto_enabled: false, turbo_mode: false, max_auto_amount: 3000, decline_grace_minutes: 5, score_threshold: 85 },
  },
  {
    id: 'balanced', label: 'متوازن', desc: 'الوضع التشغيلي الافتراضي — توازن بين السرعة والأمان.',
    settings: { automation_enabled: true, security_rules_enabled: true, balance_check_enabled: true, above_limit_to_manual: true, sms_feed_circuit_breaker_enabled: false, wallet_switch_auto_enabled: false, turbo_mode: false, max_auto_amount: 5000, decline_grace_minutes: 3, score_threshold: 80 },
  },
  {
    id: 'turbo', label: 'سريع (Turbo)', desc: 'أعلى إنتاجية: حد أكبر، مهلة أقصر، تبديل محافظ تلقائي. مخاطرة أعلى.',
    settings: { automation_enabled: true, security_rules_enabled: true, balance_check_enabled: true, above_limit_to_manual: true, sms_feed_circuit_breaker_enabled: false, wallet_switch_auto_enabled: true, turbo_mode: true, max_auto_amount: 8000, decline_grace_minutes: 1, score_threshold: 75 },
  },
  {
    id: 'maintenance', label: 'صيانة (إيقاف)', desc: 'إيقاف الأتمتة بالكامل — كل معاملة تروح مراجعة يدوية. الأمان يفضل مفعّل.',
    settings: { automation_enabled: false, security_rules_enabled: true, balance_check_enabled: true, above_limit_to_manual: true, sms_feed_circuit_breaker_enabled: true, wallet_switch_auto_enabled: false, turbo_mode: false, max_auto_amount: 5000, decline_grace_minutes: 3, score_threshold: 80 },
  },
]

function activeTemplateId(current: Record<string, unknown> | null): string | null {
  if (!current) return null
  for (const tpl of AUTOMATION_TEMPLATES) {
    const match = (Object.keys(tpl.settings) as (keyof Posture)[]).every((k) => {
      const cur = current[k]
      const want = tpl.settings[k]
      if (typeof want === 'number') return Number(cur) === want
      return Boolean(cur) === want
    })
    if (match) return tpl.id
  }
  return null
}

controlRoutes.get('/automation/templates', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const { data: current } = await old.from('automation_settings').select('*').limit(1).maybeSingle()
  return c.json({
    templates: AUTOMATION_TEMPLATES,
    current: current ?? null,
    active_id: activeTemplateId(current as Record<string, unknown> | null),
  })
})

controlRoutes.post('/automation/template', async (c) => {
  const body = await c.req.json().catch(() => null)
  const tpl = AUTOMATION_TEMPLATES.find((t) => t.id === body?.id)
  if (!tpl) return c.json({ error: 'unknown_template' }, 400)
  const url = panelUrl()
  if (!url) return c.json({ error: 'panel_not_configured' }, 500)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'save_settings', ...tpl.settings }),
  })
  const result = await res.json().catch(() => ({ error: 'bad_upstream' }))
  if (!res.ok || (result as Record<string, unknown>).ok === false) {
    return c.json({ error: 'apply_failed', detail: result }, 502)
  }
  await audit(c.get('actor'), 'automation.template_applied', { template: tpl.id, settings: tpl.settings })
  return c.json({ ok: true, applied: tpl.id })
})

controlRoutes.post('/automation', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const on = body?.on
  if (typeof on !== 'boolean') return c.json({ error: 'bad_request' }, 400)
  const { error } = await old.rpc('dashboard_toggle_automation', { p_on: on })
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  await audit(c.get('actor'), on ? 'automation.enable' : 'automation.disable', { on })
  return c.json({ ok: true, on })
})

controlRoutes.post('/limit', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const limit = Number(body?.limit)
  if (!Number.isFinite(limit) || limit <= 0) return c.json({ error: 'bad_request' }, 400)
  const { error } = await old.rpc('dashboard_set_limit', { p_limit: limit })
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  await audit(c.get('actor'), 'automation.set_limit', { limit })
  return c.json({ ok: true, limit })
})

// Proxy to the automation-panel edge function on the old project — the
// access key stays server-side (it was hardcoded in the local HTML tool).
const PANEL_DATA = new Set(['settings', 'all_accounts', 'bank_catalog', 'payfuture'])
const PANEL_ACTIONS = new Set(['run_sweep_now', 'bulk_update_accounts', 'assign_bank_account', 'toggle_rule', 'delete_rule'])

function panelUrl(): string | null {
  const base = process.env.OLD_SUPABASE_URL
  const key = process.env.AUTOMATION_PANEL_KEY
  if (!base || !key) return null
  return `${base}/functions/v1/automation-panel?k=${encodeURIComponent(key)}`
}

controlRoutes.get('/panel', async (c) => {
  const data = c.req.query('data') ?? ''
  if (!PANEL_DATA.has(data)) return c.json({ error: 'bad_request' }, 400)
  const url = panelUrl()
  if (!url) return c.json({ error: 'panel_not_configured' }, 500)
  const res = await fetch(`${url}&data=${data}`)
  return c.json(await res.json().catch(() => ({ error: 'bad_upstream' })), res.ok ? 200 : 502)
})

controlRoutes.post('/panel', async (c) => {
  const body = await c.req.json().catch(() => null)
  const action = body?.action as string | undefined
  if (!action || !PANEL_ACTIONS.has(action)) return c.json({ error: 'bad_action' }, 400)
  const url = panelUrl()
  if (!url) return c.json({ error: 'panel_not_configured' }, 500)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await res.json().catch(() => ({ error: 'bad_upstream' }))
  await audit(c.get('actor'), `automation_panel.${action}`, body as Record<string, unknown>)
  return c.json(result, res.ok ? 200 : 502)
})

controlRoutes.post('/queue/approve', async (c) => {
  const old = oldDb()
  if (!old) return c.json({ error: 'old_db_not_configured' }, 500)
  const body = await c.req.json().catch(() => null)
  const txId = Number(body?.tx_id)
  const smsId = Number(body?.sms_id)
  if (!Number.isInteger(txId) || !Number.isInteger(smsId)) return c.json({ error: 'bad_request' }, 400)
  const { data, error } = await old.rpc('pending_link_and_approve', { p_tx_id: txId, p_sms_id: smsId })
  if (error) return c.json({ error: 'rpc_error', detail: error.message }, 500)
  const actor = c.get('actor')
  // Record WHO approved on both DBs — the worker only writes a generic "Manual".
  await Promise.all([
    old.from('maven_transactions').update({ approved_by: actor.username }).eq('tx_id', txId),
    db.from('maven_transactions').update({ approved_by: actor.username }).eq('tx_id', txId),
  ])
  await audit(actor, 'queue.link_and_approve', { tx_id: txId, sms_id: smsId, result: data })
  return c.json({ ok: true, result: data })
})
