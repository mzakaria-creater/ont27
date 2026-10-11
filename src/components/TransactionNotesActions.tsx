import { useCallback, useEffect, useState } from 'react'
import { Lock, LockOpen, MessageSquare, Send, ShieldAlert } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'

type Note = { id: number; author: string; note: string; created_at: string }

// Operator notes + safe local flags (hold from settlement / send to review).
export default function TransactionNotesActions({ txId, settlementBlocked, onChanged }: { txId: number; settlementBlocked?: boolean | null; onChanged?: () => void }) {
  const { t } = useLocale()
  const { can } = useAuth()
  const [notes, setNotes] = useState<Note[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(Boolean(settlementBlocked))
  useEffect(() => setBlocked(Boolean(settlementBlocked)), [settlementBlocked])

  const load = useCallback(async () => {
    try { setNotes((await api<{ notes: Note[] }>(`/api/tx-extras/${txId}/notes`)).notes) } catch { /* hidden for roles without access */ }
  }, [txId])
  useEffect(() => { void load() }, [load])

  const addNote = async () => {
    if (!text.trim()) return
    setBusy(true); setMsg(null)
    try { await api(`/api/tx-extras/${txId}/notes`, { method: 'POST', body: JSON.stringify({ note: text.trim() }) }); setText(''); await load() }
    catch (e) { setMsg(e instanceof ApiError ? e.code : 'note_failed') } finally { setBusy(false) }
  }
  const flag = async (path: 'hold' | 'review', value: boolean) => {
    setBusy(true); setMsg(null)
    try {
      await api(`/api/tx-extras/${txId}/${path}`, { method: 'POST', body: JSON.stringify({ value }) })
      if (path === 'hold') setBlocked(value)
      setMsg(path === 'hold' ? (value ? t('تم حجز المعاملة من التسوية.', 'Held from settlement.') : t('تم رفع الحجز.', 'Hold released.')) : (value ? t('أُرسلت للمراجعة.', 'Sent to review.') : t('أُزيلت من المراجعة.', 'Review cleared.')))
      onChanged?.()
    } catch (e) { setMsg(e instanceof ApiError ? e.code : 'action_failed') } finally { setBusy(false) }
  }
  const canAct = can('deposits', 'can_approve')

  return <>
    {canAct && <section className="card recent-card">
      <div className="section-label" style={{ marginTop: 0 }}>{t('إجراءات إضافية', 'More actions')}</div>
      <div className="drawer-actions" style={{ flexDirection: 'column' }}>
        {blocked
          ? <button className="btn-ghost" disabled={busy} onClick={() => void flag('hold', false)}><LockOpen size={14} /> {t('رفع الحجز', 'Release hold')}</button>
          : <button className="btn-ghost" disabled={busy} onClick={() => void flag('hold', true)}><Lock size={14} /> {t('حجز من التسوية', 'Place on hold')}</button>}
        <button className="btn-ghost" disabled={busy} onClick={() => void flag('review', true)}><ShieldAlert size={14} /> {t('إرسال للمراجعة', 'Send to review')}</button>
        <button className="btn-ghost" disabled={busy} onClick={() => void flag('review', false)}>{t('إزالة من المراجعة', 'Clear review')}</button>
      </div>
      {blocked && <p className="drawer-note warn-text">{t('المعاملة محجوزة ولن تدخل التسوية.', 'This transaction is held and excluded from settlement.')}</p>}
      {msg && <p className="cell-sub" style={{ marginTop: 8 }}>{msg}</p>}
    </section>}
    <section className="card recent-card">
      <div className="section-label" style={{ marginTop: 0 }}><MessageSquare size={15} aria-hidden="true" /> {t('ملاحظات', 'Notes')}</div>
      {notes.map(n => <div key={n.id} className="card" style={{ padding: 8, marginBottom: 6 }}><div className="cell-sub"><strong>{n.author}</strong> · {new Date(n.created_at).toLocaleString()}</div><div>{n.note}</div></div>)}
      {notes.length === 0 && <p className="drawer-note">{t('لا توجد ملاحظات.', 'No notes yet.')}</p>}
      <textarea className="login-input" rows={3} maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder={t('أضف ملاحظة لهذه المعاملة…', 'Add a note for this transaction…')} disabled={busy} />
      <button className="btn-primary btn-sm" style={{ marginTop: 6 }} disabled={busy || !text.trim()} onClick={() => void addNote()}><Send size={13} /> {t('إضافة ملاحظة', 'Add note')}</button>
    </section>
  </>
}
