import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { useAuth } from '../auth/AuthContext'
import { Archive, CircleDollarSign, Filter, GitBranch, Landmark, Power, Search, SlidersHorizontal, X } from 'lucide-react'
import MultiSelectFilter from '../components/MultiSelectFilter'
import { useIsMobile } from '../lib/useIsMobile'

interface AutomationTemplate { id: string; settings: Record<string, number | boolean> }
const HIGH_VALUE_SMS_THRESHOLD_EVENT = 'ontarget:high-value-sms-threshold'
const HIGH_VALUE_SMS_THRESHOLD_MAX = 10_000_000
const DEFAULT_HIGH_VALUE_SMS_THRESHOLD = 5_000
const HIGH_VALUE_SMS_THRESHOLD_PRESETS = [5_000, 10_000, 20_000, 50_000]
// Bilingual copy lives client-side so it follows the language switcher; the
// server is the source of truth for the id + the actual settings payload.
const TEMPLATE_COPY: Record<string, { label: [string, string]; desc: [string, string] }> = {
  conservative: { label: ['محافظ', 'Conservative'], desc: ['أقل مخاطرة: حد أقل، مهلة أطول، ثقة أعلى، قاطع الأمان مفعّل.', 'Lowest risk: smaller cap, longer grace, higher confidence, circuit breaker on.'] },
  balanced: { label: ['متوازن', 'Balanced'], desc: ['الوضع التشغيلي الافتراضي — توازن بين السرعة والأمان.', 'Default operating posture — balance of speed and safety.'] },
  turbo: { label: ['سريع (Turbo)', 'Turbo'], desc: ['نفس قواعد المطابقة والحدود، مع مهلة تنفيذ أسرع لمدة دقيقتين فقط.', 'Same matching and amount rules, with faster execution for two minutes only.'] },
  maintenance: { label: ['صيانة (إيقاف)', 'Maintenance (off)'], desc: ['إيقاف الأتمتة بالكامل — كل معاملة تروح مراجعة يدوية. الأمان يفضل مفعّل.', 'Automation fully off — every transaction goes to manual review. Safety stays on.'] },
}

// Automation — matching engine settings (read-only), scoped rules, worker jobs, treasury.

interface RuleRow {
  id: string; scope_type: string | null; master_merchant: string | null; merchant: string | null; sub_merchant: string | null
  account_wallet: string | null; payment_method: string | null; provider: string | null; enabled: boolean | null
  min_amount: number | null; max_amount: number | null; time_window_minutes: number | null; action_type: string | null; priority: number | null
  use_crm_matching: boolean | null; use_near_amount: boolean | null; use_unique_amount: boolean | null; first_deposit_only: boolean | null
}

type NewRule = {
  scope_type: string; master_merchant: string; merchant: string; sub_merchant: string; min_amount: string; max_amount: string
  time_window_minutes: string; action_type: 'approve' | 'decline'; priority: string
  use_crm_matching: boolean; use_near_amount: boolean; use_unique_amount: boolean; first_deposit_only: boolean
}
const EMPTY_RULE: NewRule = { scope_type: 'global', master_merchant: 'ngpay', merchant: '', sub_merchant: '', min_amount: '1', max_amount: '10000', time_window_minutes: '5', action_type: 'approve', priority: '10', use_crm_matching: false, use_near_amount: false, use_unique_amount: false, first_deposit_only: false }

// Flow templates — presets that prefill the form, never saved directly (the
// operator must review + click Save, per the explicit requirement that no
// template writes unreviewed values). "Strict matching" is included even
// though the live evaluator currently blocks any approve rule that requires
// matching (not implemented yet) -- picking it will show that block plainly
// once saved, rather than silently pretending to work.
const RULE_TEMPLATES: { id: string; label: [string, string]; desc: [string, string]; rule: Partial<NewRule> }[] = [
  { id: 'first-deposit-5000', label: ['أول إيداع حتى 5,000', 'First deposit up to 5,000'], desc: ['موافقة تلقائية لأول إيداع فقط بعد ربط SMS حصري وآمن، بحد أقصى 5,000 جنيه.', 'Auto-approve a customer’s first deposit only after an exclusive, safe SMS link, capped at EGP 5,000.'], rule: { action_type: 'approve', min_amount: '1', max_amount: '5000', time_window_minutes: '5', first_deposit_only: true, use_crm_matching: false, use_near_amount: false, use_unique_amount: true } },
  { id: 'small-auto-approve', label: ['موافقة تلقائية للمبالغ الصغيرة', 'Auto-approve small amounts'], desc: ['حد أقصى منخفض، بدون شرط مطابقة، مهلة قصيرة.', 'Low cap, no matching requirement, short window.'], rule: { action_type: 'approve', min_amount: '1', max_amount: '500', time_window_minutes: '5', use_crm_matching: false, use_near_amount: false, use_unique_amount: false } },
  { id: 'strict-matching', label: ['مطابقة صارمة', 'Strict matching'], desc: ['يتطلب كل أدوات المطابقة معاً — سيُرفض تلقائياً من المحرّك اليوم لأن المطابقة الفعلية غير مُنفَّذة بعد (fail-safe).', 'Requires every matching tool — the live engine blocks this today since real matching isn’t implemented yet (fail-safe).'], rule: { action_type: 'approve', min_amount: '1', max_amount: '10000', use_crm_matching: true, use_near_amount: true, use_unique_amount: true } },
  { id: 'decline-after-wait', label: ['رفض تلقائي بعد 5 دقائق', 'Auto-decline after 5 minutes'], desc: ['يعمل فقط حتى الحد الأقصى الذي تراجعه وتحدده قبل الحفظ؛ ما فوق الحد يبقى للمراجعة.', 'Works only up to the maximum amount you review and set before saving; amounts above it remain in review.'], rule: { action_type: 'decline', min_amount: '1', max_amount: '', time_window_minutes: '5' } },
]
interface JobRow { id: string; tx_id: number | null; amount: number | null; target_status: string | null; provider: string | null; state: string | null; mission: string | null; attempts: number | null; last_error: string | null; operator_username: string | null; created_at: string | null; completed_at: string | null }
interface BalanceRow { account_id: string | null; total_balance: number | null; available_balance: number | null; usdt_value: number | null; measured_at: string | null }
interface RateRow { currency_pair: string | null; rate: number | null; fetched_at: string | null }
interface TurboAuditRow { id: number; actor_name: string | null; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: string }

