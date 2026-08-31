import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'

// Risk & compliance — blacklist, suspicious SMS, clients flagged for review,
// and sender-number velocity/fraud detection.

interface BlacklistRow { id: string; merchant_id: string | null; type: string | null; value: string | null; reason: string | null; created_at: string | null }
interface RiskSms { id: number; received_at: string | null; device_name: string | null; sender_name: string | null; sender_number: string | null; receiver_number: string | null; amount: number | null; risk_score: number | null; risk_reason: string | null; suspicious: boolean | null; is_duplicate: boolean | null; sms_category: string | null }
interface RiskClient { id: string; client_name: string | null; phone_no: string | null; merchant_name: string | null; risk_score: number | null; approval_rate: number | null; total_transactions: number | null }
// What being on the list actually does, over the last 7 days. Shown because
// a list of 80 numbers says nothing about whether listing changed an outcome
// — and until the approval gate went in, it changed nothing at all.
interface Enforcement {
  days: number; listedNumbers: number
  humanApprovedFromListed: number; autoApprovedFromListed: number
  declinedFromListed: number; pendingFromListed: number
  totalFromListed: number; totalDecisions: number
  byNumber: { phone: string; total: number; approved: number; declined: number; pending: number; volume: number }[]
}
interface RiskData { blacklist: BlacklistRow[]; sms: RiskSms[]; clients: RiskClient[]; enforcement: Enforcement | null }
interface Offender { sender_number: string; sender_names: string[] | null; merchant: string | null; txns: number; declined: number; approved: number; decline_rate: number | null; total_amount: number | null; distinct_names: number; first_seen: string | null; last_seen: string | null; blacklisted: boolean }

