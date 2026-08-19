import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Pending operator requests to change a transaction's status or amount.
// Renders nothing at all when the queue is empty, so it never adds noise to
// the approvals screen on a normal day.

interface EditRequest {
  id: number
  tx_id: number
  ontarget_ref: string | null
  requested_status: string | null
  requested_amount: number | null
  current_status: string | null
  current_amount: number | null
  reason: string
  requested_by: string
  requested_by_role: string
  created_at: string
}

export default function EditRequestQueue() {
  const { t } = useLocale()
  const [rows, setRows] = useState<EditRequest[]>([])
  const [canDecide, setCanDecide] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api<{ rows: EditRequest[]; canDecide: boolean }>('/api/tx/edit-requests?status=pending')
      setRows(res.rows)
      setCanDecide(res.canDecide)
    } catch {
      /* the approvals screen must still render without this */
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const decide = async (id: number, action: 'approve' | 'reject') => {
    setBusy(id)
    setErr(null)
    try {
      await api(`/api/tx/edit-requests/${id}/decision`, { method: 'POST', body: JSON.stringify({ action }) })
      await load()
    } catch {
      setErr(action === 'approve'
        ? t('تعذّر تطبيق التعديل — لم يتغيّر شيء.', 'Could not apply the edit — nothing changed.')
        : t('تعذّر رفض الطلب.', 'Could not reject the request.'))
    } finally {
      setBusy(null)
    }
  }

  if (rows.length === 0) return null

  return (
    <section className="card recent-card">
      <div className="recent-head">
        <h3>✏️ {t('طلبات تعديل معاملات', 'Transaction edit requests')} <span className="mono">{rows.length}</span></h3>
        <span className="cell-sub">{t('مرسَلة من المشغّلين — تُطبَّق فقط بعد الموافقة', 'Raised by operators — applied only on approval')}</span>
      </div>
      {err && <div className="card warn">{err}</div>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('المرجع', 'Ref')}</th><th>{t('المطلوب', 'Requested')}</th>
              <th>{t('السبب', 'Reason')}</th><th>{t('مقدّم الطلب', 'Requested by')}</th>
              <th>{canDecide ? t('قرار', 'Decision') : ''}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">
                  {r.ontarget_ref
                    ? <Link to={`/transactions/${r.ontarget_ref}`}>{r.ontarget_ref}</Link>
                    : r.tx_id}
                  <div className="cell-sub mono">{r.tx_id}</div>
                </td>
                <td>
                  {r.requested_status && (
                    <div><span className="cell-sub">{r.current_status} → </span><b>{r.requested_status}</b></div>
                  )}
                  {r.requested_amount != null && (
                    <div className="mono">
                      <span className="cell-sub">{money(r.current_amount, '')} → </span>
                      <b>{money(r.requested_amount, '')}</b>
                    </div>
                  )}
                </td>
                <td>{r.reason}</td>
                <td>{r.requested_by}<div className="cell-sub">{r.requested_by_role}</div></td>
                <td>
                  {canDecide && (
                    <div className="row-actions">
                      <button className="btn-primary btn-sm" disabled={busy !== null} onClick={() => void decide(r.id, 'approve')}>
                        {busy === r.id ? '⏳' : `✅ ${t('وافق', 'Approve')}`}
                      </button>
                      <button className="btn-ghost danger btn-sm" disabled={busy !== null} onClick={() => void decide(r.id, 'reject')}>
                        ❌ {t('ارفض', 'Reject')}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
