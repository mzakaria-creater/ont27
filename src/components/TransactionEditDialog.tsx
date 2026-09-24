import { useState } from 'react'
import { Pencil, Save, Send, X } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { STATUS_META, money, statusMeta } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'

// Keep the role aliases used by older operator accounts. These roles may apply
// a direct audited edit from the unified transactions table.
const DIRECT_STATUS_ROLES = new Set(['super_admin', 'owner', 'admin', 'operations_admin', 'operator_admin', 'operation_admin', 'operator'])
const STATUSES = Object.keys(STATUS_META)
const CHANGE_REASONS = [
  ['sms_verified', 'SMS verified / payment evidence confirmed'],
  ['provider_correction', 'Provider status correction'],
  ['duplicate_resolved', 'Duplicate transaction resolved'],
  ['complaint_review', 'Complaint investigation completed'],
  ['manual_reconciliation', 'Manual reconciliation'],
  ['custom', 'Other (enter reason)'],
] as const

export default function TransactionEditDialog({ txId, ontargetRef, status, amount, currency, gateway, currentReceivingWallet, onDone, iconOnly = false }: {
  txId: number; ontargetRef?: string | null; status: string; amount?: number | null; currency?: string | null; gateway?: string | null; currentReceivingWallet?: string | null; onDone?: () => void; iconOnly?: boolean
}) {
  const { user } = useAuth(); const steward = DIRECT_STATUS_ROLES.has(user?.role ?? ''); const canEditAmount = new Set(['super_admin', 'owner', 'admin']).has(user?.role ?? '') || ['ahmedmano.solly', 'joe'].includes(user?.username?.toLowerCase() ?? '')
  const [open, setOpen] = useState(false); const [nextStatus, setNextStatus] = useState(''); const [nextAmount, setNextAmount] = useState(''); const [nextSenderNumber, setNextSenderNumber] = useState(''); const [nextReceivingWallet, setNextReceivingWallet] = useState(''); const [reason, setReason] = useState(''); const [reasonChoice, setReasonChoice] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [done, setDone] = useState<string | null>(null)
  const currentWallet = (currentReceivingWallet ?? '').trim()
  const changingWallet = nextReceivingWallet.trim() !== '' && nextReceivingWallet.trim() !== currentWallet
  const changing = (nextStatus !== '' && nextStatus !== status) || (nextAmount !== '' && Number(nextAmount) !== Number(amount ?? 0)) || nextSenderNumber.trim() !== '' || changingWallet
  // Mirrors server/txEdit.ts's isProviderDecision exactly: any explicit
  // status edit targeting a real provider outcome always executes, no matter
  // the current status; APPROVED executes as PAID since Maven has no
  // "Approved" state of its own (see the server-side comment).
  const provider = changing && gateway === 'NagupayP2P' && (
    (nextAmount !== '' && canEditAmount && ['PAID', 'DECLINED', 'EXPIRED', 'UNDERPAID', 'OVERPAID', 'APPROVED'].includes(status)) ||
    (nextStatus !== '' && ['PAID', 'DECLINED', 'EXPIRED', 'UNDERPAID', 'OVERPAID', 'APPROVED'].includes(nextStatus))
  )
  const submit = async () => {
    if (!changing || !reason.trim()) return
    setBusy(true); setError(null); setDone(null)
    try {
      const endpoint = steward ? `/api/tx/${txId}/edit` : `/api/tx/${txId}/edit-request`
      const out = await api<{ executed_on_provider?: boolean; telegram?: { sent: number } }>(endpoint, { method: 'POST', body: JSON.stringify({ status: nextStatus, amount: canEditAmount && nextAmount !== '' ? Number(nextAmount) : null, sender_number: canEditAmount && nextSenderNumber !== '' ? nextSenderNumber.trim() : null, receiving_wallet: changingWallet ? nextReceivingWallet.trim() : null, reason: reason.trim() }) })
      setDone(steward ? (out.executed_on_provider ? 'Executed on provider.' : 'Status updated locally.') : `Edit request sent (${out.telegram?.sent ?? 0} approvers).`)
      setNextStatus(''); setNextAmount(''); setNextSenderNumber(''); setNextReceivingWallet(''); setReason(''); setReasonChoice(''); onDone?.()
    } catch (e) { setError(e instanceof ApiError ? e.code : 'edit_failed') }
    finally { setBusy(false) }
  }
  return <>
    <button type="button" className={`btn-ghost btn-sm${iconOnly ? ' tx-action-icon' : ''}`} onClick={() => { setOpen(true); setDone(null); setError(null); setNextAmount(''); setNextSenderNumber(''); setNextReceivingWallet(''); setReason(''); setReasonChoice('') }} title="Edit transaction / receiving wallet" aria-label="Edit transaction / receiving wallet"><Pencil size={13}/>{!iconOnly && ' Edit'}</button>
    {open && <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => !busy && setOpen(false)}><div className="modal-card transaction-edit-dialog" onClick={e => e.stopPropagation()}>
      <div className="modal-head"><h3><Pencil size={16}/> Edit transaction / wallet</h3><button className="btn-ghost btn-sm" onClick={() => setOpen(false)}><X size={15}/></button></div>
      <div className="cell-sub mono">#{ontargetRef ?? txId} · Current: {statusMeta(status).label} · {money(amount ?? 0, currency ?? 'EGP')}</div>
      <label className="field-label">New status</label><select className="login-input" value={nextStatus} onChange={e => setNextStatus(e.target.value)} disabled={busy}><option value="">Select status…</option>{STATUSES.filter(s => s !== status).map(s => <option key={s} value={s}>{statusMeta(s).label}</option>)}</select>
      {canEditAmount && <><label className="field-label">Amount</label><input className="login-input" type="number" min="0.01" step="0.01" value={nextAmount} onChange={e => setNextAmount(e.target.value)} placeholder={String(amount ?? '')} disabled={busy}/></>}
      {canEditAmount && <><label className="field-label">Client / sender number</label><input className="login-input" inputMode="numeric" value={nextSenderNumber} onChange={e => setNextSenderNumber(e.target.value.replace(/\D/g, ''))} placeholder="01XXXXXXXXX" disabled={busy}/></>}
      <label className="field-label">Receiving wallet / رقم الاستقبال <span className="cell-sub">(fast wallet change)</span></label><input className="login-input" inputMode="numeric" value={nextReceivingWallet} onChange={e => setNextReceivingWallet(e.target.value.replace(/\D/g, ''))} placeholder={currentWallet || '01XXXXXXXXX'} disabled={busy}/>
      <label className="field-label">Reason for change (required)</label><select className="login-input" value={reasonChoice} onChange={e => { setReasonChoice(e.target.value); if (e.target.value !== 'custom') setReason(CHANGE_REASONS.find(([key]) => key === e.target.value)?.[1] ?? '') }} disabled={busy}><option value="">Select reason…</option>{CHANGE_REASONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>{reasonChoice === 'custom' && <input className="login-input" value={reason} onChange={e => setReason(e.target.value)} disabled={busy} placeholder="Enter the reason" />}
      {changing && <p className={`drawer-note${provider ? '' : ' warn-text'}`}>{provider ? 'This will execute on the provider and be audited.' : 'Local correction or approval request; every action is audited.'}</p>}
      {error && <div className="card warn">{error}</div>}{done && <div className="card">{done}</div>}
      <div className="drawer-actions"><button className="btn-primary" disabled={!changing || !reason.trim() || busy} onClick={() => void submit()}>{steward ? <Save size={14}/> : <Send size={14}/>} {busy ? 'Working…' : steward ? (changingWallet && !nextStatus && !nextAmount && !nextSenderNumber ? 'Apply wallet change' : 'Apply change') : 'Request change'}</button><button className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button></div>
    </div></div>}
  </>
}
