import { useCallback, useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'

// Risk & compliance — blacklist, suspicious SMS, clients flagged for review,
// and sender-number velocity/fraud detection.

interface BlacklistRow { id: string; merchant_id: string | null; type: string | null; value: string | null; reason: string | null; created_at: string | null }
interface RiskSms { id: number; received_at: string | null; device_name: string | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; amount: number | null; risk_score: number | null; risk_reason: string | null; suspicious: boolean | null; is_duplicate: boolean | null; sms_category: string | null }
interface RiskClient { id: string; client_name: string | null; phone_no: string | null; merchant_name: string | null; risk_score: number | null; approval_rate: number | null; total_transactions: number | null }
interface Offender { sender_number: string; sender_names: string[] | null; merchant: string | null; txns: number; declined: number; approved: number; decline_rate: number | null; total_amount: number | null; distinct_names: number; first_seen: string | null; last_seen: string | null; blacklisted: boolean }

export default function Risk() {
  const { can } = useAuth()
  const [data, setData] = useState<{ blacklist: BlacklistRow[]; sms: RiskSms[]; clients: RiskClient[] } | null>(null)
  const [vel, setVel] = useState<{ offenders: Offender[]; min_txns: number; window_days: number } | null>(null)
  const [minTxns, setMinTxns] = useState(20); const [windowDays, setWindowDays] = useState(30)
  const [err, setErr] = useState<string | null>(null)
  const canEdit = can('risk', 'can_edit')

  const loadRisk = useCallback(() => {
    api<{ blacklist: BlacklistRow[]; sms: RiskSms[]; clients: RiskClient[] }>('/api/risk')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض المخاطر.' : 'تعذّر تحميل بيانات المخاطر.'))
  }, [])
  const loadVelocity = useCallback(() => {
    api<{ offenders: Offender[]; min_txns: number; window_days: number }>(`/api/risk/velocity?min_txns=${minTxns}&window_days=${windowDays}`)
      .then(setVel).catch(() => setVel(null))
  }, [minTxns, windowDays])
  useEffect(() => { loadRisk() }, [loadRisk])
  useEffect(() => { loadVelocity() }, [loadVelocity])

  const blacklistNumber = async (o: Offender) => {
    try {
      await api('/api/risk/blacklist', { method: 'POST', body: JSON.stringify({ value: o.sender_number, type: 'phone', reason: `Velocity: ${o.txns} txns / ${o.decline_rate}% declined` }) })
      loadVelocity(); loadRisk()
    } catch { setErr('تعذّر الإضافة للقائمة السوداء.') }
  }

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🛡️ المخاطر والامتثال</h2>
        <p className="page-sub">
          {data && <>{data.blacklist.length} في القائمة السوداء · {data.sms.length} رسالة مشبوهة · {data.clients.length} عميل يحتاج مراجعة</>}
        </p>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}

      <section className="card recent-card">
        <div className="recent-head"><h3>🚀 كثافة المُرسِلين (Velocity / كشف الاحتيال)</h3>
          <span className="cell-sub">أرقام أرسلت معاملات كثيرة خلال النافذة، مرتبة حسب نسبة الرفض</span>
        </div>
        <div className="filter-bar">
          <label className="filter-field">حد أدنى للمعاملات <input className="login-input" type="number" min={2} max={500} value={minTxns} onChange={(e) => setMinTxns(Number(e.target.value) || 20)} /></label>
          <label className="filter-field">النافذة (يوم) <input className="login-input" type="number" min={1} max={365} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 30)} /></label>
        </div>
        {!vel && <p className="sidebar-hint">جارٍ الحساب…</p>}
        {vel && vel.offenders.length === 0 && <p>لا يوجد أرقام تتجاوز الحد في هذه النافذة.</p>}
        {vel && vel.offenders.length > 0 && (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>الرقم</th><th>الأسماء</th><th>المزوّد</th><th>المعاملات</th><th>رفض %</th><th>الإجمالي</th><th>القائمة السوداء</th></tr></thead>
            <tbody>{vel.offenders.map((o) => {
              const hot = (o.decline_rate ?? 0) >= 70 || o.distinct_names > 1
              return <tr key={o.sender_number}>
                <td className="mono">{o.sender_number}</td>
                <td>{(o.sender_names ?? []).join('، ') || '—'}{o.distinct_names > 1 && <span className="pay-status-badge st-pending"> {o.distinct_names} أسماء</span>}</td>
                <td>{o.merchant ?? '—'}</td>
                <td className="mono">{o.txns} <span className="cell-sub">({o.declined} رفض)</span></td>
                <td><span className={`pay-status-badge ${hot ? 'st-declined' : 'st-dim'}`}>{o.decline_rate ?? 0}%</span></td>
                <td className="mono">{money(o.total_amount, 'EGP')}</td>
                <td>{o.blacklisted ? <span className="pay-status-badge st-declined">محظور</span> : (canEdit ? <button className="btn-ghost btn-sm" onClick={() => void blacklistNumber(o)}>حظر</button> : '—')}</td>
              </tr>
            })}</tbody>
          </table></div>
        )}
      </section>

      {data && (
        <>
          <section className="card recent-card">
            <div className="recent-head"><h3>🚫 القائمة السوداء</h3></div>
            {data.blacklist.length === 0 && <p>القائمة فارغة.</p>}
            {data.blacklist.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>النوع</th><th>القيمة</th><th>السبب</th><th>أضيفت</th></tr></thead>
                  <tbody>
                    {data.blacklist.map((r) => (
                      <tr key={r.id}>
                        <td><span className="pay-status-badge st-declined">{r.type ?? '—'}</span></td>
                        <td className="mono">{r.value ?? '—'}</td>
                        <td>{r.reason ?? '—'}</td>
                        <td className="mono">{depositTime({ first_seen_at: r.created_at })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card recent-card">
            <div className="recent-head"><h3>⚠️ رسائل SMS مشبوهة / مكررة</h3></div>
            {data.sms.length === 0 && <p>لا توجد رسائل مشبوهة.</p>}
            {data.sms.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>#</th><th>المُرسِل ← المحفظة</th><th>المبلغ</th><th>السبب</th><th>الجهاز</th><th>الوقت</th></tr></thead>
                  <tbody>
                    {data.sms.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.id}</td>
                        <td>{r.sender_name ?? r.sender_number ?? '—'}<div className="cell-sub mono">← {r.receiver_number ?? '—'}</div></td>
                        <td className="mono">{money(r.amount, 'EGP')}</td>
                        <td>
                          {r.is_duplicate && <span className="pay-status-badge st-pending">مكررة</span>}{' '}
                          {r.suspicious && <span className="pay-status-badge st-declined">مشبوهة</span>}
                          {r.risk_reason && <div className="cell-sub">{r.risk_reason}</div>}
                        </td>
                        <td className="mono">{r.device_name ?? '—'}</td>
                        <td className="mono">{depositTime({ first_seen_at: r.received_at })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card recent-card">
            <div className="recent-head"><h3>👥 عملاء بحاجة لمراجعة</h3></div>
            {data.clients.length === 0 && <p>لا يوجد عملاء بانتظار المراجعة.</p>}
            {data.clients.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>العميل</th><th>التاجر</th><th>المعاملات</th><th>نسبة القبول</th><th>درجة الخطورة</th></tr></thead>
                  <tbody>
                    {data.clients.map((r) => (
                      <tr key={r.id}>
                        <td>{r.client_name ?? '—'}<div className="cell-sub mono">{r.phone_no ?? '—'}</div></td>
                        <td>{r.merchant_name ?? '—'}</td>
                        <td className="mono">{r.total_transactions ?? 0}</td>
                        <td className="mono">{r.approval_rate != null ? `${Math.round(Number(r.approval_rate))}%` : '—'}</td>
                        <td className="mono">{r.risk_score ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </PanelShell>
  )
}
