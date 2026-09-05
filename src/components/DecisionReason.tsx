import { useEffect, useRef, useState } from 'react'
import { useLocale } from '../lib/locale'
import { MIN_REASON_LENGTH, reasonIsValid, reasonsFor } from '../lib/decisionReasons'

// The reason step that stands between a click and a money decision.
//
// One component for every path — single row, drawer, detail page, and bulk —
// so the reasons recorded are the same set no matter where an operator was
// standing when they decided. Six screens each growing their own prompt is how
// you end up with six vocabularies and no way to group the results.

interface Props {
  action: 'approve' | 'decline'
  // Rendered above the presets: which transaction, or how many.
  subject: string
  busy?: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}

export default function DecisionReason({ action, subject, busy, onCancel, onConfirm }: Props) {
  const { t } = useLocale()
  const [picked, setPicked] = useState<string | null>(null)
  const [free, setFree] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Escape closes. A modal over a money decision must never be a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  const reason = (picked ?? free).trim()
  const ready = reasonIsValid(reason)
  const approve = action === 'approve'

  return (
    <div className="drawer-backdrop" onClick={() => !busy && onCancel()}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="drawer-head">
          <h3>{approve ? `✅ ${t('سبب القبول', 'Reason for approval')}` : `❌ ${t('سبب الرفض', 'Reason for decline')}`}</h3>
          <button className="btn-ghost btn-sm" disabled={busy} onClick={onCancel}>✕</button>
        </div>

        <p className="cell-sub" style={{ marginBottom: 10 }}>{subject}</p>

        <div className="chip-row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {reasonsFor(action).map((r) => (
            <button
              key={r}
              type="button"
              className={`chip${picked === r ? ' chip-active' : ''}`}
              disabled={busy}
              onClick={() => { setPicked(picked === r ? null : r); setFree('') }}
            >
              {r}
            </button>
          ))}
        </div>

        <label className="cell-sub" htmlFor="decision-reason-free">
          {t('أو اكتب سبباً آخر', 'Or write another reason')}
        </label>
        <textarea
          id="decision-reason-free"
          ref={inputRef}
          className="reason-input"
          rows={3}
          maxLength={500}
          dir="auto"
          disabled={busy}
          value={free}
          placeholder={t('اكتب السبب بالعربية…', 'Write the reason…')}
          onChange={(e) => { setFree(e.target.value); setPicked(null) }}
        />

        {!ready && reason.length > 0 && (
          <p className="cell-sub" style={{ color: 'var(--warn, #f59e0b)' }}>
            {t(`السبب قصير جداً — ${MIN_REASON_LENGTH} أحرف على الأقل.`, `Reason too short — at least ${MIN_REASON_LENGTH} characters.`)}
          </p>
        )}

        <div className="drawer-actions" style={{ marginTop: 12 }}>
          <button
            className={approve ? 'btn-primary' : 'btn-ghost danger'}
            disabled={!ready || busy}
            onClick={() => onConfirm(reason)}
          >
            {busy
              ? t('جارٍ التنفيذ…', 'Working…')
              : approve ? t('تأكيد القبول', 'Confirm approval') : t('تأكيد الرفض', 'Confirm decline')}
          </button>
          <button className="btn-ghost" disabled={busy} onClick={onCancel}>{t('إلغاء', 'Cancel')}</button>
        </div>

        <p className="drawer-note">
          {t('السبب يُسجَّل مع القرار في سجل القرارات وسجل التدقيق، ولا يمكن اتخاذ القرار بدونه.',
             'The reason is stored with the decision in the decision log and the audit log, and no decision is possible without it.')}
        </p>
      </aside>
    </div>
  )
}
