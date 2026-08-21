import { useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { useAuth } from '../auth/AuthContext'

interface AutomationTemplate { id: string; settings: Record<string, number | boolean> }
// Bilingual copy lives client-side so it follows the language switcher; the
// server is the source of truth for the id + the actual settings payload.
const TEMPLATE_COPY: Record<string, { label: [string, string]; desc: [string, string] }> = {
  conservative: { label: ['محافظ', 'Conservative'], desc: ['أقل مخاطرة: حد أقل، مهلة أطول، ثقة أعلى، قاطع الأمان مفعّل.', 'Lowest risk: smaller cap, longer grace, higher confidence, circuit breaker on.'] },
  balanced: { label: ['متوازن', 'Balanced'], desc: ['الوضع التشغيلي الافتراضي — توازن بين السرعة والأمان.', 'Default operating posture — balance of speed and safety.'] },
  turbo: { label: ['سريع (Turbo)', 'Turbo'], desc: ['أعلى إنتاجية: حد أكبر، مهلة أقصر، تبديل محافظ تلقائي. مخاطرة أعلى.', 'Highest throughput: larger cap, shorter grace, auto wallet switch. Higher risk.'] },
  maintenance: { label: ['صيانة (إيقاف)', 'Maintenance (off)'], desc: ['إيقاف الأتمتة بالكامل — كل معاملة تروح مراجعة يدوية. الأمان يفضل مفعّل.', 'Automation fully off — every transaction goes to manual review. Safety stays on.'] },
}

// Automation — matching engine settings (read-only), scoped rules, worker jobs, treasury.

interface RuleRow {
  id: string; scope_type: string | null; master_merchant: string | null; merchant: string | null; sub_merchant: string | null
  account_wallet: string | null; payment_method: string | null; provider: string | null; enabled: boolean | null
  min_amount: number | null; max_amount: number | null; time_window_minutes: number | null; action_type: string | null; priority: number | null
  use_crm_matching: boolean | null; use_near_amount: boolean | null; use_unique_amount: boolean | null
}

type NewRule = {
  scope_type: string; master_merchant: string; sub_merchant: string; min_amount: string; max_amount: string
  time_window_minutes: string; action_type: 'approve' | 'decline'; priority: string
  use_crm_matching: boolean; use_near_amount: boolean; use_unique_amount: boolean
}
const EMPTY_RULE: NewRule = { scope_type: 'global', master_merchant: 'ngpay', sub_merchant: '', min_amount: '1', max_amount: '10000', time_window_minutes: '5', action_type: 'approve', priority: '10', use_crm_matching: false, use_near_amount: false, use_unique_amount: false }

// Flow templates — presets that prefill the form, never saved directly (the
// operator must review + click Save, per the explicit requirement that no
// template writes unreviewed values). "Strict matching" is included even
// though the live evaluator currently blocks any approve rule that requires
// matching (not implemented yet) -- picking it will show that block plainly
// once saved, rather than silently pretending to work.
const RULE_TEMPLATES: { id: string; label: [string, string]; desc: [string, string]; rule: Partial<NewRule> }[] = [
  { id: 'small-auto-approve', label: ['موافقة تلقائية للمبالغ الصغيرة', 'Auto-approve small amounts'], desc: ['حد أقصى منخفض، بدون شرط مطابقة، مهلة قصيرة.', 'Low cap, no matching requirement, short window.'], rule: { action_type: 'approve', min_amount: '1', max_amount: '500', time_window_minutes: '5', use_crm_matching: false, use_near_amount: false, use_unique_amount: false } },
  { id: 'strict-matching', label: ['مطابقة صارمة', 'Strict matching'], desc: ['يتطلب كل أدوات المطابقة معاً — سيُرفض تلقائياً من المحرّك اليوم لأن المطابقة الفعلية غير مُنفَّذة بعد (fail-safe).', 'Requires every matching tool — the live engine blocks this today since real matching isn’t implemented yet (fail-safe).'], rule: { action_type: 'approve', min_amount: '1', max_amount: '10000', use_crm_matching: true, use_near_amount: true, use_unique_amount: true } },
  { id: 'decline-after-wait', label: ['رفض تلقائي بعد فترة انتظار', 'Auto-decline after a wait'], desc: ['يرفض معاملات ظلّت معلّقة أكثر من المهلة المحددة (7 دقائق كحد أدنى).', 'Declines transactions pending longer than the window (7 min minimum).'], rule: { action_type: 'decline', min_amount: '1', max_amount: '10000', time_window_minutes: '7' } },
]
interface JobRow { id: string; tx_id: number | null; amount: number | null; target_status: string | null; provider: string | null; state: string | null; mission: string | null; attempts: number | null; last_error: string | null; operator_username: string | null; created_at: string | null; completed_at: string | null }
interface BalanceRow { account_id: string | null; total_balance: number | null; available_balance: number | null; usdt_value: number | null; measured_at: string | null }
interface RateRow { currency_pair: string | null; rate: number | null; fetched_at: string | null }

const FLAG_LABELS: Record<string, string> = {
  automation_enabled: 'الأتمتة مفعّلة',
  ngpay_enabled: 'NGPay',
  // maven_enabled is the old stack's back-office worker channel; the literal
  // provider name must never surface in the UI (naming rule).
  maven_enabled: 'قناة المزوّد (back-office)',
  payfuture_enabled: 'PayFuture',
  balance_check_enabled: 'فحص الرصيد',
  above_limit_to_manual: 'فوق الحد → يدوي',
  security_rules_enabled: 'قواعد الأمان',
  wallet_switch_auto_enabled: 'تبديل المحافظ تلقائياً',
  use_crm_name_matching: 'مطابقة أسماء CRM',
  use_near_amount_matching: 'مطابقة مبلغ تقريبي',
  use_unique_amount_matching: 'مطابقة مبلغ فريد',
  use_trxid_matching: 'مطابقة رقم العملية',
  use_balance_timing_matching: 'مطابقة رصيد/توقيت',
  use_wallet_verify_ocr: 'تحقق محفظة OCR',
  use_direct_field_matching: 'مطابقة حقول مباشرة',
  use_nameonly_ocr_matching: 'مطابقة اسم OCR',
  use_account_number_matching: 'مطابقة رقم حساب',
  turbo_mode: 'وضع Turbo',
  sms_feed_circuit_breaker_enabled: 'قاطع تغذية SMS',
}

interface PayAccount {
  id: string
  label: string | null
  merchant_name: string | null
  method_name: string | null
  method_type: string | null
  priority: number | null
  status: string | null
  is_active: boolean | null
}

interface CronJob { jobid: number; jobname: string | null; schedule: string | null; active: boolean | null; last_start: string | null; last_end: string | null; last_status: string | null; last_message: string | null }

interface PayfutureRoute {
  id: string
  name: string | null
  provider: string | null
  is_active: boolean | null
  merchant_name: string | null
}

export default function Automation() {
  const [data, setData] = useState<{
    settings: Record<string, unknown> | null
    rules: RuleRow[]
    jobs: JobRow[]
    balances: BalanceRow[]
    rates: RateRow[]
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { t, locale } = useLocale()
  const { can } = useAuth()
  const li = locale === 'en' ? 1 : 0
  const canControl = can('automation', 'can_edit')
  const [accounts, setAccounts] = useState<PayAccount[] | null>(null)
  const [crons, setCrons] = useState<CronJob[] | null>(null)
  const [tpl, setTpl] = useState<{ templates: AutomationTemplate[]; active_id: string | null; current: Record<string, unknown> | null } | null>(null)
  const [applying, setApplying] = useState<string | null>(null)
  const [tplMsg, setTplMsg] = useState<string | null>(null)
  const [pf, setPf] = useState<PayfutureRoute[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [panelBusy, setPanelBusy] = useState(false)
  const [panelMsg, setPanelMsg] = useState<string | null>(null)

  const [newRule, setNewRule] = useState<NewRule>(EMPTY_RULE)
  const [ruleBusy, setRuleBusy] = useState(false)
  const [ruleMsg, setRuleMsg] = useState<string | null>(null)
  const [ruleConflict, setRuleConflict] = useState<{ id: string; action_type: string; priority: number }[] | null>(null)
  const [settingsBusy, setSettingsBusy] = useState<string | null>(null)

  const reloadAutomation = () => api<NonNullable<typeof data>>('/api/automation').then(setData).catch(() => {})

  const saveRule = async (confirmConflict = false) => {
    setRuleBusy(true); setRuleMsg(null); if (!confirmConflict) setRuleConflict(null)
    try {
      await api('/api/automation/rules', {
        method: 'POST',
        body: JSON.stringify({
          scope_type: newRule.scope_type, master_merchant: newRule.master_merchant || null, sub_merchant: newRule.sub_merchant || null,
          min_amount: newRule.min_amount, max_amount: newRule.max_amount, time_window_minutes: newRule.time_window_minutes,
          action_type: newRule.action_type, priority: newRule.priority,
          use_crm_matching: newRule.use_crm_matching, use_near_amount: newRule.use_near_amount, use_unique_amount: newRule.use_unique_amount,
          confirm_conflict: confirmConflict,
        }),
      })
      setRuleMsg(t('تم حفظ القاعدة ✅', 'Rule saved ✅'))
      setNewRule(EMPTY_RULE)
      reloadAutomation()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'priority_conflict') {
        setRuleConflict((e.body?.conflicts as typeof ruleConflict) ?? [])
        setRuleMsg(t('يوجد تعارض في الأولوية مع قاعدة مفعّلة أخرى بنفس النطاق.', 'This priority conflicts with another enabled rule in the same scope.'))
      } else {
        setRuleMsg(t('تعذّر حفظ القاعدة.', 'Unable to save the rule.'))
      }
    } finally {
      setRuleBusy(false)
    }
  }

  const toggleRule = async (row: RuleRow) => {
    try {
      await api(`/api/automation/rules/${row.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !row.enabled, confirm_conflict: true }) })
      reloadAutomation()
    } catch {
      setRuleMsg(t('تعذّر تغيير حالة القاعدة.', 'Unable to change the rule state.'))
    }
  }

  const deleteRule = async (row: RuleRow) => {
    try {
      await api(`/api/automation/rules/${row.id}`, { method: 'DELETE' })
      reloadAutomation()
    } catch {
      setRuleMsg(t('تعذّر حذف القاعدة.', 'Unable to delete the rule.'))
    }
  }

  const toggleGlobalSetting = async (key: string, value: boolean) => {
    setSettingsBusy(key)
    try {
      await api('/api/automation/settings', { method: 'PATCH', body: JSON.stringify({ [key]: value }) })
      reloadAutomation()
    } catch {
      setRuleMsg(t('تعذّر تحديث الإعداد.', 'Unable to update the setting.'))
    } finally {
      setSettingsBusy(null)
    }
  }

  const loadPanel = () => {
    api<{ accounts: PayAccount[] }>('/api/control/panel?data=all_accounts')
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts(null))
    api<{ routes: PayfutureRoute[] }>('/api/control/panel?data=payfuture')
      .then((r) => setPf(r.routes))
      .catch(() => setPf(null))
    api<{ jobs: CronJob[] }>('/api/control/crons')
      .then((r) => setCrons(r.jobs))
      .catch(() => setCrons(null))
    api<{ templates: AutomationTemplate[]; active_id: string | null; current: Record<string, unknown> | null }>('/api/control/automation/templates')
      .then(setTpl)
      .catch(() => setTpl(null))
  }

  const applyTemplate = async (id: string) => {
    setApplying(id); setTplMsg(null)
    try {
      await api('/api/control/automation/template', { method: 'POST', body: JSON.stringify({ id }) })
      setTplMsg(t('تم تطبيق القالب على الأتمتة الحيّة.', 'Template applied to live automation.'))
      api<{ templates: AutomationTemplate[]; active_id: string | null; current: Record<string, unknown> | null }>('/api/control/automation/templates').then(setTpl).catch(() => {})
    } catch {
      setTplMsg(t('تعذّر تطبيق القالب.', 'Failed to apply template.'))
    } finally { setApplying(null) }
  }

  useEffect(() => {
    api<NonNullable<typeof data>>('/api/automation')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الأتمتة.' : 'تعذّر تحميل بيانات الأتمتة.'))
    loadPanel()
  }, [])

  const bulkAccounts = async (isActive: boolean) => {
    if (sel.size === 0) return
    setPanelBusy(true)
    try {
      await api('/api/control/panel', {
        method: 'POST',
        body: JSON.stringify({ action: 'bulk_update_accounts', ids: [...sel], is_active: isActive, status: isActive ? 'active' : 'inactive' }),
      })
      setPanelMsg(`تم ${isActive ? 'تفعيل' : 'إيقاف'} ${sel.size} حساب ✅`)
      setSel(new Set())
      loadPanel()
    } catch {
      setPanelMsg('فشل التحديث — أعد المحاولة.')
    } finally {
      setPanelBusy(false)
    }
  }

  const runSweep = async () => {
    setPanelBusy(true)
    try {
      await api('/api/control/panel', { method: 'POST', body: JSON.stringify({ action: 'run_sweep_now' }) })
      setPanelMsg('تم بدء الفحص الفوري 🔄')
    } catch {
      setPanelMsg('فشل بدء الفحص.')
    } finally {
      setPanelBusy(false)
    }
  }

  const settings = data?.settings ?? null

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🤖 الأتمتة والتكامل</h2>
        <p className="page-sub">{t('محرّك القواعد الحي على هذا المشروع (قابل للتعديل) + إعدادات المحرّك ومهام الـ workers.', 'The live rule engine on this project (editable) + engine settings and worker jobs.')}</p>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}

      {settings && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>🚦 {t('المفتاح العام للأتمتة الحيّة', 'Live automation master switch')}</h3>
          </div>
          <p className="page-sub">
            {t('هذا هو المحرّك الحقيقي على هذا المشروع — يُقيّم كل معاملة NGPay معلّقة كل دقيقة (cron) وينفّذ القرار فعلياً عبر ngpay-approve. المشروع القديم أدناه لم يعد يُستخدَم.', 'This is the real engine on this project — it evaluates every pending NGPay transaction every minute (cron) and executes decisions for real through ngpay-approve. The old-project section below is no longer used.')}
          </p>
          <div className="control-row">
            <label className="login-remember" style={{ margin: 0 }}>
              <input type="checkbox" checked={settings.automation_enabled === true} disabled={!canControl || settingsBusy === 'automation_enabled'} onChange={(e) => void toggleGlobalSetting('automation_enabled', e.target.checked)} />
              <strong>{t('تشغيل الأتمتة (الموافقة/الرفض التلقائي)', 'Automation on (auto approve/decline)')}</strong>
            </label>
            <span className={`pay-status-badge ${settings.automation_enabled ? 'st-paid' : 'st-dim'}`}>{settings.automation_enabled ? t('حي الآن', 'Live now') : t('متوقف', 'Off')}</span>
          </div>
          <div className="control-row">
            <label className="login-remember" style={{ margin: 0 }}>
              <input type="checkbox" checked={settings.sms_feed_circuit_breaker_enabled !== true} disabled={!canControl || settingsBusy === 'sms_feed_circuit_breaker_enabled'} onChange={(e) => void toggleGlobalSetting('sms_feed_circuit_breaker_enabled', !e.target.checked)} />
              <strong>{t('مطابقة SMS مستمرة', 'SMS matching keeps running')}</strong>
            </label>
            <span className="cell-sub">{t('مستقلة تماماً عن مفتاح الموافقة أعلاه — إيقاف الموافقة لا يوقف استلام/مطابقة SMS.', 'Fully independent of the switch above — turning approval off does not stop SMS ingestion/matching.')}</span>
          </div>
        </section>
      )}

      <section className="card recent-card">
        <div className="recent-head"><h3>➕ {t('قواعد المحرّك — قوالب جاهزة', 'Engine rules — quick templates')}</h3></div>
        <div className="template-grid">
          {RULE_TEMPLATES.map((tpl2) => (
            <div key={tpl2.id} className="template-card">
              <div className="template-head"><strong>{tpl2.label[li]}</strong></div>
              <p className="template-desc">{tpl2.desc[li]}</p>
              {canControl && <button className="btn-primary btn-sm" onClick={() => { setNewRule({ ...EMPTY_RULE, ...tpl2.rule }); setRuleConflict(null); setRuleMsg(null) }}>{t('استخدام كنقطة بداية', 'Use as starting point')}</button>}
            </div>
          ))}
        </div>
      </section>

      <section className="card recent-card">
        <div className="recent-head"><h3>🛠️ {t('تخصيص قاعدة جديدة', 'Customize a new rule')}</h3></div>
        {!canControl && <p className="sidebar-hint">{t('عرض فقط — إضافة قواعد تتطلب صلاحية تعديل.', 'View only — adding rules needs edit permission.')}</p>}
        {canControl && (
          <>
            <div className="control-row">
              <span>{t('النطاق', 'Scope')}</span>
              <select className="login-input" value={newRule.scope_type} onChange={(e) => setNewRule({ ...newRule, scope_type: e.target.value })}>
                <option value="global">{t('عام', 'Global')}</option>
                <option value="wallet">{t('محفظة', 'Wallet')}</option>
              </select>
              <span>{t('التاجر الرئيسي', 'Master merchant')}</span>
              <select className="login-input" value={newRule.master_merchant} onChange={(e) => setNewRule({ ...newRule, master_merchant: e.target.value })}>
                <option value="ngpay">NGPay ({t('حي', 'live')})</option>
                <option value="payfuture">PayFuture ({t('لا يوجد تنفيذ آلي بعد', 'no execution worker yet')})</option>
              </select>
              <span>{t('تاجر فرعي (اختياري)', 'Sub-merchant (optional)')}</span>
              <input className="login-input" placeholder={t('مثال: MelBet', 'e.g. MelBet')} value={newRule.sub_merchant} onChange={(e) => setNewRule({ ...newRule, sub_merchant: e.target.value })} />
            </div>
            <div className="control-row">
              <span>{t('المدى (EGP)', 'Range (EGP)')}</span>
              <input className="login-input" style={{ width: 100 }} type="number" value={newRule.min_amount} onChange={(e) => setNewRule({ ...newRule, min_amount: e.target.value })} />
              <span>–</span>
              <input className="login-input" style={{ width: 100 }} type="number" value={newRule.max_amount} onChange={(e) => setNewRule({ ...newRule, max_amount: e.target.value })} />
              <span>{t('المهلة (دقائق)', 'Window (minutes)')}</span>
              <input className="login-input" style={{ width: 80 }} type="number" value={newRule.time_window_minutes} onChange={(e) => setNewRule({ ...newRule, time_window_minutes: e.target.value })} />
              <span>{t('الأولوية', 'Priority')}</span>
              <input className="login-input" style={{ width: 70 }} type="number" value={newRule.priority} onChange={(e) => setNewRule({ ...newRule, priority: e.target.value })} />
            </div>
            <div className="control-row">
              <span>{t('الإجراء', 'Action')}</span>
              <select className="login-input" value={newRule.action_type} onChange={(e) => setNewRule({ ...newRule, action_type: e.target.value as 'approve' | 'decline' })}>
                <option value="approve">{t('موافقة', 'Approve')}</option>
                <option value="decline">{t('رفض', 'Decline')}</option>
              </select>
            </div>
            {newRule.action_type === 'approve' && (
              <div className="control-row">
                <label className="login-remember" style={{ margin: 0 }}><input type="checkbox" checked={newRule.use_crm_matching} onChange={(e) => setNewRule({ ...newRule, use_crm_matching: e.target.checked })} />{t('مطابقة CRM', 'CRM matching')}</label>
                <label className="login-remember" style={{ margin: 0 }}><input type="checkbox" checked={newRule.use_near_amount} onChange={(e) => setNewRule({ ...newRule, use_near_amount: e.target.checked })} />{t('مطابقة مبلغ تقريبي', 'Near-amount matching')}</label>
                <label className="login-remember" style={{ margin: 0 }}><input type="checkbox" checked={newRule.use_unique_amount} onChange={(e) => setNewRule({ ...newRule, use_unique_amount: e.target.checked })} />{t('مطابقة مبلغ فريد', 'Unique-amount matching')}</label>
              </div>
            )}
            {newRule.action_type === 'approve' && (newRule.use_crm_matching || newRule.use_near_amount || newRule.use_unique_amount) && (
              <div className="card">{t(
                'هذه الخيارات تتجاوز إعدادات المطابقة العامة لهذه القاعدة وحدها. إلغاء تحديد أيٍّ منها يوقف تلك الطبقة لهذه القاعدة فقط — ولا يوقف المطابقة كلها: طبقات الهاتف والمحفظة والجهاز تظل تعمل.',
                'These override the global matching settings for this rule only. Unticking one disables that layer for this rule alone — it does not disable matching: the phone, wallet and device layers still apply.',
              )}</div>
            )}
            {ruleMsg && <p className="page-sub">{ruleMsg}</p>}
            {ruleConflict && ruleConflict.length > 0 && (
              <div className="card warn">
                {t('قواعد متعارضة بنفس الأولوية:', 'Conflicting rules at the same priority:')} {ruleConflict.map((c) => `${c.action_type}#${c.priority}`).join(', ')}
                <div><button className="btn-ghost danger btn-sm" onClick={() => void saveRule(true)}>{t('احفظ رغم التعارض', 'Save anyway')}</button></div>
              </div>
            )}
            <button className="btn-primary btn-sm" disabled={ruleBusy} onClick={() => void saveRule(false)}>{ruleBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ القاعدة', 'Save rule')}</button>
          </>
        )}
      </section>

      <section className="card recent-card">
        <div className="recent-head"><h3>📐 {t('قواعد المحرّك الحي', 'Live engine rules')} ({data?.rules.length ?? 0})</h3></div>
        {data && data.rules.length === 0 && <p>{t('لا توجد قواعد.', 'No rules.')}</p>}
        {data && data.rules.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>{t('النطاق', 'Scope')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('المدى', 'Range')}</th><th>{t('المهلة', 'Window')}</th><th>{t('الإجراء', 'Action')}</th><th>{t('مطابقة', 'Matching')}</th><th>{t('الحالة', 'Status')}</th><th /></tr></thead>
              <tbody>
                {data.rules.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.scope_type ?? '—'}<div className="cell-sub">{t('أولوية', 'priority')} {r.priority ?? '—'}</div></td>
                    <td>{r.sub_merchant ?? r.merchant ?? r.master_merchant ?? t('الكل', 'any')}</td>
                    <td className="mono">{money(r.min_amount, '')} – {money(r.max_amount, '')}</td>
                    <td className="mono">{r.time_window_minutes ?? '—'}{t('د', 'm')}</td>
                    <td className="mono">{r.action_type ?? '—'}</td>
                    <td className="cell-sub">{[r.use_crm_matching && 'CRM', r.use_near_amount && t('تقريبي', 'near'), r.use_unique_amount && t('فريد', 'unique')].filter(Boolean).join(', ') || '—'}</td>
                    <td><span className={`pay-status-badge ${r.enabled ? 'st-paid' : 'st-dim'}`}>{r.enabled ? t('مفعّلة', 'Enabled') : t('موقوفة', 'Disabled')}</span></td>
                    <td>{canControl && <div className="row-actions">
                      <button className="btn-ghost btn-sm" onClick={() => void toggleRule(r)}>{r.enabled ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>
                      <button className="btn-ghost danger btn-sm" onClick={() => void deleteRule(r)}>{t('حذف', 'Delete')}</button>
                    </div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {tpl && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>🗄️ {t('قوالب النظام القديم (غير مُستخدَمة بعد الآن)', 'Old-project templates (no longer used)')}</h3>
            <span className="cell-sub">{t('يبقى المشروع القديم كما هو دون تعديل — هذا القسم مرجعي فقط بعد نقل الأتمتة الحقيقية إلى هذا المشروع.', 'The old project stays untouched — this section is reference-only now that real automation moved to this project.')}</span>
          </div>
          {tplMsg && <p className="page-sub">{tplMsg}</p>}
          <div className="template-grid">
            {tpl.templates.map((row) => {
              const copy = TEMPLATE_COPY[row.id] ?? { label: [row.id, row.id], desc: ['', ''] }
              const active = tpl.active_id === row.id
              return (
                <div key={row.id} className={`template-card${active ? ' active' : ''}`}>
                  <div className="template-head">
                    <strong>{copy.label[li]}</strong>
                    {active && <span className="pay-status-badge st-paid">{t('نشط', 'Active')}</span>}
                  </div>
                  <p className="template-desc">{copy.desc[li]}</p>
                  <div className="template-meta mono">
                    {t('حد', 'Cap')} {money(Number(row.settings.max_auto_amount), 'EGP')} · {t('مهلة', 'Grace')} {String(row.settings.decline_grace_minutes)}{t('د', 'm')} · {t('ثقة', 'Score')} ≥{String(row.settings.score_threshold)}
                    {row.settings.turbo_mode ? ` · Turbo` : ''}{row.settings.automation_enabled === false ? ` · ${t('موقوف', 'Off')}` : ''}
                  </div>
                  <button
                    className="btn-primary btn-sm"
                    disabled={active || !canControl || applying !== null}
                    aria-label={t(`تطبيق قالب ${copy.label[0]}`, `Apply ${copy.label[1]} template`)}
                    onClick={() => void applyTemplate(row.id)}
                  >
                    {applying === row.id ? t('جارٍ التطبيق…', 'Applying…') : active ? t('مُطبَّق', 'Applied') : t('تطبيق', 'Apply')}
                  </button>
                </div>
              )
            })}
          </div>
          {tpl.active_id === null && <p className="sidebar-hint">{t('الإعدادات الحالية لا تطابق أي قالب (تعديل يدوي مخصّص).', 'Current settings match no template (custom manual tuning).')}</p>}
          {!canControl && <p className="sidebar-hint">{t('العرض فقط — تطبيق القوالب يتطلب صلاحية تعديل.', 'View only — applying templates needs edit permission.')}</p>}
        </section>
      )}

      {crons && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>⏱️ صحة مهام الجدولة (النظام القديم)</h3>
            <span className="mono cell-sub">{crons.filter((j) => j.active).length} نشطة من {crons.length}</span>
          </div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>#</th><th>المهمة</th><th>الجدولة</th><th>نشطة</th><th>آخر تشغيل</th><th>النتيجة</th><th>الرسالة</th></tr></thead>
            <tbody>{crons.map((j) => <tr key={j.jobid}>
              <td className="mono">{j.jobid}</td>
              <td className="mono">{j.jobname ?? '—'}</td>
              <td className="mono">{j.schedule ?? '—'}</td>
              <td>{j.active ? '●' : '○'}</td>
              <td className="mono">{j.last_start ? depositTime({ first_seen_at: j.last_start }) : '—'}</td>
              <td><span className={`pay-status-badge ${j.last_status === 'succeeded' ? 'st-paid' : j.last_status ? 'st-declined' : 'st-dim'}`}>{j.last_status ?? '—'}</span></td>
              <td className="cell-sub">{j.last_message ?? '—'}</td>
            </tr>)}</tbody>
          </table></div>
        </section>
      )}

      {settings && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>⚙️ إعدادات المحرّك</h3>
            <span className="mono cell-sub">
              حد تلقائي: {money(Number(settings.max_auto_amount ?? 0), 'EGP')} · عتبة: {String(settings.score_threshold ?? '—')}
            </span>
          </div>
          <div className="flag-grid">
            {Object.entries(FLAG_LABELS).map(([key, label]) => {
              const v = settings[key]
              if (v === undefined || v === null) return null
              return (
                <span key={key} className={`pay-status-badge ${v ? 'st-paid' : 'st-dim'}`}>
                  {v ? '●' : '○'} {label}
                </span>
              )
            })}
          </div>
        </section>
      )}

      {data && (
        <>
          <section className="card recent-card">
            <div className="recent-head"><h3>🧑‍💻 مهام المتصفح الأخيرة</h3></div>
            {data.jobs.length === 0 && <p>لا توجد مهام.</p>}
            {data.jobs.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>tx</th><th>المبلغ</th><th>المهمة</th><th>الحالة</th><th>المشغّل</th><th>الوقت</th></tr></thead>
                  <tbody>
                    {data.jobs.map((j) => (
                      <tr key={j.id}>
                        <td className="mono">{j.tx_id ?? '—'}</td>
                        <td className="mono">{money(j.amount, 'EGP')}</td>
                        <td className="mono">{j.mission ?? '—'} → {j.target_status ?? '—'}</td>
                        <td>
                          <span className={`pay-status-badge ${j.state === 'completed' ? 'st-paid' : j.state === 'failed' ? 'st-declined' : 'st-pending'}`}>
                            {j.state ?? '—'}
                          </span>
                          {j.last_error && <div className="cell-sub">{j.last_error.slice(0, 60)}</div>}
                        </td>
                        <td>{j.operator_username ?? 'آلي'}</td>
                        <td className="mono">{depositTime({ first_seen_at: j.completed_at ?? j.created_at })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {accounts && (
            <section className="card recent-card">
              <div className="recent-head">
                <h3>🏦 حسابات الدفع ({accounts.length})</h3>
                {sel.size > 0 && (
                  <div className="row-actions">
                    <span>{sel.size} محدد</span>
                    <button className="btn-primary btn-sm" disabled={panelBusy} onClick={() => void bulkAccounts(true)}>✅ تفعيل</button>
                    <button className="btn-ghost danger btn-sm" disabled={panelBusy} onClick={() => void bulkAccounts(false)}>⏸ إيقاف</button>
                  </div>
                )}
              </div>
              {panelMsg && <p className="cell-sub">{panelMsg}</p>}
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="check-col">
                        <input
                          type="checkbox"
                          checked={accounts.length > 0 && accounts.every((a) => sel.has(a.id))}
                          onChange={() => setSel(sel.size === accounts.length ? new Set() : new Set(accounts.map((a) => a.id)))}
                        />
                      </th>
                      <th>الحساب</th><th>التاجر</th><th>الطريقة</th><th>الأولوية</th><th>الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}>
                        <td className="check-col">
                          <input
                            type="checkbox"
                            checked={sel.has(a.id)}
                            onChange={() => setSel((p) => { const n = new Set(p); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n })}
                          />
                        </td>
                        <td className="mono">{a.label ?? '—'}</td>
                        <td>{a.merchant_name ?? '—'}</td>
                        <td>{a.method_name ?? a.method_type ?? '—'}</td>
                        <td className="mono">{a.priority ?? '—'}</td>
                        <td><span className={`pay-status-badge ${a.is_active ? 'st-paid' : 'st-dim'}`}>{a.is_active ? 'نشط' : 'موقوف'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {pf && (
            <section className="card recent-card">
              <div className="recent-head">
                <h3>🔌 Payfuture</h3>
                <button className="btn-ghost btn-sm" disabled={panelBusy} onClick={() => void runSweep()}>🔄 إعادة فحص الآن</button>
              </div>
              <div className="flag-grid">
                {pf.map((r) => (
                  <span key={r.id} className={`pay-status-badge ${r.is_active ? 'st-paid' : 'st-dim'}`}>
                    {r.is_active ? '●' : '○'} {r.name ?? r.merchant_name ?? '—'}
                  </span>
                ))}
              </div>
            </section>
          )}

          {(data.balances.length > 0 || data.rates.length > 0) && (
            <section className="card recent-card">
              <div className="recent-head"><h3>🏦 الخزينة (Binance) وأسعار الصرف</h3></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>الحساب / الزوج</th><th>القيمة</th><th>آخر قياس</th></tr></thead>
                  <tbody>
                    {data.balances.map((b, i) => (
                      <tr key={`b${i}`}>
                        <td className="mono">{b.account_id ?? '—'}</td>
                        <td className="mono">{money(b.available_balance, '')} / {money(b.total_balance, '')} (USDT {money(b.usdt_value, '')})</td>
                        <td className="mono">{depositTime({ first_seen_at: b.measured_at })}</td>
                      </tr>
                    ))}
                    {data.rates.map((r, i) => (
                      <tr key={`r${i}`}>
                        <td className="mono">{r.currency_pair ?? '—'}</td>
                        <td className="mono">{r.rate ?? '—'}</td>
                        <td className="mono">{depositTime({ first_seen_at: r.fetched_at })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </PanelShell>
  )
}
