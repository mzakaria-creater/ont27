import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Settlements — per-merchant aggregates (approved deposits vs payouts) over a window.

interface SettleRow {
  merchant: string
  master: string | null
  depCount: number
  depVolume: number
  fees: number
  commission: number
  payCount: number
  payVolume: number
}
interface SettlementPayment { id: string; merchant: string; settlement_month: string; amount: number; blocked_percent: number; note: string | null; paid_by: string | null; paid_at: string }

// Gross settlement batches per sub-merchant. Net is deliberately absent: the
// per-transaction fee columns are NULL on every paid row, and the configured
// rates cannot be applied unambiguously — so the page shows what is certain
// and names what is not, rather than publishing a payable amount derived from
// a guessed rate.
interface Batch {
  subMerchant: string; merchant: string
  paidCount: number; declinedCount: number; totalCount: number
  grossVolume: number; avgTicket: number | null
  firstDay: string | null; lastDay: string | null
  rateRow: string | null; commissionRate: number | null
  payinPct: number | null; payoutPct: number | null
  rateMissing: boolean; rateConflict: boolean; rateCandidates: number
}
interface Batches {
  days: number; gateway: string; generatedAt: string
  netComputable: boolean; netBlockedBecause: string[]
  grossTotal: number; paidTotal: number; batches: Batch[]
}

