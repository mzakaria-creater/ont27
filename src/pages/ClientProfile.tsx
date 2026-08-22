import { useCallback, useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import MethodLogo from '../components/MethodLogo'
import { api } from '../lib/api'
import { money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// One customer, everything we hold: profile, every wallet they have paid into,
// full deposit and payout history, and the SMS their number produced.
//
// Keyed on the phone number, not a crm_clients row. Someone can have no CRM
// record and still have a year of transactions, and that is exactly when this
// page gets opened.

interface Totals {
  tx_total: number; tx_paid: number; tx_declined: number; tx_pending: number
  volume_paid: number; first_seen: string | null; last_seen: string | null
}
interface WalletUse { wallet: string; uses: number; paid: number; volume: number; last_used: string | null }
interface Deposit {
  tx_id: number; ontarget_ref: string | null; amount: number | null; currency: string | null
  status: string | null; payment_method: string | null; merchant: string | null
  sub_merchant: string | null; to_account_number: string | null; sender_name: string | null
  approved_by: string | null; first_seen_at: string | null
}
interface Payout {
  maven_id: number; ontarget_ref: string | null; amount: number | null; status: string | null
  pay_by: string | null; merchant: string | null; account_name: string | null
  approved_by: string | null; first_seen_at: string | null
}
interface Sms {
  id: number; amount: number | null; sender_name: string | null; sender_number: string | null
  receiver_number: string | null; wallet_number: string | null; sms_category: string | null
  device_name: string | null; consumed_by_tx_id: number | null; created_at: string
}
interface Profile {
  phone: string | null
  profile: Record<string, unknown> | null
  blacklisted: boolean
  totals: Totals
  wallets: WalletUse[]
  deposits: Deposit[]
  payouts: Payout[]
  sms: Sms[]
  limit: number
}

type Tab = 'deposits' | 'payouts' | 'sms' | 'wallets'

export default function ClientProfile() {
  const { t } = useLocale()
  const { phone: routePhone } = useParams<{ phone: string }>()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState(routePhone ?? params.get('phone') ?? '')
  const [tab, setTab] = useState<Tab>('deposits')
  const [data, setData] = useState<Profile | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const phone = routePhone ?? params.get('phone') ?? ''

  const load = useCallback(() => {
    if (!phone) { setData(null); return }
    setBusy(true)
    api<Profile>(`/api/crm/profile/${encodeURIComponent(phone)}`)
      .then((d) => { setData(d); setErr(null) })
      .catch(() => setErr(t('تعذّر تحميل ملف العميل.', 'Could not load the client profile.')))
      .finally(() => setBusy(false))
  }, [phone, t])

  useEffect(() => { load() }, [load])

  const p = data?.profile as Record<string, string | number | boolean | null> | null
  const rate = data && data.totals.tx_paid + data.totals.tx_declined > 0
    ? (data.totals.tx_paid * 100) / (data.totals.tx_paid + data.totals.tx_declined)
    : null

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('ملف العميل', 'Client profile')}</h2>
        <p className="page-sub">
          {t(
            'كل ما نحمله عن رقم واحد: المحافظ التي دفع إليها، وسجل الإيداعات والسحوبات، والرسائل الصادرة عن رقمه.',
            'Everything held against one number: the wallets they pay into, deposit and payout history, and the SMS their number produced.',
          )}
        </p>
        <form
          className="search-row"
          onSubmit={(e) => { e.preventDefault(); const p2 = new URLSearchParams(params); p2.set('phone', query.trim()); setParams(p2) }}
        >
          <input
            className="login-input search-input"
            placeholder={t('رقم الهاتف — بأي صيغة', 'Phone number — any format')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn-primary btn-sm" disabled={busy}>{t('بحث', 'Look up')}</button>
        </form>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!phone && !err && <div className="card">{t('أدخل رقم هاتف للبحث.', 'Enter a phone number to look one up.')}</div>}
      {phone && busy && !data && <div className="card">{t('جارٍ التحميل…', 'Loading…')}</div>}

      {data && (
        <>
          {data.blacklisted && (
            <div className="card warn">
              <strong>{t('هذا الرقم في قائمة المخاطر التلقائية.', 'This number is on the automatic risk list.')}</strong>{' '}
              {t(
                'لن يُعتمد آلياً — كل معاملة منه تذهب لقرار بشري. لا يُرفض تلقائياً.',
                'It will not auto-approve — every transaction from it goes to a human. It is never auto-declined.',
              )}
            </div>
          )}

          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-value">{money(data.totals.volume_paid, 'EGP')}</div>
              <div className="kpi-label">{t('حجم معتمد', 'Approved volume')}</div>
              <div className="cell-sub">{data.totals.tx_paid} {t('من', 'of')} {data.totals.tx_total}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{rate == null ? '—' : `${rate.toFixed(1)}%`}</div>
              <div className="kpi-label">{t('نسبة الاعتماد', 'Approval rate')}</div>
              <div className="cell-sub">{data.totals.tx_declined} {t('مرفوضة', 'declined')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{data.wallets.length}</div>
              <div className="kpi-label">{t('محافظ استُخدمت', 'Wallets used')}</div>
              <div className="cell-sub">{t('محافظنا التي دفع إليها', 'our wallets they paid into')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value mono">{data.phone ?? '—'}</div>
              <div className="kpi-label">{p?.client_name ? String(p.client_name) : t('لا يوجد سجل CRM', 'no CRM record')}</div>
              <div className="cell-sub">
                {data.totals.first_seen ? new Date(data.totals.first_seen).toLocaleDateString() : '—'}
                {' → '}
                {data.totals.last_seen ? new Date(data.totals.last_seen).toLocaleDateString() : '—'}
              </div>
            </div>
          </div>

          <div className="filter-bar">
            {([
              ['deposits', t('الإيداعات', 'Deposits'), data.deposits.length],
              ['payouts', t('السحوبات', 'Payouts'), data.payouts.length],
              ['wallets', t('المحافظ', 'Wallets'), data.wallets.length],
              ['sms', t('الرسائل', 'SMS'), data.sms.length],
            ] as [Tab, string, number][]).map(([id, label, n]) => (
              <button key={id} className={tab === id ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setTab(id)}>
                {label} <span className="chip-count">{n}</span>
              </button>
            ))}
          </div>

          <section className="card recent-card">
            {tab === 'wallets' && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('المحفظة', 'Wallet')}</th>
                      <th>{t('مرات الاستخدام', 'Uses')}</th>
                      <th>{t('معتمدة', 'Paid')}</th>
                      <th>{t('الحجم', 'Volume')}</th>
                      <th>{t('آخر استخدام', 'Last used')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.wallets.map((w) => (
                      <tr key={w.wallet}>
                        <td className="mono">{w.wallet}</td>
                        <td className="mono">{w.uses}</td>
                        <td className="mono">{w.paid}</td>
                        <td className="mono">{money(w.volume, 'EGP')}</td>
                        <td className="mono">{w.last_used ? new Date(w.last_used).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'deposits' && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('المرجع', 'Ref')}</th>
                      <th>{t('المبلغ', 'Amount')}</th>
                      <th>{t('الحالة', 'Status')}</th>
                      <th>{t('الطريقة', 'Method')}</th>
                      <th>{t('المحفظة', 'Wallet')}</th>
                      <th>{t('التاجر', 'Merchant')}</th>
                      <th>{t('اعتمد بواسطة', 'Approved by')}</th>
                      <th>{t('الوقت', 'Time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.deposits.map((d) => (
                      <tr key={d.tx_id} className={d.status === 'PENDING' ? 'row-pending' : undefined}>
                        {/* The detail route resolves an ontarget_ref, so link
                            on that and fall back to tx_id only when the ref is
                            genuinely missing. */}
                        <td className="mono"><Link to={`/transactions/${d.ontarget_ref ?? d.tx_id}`}>{d.ontarget_ref ?? d.tx_id}</Link></td>
                        <td className="mono">{money(d.amount, d.currency ?? 'EGP')}</td>
                        <td><span className={`pay-status-badge ${statusMeta(d.status ?? '').cls}`}>{statusMeta(d.status ?? '').label}</span></td>
                        <td><span className="method-cell"><MethodLogo method={d.payment_method} /><span className="method-name">{d.payment_method ?? '—'}</span></span></td>
                        <td className="mono">{d.to_account_number ?? '—'}</td>
                        <td>{d.sub_merchant ?? d.merchant ?? '—'}</td>
                        <td>{d.approved_by ?? '—'}</td>
                        <td className="mono">{d.first_seen_at ? new Date(d.first_seen_at).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                    {data.deposits.length === 0 && <tr><td colSpan={8} className="cell-sub">{t('لا توجد إيداعات.', 'No deposits.')}</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'payouts' && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('المرجع', 'Ref')}</th>
                      <th>{t('المبلغ', 'Amount')}</th>
                      <th>{t('الحالة', 'Status')}</th>
                      <th>{t('الطريقة', 'Method')}</th>
                      <th>{t('الاسم', 'Name')}</th>
                      <th>{t('الوقت', 'Time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payouts.map((r) => (
                      <tr key={r.maven_id}>
                        <td className="mono">{r.ontarget_ref ?? r.maven_id}</td>
                        <td className="mono">{money(r.amount, 'EGP')}</td>
                        <td><span className={`pay-status-badge ${statusMeta(r.status ?? '').cls}`}>{statusMeta(r.status ?? '').label}</span></td>
                        <td>{r.pay_by ?? '—'}</td>
                        <td>{r.account_name ?? '—'}</td>
                        <td className="mono">{r.first_seen_at ? new Date(r.first_seen_at).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                    {data.payouts.length === 0 && <tr><td colSpan={6} className="cell-sub">{t('لا توجد سحوبات.', 'No payouts.')}</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'sms' && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('النوع', 'Type')}</th>
                      <th>{t('المبلغ', 'Amount')}</th>
                      <th>{t('محفظتنا', 'Our wallet')}</th>
                      <th>{t('الجهاز', 'Device')}</th>
                      <th>{t('مُطالَب بها', 'Claimed by')}</th>
                      <th>{t('الوقت', 'Time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sms.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.id}</td>
                        <td>{s.sms_category ?? '—'}</td>
                        <td className="mono">{money(s.amount, 'EGP')}</td>
                        <td className="mono">{s.wallet_number ?? '—'}</td>
                        <td>{s.device_name ?? '—'}</td>
                        <td className="mono">{s.consumed_by_tx_id ?? '—'}</td>
                        <td className="mono">{new Date(s.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                    {data.sms.length === 0 && <tr><td colSpan={7} className="cell-sub">{t('لا توجد رسائل من هذا الرقم.', 'No SMS from this number.')}</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            <p className="cell-sub">
              {t(
                `السجلات محدودة بآخر ${data.limit} صفاً لكل قسم. عدّاد المحافظ محسوب على كل المعاملات لا على المعروض.`,
                `History is capped at the most recent ${data.limit} rows per section. The wallet counts are computed over all transactions, not just what is shown.`,
              )}
            </p>
          </section>
        </>
      )}
    </PanelShell>
  )
}
