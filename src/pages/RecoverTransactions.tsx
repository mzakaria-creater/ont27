import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw, RotateCcw } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import ProofModal from '../components/ProofModal'
import ProofIconButton from '../components/ProofIconButton'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

// Declined deposits that picked up SMS evidence too late to have been part
// of the original decision — server/extras.ts GET /transactions/recoverable.
// The matcher (server/smsMatcher.ts) already refuses to auto-approve these;
// this page exists only so an operator doesn't have to go hunting through
// the full transaction list to find them. Recovering one still goes through
// the exact same POST /deposits/:id/decision approve action every other
// approval uses.

interface MatchedSms {
  id: number
  received_at: string | null
  amount: number | null
  balance_after: number | null
  sender_name: string | null
  sender_number: string | null
  receiver_number: string | null
  raw_sms: string | null
  message: string | null
  sms_first_line: string | null
}

interface RecoverRow {
  tx_id: number
  ontarget_ref: string | null
  status: string
  amount: number | null
  currency: string | null
  sender_name: string | null
  sender_number: string | null
  merchant: string | null
  master_merchant: string | null
  proof_image_url: string | null
  first_seen_at: string | null
  matched_sms: MatchedSms | null
}

export default function RecoverTransactions() {
  const { t } = useLocale()
  const { can } = useAuth()
  const isMobile = useIsMobile()
  const [rows, setRows] = useState<RecoverRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [proof, setProof] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    api<{ rows: RecoverRow[] }>('/api/transactions/recoverable')
      .then((res) => setRows(res.rows ?? []))
      .catch((e) => setErr(e instanceof ApiError && e.status === 403
        ? t('لا تملك صلاحية عرض هذه الصفحة.', 'You do not have permission to view this page.')
        : t('تعذّر تحميل قائمة الاسترجاع.', 'Failed to load the recovery worklist.')))
      .finally(() => setLoading(false))
  }, [t])
  useEffect(() => { load() }, [load])

  const recover = async (row: RecoverRow) => {
    if (!window.confirm(t(`استرجاع المعاملة ${row.ontarget_ref ?? row.tx_id} واعتمادها؟`, `Recover and approve transaction ${row.ontarget_ref ?? row.tx_id}?`))) return
    setBusy(row.tx_id)
    try {
      await api(`/api/deposits/${row.tx_id}/decision`, { method: 'POST', body: JSON.stringify({ action: 'approve', note: 'Recovered from Recover Transaction Review — late SMS evidence found after decline' }) })
      setRows((current) => current?.filter((r) => r.tx_id !== row.tx_id) ?? current)
    } catch (e) {
      setErr(e instanceof ApiError ? `${t('فشل الاسترجاع', 'Recovery failed')}: ${e.code}` : t('فشل الاسترجاع.', 'Recovery failed.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <section className="page-head admin-head">
        <span className="admin-head-icon"><RotateCcw size={20} /></span>
        <div className="admin-head-text">
          <span className="admin-head-eyebrow">{t('استرجاع المعاملات', 'Transaction recovery')}</span>
          <h2>{t('مراجعة الاسترجاع', 'Recover Transaction Review')}</h2>
          <p className="page-sub">{t('معاملات مرفوضة وصلها دليل SMS متأخر — تحتاج مراجعة يدوية قبل أي قرار.', 'Declined transactions that later received matching SMS evidence — needs a manual decision before anything changes.')}</p>
        </div>
        <div className="admin-head-actions">
          <button className="btn-ghost btn-sm" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        <div className="recent-head"><h3>{t('قائمة الاسترجاع', 'Recovery worklist')} ({rows?.length ?? 0})</h3></div>
        {!rows && !err && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {rows && rows.length === 0 && <p className="maven-empty">{t('لا توجد معاملات بحاجة لاسترجاع حالياً.', 'No transactions need recovery right now.')}</p>}
        {rows && rows.length > 0 && (isMobile ? (
          <div className="risk-card-list">
            {rows.map((r) => (
              <div key={r.tx_id} className="risk-row-card">
                <div className="risk-row-card-head"><span className="mono">{r.ontarget_ref ?? r.tx_id}</span><span className="pay-status-badge st-declined">{r.status}</span></div>
                <div className="cell-sub">{r.merchant ?? '—'} · {r.sender_name ?? r.sender_number ?? '—'}</div>
                <div className="risk-row-card-foot"><span className="mono">{money(r.amount, r.currency ?? 'EGP')}</span>{r.proof_image_url && <ProofIconButton url={r.proof_image_url} onOpen={setProof} compact/>}</div>
                {r.matched_sms && <div className="tx-sms-raw" style={{ marginTop: 6 }}>
                  <span className="tx-sms-label">📨 {t('SMS متأخر', 'Late SMS')}</span>
                  <span className="mono">#{r.matched_sms.id}</span>
                  <span>{r.matched_sms.sender_name ?? r.matched_sms.sender_number ?? '—'}</span>
                  <span className="mono">{money(r.matched_sms.amount, r.currency ?? 'EGP')}</span>
                  {!r.matched_sms.sender_number && <div className="tx-sms-weak-nudge"><AlertTriangle size={12} aria-hidden="true"/> {t('مطابقة بالاسم فقط — راجع الإثبات', 'Name-only match — check the proof')}</div>}
                </div>}
                {can('deposits', 'can_approve') && <div className="row-actions"><button className="btn-primary btn-sm" disabled={busy === r.tx_id} onClick={() => void recover(r)}>{t('استرجاع واعتماد', 'Recover & approve')}</button></div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap"><table className="data-table">
            <thead><tr>
              <th>{t('المرجع', 'Reference')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('المبلغ', 'Amount')}</th>
              <th>{t('دليل SMS المتأخر', 'Late SMS evidence')}</th><th>{t('الإثبات', 'Proof')}</th><th>{t('إجراء', 'Action')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tx_id}>
                  <td className="mono">{r.ontarget_ref ?? r.tx_id}<div className="cell-sub">{r.first_seen_at ? new Date(r.first_seen_at).toLocaleString() : '—'}</div></td>
                  <td>{r.merchant ?? '—'}<div className="cell-sub">{r.sender_name ?? r.sender_number ?? '—'}</div></td>
                  <td className="mono">{money(r.amount, r.currency ?? 'EGP')}</td>
                  <td>{r.matched_sms ? <div className="tx-sms-raw">
                    <span className="mono">#{r.matched_sms.id}</span>
                    <span>{r.matched_sms.sender_name ?? r.matched_sms.sender_number ?? '—'}</span>
                    <span className="mono">{money(r.matched_sms.amount, r.currency ?? 'EGP')}</span>
                    {!r.matched_sms.sender_number && <div className="tx-sms-weak-nudge"><AlertTriangle size={12} aria-hidden="true"/> {t('اسم فقط', 'Name only')}</div>}
                  </div> : '—'}</td>
                  <td>{r.proof_image_url ? <ProofIconButton url={r.proof_image_url} onOpen={setProof} compact/> : '—'}</td>
                  <td>{can('deposits', 'can_approve') && <button className="btn-primary btn-sm" disabled={busy === r.tx_id} onClick={() => void recover(r)}>{t('استرجاع واعتماد', 'Recover & approve')}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        ))}
      </section>

      {proof && <ProofModal url={proof} onClose={() => setProof(null)} />}
    </>
  )
}