export default function Risk() {
  const { can } = useAuth()
  const { t } = useLocale()
  const [data, setData] = useState<RiskData | null>(null)
  const [vel, setVel] = useState<{ offenders: Offender[]; min_txns: number; window_days: number } | null>(null)
  const [minTxns, setMinTxns] = useState(20); const [windowDays, setWindowDays] = useState(30)
  const [err, setErr] = useState<string | null>(null)
  const [blockValue, setBlockValue] = useState(''); const [blockType, setBlockType] = useState<'phone'|'country'|'city'>('phone'); const [blockReason, setBlockReason] = useState('')
  const canEdit = can('risk', 'can_edit')

  const loadRisk = useCallback(() => {
    api<RiskData>('/api/risk')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض المخاطر.', 'You do not have permission to view risk data.') : t('تعذّر تحميل بيانات المخاطر.', 'Failed to load risk data.')))
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
    } catch { setErr(t('تعذّر الإضافة للقائمة السوداء.', 'Failed to add to the blacklist.')) }
  }
  const addBlock = async () => {
    if (!blockValue.trim() || !canEdit) return
    try { await api('/api/risk/blacklist', { method:'POST', body: JSON.stringify({ type: blockType, value: blockValue.trim(), reason: blockReason.trim() || `Manual ${blockType} block` }) }); setBlockValue(''); setBlockReason(''); loadRisk() }
    catch (e) { setErr(e instanceof ApiError && e.status === 409 ? t('القيمة محظورة بالفعل.', 'Already blocked.') : t('تعذّرت إضافة الحظر.', 'Could not add block.')) }
  }
  const removeBlock = async (id: string) => { if (!canEdit || !window.confirm(t('إزالة الحظر؟','Remove this block?'))) return; try { await api(`/api/risk/blacklist/${id}`, { method:'DELETE' }); loadRisk() } catch { setErr(t('تعذّرت إزالة الحظر.','Could not remove block.')) } }

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🛡️ {t('المخاطر والامتثال', 'Risk & compliance')}</h2>
        <p className="page-sub">
          {data && <>{data.blacklist.length} {t('في القائمة السوداء', 'blacklisted')} · {data.sms.length} {t('رسالة مشبوهة', 'suspicious SMS')} · {data.clients.length} {t('عميل يحتاج مراجعة', 'clients need review')}</>}
        </p>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}

      {data?.enforcement && (
        <section className="card">
          <div className="section-label">{t('أثر القائمة على القرارات', 'What the list is doing')}</div>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-value">{data.enforcement.totalFromListed}</div>
              <div className="kpi-label">{t('قرارات من أرقام مُدرَجة', 'Decisions from listed numbers')}</div>
              <div className="cell-sub">{t(`من ${data.enforcement.totalDecisions} خلال ${data.enforcement.days} أيام`, `of ${data.enforcement.totalDecisions} over ${data.enforcement.days} days`)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{data.enforcement.autoApprovedFromListed}</div>
              <div className="kpi-label">{t('كانت تُعتمد آلياً', 'Were auto-approving')}</div>
              <div className="cell-sub">{t('تذهب الآن لقرار بشري', 'now routed to a human')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{data.enforcement.humanApprovedFromListed}</div>
              <div className="kpi-label">{t('اعتمدها مشغّل بشري', 'A human approved')}</div>
              <div className="cell-sub">{t('كان الرفض التلقائي سيرفضها', 'an auto-decline would have refused these')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{data.enforcement.declinedFromListed}</div>
              <div className="kpi-label">{t('مرفوضة', 'Declined')}</div>
              <div className="cell-sub">{data.enforcement.pendingFromListed} {t('قيد المراجعة', 'pending')}</div>
            </div>
          </div>
          <p className="cell-sub">
            {t(
              'الإدراج يمنع الاعتماد التلقائي فقط ولا يرفض أبداً: سلسلة رفض قد تكون عميلاً لديه مشكلة دفع حقيقية، وجعل القائمة ترفضه يجعل الحظر ذاتي التغذية.',
              'Listing withholds automatic approval and never declines: a run of declines can be a customer with a real payment problem, and letting the list decline them makes the block self-feeding.',
            )}
          </p>
          {data.enforcement.byNumber.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('الرقم', 'Number')}</th>
                    <th>{t('الإجمالي', 'Total')}</th>
                    <th>{t('معتمدة', 'Approved')}</th>
                    <th>{t('مرفوضة', 'Declined')}</th>
                    <th>{t('معلّقة', 'Pending')}</th>
                    <th>{t('حجم معتمد', 'Approved volume')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.enforcement.byNumber.slice(0, 15).map((n) => (
                    <tr key={n.phone}>
                      <td className="mono"><Link to={`/client/${n.phone}`}>{n.phone}</Link></td>
                      <td className="mono">{n.total}</td>
                      <td className="mono">{n.approved}</td>
                      <td className="mono">{n.declined}</td>
                      <td className="mono">{n.pending}</td>
                      <td className="mono">{money(n.volume, 'EGP')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card recent-card">
        <div className="recent-head"><h3>🚀 {t('كثافة المُرسِلين (Velocity / كشف الاحتيال)', 'Sender velocity (fraud detection)')}</h3>
          <span className="cell-sub">{t('أرقام أرسلت معاملات كثيرة خلال النافذة، مرتبة حسب نسبة الرفض', 'Numbers with many transactions in the window, ranked by decline rate')}</span>
        </div>
        <div className="filter-bar">
          <label className="filter-field">{t('حد أدنى للمعاملات', 'Min transactions')} <input className="login-input" type="number" min={2} max={500} value={minTxns} onChange={(e) => setMinTxns(Number(e.target.value) || 20)} /></label>
          <label className="filter-field">{t('النافذة (يوم)', 'Window (days)')} <input className="login-input" type="number" min={1} max={365} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 30)} /></label>
        </div>
        {!vel && <p className="sidebar-hint">{t('جارٍ الحساب…', 'Calculating…')}</p>}
        {vel && vel.offenders.length === 0 && <p>{t('لا يوجد أرقام تتجاوز الحد في هذه النافذة.', 'No numbers exceed the threshold in this window.')}</p>}
        {vel && vel.offenders.length > 0 && (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>{t('الرقم', 'Number')}</th><th>{t('الأسماء', 'Names')}</th><th>{t('المزوّد', 'Provider')}</th><th>{t('المعاملات', 'Txns')}</th><th>{t('رفض %', 'Decline %')}</th><th>{t('الإجمالي', 'Total')}</th><th>{t('القائمة السوداء', 'Blacklist')}</th></tr></thead>
            <tbody>{vel.offenders.map((o) => {
              const hot = (o.decline_rate ?? 0) >= 70 || o.distinct_names > 1
              return <tr key={o.sender_number}>
                <td className="mono">{o.sender_number}</td>
                <td>{(o.sender_names ?? []).join('، ') || '—'}{o.distinct_names > 1 && <span className="pay-status-badge st-pending"> {o.distinct_names} {t('أسماء', 'names')}</span>}</td>
                <td>{o.merchant ?? '—'}</td>
                <td className="mono">{o.txns} <span className="cell-sub">({o.declined} {t('رفض', 'declined')})</span></td>
                <td><span className={`pay-status-badge ${hot ? 'st-declined' : 'st-dim'}`}>{o.decline_rate ?? 0}%</span></td>
                <td className="mono">{money(o.total_amount, 'EGP')}</td>
                <td>{o.blacklisted ? <span className="pay-status-badge st-declined">{t('محظور', 'Blocked')}</span> : (canEdit ? <button className="btn-ghost btn-sm" onClick={() => void blacklistNumber(o)}>{t('حظر', 'Block')}</button> : '—')}</td>
              </tr>
            })}</tbody>
          </table></div>
        )}
      </section>

      {data && (
        <>
          <section className="card recent-card">
            <div className="recent-head"><h3>🚫 {t('حظر رقم محفظة','Block wallet number')}</h3><span className="cell-sub">{t('أي معاملة من الرقم المحظور تُرفض فوراً بدون مطابقة SMS.','Transactions from a blocked number are declined immediately without SMS matching.')}</span></div>
            <div className="filter-bar"><select className="filter-select" value={blockType} onChange={e => setBlockType(e.target.value as typeof blockType)} disabled={!canEdit}><option value="phone">Wallet / phone</option><option value="country">Country</option><option value="city">City</option></select><input className="login-input" value={blockValue} onChange={e=>setBlockValue(e.target.value)} placeholder={blockType === 'phone' ? '01xxxxxxxxx' : blockType === 'country' ? 'EG' : 'City'} disabled={!canEdit}/><input className="login-input" value={blockReason} onChange={e=>setBlockReason(e.target.value)} placeholder="Reason" disabled={!canEdit}/><button className="btn-primary btn-sm" onClick={()=>void addBlock()} disabled={!canEdit || !blockValue.trim()}>🚫 {t('حظر فوري','Block now')}</button></div>
          </section>
          <section className="card recent-card">
            <div className="recent-head"><h3>📋 {t('الأرقام والقيم المحظورة', 'Blocked numbers and values')}</h3><button className="btn-ghost btn-sm" onClick={loadRisk}>🔄 {t('تحديث','Refresh')}</button></div>
            {data.blacklist.length === 0 && <p>{t('القائمة فارغة.', 'The list is empty.')}</p>}
            {data.blacklist.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>{t('النوع', 'Type')}</th><th>{t('القيمة', 'Value')}</th><th>{t('السبب', 'Reason')}</th><th>{t('أضيفت', 'Added')}</th><th>{t('إجراء','Action')}</th></tr></thead>
                  <tbody>
                    {data.blacklist.map((r) => (
                      <tr key={r.id}>
                        <td><span className="pay-status-badge st-declined">{r.type ?? '—'}</span></td>
                        <td className="mono">{r.value ?? '—'}</td>
                        <td>{r.reason ?? '—'}</td>
                        <td className="mono">{depositTime({ first_seen_at: r.created_at })}</td><td>{canEdit && <button className="btn-ghost danger btn-sm" onClick={()=>void removeBlock(r.id)}>{t('إلغاء الحظر','Unblock')}</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card recent-card">
            <div className="recent-head"><h3>⚠️ {t('رسائل SMS مشبوهة / مكررة', 'Suspicious / duplicate SMS')}</h3></div>
            {data.sms.length === 0 && <p>{t('لا توجد رسائل مشبوهة.', 'No suspicious messages.')}</p>}
            {data.sms.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>#</th><th>{t('المُرسِل ← المحفظة', 'Sender ← wallet')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('السبب', 'Reason')}</th><th>{t('الجهاز', 'Device')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
                  <tbody>
                    {data.sms.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.id}</td>
                        <td>{r.sender_name ?? r.sender_number ?? '—'}<div className="cell-sub mono">← {r.receiver_number ?? '—'}</div></td>
                        <td className="mono">{money(r.amount, 'EGP')}</td>
                        <td>
                          {r.is_duplicate && <span className="pay-status-badge st-pending">{t('مكررة', 'Duplicate')}</span>}{' '}
                          {r.suspicious && <span className="pay-status-badge st-declined">{t('مشبوهة', 'Suspicious')}</span>}
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
            <div className="recent-head"><h3>👥 {t('عملاء بحاجة لمراجعة', 'Clients needing review')}</h3></div>
            {data.clients.length === 0 && <p>{t('لا يوجد عملاء بانتظار المراجعة.', 'No clients awaiting review.')}</p>}
            {data.clients.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>{t('العميل', 'Client')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('المعاملات', 'Txns')}</th><th>{t('نسبة القبول', 'Approval rate')}</th><th>{t('درجة الخطورة', 'Risk score')}</th></tr></thead>
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