export default function Settlements() {
  const { t } = useLocale()
  const { can } = useAuth()
  const [days, setDays] = useState(7)
  const [batches, setBatches] = useState<Batches | null>(null)
  const [rows, setRows] = useState<SettleRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [payments, setPayments] = useState<SettlementPayment[]>([])
  const [paymentForm, setPaymentForm] = useState({ merchant: '', settlement_month: new Date().toISOString().slice(0, 7), amount: '', blocked_percent: '0', note: '' })
  const [paymentBusy, setPaymentBusy] = useState(false)

  useEffect(() => {
    setRows(null)
    api<{ rows: SettleRow[] }>(`/api/settlements?days=${days}`)
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض التسويات.', 'You do not have permission to view settlements.') : t('تعذّر تحميل التسويات.', 'Failed to load settlements.')))
  }, [days])

  useEffect(() => { api<{ payments: SettlementPayment[] }>('/api/settlements/payments').then((r) => setPayments(r.payments)).catch(() => setPayments([])) }, [])

  const addPayment = async (event: FormEvent) => {
    event.preventDefault(); setPaymentBusy(true); setErr(null)
    try { const r = await api<{ payment: SettlementPayment }>('/api/settlements/payments', { method: 'POST', body: JSON.stringify(paymentForm) }); setPayments((p) => [r.payment, ...p]); setPaymentForm({ ...paymentForm, amount: '', note: '' }) }
    catch (e) { setErr(e instanceof ApiError ? e.message : t('تعذر حفظ دفعة التسوية.', 'Could not save settlement payment.')) }
    finally { setPaymentBusy(false) }
  }

  useEffect(() => {
    setBatches(null)
    api<Batches>(`/api/settlements/batches?days=${days}`).then(setBatches).catch(() => setBatches(null))
  }, [days])

  const totals = (rows ?? []).reduce(
    (t, r) => ({
      depVolume: t.depVolume + r.depVolume,
      payVolume: t.payVolume + r.payVolume,
      fees: t.fees + r.fees,
      commission: t.commission + r.commission,
    }),
    { depVolume: 0, payVolume: 0, fees: 0, commission: 0 },
  )

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🧾 {t('التسويات', 'Settlements')}</h2>
        <p className="page-sub">{t('صافي كل تاجر خلال الفترة (إيداعات معتمدة − سحوبات معتمدة) · محسوبة من المعاملات الحقيقية', 'Net per merchant over the window (approved deposits − approved payouts) · computed from real transactions')}</p>
      </section>

      <div className="filter-bar">
        <div className="filter-pills">
          {[7, 14, 30].map((d) => (
            <button key={d} className={`pill${days === d ? ' active' : ''}`} onClick={() => setDays(d)}>
              {t('آخر', 'Last')} {d} {t('يوم', 'days')}
            </button>
          ))}
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-icon">💰</span>
          <div className="kpi-value">{rows ? money(totals.depVolume, '') : '…'}</div>
          <div className="kpi-label">{t('إجمالي الإيداعات المعتمدة (EGP)', 'Total approved deposits (EGP)')}</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">📤</span>
          <div className="kpi-value">{rows ? money(totals.payVolume, '') : '…'}</div>
          <div className="kpi-label">{t('إجمالي السحوبات المعتمدة (EGP)', 'Total approved payouts (EGP)')}</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">🧮</span>
          <div className="kpi-value">{rows ? money(totals.depVolume - totals.payVolume, '') : '…'}</div>
          <div className="kpi-label">{t('الصافي (EGP)', 'Net (EGP)')}</div>
        </div>
        <div className="kpi-card">
          <span className="kpi-icon">🪙</span>
          <div className="kpi-value">{rows ? money(totals.commission + totals.fees, '') : '…'}</div>
          <div className="kpi-label">{t('عمولات + رسوم (EGP)', 'Commission + fees (EGP)')}</div>
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}

      {can('settlements', 'can_edit') && <section className="card settlement-payment-card">
        <div className="recent-head"><div><h3>💸 {t('إضافة دفعة / حجز للتاجر', 'Add merchant payment / hold')}</h3><p className="page-sub">{t('المتاح = (Payin − Payout) − الدفعات − نسبة الحجز.', 'Available = (Payin − Payout) − payments − hold percentage.')}</p></div></div>
        <form className="settlement-payment-form" onSubmit={addPayment}><select className="login-input" required value={paymentForm.merchant} onChange={e => setPaymentForm({ ...paymentForm, merchant: e.target.value })}><option value="">{t('اختر التاجر', 'Select merchant')}</option>{(rows ?? []).map(r => <option key={r.merchant} value={r.merchant}>{r.merchant}</option>)}</select><input className="login-input" type="month" required value={paymentForm.settlement_month} onChange={e => setPaymentForm({ ...paymentForm, settlement_month: e.target.value })} /><input className="login-input" type="number" min="0.01" step="0.01" required placeholder={t('المبلغ المدفوع', 'Payment amount')} value={paymentForm.amount} onChange={e => setPaymentForm({ ...paymentForm, amount: e.target.value })} /><input className="login-input" type="number" min="0" max="100" step="0.01" placeholder={t('نسبة الحجز %', 'Hold %')} value={paymentForm.blocked_percent} onChange={e => setPaymentForm({ ...paymentForm, blocked_percent: e.target.value })} /><input className="login-input" placeholder={t('ملاحظة', 'Note')} value={paymentForm.note} onChange={e => setPaymentForm({ ...paymentForm, note: e.target.value })} /><button className="btn-primary" disabled={paymentBusy || !paymentForm.merchant}>{paymentBusy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ الدفعة', 'Save payment')}</button></form>
      </section>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">{t('جارٍ الحساب…', 'Calculating…')}</p>}
        {rows && rows.length === 0 && <p>{t('لا توجد معاملات معتمدة في الفترة.', 'No approved transactions in this window.')}</p>}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('التاجر', 'Merchant')}</th>
                  <th>{t('إيداعات', 'Deposits')}</th>
                  <th>{t('حجم الإيداعات', 'Deposit volume')}</th>
                  <th>{t('سحوبات', 'Payouts')}</th>
                  <th>{t('حجم السحوبات', 'Payout volume')}</th>
                  <th>{t('عمولة', 'Commission')}</th>
                  <th>{t('رسوم', 'Fees')}</th>
                  <th>{t('الصافي', 'Net')}</th><th>{t('المدفوع/المحجوز', 'Paid / held')}</th><th>{t('المتاح', 'Available')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.merchant}>
                    <td>{r.merchant}{r.master && <div className="cell-sub">{r.master}</div>}</td>
                    <td className="mono">{r.depCount}</td>
                    <td className="mono">{money(r.depVolume, 'EGP')}</td>
                    <td className="mono">{r.payCount}</td>
                    <td className="mono">{money(r.payVolume, 'EGP')}</td>
                    <td className="mono">{money(r.commission, 'EGP')}</td>
                    <td className="mono">{money(r.fees, 'EGP')}</td>
                    <td className="mono" style={{ color: r.depVolume - r.payVolume >= 0 ? 'var(--status-paid)' : 'var(--status-declined)' }}>
                      {money(r.depVolume - r.payVolume, 'EGP')}
                    </td>
                    {(() => { const net = r.depVolume - r.payVolume; const ps = payments.filter(p => p.merchant === r.merchant); const paid = ps.reduce((s, p) => s + Number(p.amount), 0); const held = ps.reduce((s, p) => s + Number(p.amount) * Number(p.blocked_percent) / 100, 0); return <><td className="mono">{money(paid + held, 'EGP')}</td><td className="mono" style={{ color: net - paid - held >= 0 ? 'var(--status-paid)' : 'var(--status-declined)' }}>{money(net - paid - held, 'EGP')}</td></> })()}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {batches && (
        <section className="card">
          <div className="section-label">{t('دفعات التسوية لكل تاجر فرعي', 'Settlement batches per sub-merchant')}</div>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-value">{money(batches.grossTotal, 'EGP')}</div>
              <div className="kpi-label">{t('إجمالي إجمالي (Gross)', 'Gross total')}</div>
              <div className="cell-sub">{batches.paidTotal} {t('معاملة معتمدة', 'paid transactions')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{batches.batches.filter((b) => b.rateConflict).length}</div>
              <div className="kpi-label">{t('تعارض في نسبة العمولة', 'Rate conflicts')}</div>
              <div className="cell-sub">{t('من', 'of')} {batches.batches.length}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{batches.batches.filter((b) => b.rateMissing).length}</div>
              <div className="kpi-label">{t('بلا نسبة مُعرَّفة', 'No rate defined')}</div>
              <div className="cell-sub">{t('لا يمكن تسويتها', 'cannot be settled')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">—</div>
              <div className="kpi-label">{t('الصافي', 'Net')}</div>
              <div className="cell-sub">{t('غير قابل للحساب', 'not computable')}</div>
            </div>
          </div>

          <div className="card warn">
            <strong>{t('الصافي غير محسوب عمداً.', 'Net is deliberately not computed.')}</strong>
            <ul className="plain-list">
              {batches.netBlockedBecause.map((r) => <li key={r}>• {r}</li>)}
            </ul>
            <p className="cell-sub">
              {t(
                'مبلغ التسوية مبلغ مستحق الدفع. نشره بنسبة مُخمَّنة أسوأ من عدم نشره — الفارق على EZInvest وحدها بين قراءتَي النسبة 61,670 ج.',
                'A settlement figure is a payable amount. Publishing one from a guessed rate is worse than publishing none — on EZInvest alone the two readings differ by 61,670 EGP.',
              )}
            </p>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('التاجر الفرعي', 'Sub-merchant')}</th>
                  <th>{t('إجمالي (Gross)', 'Gross')}</th>
                  <th>{t('معتمدة', 'Paid')}</th>
                  <th>{t('متوسط العملية', 'Avg ticket')}</th>
                  <th>{t('صف النسبة', 'Rate row')}</th>
                  <th>{t('commission_rate', 'commission_rate')}</th>
                  <th>{t('payin + payout', 'payin + payout')}</th>
                </tr>
              </thead>
              <tbody>
                {batches.batches.map((b) => (
                  <tr key={b.subMerchant} className={b.rateMissing ? 'row-pending' : undefined}>
                    <td>{b.subMerchant}</td>
                    <td className="mono">{money(b.grossVolume, 'EGP')}</td>
                    <td className="mono">{b.paidCount}</td>
                    <td className="mono">{b.avgTicket == null ? '—' : money(b.avgTicket, 'EGP')}</td>
                    <td>
                      {b.rateRow ?? <span className="pay-status-badge st-declined">{t('غير موجود', 'missing')}</span>}
                      {b.rateCandidates > 1 && (
                        <div className="cell-sub">{t(`${b.rateCandidates} صفوف مطابقة`, `${b.rateCandidates} rows match`)}</div>
                      )}
                    </td>
                    <td className="mono">{b.commissionRate == null ? '—' : `${b.commissionRate}%`}</td>
                    <td className="mono">
                      {b.payinPct == null ? '—' : `${b.payinPct}% + ${b.payoutPct ?? 0}%`}
                      {b.rateConflict && !b.rateMissing && (
                        <div className="cell-sub">{t('يخالف العمود المجاور', 'disagrees with the column beside it')}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </PanelShell>
  )
}
