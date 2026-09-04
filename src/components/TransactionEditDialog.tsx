import { useState } from 'react'
import { Pencil, Save, Send, X } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { STATUS_META, money, statusMeta } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'

// Keep the role aliases used by older operator accounts. These roles may apply
// a direct audited edit from the unified transactions table.
const DIRECT_STATUS_ROLES = new Set(['super_admin', 'owner', 'admin', 'operations_admin', 'operator_admin', 'operation_admin', 'operator'])
const STATUSES = Object.keys(STATUS_META)

export default function TransactionEditDialog({ txId, ontargetRef, status, amount, currency, gateway, onDone }: {
  txId: number; ontargetRef?: string | null; status: string; amount?: number | null; currency?: string | null; gateway?: string | null; onDone?: () => void
}) {
  const { user } = useAuth(); const steward = DIRECT_STATUS_ROLES.has(user?.role ?? ''); const canEditAmount = new Set(['super_admin', 'owner', 'admin']).has(user?.role ?? '')
  const [open, setOpen] = useState(false); const [nextStatus, setNextStatus] = useState(''); const [nextAmount, setNextAmount] = useState(''); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null)
  const changing = (nextStatus !== '' && nextStatus !== status) || (nextAmount !== '' && Number(nextAmount) !== Number(amount ?? 0))
  const provider = changing && gateway === 'NagupayP2P' && (status === 'PENDING' || (status === 'DECLINED' && nextStatus === 'PAID')) && (nextStatus === 'PAID' || nextStatus === 'DECLINED')
  const submit = async () => {
    if (!changing || !reason.trim()) return
    setBusy(true); setError(null); setDone(null)
    try {
      const endpoint = steward ? `/api/tx/${txId}/edit` : `/api/tx/${txId}/edit-request`
      const out = await api<{ executed_on_provider?: boolean; telegram?: { sent: number } }>(endpoint, { method: 'POST', body: JSON.stringify({ status: nextStatus, amount: canEditAmount && nextAmount !== '' ? Number(nextAmount) : null, reason: reason.trim() }) })
      setDone(steward ? (out.executed_on_provider ? 'Executed on provider.' : 'Status updated locally.') : `Edit request sent (${out.telegram?.sent ?? 0} approvers).`)
      setNextStatus(''); setNextAmount(''); setReason(''); onDone?.()
    } catch (e) { setError(e instanceof ApiError ? e.code : 'edit_failed') }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" className="btn-ghost btn-sm" onClick={() => { setOpen(true); setDone(null); setError(null); setNextAmount('') }} title="Edit transaction"><Pencil size={13}/> Edit</button>
    {open && <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => !busy && setOpen(false)}><div className="modal-card transaction-edit-dialog" onClick={e => e.stopPropagation()}>
      <div className="modal-head"><h3><Pencil size={16}/> Edit transaction status</h3><button className="btn-ghost btn-sm" onClick={() => setOpen(false)}><X size={15}/></button></div>
      <div className="cell-sub mono">#{ontargetRef ?? txId} · Current: {statusMeta(status).label} · {money(amount ?? 0, currency ?? 'EGP')}</div>
      <label className="field-label">New status</label><select className="login-input" value={nextStatus} onChange={e => setNextStatus(e.target.value)} disabled={busy}><option value="">Select status…</option>{STATUSES.filter(s => s !== status).map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}</select>
      {canEditAmount && <><label className="field-label">Amount</label><input className="login-input" type="number" min="0.01" step="0.01" value={nextAmount} onChange={e => setNextAmount(e.target.value)} placeholder={String(amount ?? '')} disabled={busy}/></>}
      <label className="field-label">Reason (required)</label><input className="login-input" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} placeholder="Why is this status changing?" />
      {changing && <p className={`drawer-note${provider ? '' : ' warn-text'}`}>{provider ? 'This will execute on the provider and be audited.' : 'Local correction or approval request; every action is audited.'}</p>}
      {error && <div className="card warn">{error}</div>}{done && <div className="card">{done}</div>}
      <div className="drawer-actions"><button className="btn-primary" disabled={!changing || !reason.trim() || busy} onClick={() => void submit()}>{steward ? <Save size={14}/> : <Send size={14}/>} {busy ? 'Working…' : steward ? 'Apply status' : 'Request status edit'}</button><button className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button></div>
    </div></div>}
  </>
}
