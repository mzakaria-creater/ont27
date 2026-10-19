import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CirclePause, Pencil, Plus, RefreshCw, RotateCcw, ShieldAlert, WalletCards, X } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Rule {
  id: string
  bank_id: string
  merchant: string
  payment_type: string
  source_wallet: string
  target_wallet: string
  amount_threshold: number
  amount_received_since_check: number
  active: boolean
  status: 'active' | 'switched' | 'error' | 'paused'
  switched_at: string | null
  last_checked_at: string | null
  last_error: string | null
  created_at: string
}

type Form = Pick<Rule, 'bank_id' | 'merchant' | 'payment_type' | 'source_wallet' | 'target_wallet'> & { amount_threshold: string }
const emptyForm: Form = { bank_id: '', merchant: '', payment_type: 'Vodafone Cash', source_wallet: '', target_wallet: '', amount_threshold: '' }

const statusLabel = (status: Rule['status'], t: (ar: string, en: string) => string) => ({
  active: t('نشطة', 'Active'), switched: t('تم التبديل', 'Switched'), paused: t('متوقفة', 'Paused'), error: t('خطأ', 'Error'),
}[status])

export default function WalletThresholdRules() {
  const { t } = useLocale()
  const { can } = useAuth()
  const canEdit = can('wallets', 'can_edit')
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState<Form>(emptyForm)
  const [filter, setFilter] = useState<'all' | Rule['status']>('all')

  const load = useCallback(async () => {
    try {
      const response = await api<{ rules: Rule[] }>('/api/wallets/threshold-switch-rules')
      setRules(response.rules)
      setError(null)
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.code : t('تعذر تحميل القواعد.', 'Unable to load rules.'))
    } finally { setLoading(false) }
  }, [t])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 20_000); return () => window.clearInterval(timer) }, [load])

  const filtered = useMemo(() => filter === 'all' ? rules : rules.filter((rule) => rule.status === filter), [filter, rules])
  const stats = useMemo(() => ({ active: rules.filter((rule) => rule.active && rule.status === 'active').length, switched: rules.filter((rule) => rule.status === 'switched').length, errors: rules.filter((rule) => rule.status === 'error').length }), [rules])

  const openCreate = () => { setEditing(null); setCreateOpen(true); setForm(emptyForm); setError(null); setNotice(null) }
  const openEdit = (rule: Rule) => { setCreateOpen(false); setEditing(rule); setForm({ bank_id: rule.bank_id, merchant: rule.merchant, payment_type: rule.payment_type, source_wallet: rule.source_wallet, target_wallet: rule.target_wallet, amount_threshold: String(rule.amount_threshold) }); setError(null); setNotice(null) }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null)
    try {
      const path = editing ? `/api/wallets/threshold-switch-rules/${editing.id}` : '/api/wallets/threshold-switch-rules'
      await api(path, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ ...form, amount_threshold: Number(form.amount_threshold) }) })
      setEditing(null); setCreateOpen(false); setNotice(t('تم حفظ القاعدة.', 'Rule saved.')); await load()
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : ''
      setError(code === 'source_wallet_not_live_for_bank' ? t('رقم المصدر لا يطابق رقم Maven الحي.', 'Source does not match the live Maven number.') : code === 'target_wallet_in_use' ? t('رقم الهدف مستخدم بالفعل.', 'Target wallet is already in use.') : code === 'active_rule_exists_for_bank' ? t('يوجد قانون نشط لهذا البنك.', 'This bank already has an active rule.') : t('تعذر حفظ القاعدة.', 'Could not save the rule.'))
    } finally { setBusy(false) }
  }
  const action = async (rule: Rule, kind: 'pause' | 'rearm') => {
    setBusy(true); setError(null)
    try { await api(`/api/wallets/threshold-switch-rules/${rule.id}/${kind}`, { method: 'POST' }); setNotice(kind === 'pause' ? t('تم إيقاف القاعدة.', 'Rule paused.') : t('تمت إعادة تسليح القاعدة.', 'Rule rearmed.')); await load() }
    catch (cause) { setError(cause instanceof ApiError ? cause.code : t('تعذر تنفيذ الإجراء.', 'Action failed.')) }
    finally { setBusy(false) }
  }

  return <div className="page-shell wallet-rules-page">
    <div className="page-header"><div><div className="eyebrow"><WalletCards size={16} /> {t('تشغيل المحافظ', 'Wallet operations')}</div><h1>{t('قواعد تبديل المحافظ', 'Wallet switch rules')}</h1><p>{t('بدّل محفظة Maven تلقائيًا عند وصول إجمالي الإيداعات إلى الحد المحدد.', 'Automatically switch a Maven wallet when cumulative deposits reach the configured threshold.')}</p></div><div className="page-header-actions"><button className="btn-ghost btn-sm" type="button" onClick={() => void load()}><RefreshCw size={15} /> {t('تحديث', 'Refresh')}</button>{canEdit && <button className="btn-primary btn-sm" type="button" onClick={openCreate}><Plus size={15} /> {t('قاعدة جديدة', 'New rule')}</button>}</div></div>
    {notice && <div className="inline-success"><CheckCircle2 size={16} /> {notice}<button type="button" onClick={() => setNotice(null)} aria-label={t('إغلاق', 'Dismiss')}><X size={14} /></button></div>}
    {error && <div className="inline-error"><ShieldAlert size={16} /> {error}</div>}
    <div className="wallet-rule-stats"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}><span>{t('كل القواعد', 'All rules')}</span><strong>{rules.length}</strong></button><button className={filter === 'active' ? 'active' : ''} onClick={() => setFilter('active')}><span>{t('نشطة', 'Active')}</span><strong>{stats.active}</strong></button><button className={filter === 'switched' ? 'active' : ''} onClick={() => setFilter('switched')}><span>{t('تم تبديلها', 'Switched')}</span><strong>{stats.switched}</strong></button><button className={filter === 'error' ? 'active' : ''} onClick={() => setFilter('error')}><span>{t('تحتاج مراجعة', 'Needs review')}</span><strong>{stats.errors}</strong></button></div>
    <section className="card wallet-rule-guide"><strong>{t('طريقة الحساب', 'How the counter works')}</strong><span>{t('المجموع = مبالغ SMS الإيداع منذ إنشاء القاعدة. السحب ورصيد SMS الحالي لا يدخلان في القرار.', 'Total = deposit SMS amounts since the rule was created. Withdrawals and the current SMS balance never trigger the decision.')}</span></section>
    <section className="card wallet-rule-table"><div className="section-heading"><div><h2>{t('القواعد والإعدادات', 'Rules & settings')}</h2><p>{t('كل بنك Maven له قاعدة نشطة واحدة فقط.', 'Each Maven bank can have one active rule.')}</p></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>{t('البنك / التاجر', 'Bank / merchant')}</th><th>{t('من → إلى', 'From → to')}</th><th>{t('التقدم', 'Progress')}</th><th>{t('الحالة', 'Status')}</th><th>{t('آخر فحص', 'Last checked')}</th><th>{t('إجراء', 'Action')}</th></tr></thead><tbody>{loading ? <tr><td colSpan={6} className="empty-state">{t('جارٍ التحميل…', 'Loading…')}</td></tr> : filtered.map((rule) => { const progress = rule.amount_threshold > 0 ? Math.min(100, (Number(rule.amount_received_since_check) / Number(rule.amount_threshold)) * 100) : 0; return <tr key={rule.id}><td><strong className="mono">{rule.bank_id}</strong><div className="cell-sub">{rule.merchant} · {rule.payment_type}</div></td><td><strong className="mono">{rule.source_wallet}</strong><div className="rule-arrow">→</div><strong className="mono">{rule.target_wallet}</strong></td><td><div className="rule-progress-label"><strong>{money(Number(rule.amount_received_since_check), 'EGP')}</strong><span>{money(Number(rule.amount_threshold), 'EGP')}</span></div><div className="rule-progress"><i style={{ width: `${progress}%` }} /></div><small>{Math.round(progress)}%</small></td><td><span className={`rule-status ${rule.status}`}><span />{statusLabel(rule.status, t)}</span>{rule.last_error && <div className="cell-sub rule-error">{rule.last_error}</div>}</td><td className="cell-sub mono">{rule.last_checked_at ? new Date(rule.last_checked_at).toLocaleString('en-GB') : '—'}</td><td><div className="row-actions">{canEdit && rule.active && rule.status === 'active' && <><button className="btn-ghost btn-sm" type="button" onClick={() => openEdit(rule)}><Pencil size={14} /> {t('تعديل', 'Edit')}</button><button className="icon-button" type="button" title={t('إيقاف القاعدة', 'Pause rule')} onClick={() => void action(rule, 'pause')} disabled={busy}><CirclePause size={15} /></button></>}{canEdit && (!rule.active || rule.status !== 'active') && <button className="btn-ghost btn-sm" type="button" onClick={() => void action(rule, 'rearm')} disabled={busy}><RotateCcw size={14} /> {t('إعادة تشغيل', 'Rearm')}</button>}</div></td></tr> })}{!loading && filtered.length === 0 && <tr><td colSpan={6} className="empty-state">{t('لا توجد قواعد بهذه الحالة.', 'No rules in this state.')}</td></tr>}</tbody></table></div></section>
    {(editing || createOpen) && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setEditing(null); setCreateOpen(false) } }}><form className="card wallet-rule-form" onSubmit={submit}><div className="section-heading"><div><h2>{editing ? t('تعديل القاعدة', 'Edit rule') : t('إنشاء قاعدة', 'Create rule')}</h2><p>{t('تحقق من الرقم الحي قبل الحفظ.', 'The live number is verified before saving.')}</p></div><button className="icon-button" type="button" onClick={() => { setEditing(null); setCreateOpen(false) }} aria-label={t('إغلاق', 'Close')}><X size={17} /></button></div><div className="form-grid"><label>{t('كود بنك Maven', 'Maven bank code')}<input required value={form.bank_id} onChange={(e) => setForm({ ...form, bank_id: e.target.value })} disabled={!!editing} /></label><label>{t('التاجر', 'Merchant')}<input required value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} /></label><label>{t('نوع الدفع', 'Payment type')}<input required value={form.payment_type} onChange={(e) => setForm({ ...form, payment_type: e.target.value })} /></label><label>{t('المحفظة الحالية', 'Current wallet')}<input required inputMode="numeric" value={form.source_wallet} onChange={(e) => setForm({ ...form, source_wallet: e.target.value })} /></label><label>{t('المحفظة التالية', 'Next wallet')}<input required inputMode="numeric" value={form.target_wallet} onChange={(e) => setForm({ ...form, target_wallet: e.target.value })} /></label><label>{t('التبديل عند إجمالي (EGP)', 'Switch at cumulative (EGP)')}<input required min="1" type="number" value={form.amount_threshold} onChange={(e) => setForm({ ...form, amount_threshold: e.target.value })} /></label></div><div className="form-actions"><button className="btn-ghost btn-sm" type="button" onClick={() => { setEditing(null); setCreateOpen(false) }}>{t('إلغاء', 'Cancel')}</button><button className="btn-primary btn-sm" type="submit" disabled={busy}>{busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ القاعدة', 'Save rule')}</button></div></form></div>}
  </div>
}
