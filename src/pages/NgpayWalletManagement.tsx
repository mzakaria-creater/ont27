import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckSquare, Edit3, RefreshCw, Search, ShieldCheck, Smartphone, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

interface WalletRow {
  to_account_number: string
  device: string | null
  provider: string | null
  payment_type: string | null
  merchant: string | null
  sim_slot: number | null
  daily_limit: number | null
  updated_at: string | null
}

interface WalletResponse { wallets: WalletRow[] }

const NG_PAY_MERCHANT = 'NGPay-MelBet-Prod'

export default function NgpayWalletManagement() {
  const { t } = useLocale()
  const isMobile = useIsMobile()
  const [wallets, setWallets] = useState<WalletRow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [target, setTarget] = useState('01213841568')
  const [merge, setMerge] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const data = await api<WalletResponse>('/api/wallets')
      setWallets((data.wallets ?? []).filter((row) => row.merchant === NG_PAY_MERCHANT))
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية تعديل المحافظ.', 'You do not have wallet edit permission.') : t('تعذر تحميل محافظ NGPay.', 'Unable to load NGPay wallets.'))
    } finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return wallets.filter((row) => !needle || [row.to_account_number, row.device, row.provider, row.payment_type].some((value) => value?.toLowerCase().includes(needle)))
  }, [wallets, query])

  const allVisible = filtered.length > 0 && filtered.every((row) => selected.includes(row.to_account_number))
  const toggle = (number: string) => setSelected((current) => current.includes(number) ? current.filter((item) => item !== number) : [...current, number])
  const toggleVisible = () => setSelected((current) => allVisible ? current.filter((item) => !filtered.some((row) => row.to_account_number === item)) : [...new Set([...current, ...filtered.map((row) => row.to_account_number)])])

  const replaceSelected = async () => {
    const normalized = target.replace(/\D/g, '')
    if (!/^\d{8,20}$/.test(normalized) || selected.length === 0) return
    if (!window.confirm(t(`سيتم تغيير ${selected.length} محفظة NGPay إلى ${normalized}. لا يمكن دمج عدة أجهزة تحت نفس الرقم. هل تريد المتابعة؟`, `Change ${selected.length} NGPay wallet mapping(s) to ${normalized}? Multiple devices cannot share one wallet key.`))) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await api<{ updated?: WalletRow; merged?: { deleted_rows?: number; target?: string } }>('/api/wallets/ngpay/bulk-replace', { method: 'POST', body: JSON.stringify({ wallet_numbers: selected, new_wallet_number: normalized, merge }) })
      setNotice(merge ? t(`تم دمج ${result.merged?.deleted_rows ?? Math.max(0, selected.length - 1)} محافظ في ${result.merged?.target ?? normalized}.`, `Merged ${result.merged?.deleted_rows ?? Math.max(0, selected.length - 1)} wallet mapping(s) into ${result.merged?.target ?? normalized}.`) : t(`تم تغيير ${result.updated?.to_account_number ?? normalized}.`, `Updated ${result.updated?.to_account_number ?? normalized}.`))
      setSelected([]); await load()
    } catch (e) {
      const body = e instanceof ApiError ? e.body : null
      setError(body?.detail ? String(body.detail) : t('تعذر التغيير. عند تحديد عدة محافظ يلزم دمج صريح لأن رقم المحفظة مفتاح أساسي.', 'Replacement failed. Multiple selected wallets require an explicit merge because the wallet number is the primary key.'))
    } finally { setBusy(false) }
  }

  return <PanelShell>
    <section className="page-head">
      <div><h2><WalletCards size={25} /> {t('إدارة محافظ NGPay', 'NGPay wallet management')}</h2><p className="page-sub">{t('غيّر رقم الاستقبال مع معاينة وحماية من دمج الأجهزة أو فقدان سجل SMS.', 'Change receiving numbers with a guarded preview that protects device mappings and SMS history.')}</p></div>
      <button className="btn-ghost" type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> {t('تحديث', 'Refresh')}</button>
    </section>

    <div className="stat-grid">
      <div className="stat-card"><span className="stat-label"><WalletCards size={16} /> {t('محافظ NGPay', 'NGPay wallets')}</span><span className="stat-value">{wallets.length}</span><span className="stat-sub">{t('إعدادات التوجيه الحالية', 'Current routing mappings')}</span></div>
      <div className="stat-card"><span className="stat-label"><CheckSquare size={16} /> {t('محدد', 'Selected')}</span><span className="stat-value">{selected.length}</span><span className="stat-sub">{t('للتعديل', 'for replacement')}</span></div>
      <div className="stat-card"><span className="stat-label"><ShieldCheck size={16} /> {t('السجل التاريخي', 'Historical records')}</span><span className="stat-value">{t('محمي', 'Protected')}</span><span className="stat-sub">{t('لا يتم تعديل SMS أو المعاملات', 'SMS and transactions are not changed')}</span></div>
    </div>

    <section className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="filter-row" style={{ alignItems: 'end' }}>
        <label className="field" style={{ flex: 1, minWidth: 220 }}><span><Search size={14} /> {t('بحث', 'Search')}</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('رقم أو جهاز أو مزود', 'Number, device, or provider')} /></label>
        <label className="field" style={{ flex: 1, minWidth: 220 }}><span><Edit3 size={14} /> {t('الرقم الجديد', 'New wallet number')}</span><input className="mono" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="01213841568" /></label>
        <button className="btn-primary" type="button" disabled={busy || selected.length === 0 || !/^\d{8,20}$/.test(target.replace(/\D/g, ''))} onClick={() => void replaceSelected()}>{busy ? t('جارٍ الحفظ…', 'Saving…') : merge ? t('دمج المحدد', 'Merge selected') : t('تطبيق على المحدد', 'Apply to selected')}</button>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, fontSize: 13 }}><input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> {t('دمج المحافظ المحددة في رقم واحد (يسجل الأجهزة القديمة في السجل)', 'Merge selected wallets into one number (archives old device mappings)')}</label>
      <div className="page-sub" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}><AlertTriangle size={15} /> {t('إذا كانت عدة صفوف ستصبح نفس الرقم، ستتوقف العملية لحماية مفاتيح الأجهزة. استخدم تعديل كل صف أو اطلب دمجًا صريحًا.', 'If several rows would become the same number, the operation stops to protect device keys. Edit rows individually or request an explicit merge.')}</div>
    </section>

    {error && <div className="card warn" style={{ marginBottom: 16 }}>{error}</div>}
    {notice && <div className="card success" style={{ marginBottom: 16 }}>{notice}</div>}

    <section className="card">
      <div className="recent-head"><div><h3>{t('محافظ NGPay الحالية', 'Current NGPay wallets')}</h3><p className="cell-sub">{selected.length} {t('محدد', 'selected')} · {NG_PAY_MERCHANT}</p></div><label className="maven-select-all"><input type="checkbox" checked={allVisible} onChange={toggleVisible} /> {t('تحديد الظاهر', 'Select visible')}</label></div>
      {loading && <p className="maven-empty">{t('جارٍ التحميل…', 'Loading…')}</p>}
      {!loading && filtered.length === 0 && <p className="maven-empty">{t('لا توجد محافظ NGPay مطابقة.', 'No matching NGPay wallets.')}</p>}
      {!loading && filtered.length > 0 && (isMobile ? (
        <div className="risk-card-list">
          {filtered.map((row) => (
            <label key={`${row.to_account_number}-${row.device ?? ''}-${row.sim_slot ?? 0}`} className="risk-row-card">
              <div className="risk-row-card-head">
                <span><input type="checkbox" checked={selected.includes(row.to_account_number)} onChange={() => toggle(row.to_account_number)} aria-label={t(`تحديد ${row.to_account_number}`, `Select ${row.to_account_number}`)} /> <strong className="mono">{row.to_account_number}</strong></span>
                <span className="mono">{row.daily_limit == null ? '60,000' : row.daily_limit.toLocaleString()}</span>
              </div>
              <div className="cell-sub">{row.device ?? '—'}{row.sim_slot != null && ` · SIM ${row.sim_slot}`} · {row.provider ?? row.payment_type ?? '—'}</div>
              <div className="risk-row-card-foot"><span className="mono muted">{row.updated_at ? new Date(row.updated_at).toLocaleString('en-GB') : '—'}</span></div>
            </label>
          ))}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table"><thead><tr><th></th><th>{t('الرقم الحالي', 'Current number')}</th><th>{t('الجهاز / SIM', 'Device / SIM')}</th><th>{t('المزود', 'Provider')}</th><th>{t('الحد اليومي', 'Daily limit')}</th><th>{t('آخر تحديث', 'Last update')}</th></tr></thead><tbody>
        {filtered.map((row) => <tr key={`${row.to_account_number}-${row.device ?? ''}-${row.sim_slot ?? 0}`}><td><input type="checkbox" checked={selected.includes(row.to_account_number)} onChange={() => toggle(row.to_account_number)} aria-label={t(`تحديد ${row.to_account_number}`, `Select ${row.to_account_number}`)} /></td><td className="mono"><strong>{row.to_account_number}</strong></td><td><strong>{row.device ?? '—'}</strong><div className="cell-sub">{row.sim_slot == null ? '—' : `SIM ${row.sim_slot}`}</div></td><td>{row.provider ?? row.payment_type ?? '—'}</td><td className="mono">{row.daily_limit == null ? '60,000' : row.daily_limit.toLocaleString()}</td><td className="cell-sub mono">{row.updated_at ? new Date(row.updated_at).toLocaleString('en-GB') : '—'}</td></tr>)}
      </tbody></table></div>
      ))}
    </section>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }} className="page-sub"><Smartphone size={15} /> {t('هذه الصفحة تعدّل إعدادات التوجيه المحلية فقط؛ لا تعيد كتابة أرقام المعاملات أو SMS القديمة.', 'This page changes local routing configuration only; it never rewrites historical transactions or SMS.')}</div>
  </PanelShell>
}
