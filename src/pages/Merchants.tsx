import { useEffect, useMemo, useState } from 'react'
import { Building2, CheckCircle2, Download, Layers, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MultiSelectFilter from '../components/MultiSelectFilter'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { exportCsv } from '../lib/exportTable'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

// Merchants directory (view). The API never returns api_key/secret_key/
// callback_secret — key management stays a separate super_admin flow.

interface MerchantRow {
  id: string
  name: string | null
  code: string | null
  MID: string | null
  status: string | null
  is_active: boolean | null
  active: boolean | null
  kyc_status: string | null
  email: string | null
  phone: string | null
  business_type: string | null
  country: string | null
  country_code: string | null
  base_currency: string | null
  website: string | null
  business_address: string | null
  primary_contact_name: string | null
  registration_id: string | null
  blocked_amount: number | null
  callback_url: string | null
  master_merchant_id: string | null
  operator_id: string | null
  key_rotated_at: string | null
  created_at: string | null
  updated_at: string | null
}

interface MasterRow {
  id: string
  name: string | null
  code: string | null
}

interface HierarchyRow {
  id: number
  master_merchant_id: string | null
  name: string | null
  mid: string | null
  active: boolean | null
  created_at: string | null
}

const KYC_META: Record<string, { ar: string; en: string; cls: string }> = {
  approved: { ar: 'موثّق', en: 'Verified', cls: 'st-paid' },
  verified: { ar: 'موثّق', en: 'Verified', cls: 'st-paid' },
  pending: { ar: 'قيد التوثيق', en: 'Pending', cls: 'st-pending' },
  rejected: { ar: 'مرفوض', en: 'Rejected', cls: 'st-declined' },
}

function isLive(m: MerchantRow): boolean {
  return (m.is_active ?? m.active ?? false) === true
}

export default function Merchants() {
  const { t } = useLocale()
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<MerchantRow[] | null>(null)
  const [masters, setMasters] = useState<MasterRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all')
  const [masterFilter, setMasterFilter] = useState<string[]>([])
  const [kycFilter, setKycFilter] = useState<string[]>([])
  const [selected, setSelected] = useState<MerchantRow | null>(null)

  const load = () => {
    setLoading(true); setErr(null)
    api<{ rows: MerchantRow[]; masters: MasterRow[]; hierarchy?: HierarchyRow[] }>('/api/merchants')
      .then((res) => {
        const hierarchyRows: MerchantRow[] = (res.hierarchy ?? []).map((row) => ({
          id: `hierarchy-${row.id}`,
          name: row.name,
          code: null,
          MID: row.mid,
          status: row.active === false ? 'inactive' : 'active',
          is_active: row.active !== false,
          active: row.active !== false,
          kyc_status: null,
          email: null,
          phone: null,
          business_type: 'Sub-merchant',
          country: null,
          country_code: null,
          base_currency: null,
          website: null,
          business_address: null,
          primary_contact_name: null,
          registration_id: null,
          blocked_amount: 0,
          callback_url: null,
          master_merchant_id: row.master_merchant_id,
          operator_id: null,
          key_rotated_at: null,
          created_at: row.created_at,
          updated_at: null,
        }))
        setRows([...res.rows, ...hierarchyRows])
        setMasters(res.masters)
      })
      .catch((e) => {
        setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التجار.', 'You do not have permission to view merchants.') : t('تعذّر تحميل التجار.', 'Failed to load merchants.'))
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const masterName = useMemo(() => {
    const map = new Map(masters.map((m) => [m.id, m.name ?? m.code ?? m.id]))
    return (id: string | null) => (id ? map.get(id) ?? id : null)
  }, [masters])

  const kycOptions = useMemo(() => {
    const set = new Set<string>()
    for (const m of rows ?? []) if (m.kyc_status) set.add(m.kyc_status.toLowerCase())
    return [...set].sort()
  }, [rows])

  const filtered = useMemo(() => {
    if (!rows) return null
    const needle = q.trim().toLowerCase()
    return rows.filter((m) => {
      if (statusFilter === 'active' && !isLive(m)) return false
      if (statusFilter === 'disabled' && isLive(m)) return false
      if (masterFilter.length && !masterFilter.includes(masterName(m.master_merchant_id) ?? '')) return false
      if (kycFilter.length && !kycFilter.includes((m.kyc_status ?? '').toLowerCase())) return false
      if (!needle) return true
      return [m.name, m.code, m.MID, m.email, m.phone, m.country, masterName(m.master_merchant_id)]
        .some((v) => v?.toLowerCase().includes(needle))
    })
  }, [rows, q, statusFilter, masterFilter, kycFilter, masterName])

  const totals = useMemo(() => {
    const list = rows ?? []
    return {
      total: list.length,
      active: list.filter(isLive).length,
      disabled: list.filter((m) => !isLive(m)).length,
      blocked: list.filter((m) => Number(m.blocked_amount) > 0).length,
    }
  }, [rows])

  const exportRows = () => exportCsv(filtered ?? [], [
    { header: 'Merchant', key: 'name', value: (r) => r.name ?? '' },
    { header: 'Code', key: 'code', value: (r) => r.code ?? '' },
    { header: 'MID', key: 'mid', value: (r) => r.MID ?? '' },
    { header: 'Master merchant', key: 'master', value: (r) => masterName(r.master_merchant_id) ?? '' },
    { header: 'Country', key: 'country', value: (r) => r.country_code ?? r.country ?? '' },
    { header: 'Currency', key: 'currency', value: (r) => r.base_currency ?? '' },
    { header: 'KYC', key: 'kyc', value: (r) => r.kyc_status ?? '' },
    { header: 'Status', key: 'status', value: (r) => isLive(r) ? 'Active' : 'Disabled' },
    { header: 'Blocked amount', key: 'blocked', value: (r) => r.blocked_amount ?? 0 },
  ], 'merchants')

  return (
    <PanelShell>
      <section className="page-head admin-head">
        <span className="admin-head-icon"><Building2 size={20} /></span>
        <div className="admin-head-text">
          <span className="admin-head-eyebrow">{t('دليل التجار', 'Merchant directory')}</span>
          <h2>{t('التجار', 'Merchants')}</h2>
          <p className="page-sub">{rows && <>{totals.total.toLocaleString('en-US')} {t('تاجر', 'merchants')} · {masters.length} {t('تاجر رئيسي', 'master merchants')}</>}</p>
        </div>
        <div className="admin-head-actions">
          <button className="btn-ghost btn-sm" onClick={exportRows} disabled={loading || !filtered?.length}><Download size={15}/> CSV</button>
          <button className="btn-ghost btn-sm" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      <div className="kpi-grid">
        <div className="kpi-card"><Layers className="kpi-icon"/><div className="kpi-value">{totals.total.toLocaleString()}</div><div className="kpi-label">{t('إجمالي التجار', 'Total merchants')}</div></div>
        <div className="kpi-card"><CheckCircle2 className="kpi-icon"/><div className="kpi-value">{totals.active.toLocaleString()}</div><div className="kpi-label">{t('نشط', 'Active')}</div></div>
        <div className="kpi-card"><XCircle className="kpi-icon"/><div className="kpi-value">{totals.disabled.toLocaleString()}</div><div className="kpi-label">{t('موقوف', 'Disabled')}</div></div>
        <div className="kpi-card"><ShieldAlert className="kpi-icon"/><div className="kpi-value">{totals.blocked.toLocaleString()}</div><div className="kpi-label">{t('لديه مبالغ محجوزة', 'With blocked funds')}</div></div>
      </div>

      <div className="filter-bar">
        <form className="search-row" onSubmit={(e) => e.preventDefault()}>
          <input
            className="login-input search-input"
            placeholder={t('بحث: اسم / كود / MID / بريد / دولة…', 'Search: name / code / MID / email / country…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
        <div className="admin-tabs">
          <button type="button" className={`pill${statusFilter === 'all' ? ' active' : ''}`} onClick={() => setStatusFilter('all')}>{t('الكل', 'All')}</button>
          <button type="button" className={`pill${statusFilter === 'active' ? ' active' : ''}`} onClick={() => setStatusFilter('active')}>{t('نشط', 'Active')}</button>
          <button type="button" className={`pill${statusFilter === 'disabled' ? ' active' : ''}`} onClick={() => setStatusFilter('disabled')}>{t('موقوف', 'Disabled')}</button>
        </div>
        <MultiSelectFilter label={t('التاجر الرئيسي', 'Master merchant')} allLabel={t('الكل', 'All')} options={masters.map((m) => ({ value: m.name ?? m.code ?? m.id, label: m.name ?? m.code ?? m.id }))} value={masterFilter} onChange={setMasterFilter}/>
        {kycOptions.length > 0 && <MultiSelectFilter label="KYC" allLabel={t('الكل', 'All')} options={kycOptions.map((v) => ({ value: v, label: KYC_META[v] ? t(KYC_META[v].ar, KYC_META[v].en) : v }))} value={kycFilter} onChange={setKycFilter}/>}
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {filtered && filtered.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
        {filtered && filtered.length > 0 && (isMobile ? (
          <div className="merchant-card-list">
            {filtered.map((m) => {
              const kyc = m.kyc_status ? KYC_META[m.kyc_status.toLowerCase()] : null
              return (
                <button key={m.id} type="button" className="merchant-row-card" onClick={() => setSelected(m)}>
                  <div className="merchant-row-card-head">
                    <span>{m.name ?? '—'}{m.code && <span className="mono cell-sub"> · {m.code}</span>}</span>
                    <span className={`pay-status-badge ${isLive(m) ? 'st-paid' : 'st-dim'}`}>{isLive(m) ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</span>
                  </div>
                  <div className="cell-sub">MID <span className="mono">{m.MID ?? '—'}</span> · {masterName(m.master_merchant_id) ?? '—'}</div>
                  <div className="merchant-row-card-foot">
                    <span className="mono">{m.country_code ?? m.country ?? '—'} · {m.base_currency ?? '—'}</span>
                    {kyc ? <span className={`pay-status-badge ${kyc.cls}`}>{t(kyc.ar, kyc.en)}</span> : <span className="mono">{m.kyc_status ?? '—'}</span>}
                    <span className="mono">{money(m.blocked_amount, m.base_currency)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>MID</th>
                  <th>{t('التاجر الرئيسي', 'Master merchant')}</th>
                  <th>{t('الدولة / العملة', 'Country / currency')}</th>
                  <th>KYC</th>
                  <th>{t('الحالة', 'Status')}</th>
                  <th>{t('مبالغ محجوزة', 'Blocked amount')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => {
                  const kyc = m.kyc_status ? KYC_META[m.kyc_status.toLowerCase()] : null
                  return (
                    <tr key={m.id} onClick={() => setSelected(m)}>
                      <td>
                        {m.name ?? '—'}
                        {m.code && <div className="cell-sub mono">{m.code}</div>}
                      </td>
                      <td className="mono">{m.MID ?? '—'}</td>
                      <td>{masterName(m.master_merchant_id) ?? '—'}</td>
                      <td className="mono">{m.country_code ?? m.country ?? '—'} · {m.base_currency ?? '—'}</td>
                      <td>
                        {kyc
                          ? <span className={`pay-status-badge ${kyc.cls}`}>{t(kyc.ar, kyc.en)}</span>
                          : <span className="mono">{m.kyc_status ?? '—'}</span>}
                      </td>
                      <td>
                        <span className={`pay-status-badge ${isLive(m) ? 'st-paid' : 'st-dim'}`}>
                          {isLive(m) ? t('نشط', 'Active') : t('موقوف', 'Disabled')}
                        </span>
                      </td>
                      <td className="mono">{money(m.blocked_amount, m.base_currency)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {selected && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3><Building2 size={16}/> {selected.name ?? selected.code ?? '—'}</h3>
              <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
            </div>

            <dl className="detail-grid">
              <dt>{t('الكود', 'Code')}</dt><dd className="mono">{selected.code ?? '—'}</dd>
              <dt>MID</dt><dd className="mono">{selected.MID ?? '—'}</dd>
              <dt>{t('الحالة', 'Status')}</dt><dd>{isLive(selected) ? t('نشط', 'Active') : t('موقوف', 'Disabled')}{selected.status && <> · <span className="mono">{selected.status}</span></>}</dd>
              <dt>KYC</dt><dd className="mono">{selected.kyc_status ?? '—'}</dd>
              <dt>{t('التاجر الرئيسي', 'Master merchant')}</dt><dd>{masterName(selected.master_merchant_id) ?? '—'}</dd>
              <dt>{t('النشاط', 'Business type')}</dt><dd>{selected.business_type ?? '—'}</dd>
              <dt>{t('جهة الاتصال', 'Contact')}</dt><dd>{selected.primary_contact_name ?? '—'}</dd>
              <dt>{t('البريد', 'Email')}</dt><dd className="mono small">{selected.email ?? '—'}</dd>
              <dt>{t('الهاتف', 'Phone')}</dt><dd className="mono">{selected.phone ?? '—'}</dd>
              <dt>{t('الدولة', 'Country')}</dt><dd>{selected.country ?? selected.country_code ?? '—'}</dd>
              <dt>{t('العملة', 'Currency')}</dt><dd className="mono">{selected.base_currency ?? '—'}</dd>
              <dt>{t('الموقع', 'Website')}</dt><dd className="mono small">{selected.website ?? '—'}</dd>
              <dt>{t('السجل التجاري', 'Registration ID')}</dt><dd className="mono">{selected.registration_id ?? '—'}</dd>
              <dt>{t('العنوان', 'Address')}</dt><dd>{selected.business_address ?? '—'}</dd>
              <dt>Callback URL</dt><dd className="mono small">{selected.callback_url ?? '—'}</dd>
              <dt>{t('مبالغ محجوزة', 'Blocked amount')}</dt><dd className="mono">{money(selected.blocked_amount, selected.base_currency)}</dd>
              <dt>{t('آخر تدوير مفاتيح', 'Last key rotation')}</dt><dd className="mono">{selected.key_rotated_at?.slice(0, 10) ?? '—'}</dd>
            </dl>

            <p className="drawer-note">
              {t('مفاتيح الـ API والأسرار لا تُعرض في اللوحة — إدارتها تتم من تدفق منفصل لدور', 'API keys and secrets are never shown in the panel — managed via a separate flow for the')}
              <span className="mono"> super_admin</span>{t(' فقط.', ' role.')}
            </p>
          </aside>
        </div>
      )}
    </PanelShell>
  )
}
