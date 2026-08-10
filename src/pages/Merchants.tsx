import { useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

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
  provider: string | null
  status: string | null
  country_code: string | null
  base_currency: string | null
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
  const [rows, setRows] = useState<MerchantRow[] | null>(null)
  const [masters, setMasters] = useState<MasterRow[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<MerchantRow | null>(null)

  useEffect(() => {
    api<{ rows: MerchantRow[]; masters: MasterRow[] }>('/api/merchants')
      .then((res) => { setRows(res.rows); setMasters(res.masters) })
      .catch((e) => {
        setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التجار.', 'You do not have permission to view merchants.') : t('تعذّر تحميل التجار.', 'Failed to load merchants.'))
      })
  }, [])

  const masterName = useMemo(() => {
    const map = new Map(masters.map((m) => [m.id, m.name ?? m.code ?? m.id]))
    return (id: string | null) => (id ? map.get(id) ?? id : null)
  }, [masters])

  const filtered = useMemo(() => {
    if (!rows) return null
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((m) =>
      [m.name, m.code, m.MID, m.email, m.phone, m.country, masterName(m.master_merchant_id)]
        .some((v) => v?.toLowerCase().includes(needle)),
    )
  }, [rows, q, masterName])

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🏬 {t('التجار', 'Merchants')}</h2>
        <p className="page-sub">
          {rows && <>{rows.length.toLocaleString('en-US')} {t('تاجر', 'merchants')} · {masters.length} {t('تاجر رئيسي', 'master merchants')}</>}
        </p>
      </section>

      <div className="filter-bar">
        <form className="search-row" onSubmit={(e) => e.preventDefault()}>
          <input
            className="login-input search-input"
            placeholder={t('بحث: اسم / كود / MID / بريد / دولة…', 'Search: name / code / MID / email / country…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {filtered && filtered.length === 0 && <p>{t('لا توجد نتائج مطابقة.', 'No matching results.')}</p>}
        {filtered && filtered.length > 0 && (
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
        )}
      </section>

      {selected && (
        <div className="drawer-backdrop" onClick={() => setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>{selected.name ?? selected.code ?? '—'}</h3>
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
