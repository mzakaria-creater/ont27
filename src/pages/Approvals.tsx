import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useBulk } from '../lib/useBulk'

// Approvals queue — every PENDING deposit and payout in one screen with
// quick + bulk actions.

interface DepRow {
  tx_id: number
  ontarget_ref: string | null
  merchant_tx_reference: string | null
  status: string
  amount: number | null
  currency: string | null
  sender_name: string | null
  sender_number: string | null
  payment_method: string | null
  merchant: string | null
  master_merchant: string | null
  first_seen_at: string | null
  created_utc: string | null
}

interface PayRow {
  maven_id: number
  ontarget_ref: string | null
  status: string
  amount: number | null
  pay_by: string | null
  merchant: string | null
  account_name: string | null
  mobile_no: string | null
  first_seen_at: string | null
  created_utc: string | null
}

export default function Approvals() {
  const { can } = useAuth()
  const [deposits, setDeposits] = useState<DepRow[] | null>(null)
  const [payouts, setPayouts] = useState<PayRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [rowBusy, setRowBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api<{ deposits: DepRow[]; payouts: PayRow[] }>('/api/approvals')
      setDeposits(res.deposits)
      setPayouts(res.payouts)
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض طابور الموافقات.' : 'تعذّر تحميل الطابور.')
    }
  }, [])

  useEffect(() => {
    void load()
    const iv = setInterval(() => void load(), 30_000)
    return () => clearInterval(iv)
  }, [load])

  const depBulk = useBulk((id) => `/api/deposits/${id}/decision`, () => void load())
  const payBulk = useBulk((id) => `/api/payouts/${id}/decision`, () => void load())

  const quick = async (kind: 'deposits' | 'payouts', id: number, action: 'approve' | 'decline') => {
    setRowBusy(`${kind}-${id}`)
    try {
      await api(`/api/${kind}/${id}/decision`, { method: 'POST', body: JSON.stringify({ action }) })
      void load()
    } catch {
      setErr('فشل تنفيذ القرار — أعد المحاولة.')
    } finally {
      setRowBusy(null)
    }
  }

  const canDep = can('deposits', 'can_approve')
  const canPay = can('payouts', 'can_approve')

  return (
    <PanelShell>
      <section className="page-head">
        <h2>✅ طابور الموافقات</h2>
        <p className="page-sub">
          كل المعلّق في مكان واحد · تحديث تلقائي كل 30 ثانية
          {deposits && payouts && <> · {deposits.length + payouts.length} بانتظار قرار</>}
        </p>
      </section>

      {err && <div className="card warn">{err}</div>}

      {/* deposits */}
      <section className="card recent-card">
        <div className="recent-head">
          <h3>💰 إيداعات معلّقة {deposits && <span className="mono">({deposits.length})</span>}</h3>
          <Link to="/deposits?status=PENDING" className="pay-status-link">فتح صفحة الإيداعات ←</Link>
        </div>
        {depBulk.progress && <div className="card bulk-progress">{depBulk.progress}</div>}
        {depBulk.selected.size > 0 && canDep && (
          <div className="bulk-bar">
            <span>{depBulk.selected.size} محدد</span>
            <button className="btn-primary btn-sm" disabled={depBulk.busy} onClick={() => void depBulk.run('approve')}>✅ اعتماد الكل</button>
            <button className="btn-ghost danger btn-sm" disabled={depBulk.busy} onClick={() => void depBulk.run('decline')}>❌ رفض الكل</button>
          </div>
        )}
        {!deposits && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {deposits && deposits.length === 0 && <p>لا توجد إيداعات معلّقة 🎉</p>}
        {deposits && deposits.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {canDep && (
                    <th className="check-col">
                      <input
                        type="checkbox"
                        checked={deposits.length > 0 && deposits.every((r) => depBulk.selected.has(r.tx_id))}
                        onChange={() => depBulk.toggleAll(deposits.map((r) => r.tx_id))}
                      />
                    </th>
                  )}
                  <th>رقم العملية</th>
                  <th>المبلغ</th>
                  <th>المُرسِل</th>
                  <th>الطريقة</th>
                  <th>التاجر</th>
                  <th>الوقت</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((r) => (
                  <tr key={r.tx_id} className="row-pending">
                    {canDep && (
                      <td className="check-col">
                        <input type="checkbox" checked={depBulk.selected.has(r.tx_id)} onChange={() => depBulk.toggle(r.tx_id)} />
                      </td>
                    )}
                    <td className="mono">
                      {r.ontarget_ref ?? r.tx_id}
                      {r.merchant_tx_reference && <div className="cell-sub mono">{r.merchant_tx_reference}</div>}
                    </td>
                    <td className="mono">{money(r.amount, r.currency)}</td>
                    <td>{r.sender_name ?? '—'}{r.sender_number && <div className="cell-sub mono">{r.sender_number}</div>}</td>
                    <td>{r.payment_method ?? '—'}</td>
                    <td>{r.merchant ?? '—'}</td>
                    <td className="mono">{depositTime(r)}</td>
                    <td>
                      {canDep && (
                        <div className="row-actions">
                          <button className="btn-primary btn-sm" disabled={rowBusy === `deposits-${r.tx_id}`} onClick={() => void quick('deposits', r.tx_id, 'approve')}>✅</button>
                          <button className="btn-ghost danger btn-sm" disabled={rowBusy === `deposits-${r.tx_id}`} onClick={() => void quick('deposits', r.tx_id, 'decline')}>❌</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* payouts */}
      <section className="card recent-card">
        <div className="recent-head">
          <h3>📤 سحوبات معلّقة {payouts && <span className="mono">({payouts.length})</span>}</h3>
          <Link to="/payouts?status=PENDING" className="pay-status-link">فتح صفحة السحوبات ←</Link>
        </div>
        {payBulk.progress && <div className="card bulk-progress">{payBulk.progress}</div>}
        {payBulk.selected.size > 0 && canPay && (
          <div className="bulk-bar">
            <span>{payBulk.selected.size} محدد</span>
            <button className="btn-primary btn-sm" disabled={payBulk.busy} onClick={() => void payBulk.run('approve')}>✅ اعتماد الكل</button>
            <button className="btn-ghost danger btn-sm" disabled={payBulk.busy} onClick={() => void payBulk.run('decline')}>❌ رفض الكل</button>
          </div>
        )}
        {!payouts && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {payouts && payouts.length === 0 && <p>لا توجد سحوبات معلّقة 🎉</p>}
        {payouts && payouts.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {canPay && (
                    <th className="check-col">
                      <input
                        type="checkbox"
                        checked={payouts.length > 0 && payouts.every((r) => payBulk.selected.has(r.maven_id))}
                        onChange={() => payBulk.toggleAll(payouts.map((r) => r.maven_id))}
                      />
                    </th>
                  )}
                  <th>رقم العملية</th>
                  <th>المبلغ</th>
                  <th>المستفيد</th>
                  <th>الطريقة</th>
                  <th>التاجر</th>
                  <th>الوقت</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((r) => (
                  <tr key={r.maven_id} className="row-pending">
                    {canPay && (
                      <td className="check-col">
                        <input type="checkbox" checked={payBulk.selected.has(r.maven_id)} onChange={() => payBulk.toggle(r.maven_id)} />
                      </td>
                    )}
                    <td className="mono">{r.ontarget_ref ?? r.maven_id}<div className="cell-sub mono">{r.maven_id}</div></td>
                    <td className="mono">{money(r.amount, 'EGP')}</td>
                    <td>{r.account_name ?? '—'}{r.mobile_no && <div className="cell-sub mono">{r.mobile_no}</div>}</td>
                    <td>{r.pay_by ?? '—'}</td>
                    <td>{r.merchant ?? '—'}</td>
                    <td className="mono">{depositTime(r)}</td>
                    <td>
                      {canPay && (
                        <div className="row-actions">
                          <button className="btn-primary btn-sm" disabled={rowBusy === `payouts-${r.maven_id}`} onClick={() => void quick('payouts', r.maven_id, 'approve')}>✅</button>
                          <button className="btn-ghost danger btn-sm" disabled={rowBusy === `payouts-${r.maven_id}`} onClick={() => void quick('payouts', r.maven_id, 'decline')}>❌</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PanelShell>
  )
}