const FLAG_LABELS: Record<string, string> = {
  automation_enabled: 'الأتمتة مفعّلة',
  auto_decline_enabled: 'الرفض التلقائي للمعاملات',
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
    turbo_history?: TurboAuditRow[]
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { t, locale } = useLocale()
  const { can } = useAuth()
  const isMobile = useIsMobile()
  const li = locale === 'en' ? 1 : 0
  const canControl = can('automation', 'can_edit')
  const canRulesChange = can('automation_rules','can_edit') || can('automation','can_edit')
  const canRuleCreate = can('automation_rules','can_create') || can('automation','can_create')
  const canTemplatesChange = can('automation_templates','can_edit') || canControl
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
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set())
  const ruleBuilderRef = useRef<HTMLElement | null>(null)
  const [settingsBusy, setSettingsBusy] = useState<string | null>(null)
  const [popupSettingsOpen, setPopupSettingsOpen] = useState(false)
  const [popupThreshold, setPopupThreshold] = useState('5000')
  const [popupSettingsBusy, setPopupSettingsBusy] = useState(false)
  const [popupSettingsError, setPopupSettingsError] = useState<string | null>(null)
  const popupDialogRef = useRef<HTMLElement | null>(null)
  const popupInputRef = useRef<HTMLInputElement | null>(null)
  const [turboBusy, setTurboBusy] = useState(false)
  const [turboUntil, setTurboUntil] = useState<number | null>(null)
  const turboTimerRef = useRef<number | null>(null)
  const turboRestoreRef = useRef<Record<string, unknown> | null>(null)
  const [ruleSearch, setRuleSearch] = useState('')
  const [ruleProviders, setRuleProviders] = useState<string[]>([])
  const [ruleStatuses, setRuleStatuses] = useState<string[]>([])
  const [ruleActions, setRuleActions] = useState<string[]>([])
  const [tab, setTab] = useState<'control' | 'rules' | 'operations' | 'legacy'>('control')

  const reloadAutomation = () => api<NonNullable<typeof data>>('/api/automation').then(setData).catch(() => {})

  const saveRule = async (confirmConflict = false) => {
    setRuleBusy(true); setRuleMsg(null); if (!confirmConflict) setRuleConflict(null)
    try {
      await api('/api/automation/rules', {
        method: 'POST',
        body: JSON.stringify({
          scope_type: newRule.scope_type, master_merchant: newRule.master_merchant || null, sub_merchant: newRule.sub_merchant || null,
          merchant: newRule.merchant || null,
          min_amount: newRule.min_amount, max_amount: newRule.max_amount, time_window_minutes: newRule.time_window_minutes,
          action_type: newRule.action_type, priority: newRule.priority,
          use_crm_matching: newRule.use_crm_matching, use_near_amount: newRule.use_near_amount, use_unique_amount: newRule.use_unique_amount,
          first_deposit_only: newRule.first_deposit_only,
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

  const startNewFlow = (draft: Partial<NewRule> = {}) => {
    setNewRule({ ...EMPTY_RULE, ...draft })
    setRuleConflict(null)
    setRuleMsg(null)
    setTab('rules')
    window.requestAnimationFrame(() => ruleBuilderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const toggleRuleSelection = (id: string) => setSelectedRuleIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const toggleVisibleRuleSelection = () => setSelectedRuleIds((current) => {
    const visible = filteredRules.map((row) => row.id)
    const allSelected = visible.length > 0 && visible.every((id) => current.has(id))
    const next = new Set(current)
    visible.forEach((id) => allSelected ? next.delete(id) : next.add(id))
    return next
  })

  const bulkRuleAction = async (action: 'enable' | 'disable' | 'delete') => {
    if (!canRulesChange || selectedRuleIds.size === 0) return
    if (action === 'delete' && !window.confirm(t(`حذف ${selectedRuleIds.size} قاعدة؟`, `Delete ${selectedRuleIds.size} selected rule(s)?`))) return
    setRuleBusy(true); setRuleMsg(null)
    try {
      await Promise.all([...selectedRuleIds].map((id) => action === 'delete'
        ? api(`/api/automation/rules/${id}`, { method: 'DELETE' })
        : api(`/api/automation/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: action === 'enable', confirm_conflict: true }) })))
      setSelectedRuleIds(new Set())
      await reloadAutomation()
      setRuleMsg(t('تم تحديث القواعد المحددة.', 'Selected rules updated.'))
    } catch {
      setRuleMsg(t('تعذّر تحديث بعض القواعد المحددة.', 'Some selected rules could not be updated.'))
    } finally { setRuleBusy(false) }
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

  const openPopupSettings = () => {
    const current = Number(data?.settings?.high_value_sms_popup_threshold ?? DEFAULT_HIGH_VALUE_SMS_THRESHOLD)
    setPopupThreshold(String(Number.isFinite(current) && current >= 0 ? current : DEFAULT_HIGH_VALUE_SMS_THRESHOLD))
    setPopupSettingsError(null)
    setPopupSettingsOpen(true)
  }

  const savePopupSettings = async () => {
    const value = Number(popupThreshold)
    if (!popupThreshold.trim() || !Number.isFinite(value) || value < 0 || value > HIGH_VALUE_SMS_THRESHOLD_MAX) {
      setPopupSettingsError(t('أدخل مبلغًا من 0 إلى 10,000,000 جنيه.', 'Enter an amount from EGP 0 to EGP 10,000,000.'))
      return
    }
    const normalized = Math.round(value * 100) / 100
    setPopupSettingsBusy(true)
    setPopupSettingsError(null)
    try {
      const result = await api<{ settings: Record<string, unknown> }>('/api/automation/settings', {
        method: 'PATCH',
        body: JSON.stringify({ high_value_sms_popup_threshold: normalized }),
      })
      setData((current) => current ? { ...current, settings: result.settings } : current)
      window.dispatchEvent(new CustomEvent(HIGH_VALUE_SMS_THRESHOLD_EVENT, { detail: normalized }))
      setPopupSettingsOpen(false)
      setRuleMsg(t(`تم ضبط نافذة SMS للمبالغ الأكبر من ${money(normalized, 'EGP')}.`, `SMS popup now opens above ${money(normalized, 'EGP')}.`))
    } catch (error) {
      setPopupSettingsError(error instanceof ApiError && error.code === 'invalid_high_value_sms_popup_threshold'
        ? t('المبلغ خارج النطاق المسموح.', 'The amount is outside the allowed range.')
        : t('تعذّر حفظ إعداد النافذة.', 'Unable to save the popup setting.'))
    } finally {
      setPopupSettingsBusy(false)
    }
  }

  useEffect(() => {
    if (!popupSettingsOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => popupInputRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPopupSettingsOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(popupDialogRef.current?.querySelectorAll<HTMLElement>('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [popupSettingsOpen])

  const stopTurbo = async (automatic = false) => {
    if (!canControl || turboBusy) return
    setTurboBusy(true)
    try {
      const restore = turboRestoreRef.current ?? {}
      await api('/api/automation/settings', {
        method: 'PATCH',
        body: JSON.stringify({ ...restore, turbo_mode: false }),
      })
      if (turboTimerRef.current != null) window.clearTimeout(turboTimerRef.current)
      turboTimerRef.current = null
      turboRestoreRef.current = null
      setTurboUntil(null)
      await reloadAutomation()
      setRuleMsg(automatic
        ? t('انتهت جلسة Turbo وعادت القواعد والإعدادات السابقة.', 'Turbo ended; the previous rules and settings were restored.')
        : t('تم إيقاف Turbo — عادت القواعد والإعدادات السابقة.', 'Turbo stopped; the previous rules and settings were restored.'))
    } catch {
      setRuleMsg(t('تعذّر إيقاف Turbo — حاول مرة أخرى.', 'Turbo could not be stopped — try again.'))
    } finally {
      setTurboBusy(false)
    }
  }

  const runTurboForTwoMinutes = async () => {
    if (!canControl || turboBusy) return
    setTurboBusy(true)
    setRuleMsg(null)
    try {
      // Turbo changes timing only. Preserve the operator's amount cap,
      // wallet policy and every matching rule so it cannot widen approvals.
      turboRestoreRef.current = {
        max_auto_amount: data?.settings?.max_auto_amount,
        decline_grace_minutes: data?.settings?.decline_grace_minutes,
        wallet_switch_auto_enabled: data?.settings?.wallet_switch_auto_enabled,
      }
      await api('/api/automation/settings', {
        method: 'PATCH',
        body: JSON.stringify({ turbo_mode: true, decline_grace_minutes: 1 }),
      })
      const until = Date.now() + 120_000
      setTurboUntil(until)
      setRuleMsg(t('تم تشغيل Turbo لمدة دقيقتين — سيعود للوضع المتوازن تلقائياً.', 'Turbo is on for 2 minutes — it will return to Balanced automatically.'))
      turboTimerRef.current = window.setTimeout(() => { void stopTurbo(true) }, 120_000)
    } catch {
      turboRestoreRef.current = null
      setRuleMsg(t('تعذّر تشغيل Turbo.', 'Unable to start Turbo.'))
    } finally {
      setTurboBusy(false)
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
  const filteredRules = (data?.rules ?? []).filter((rule) => {
    const query = ruleSearch.trim().toLowerCase()
    const searchable = [rule.scope_type, rule.master_merchant, rule.merchant, rule.sub_merchant, rule.account_wallet, rule.provider].filter(Boolean).join(' ').toLowerCase()
    if (query && !searchable.includes(query)) return false
    if (ruleProviders.length > 0 && !ruleProviders.includes(String(rule.master_merchant ?? rule.provider ?? '').toLowerCase())) return false
    if (ruleStatuses.length > 0 && !ruleStatuses.includes(rule.enabled ? 'active' : 'disabled')) return false
    if (ruleActions.length > 0 && !ruleActions.includes(String(rule.action_type ?? ''))) return false
    return true
  })
  const resetRuleFilters = () => { setRuleSearch(''); setRuleProviders([]); setRuleStatuses([]); setRuleActions([]) }
  const hasRuleFilters = Boolean(ruleSearch || ruleProviders.length || ruleStatuses.length || ruleActions.length)

  return (
    <>
      <section className="page-head">
        <h2>🤖 الأتمتة والتكامل</h2>
        <p className="page-sub">{t('محرّك القواعد الحي على هذا المشروع (قابل للتعديل) + إعدادات المحرّك ومهام الـ workers.', 'The live rule engine on this project (editable) + engine settings and worker jobs.')}</p>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}

      <div className="automation-tabs" role="tablist" aria-label={t('أقسام الأتمتة', 'Automation sections')}>
        <button type="button" role="tab" aria-selected={tab === 'control'} className={tab === 'control' ? 'active' : ''} onClick={() => setTab('control')}><Power size={15} /> {t('التحكم', 'Control')}</button>
        <button type="button" role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}><GitBranch size={15} /> {t('القواعد', 'Rules')}{data ? ` (${data.rules.length})` : ''}</button>
        <button type="button" role="tab" aria-selected={tab === 'operations'} className={tab === 'operations' ? 'active' : ''} onClick={() => setTab('operations')}><Landmark size={15} /> {t('العمليات', 'Operations')}</button>
        <button type="button" role="tab" aria-selected={tab === 'legacy'} className={tab === 'legacy' ? 'active' : ''} onClick={() => setTab('legacy')}><Archive size={15} /> {t('أرشيف قديم', 'Legacy')}</button>
      </div>

      {tab === 'control' && settings && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>🚦 {t('المفتاح العام للأتمتة الحيّة', 'Live automation master switch')}</h3>
          </div>
          <p className="page-sub">
            {t('هذا هو المحرّك الحقيقي على هذا المشروع — يُقيّم كل معاملة NGPay معلّقة كل دقيقة (cron) وينفّذ القرار فعلياً عبر ngpay-approve. المشروع القديم أدناه لم يعد يُستخدَم.', 'This is the real engine on this project — it evaluates every pending NGPay transaction every minute (cron) and executes decisions for real through ngpay-approve. The old-project section below is no longer used.')}
          </p>
          <div className="control-row">
            <button
              type="button"
              className={`automation-master-toggle ${settings.automation_enabled ? 'is-on' : 'is-off'}`}
              role="switch"
              aria-checked={settings.automation_enabled === true}
              disabled={!canControl || settingsBusy === 'automation_enabled'}
              onClick={() => void toggleGlobalSetting('automation_enabled', settings.automation_enabled !== true)}
            >
              <span className="automation-toggle-track"><span className="automation-toggle-thumb" /></span>
              <span><strong>{t('الأتمتة: موافق / إيقاف', 'Automation: ON / OFF')}</strong><small>{settings.automation_enabled ? t('ON — القرارات التلقائية مفعّلة', 'ON — automated decisions enabled') : t('OFF — مراجعة يدوية فقط', 'OFF — manual review only')}</small></span>
              <b>{settings.automation_enabled ? 'ON' : 'OFF'}</b>
            </button>
          </div>
          <div className="control-row">
            <label className="login-remember" style={{ margin: 0 }}>
              <input type="checkbox" checked={settings.sms_feed_circuit_breaker_enabled !== true} disabled={!canControl || settingsBusy === 'sms_feed_circuit_breaker_enabled'} onChange={(e) => void toggleGlobalSetting('sms_feed_circuit_breaker_enabled', !e.target.checked)} />
              <strong>{t('مطابقة SMS مستمرة', 'SMS matching keeps running')}</strong>
            </label>
            <span className="cell-sub">{t('مستقلة تماماً عن مفتاح الموافقة أعلاه — إيقاف الموافقة لا يوقف استلام/مطابقة SMS.', 'Fully independent of the switch above — turning approval off does not stop SMS ingestion/matching.')}</span>
          </div>
          <div className="control-row">
            <button
              type="button"
              className={`automation-master-toggle ${settings.auto_decline_enabled === true ? 'is-on' : 'is-off'}`}
              role="switch"
              aria-checked={settings.auto_decline_enabled === true}
              disabled={!canControl || settingsBusy === 'auto_decline_enabled'}
              onClick={() => void toggleGlobalSetting('auto_decline_enabled', settings.auto_decline_enabled !== true)}
            >
              <span className="automation-toggle-track"><span className="automation-toggle-thumb" /></span>
              <span><strong>{t('الرفض التلقائي للمعاملات', 'Auto-decline transactions')}</strong><small>{settings.auto_decline_enabled === true ? t('ON — رفض المعاملات غير المطابقة بعد المهلة', 'ON — decline stale unmatched transactions') : t('OFF — تظل المعاملات غير المطابقة PENDING', 'OFF — stale unmatched transactions stay PENDING')}</small></span>
              <b>{settings.auto_decline_enabled === true ? 'ON' : 'OFF'}</b>
            </button>
          </div>
          {settings.auto_decline_enabled === true && canRuleCreate && <button type="button" className="btn-ghost btn-sm automation-create-flow-button" onClick={() => startNewFlow({ action_type: 'decline', max_amount: '5000', time_window_minutes: '5' })}>{t('إنشاء تدفق رفض', 'Create decline flow')}</button>}
          <div className="control-row automation-popup-threshold-row">
            <div className="automation-popup-threshold-summary">
              <span className="automation-popup-threshold-icon" aria-hidden="true"><CircleDollarSign size={20} /></span>
              <span>
                <strong>{t('نافذة تنبيه المبالغ الكبيرة', 'High-value SMS popup')}</strong>
                <small>{t('تظهر للرسائل الجديدة التي تتجاوز', 'Opens for new SMS amounts above')} {money(Number(settings.high_value_sms_popup_threshold ?? DEFAULT_HIGH_VALUE_SMS_THRESHOLD), 'EGP')}</small>
              </span>
            </div>
            <button type="button" className="btn-ghost btn-sm automation-popup-settings-button" disabled={!canControl} onClick={openPopupSettings}>
              <SlidersHorizontal size={15} /> {t('إعداد المبلغ', 'Set amount')}
            </button>
          </div>
          <div className={`automation-turbo-card ${settings.turbo_mode ? 'is-on' : ''}`}>
            <div>
              <strong>⚡ {t('Turbo Mode — جلسة سريعة', 'Turbo Mode — quick session')}</strong>
              <p>{t('يشغّل المعالجة السريعة لمدة دقيقتين فقط، ثم يعود تلقائياً إلى الوضع المتوازن.', 'Runs the faster processing posture for exactly two minutes, then returns to Balanced automatically.')}</p>
              {turboUntil && <small>{t('ينتهي عند', 'Ends at')} {new Date(turboUntil).toLocaleTimeString()}</small>}
            </div>
            <button type="button" className={turboUntil ? 'btn-ghost danger btn-sm' : 'btn-primary btn-sm'} disabled={!canControl || turboBusy} onClick={() => void (turboUntil ? stopTurbo() : runTurboForTwoMinutes())}>
              {turboBusy ? t('جارٍ التنفيذ…', 'Processing…') : turboUntil ? t('إيقاف Turbo الآن', 'Stop Turbo now') : t('تشغيل Turbo لدقيقتين', 'Run Turbo for 2 minutes')}
            </button>
          </div>
          {(data?.turbo_history?.length ?? 0) > 0 && <div className="automation-turbo-report">
            <div className="automation-turbo-report-head"><strong>📊 {t('تقرير جلسات Turbo', 'Turbo activity report')}</strong><span>{t('آخر 30 تغييرًا', 'Last 30 changes')}</span></div>
            {isMobile ? (
              <div className="risk-card-list">
                {(data?.turbo_history ?? []).map((row) => {
                  const after = row.after ?? {}
                  const template = typeof after.template === 'string' ? after.template : null
                  const turbo = template ? template === 'turbo' : after.turbo_mode === true
                  return <div key={row.id} className="risk-row-card">
                    <div className="risk-row-card-head"><span className={`pay-status-badge ${turbo ? 'st-paid' : 'st-dim'}`}>{turbo ? '⚡ Turbo ON' : 'Balanced / Turbo OFF'}</span><span>{row.actor_name ?? 'system'}</span></div>
                    <div className="cell-sub">{template ? template : `${after.max_auto_amount ?? '—'} EGP · ${after.decline_grace_minutes ?? '—'}m · ${after.wallet_switch_auto_enabled ? 'wallet switch' : 'fixed wallet'}`}</div>
                    <div className="risk-row-card-foot"><span className="mono muted">{new Date(row.created_at).toLocaleString()}</span></div>
                  </div>
                })}
              </div>
            ) : (
            <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الوقت', 'Time')}</th><th>{t('الإجراء', 'Action')}</th><th>{t('المنفّذ', 'Actor')}</th><th>{t('الإعدادات', 'Applied settings')}</th></tr></thead><tbody>
              {(data?.turbo_history ?? []).map((row) => {
                const after = row.after ?? {}
                const template = typeof after.template === 'string' ? after.template : null
                const turbo = template ? template === 'turbo' : after.turbo_mode === true
                return <tr key={row.id}><td className="mono">{new Date(row.created_at).toLocaleString()}</td><td><span className={`pay-status-badge ${turbo ? 'st-paid' : 'st-dim'}`}>{turbo ? '⚡ Turbo ON' : 'Balanced / Turbo OFF'}</span></td><td>{row.actor_name ?? 'system'}</td><td className="cell-sub">{template ? template : `${after.max_auto_amount ?? '—'} EGP · ${after.decline_grace_minutes ?? '—'}m · ${after.wallet_switch_auto_enabled ? 'wallet switch' : 'fixed wallet'}`}</td></tr>
              })}
            </tbody></table></div>
            )}
          </div>}
        </section>
      )}

      {tab === 'rules' && <>
      <section className="card recent-card">
        <div className="recent-head"><h3>➕ {t('قواعد المحرّك — قوالب جاهزة', 'Engine rules — quick templates')}</h3></div>
        <div className="template-grid">
          {RULE_TEMPLATES.map((tpl2) => (
            <div key={tpl2.id} className="template-card">
              <div className="template-head"><strong>{tpl2.label[li]}</strong></div>
              <p className="template-desc">{tpl2.desc[li]}</p>
              {canRuleCreate && <button className="btn-primary btn-sm" onClick={() => startNewFlow(tpl2.rule)}>{t('استخدام كنقطة بداية', 'Use as starting point')}</button>}
            </div>
          ))}
        </div>
      </section>

      <section ref={ruleBuilderRef} className="card recent-card automation-rule-builder">
        <div className="recent-head"><div><h3>🛠️ {t('إنشاء تدفق جديد', 'Create a new flow')}</h3><p className="cell-sub">{t('صمّم قاعدة، راجع حدودها، ثم احفظها لتظهر في قائمة القواعد الحيّة.', 'Design a rule, review its limits, then save it to the live rules list.')}</p></div><span className="pay-status-badge st-pending">{newRule.action_type === 'decline' ? t('رفض تلقائي', 'Auto-decline') : t('موافقة تلقائية', 'Auto-approve')}</span></div>
        {!canRuleCreate && <p className="sidebar-hint">{t('عرض فقط — إضافة قواعد تتطلب صلاحية إنشاء.', 'View only — adding rules needs create permission.')}</p>}
        {canRuleCreate && (
          <>
            <div className="control-row">
              <span>{t('النطاق', 'Scope')}</span>
              <select className="login-input" value={newRule.scope_type} onChange={(e) => setNewRule({ ...newRule, scope_type: e.target.value })}>
                <option value="global">{t('عام', 'Global')}</option>
                <option value="merchant">{t('تاجر محدد', 'Specific merchant')}</option>
                <option value="wallet">{t('محفظة', 'Wallet')}</option>
              </select>
              <span>{t('التاجر الرئيسي', 'Master merchant')}</span>
              <select className="login-input" value={newRule.master_merchant} onChange={(e) => setNewRule({ ...newRule, master_merchant: e.target.value })}>
                <option value="ngpay">NGPay ({t('حي', 'live')})</option>
                <option value="payfuture">PayFuture ({t('لا يوجد تنفيذ آلي بعد', 'no execution worker yet')})</option>
              </select>
              <span>{t('اسم التاجر في المعاملة', 'Transaction merchant')}</span>
              <input className="login-input" placeholder={t('مثال: HFM / Hf markets', 'e.g. HFM / Hf markets')} value={newRule.merchant} onChange={(e) => setNewRule({ ...newRule, merchant: e.target.value })} />
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
            {newRule.action_type === 'decline' && <div className="card warn">{t('الرفض التلقائي ينتظر 5 دقائق على الأقل، ولن يُحفَظ بدون Maximum Amount موجب. أي مبلغ أعلى من الحد يظل pending review.', 'Auto-decline waits at least 5 minutes and cannot be saved without a positive Maximum Amount. Any amount above the limit remains pending review.')}</div>}
            {newRule.action_type === 'approve' && (
              <div className="control-row">
                <label className="login-remember" style={{ margin: 0 }}><input type="checkbox" checked={newRule.first_deposit_only} onChange={(e) => setNewRule({ ...newRule, first_deposit_only: e.target.checked, max_amount: e.target.checked ? '5000' : newRule.max_amount })} />{t('أول إيداع فقط (SMS مطلوب، حد 5,000)', 'First deposit only (SMS required, 5,000 cap)')}</label>
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
            <button className="btn-primary btn-sm" disabled={ruleBusy} onClick={() => void saveRule(false)}>{ruleBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ التدفق', 'Save flow')}</button>
          </>
        )}
      </section>

      <section className="card recent-card">
        <div className="recent-head"><div><h3>📐 {t('قواعد المحرّك الحي', 'Live engine rules')} ({data?.rules.length ?? 0})</h3><p className="cell-sub">{t('حدد عدة قواعد لتفعيلها أو إيقافها أو حذفها دفعة واحدة.', 'Select multiple rules to enable, disable or delete them in bulk.')}</p></div><div className="row-actions"><button type="button" className="btn-primary btn-sm" disabled={!canRuleCreate} onClick={() => startNewFlow()}>{t('إنشاء تدفق جديد', 'Create new flow')}</button>{selectedRuleIds.size > 0 && <><span className="pay-status-badge st-pending">{selectedRuleIds.size} {t('محدد', 'selected')}</span><button type="button" className="btn-ghost btn-sm" disabled={ruleBusy} onClick={() => void bulkRuleAction('enable')}>{t('تفعيل', 'Enable')}</button><button type="button" className="btn-ghost btn-sm" disabled={ruleBusy} onClick={() => void bulkRuleAction('disable')}>{t('إيقاف', 'Disable')}</button><button type="button" className="btn-ghost danger btn-sm" disabled={ruleBusy} onClick={() => void bulkRuleAction('delete')}>{t('حذف', 'Delete')}</button></>}</div></div>
        <div className="automation-filter-bar" role="search" aria-label={t('فلترة قواعد الأتمتة', 'Filter automation rules')}>
          <div className="automation-filter-title"><Filter size={16} /><span>{t('فلترة القواعد', 'Rule filters')}</span></div>
          <label className="automation-filter-search">
            <Search size={16} />
            <input value={ruleSearch} onChange={(e) => setRuleSearch(e.target.value)} placeholder={t('بحث بالتاجر، المحفظة أو النطاق', 'Search merchant, wallet or scope')} />
          </label>
          <MultiSelectFilter label={t('المزوّد', 'Provider')} allLabel={t('كل المزوّدين', 'All providers')} options={[{value:'ngpay',label:'NGPay'},{value:'payfuture',label:'PayFuture'}]} value={ruleProviders} onChange={setRuleProviders}/>
          <MultiSelectFilter label={t('الحالة', 'Status')} allLabel={t('كل الحالات', 'All statuses')} options={[{value:'active',label:t('مفعّلة','Enabled')},{value:'disabled',label:t('موقوفة','Disabled')}]} value={ruleStatuses} onChange={setRuleStatuses}/>
          <MultiSelectFilter label={t('الإجراء', 'Action')} allLabel={t('كل الإجراءات', 'All actions')} options={[{value:'approve',label:t('موافقة','Approve')},{value:'decline',label:t('رفض','Decline')}]} value={ruleActions} onChange={setRuleActions}/>
          <span className="automation-filter-count">{filteredRules.length} / {data?.rules.length ?? 0}</span>
          {hasRuleFilters && <button className="btn-ghost btn-sm" onClick={resetRuleFilters}><X size={14} /> {t('مسح', 'Clear')}</button>}
        </div>
        {data && data.rules.length === 0 && <p>{t('لا توجد قواعد.', 'No rules.')}</p>}
        {data && data.rules.length > 0 && filteredRules.length === 0 && <div className="automation-filter-empty">{t('لا توجد قواعد تطابق الفلاتر الحالية.', 'No rules match the current filters.')}</div>}
        {data && filteredRules.length > 0 && (isMobile ? (
          <div className="risk-card-list">
            {filteredRules.map((r) => (
              <div key={r.id} className="risk-row-card">
                <div className="risk-row-card-head"><span className="mono">{r.scope_type ?? '—'} · {t('أولوية', 'priority')} {r.priority ?? '—'}</span><span className={`pay-status-badge ${r.enabled ? 'st-paid' : 'st-dim'}`}>{r.enabled ? t('مفعّلة', 'Enabled') : t('موقوفة', 'Disabled')}</span></div>
                <div className="cell-sub">{r.sub_merchant ?? r.merchant ?? r.master_merchant ?? t('الكل', 'any')} · {r.action_type ?? '—'}</div>
                <div className="cell-sub">{money(r.min_amount, '')} – {money(r.max_amount, '')} · {r.time_window_minutes ?? '—'}{t('د', 'm')}</div>
                <div className="risk-row-card-foot"><span>{[r.use_crm_matching && 'CRM', r.use_near_amount && t('تقريبي', 'near'), r.use_unique_amount && t('فريد', 'unique')].filter(Boolean).join(', ') || '—'}</span></div>
                {canRulesChange && <div className="row-actions">
                  <button className="btn-ghost btn-sm" onClick={() => void toggleRule(r)}>{r.enabled ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>
                  <button className="btn-ghost danger btn-sm" onClick={() => void deleteRule(r)}>{t('حذف', 'Delete')}</button>
                </div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th className="check-col"><input type="checkbox" checked={filteredRules.length > 0 && filteredRules.every((row) => selectedRuleIds.has(row.id))} onChange={toggleVisibleRuleSelection} aria-label={t('تحديد كل القواعد الظاهرة', 'Select all visible rules')} /></th><th>{t('النطاق', 'Scope')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('المدى', 'Range')}</th><th>{t('المهلة', 'Window')}</th><th>{t('الإجراء', 'Action')}</th><th>{t('مطابقة', 'Matching')}</th><th>{t('الحالة', 'Status')}</th><th /></tr></thead>
              <tbody>
                {filteredRules.map((r) => (
                  <tr key={r.id}>
                    <td className="check-col"><input type="checkbox" checked={selectedRuleIds.has(r.id)} onChange={() => toggleRuleSelection(r.id)} aria-label={t(`تحديد القاعدة ${r.id}`, `Select rule ${r.id}`)} /></td><td className="mono">{r.scope_type ?? '—'}<div className="cell-sub">{t('أولوية', 'priority')} {r.priority ?? '—'}</div></td>
                    <td>{r.sub_merchant ?? r.merchant ?? r.master_merchant ?? t('الكل', 'any')}</td>
                    <td className="mono">{money(r.min_amount, '')} – {money(r.max_amount, '')}</td>
                    <td className="mono">{r.time_window_minutes ?? '—'}{t('د', 'm')}</td>
                    <td className="mono">{r.action_type ?? '—'}</td>
                    <td className="cell-sub">{[r.use_crm_matching && 'CRM', r.use_near_amount && t('تقريبي', 'near'), r.use_unique_amount && t('فريد', 'unique')].filter(Boolean).join(', ') || '—'}</td>
                    <td><span className={`pay-status-badge ${r.enabled ? 'st-paid' : 'st-dim'}`}>{r.enabled ? t('مفعّلة', 'Enabled') : t('موقوفة', 'Disabled')}</span></td>
                    <td>{canRulesChange && <div className="row-actions">
                      <button className="btn-ghost btn-sm" onClick={() => void toggleRule(r)}>{r.enabled ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>
                      <button className="btn-ghost danger btn-sm" onClick={() => void deleteRule(r)}>{t('حذف', 'Delete')}</button>
                    </div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
      </>}

      {tab === 'legacy' && tpl && (
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
                    disabled={active || !canTemplatesChange || applying !== null}
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
          {!canTemplatesChange && <p className="sidebar-hint">{t('العرض فقط — تطبيق القوالب يتطلب صلاحية تعديل.', 'View only — applying templates needs edit permission.')}</p>}
        </section>
      )}

      {tab === 'legacy' && crons && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>⏱️ صحة مهام الجدولة (النظام القديم)</h3>
            <span className="mono cell-sub">{crons.filter((j) => j.active).length} نشطة من {crons.length}</span>
          </div>
          {isMobile ? (
            <div className="risk-card-list">
              {crons.map((j) => <div key={j.jobid} className="risk-row-card">
                <div className="risk-row-card-head"><span className="mono">#{j.jobid} {j.jobname ?? '—'}</span><span className={`pay-status-badge ${j.last_status === 'succeeded' ? 'st-paid' : j.last_status ? 'st-declined' : 'st-dim'}`}>{j.last_status ?? '—'}</span></div>
                <div className="cell-sub">{j.schedule ?? '—'} · {j.active ? '● active' : '○ inactive'}</div>
                {j.last_message && <div className="cell-sub">{j.last_message}</div>}
                <div className="risk-row-card-foot"><span className="mono muted">{j.last_start ? depositTime({ first_seen_at: j.last_start }) : '—'}</span></div>
              </div>)}
            </div>
          ) : (
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
          )}
        </section>
      )}

      {tab === 'control' && settings && (
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
                <button
                  key={key}
                  type="button"
                  className={`pay-status-badge flag-toggle ${v ? 'st-paid' : 'st-dim'}`}
                  disabled={!canControl || settingsBusy === key}
                  aria-pressed={v === true}
                  onClick={() => void toggleGlobalSetting(key, v !== true)}
                >
                  {settingsBusy === key ? '…' : v ? '●' : '○'} {label}
                </button>
              )
            })}
          </div>
          {!canControl && <p className="sidebar-hint">{t('عرض فقط — تعديل هذه الإعدادات يتطلب صلاحية تحكم.', 'View only — editing these settings needs control permission.')}</p>}
        </section>
      )}

      {tab === 'operations' && data && (
        <>
          <section className="card recent-card">
            <div className="recent-head"><h3>🧑‍💻 مهام المتصفح الأخيرة</h3></div>
            {data.jobs.length === 0 && <p>لا توجد مهام.</p>}
            {data.jobs.length > 0 && (isMobile ? (
              <div className="risk-card-list">
                {data.jobs.map((j) => (
                  <div key={j.id} className="risk-row-card">
                    <div className="risk-row-card-head"><span className="mono">{j.tx_id ?? '—'}</span><span className="mono">{money(j.amount, 'EGP')}</span></div>
                    <div className="cell-sub">{j.mission ?? '—'} → {j.target_status ?? '—'}</div>
                    {j.last_error && <div className="cell-sub">{j.last_error.slice(0, 60)}</div>}
                    <div className="risk-row-card-foot">
                      <span className={`pay-status-badge ${j.state === 'completed' ? 'st-paid' : j.state === 'failed' ? 'st-declined' : 'st-pending'}`}>{j.state ?? '—'}</span>
                      <span>{j.operator_username ?? 'آلي'}</span>
                      <span className="mono muted">{depositTime({ first_seen_at: j.completed_at ?? j.created_at })}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
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
            ))}
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
              {isMobile ? (
                <div className="risk-card-list">
                  {accounts.map((a) => (
                    <label key={a.id} className="risk-row-card">
                      <div className="risk-row-card-head">
                        <span><input type="checkbox" checked={sel.has(a.id)} onChange={() => setSel((p) => { const n = new Set(p); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n })} /> <span className="mono">{a.label ?? '—'}</span></span>
                        <span className={`pay-status-badge ${a.is_active ? 'st-paid' : 'st-dim'}`}>{a.is_active ? 'نشط' : 'موقوف'}</span>
                      </div>
                      <div className="cell-sub">{a.merchant_name ?? '—'} · {a.method_name ?? a.method_type ?? '—'} · {t('أولوية', 'priority')} {a.priority ?? '—'}</div>
                    </label>
                  ))}
                </div>
              ) : (
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
              )}
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
              {isMobile ? (
                <div className="risk-card-list">
                  {data.balances.map((b, i) => (
                    <div key={`b${i}`} className="risk-row-card">
                      <div className="risk-row-card-head"><span className="mono">{b.account_id ?? '—'}</span><span className="mono muted">{depositTime({ first_seen_at: b.measured_at })}</span></div>
                      <div className="cell-sub mono">{money(b.available_balance, '')} / {money(b.total_balance, '')} (USDT {money(b.usdt_value, '')})</div>
                    </div>
                  ))}
                  {data.rates.map((r, i) => (
                    <div key={`r${i}`} className="risk-row-card">
                      <div className="risk-row-card-head"><span className="mono">{r.currency_pair ?? '—'}</span><span className="mono muted">{depositTime({ first_seen_at: r.fetched_at })}</span></div>
                      <div className="cell-sub mono">{r.rate ?? '—'}</div>
                    </div>
                  ))}
                </div>
              ) : (
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
              )}
            </section>
          )}
        </>
      )}
      {popupSettingsOpen && <div className="automation-popup-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !popupSettingsBusy) setPopupSettingsOpen(false) }}>
        <section ref={popupDialogRef} className="automation-popup-settings-modal" role="dialog" aria-modal="true" aria-labelledby="popup-settings-title" aria-describedby="popup-settings-description">
          <header>
            <span className="automation-popup-settings-icon" aria-hidden="true"><CircleDollarSign size={23} /></span>
            <div>
              <h3 id="popup-settings-title">{t('إعداد نافذة تنبيه المبلغ', 'Amount popup settings')}</h3>
              <p id="popup-settings-description">{t('اختر الحد الذي يجب أن تتجاوزه رسالة SMS الجديدة لفتح التنبيه في منتصف الشاشة.', 'Choose the amount a new SMS must exceed before opening the centered alert.')}</p>
            </div>
            <button type="button" className="automation-popup-settings-close" disabled={popupSettingsBusy} onClick={() => setPopupSettingsOpen(false)} aria-label={t('إغلاق', 'Close')}><X size={18} /></button>
          </header>
          <form onSubmit={(event) => { event.preventDefault(); void savePopupSettings() }}>
            <label htmlFor="high-value-sms-threshold">{t('التنبيه للمبالغ الأكبر من', 'Show popup above')}</label>
            <div className="automation-popup-amount-input">
              <input ref={popupInputRef} id="high-value-sms-threshold" type="number" min="0" max={HIGH_VALUE_SMS_THRESHOLD_MAX} step="100" inputMode="decimal" value={popupThreshold} onChange={(event) => { setPopupThreshold(event.target.value); setPopupSettingsError(null) }} aria-invalid={popupSettingsError != null} aria-describedby={popupSettingsError ? 'popup-threshold-hint popup-threshold-error' : 'popup-threshold-hint'} />
              <span>EGP</span>
            </div>
            <small id="popup-threshold-hint">{t('التنبيه لرسائل الدخول والخروج: 5,000 يظهر تنبيهات أكثر، و50,000 يظهر أقل. القيمة 0 تعرض كل رسالة أكبر من صفر.', 'Alerts for inbound and outbound SMS: 5,000 shows more; 50,000 shows fewer. Zero alerts on every message above zero.')}</small>
            <div className="automation-popup-presets" aria-label={t('قيم سريعة', 'Quick values')}>
              {HIGH_VALUE_SMS_THRESHOLD_PRESETS.map((preset) => <button key={preset} type="button" className={Number(popupThreshold) === preset ? 'is-selected' : ''} aria-pressed={Number(popupThreshold) === preset} onClick={() => { setPopupThreshold(String(preset)); setPopupSettingsError(null) }}>{money(preset, 'EGP')}</button>)}
            </div>
            {popupSettingsError && <p id="popup-threshold-error" className="automation-popup-settings-error" role="alert">{popupSettingsError}</p>}
            <p className="automation-popup-settings-note">{t('هذا الإعداد يغيّر التنبيه فقط. لا يغيّر المطابقة أو الموافقة أو الرفض التلقائي، وتذاكر شكاوى Telegram تظل فورية.', 'This changes alerts only. It does not change matching, approval, or auto-decline, and Telegram complaint tickets remain immediate.')}</p>
            <footer>
              <button type="button" className="btn-ghost" disabled={popupSettingsBusy} onClick={() => setPopupSettingsOpen(false)}>{t('إلغاء', 'Cancel')}</button>
              <button type="submit" className="btn-primary" disabled={popupSettingsBusy}>{popupSettingsBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ المبلغ', 'Save amount')}</button>
            </footer>
          </form>
        </section>
      </div>}
    </>
  )
}
