import { useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'

// Risk & compliance — blacklist, suspicious SMS, clients flagged for review.

interface BlacklistRow { id: string; merchant_id: string | null; type: string | null; value: string | null; reason: string | null; created_at: string | null }
interface RiskSms { id: number; received_at: string | null; device_name: string | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; amount: number | null; risk_score: number | null; risk_reason: string | null; suspicious: boolean | null; is_duplicate: boolean | null; sms_category: string | null }
interface RiskClient { id: string; client_name: string | null; phone_no: string | null; merchant_name: string | null; risk_score: number | null; approval_rate: number | null; total_transactions: number | null }

export default function Risk() {
  const [data, setData] = useState<{ blacklist: BlacklistRow[]; sms: RiskSms[]; clients: RiskClient[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api<{ blacklist: BlacklistRow[]; sms: RiskSms[]; clients: RiskClient[] }>('/api/risk')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض المخاطر.' : 'تعذّر تحميل بيانات المخاطر.'))
  }, [])

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
