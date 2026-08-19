import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api, ApiError } from '../lib/api'
import { STATUS_META, money, statusMeta } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Edit a transaction's status or amount.
//
// Stewards (super_admin / owner / admin) apply the change directly. Everyone
// else raises a request that goes to Mina and Eslam on Telegram and is applied
// only once one of them approves it in the panel.
//
// The panel is explicit about what actually reaches the provider, because the
// two cases are genuinely different and confusing them is how undocumented
// divergence gets created:
//   · NGPay + still PENDING + target PAID/DECLINED → real execution on Maven.
//   · anything else, and every amount change → local correction only.

const STEWARD_ROLES = new Set(['super_admin', 'owner', 'admin'])

interface Props {
  txId: number
  ontargetRef: string | null
  status: string
  amount: number | null
  currency: string | null
  gateway: string | null
  onDone: () => void
}

export default function TransactionEditPanel({
  txId, ontargetRef, status, amount, currency, gateway, onDone,
}: Props) {
  const { t } = useLocale()
  const { user } = useAuth()
  const isSteward = STEWARD_ROLES.has(user?.role ?? '')

  const [open, setOpen] = useState(false)
  const [nextStatus, setNextStatus] = useState('')
  const [nextAmount, setNextAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const changingStatus = nextStatus !== '' && nextStatus !== status
  const changingAmount = nextAmount.trim() !== '' && Number(nextAmount) !== Number(amount)
  const canSubmit = (changingStatus || changingAmount) && reason.trim().length > 0 && !busy

  // Mirrors the server's rule exactly — this is the one thing the operator
  // must not be misled about.
  const hitsProvider =
    changingStatus && gateway === 'NagupayP2P' && status === 'PENDING' &&
    (nextStatus === 'PAID' || nextStatus === 'DECLINED')

  const submit = async () => {
    setBusy(true)
    setErr(null)
    setDone(null)
    const payload = {
      status: changingStatus ? nextStatus : null,
      amount: changingAmount ? Number(nextAmount) : null,
      reason: reason.trim(),
    }
    try {
      if (isSteward) {
        const res = await api<{ local_only: boolean; executed_on_provider: boolean }>(
          `/api/tx/${txId}/edit`, { method: 'POST', body: JSON.stringify(payload) },
        )
        setDone(res.executed_on_provider
          ? t('نُفِّذ على المزوّد وتأكّد.', 'Executed on the provider and confirmed.')
          : t('تم التعديل محلياً (لم يُرسَل للمزوّد).', 'Edited locally (not sent to the provider).'))
        onDone()
      } else {
        const res = await api<{ telegram: { sent: number; error?: string } }>(
          `/api/tx/${txId}/edit-request`, { method: 'POST', body: JSON.stringify(payload) },
        )
        setDone(res.telegram.sent > 0
          ? t(`أُرسل الطلب إلى ${res.telegram.sent} من المسؤولين على تيليجرام.`, `Request sent to ${res.telegram.sent} approver(s) on Telegram.`)
          : t(`سُجِّل الطلب، لكن لم يصل تيليجرام${res.telegram.error ? `: ${res.telegram.error}` : ''} — أبلغ المسؤول يدوياً.`,
              `Request saved, but Telegram delivery failed${res.telegram.error ? `: ${res.telegram.error}` : ''} — tell an approver directly.`))
      }
      setNextStatus('')
      setNextAmount('')
      setReason('')
    } catch (e) {
      if (e instanceof ApiError && e.code === 'steward_role_required') {
        setErr(t('هذا التعديل يحتاج دور مسؤول.', 'This edit requires a steward role.'))
      } else if (e instanceof ApiError && e.code === 'worker_failed') {
        setErr(t('فشل التنفيذ على المزوّد — لم يتغيّر شيء.', 'Provider execution failed — nothing changed.'))
      } else {
        setErr(t('تعذّر تنفيذ الطلب.', 'The request could not be completed.'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card recent-card">
      <div className="recent-head">
        <h3>✏️ {t('تعديل المعاملة', 'Edit transaction')}</h3>
        <button className="btn-ghost btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? t('إغلاق', 'Close') : isSteward ? t('تعديل', 'Edit') : t('طلب تعديل', 'Request edit')}
        </button>
      </div>

      {!open && (
        <p className="cell-sub">
          {isSteward
            ? t('يمكنك تعديل الحالة أو المبلغ مباشرة — كل تعديل يُسجَّل في سجل التدقيق.', 'You can change the status or amount directly — every edit is written to the audit log.')
            : t('دورك لا يسمح بالتعديل المباشر. يمكنك إرسال طلب إلى مينا وإسلام على تيليجرام.', 'Your role cannot edit directly. You can send a request to Mina and Eslam on Telegram.')}
        </p>
      )}

      {open && (
        <>
          <div className="detail-grid" style={{ marginBottom: 12 }}>
            <dt>{t('الحالة الحالية', 'Current status')}</dt>
            <dd><span className={`pay-status-badge ${statusMeta(status).cls}`}>{statusMeta(status).label}</span></dd>
            <dt>{t('المبلغ الحالي', 'Current amount')}</dt>
            <dd className="mono">{money(amount, currency)}</dd>
          </div>

          <label className="field-label">{t('الحالة الجديدة', 'New status')}</label>
          <select className="login-input" value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} disabled={busy}>
            <option value="">{t('— بدون تغيير —', '— no change —')}</option>
            {Object.keys(STATUS_META).filter((s) => s !== status).map((s) => (
              <option key={s} value={s}>{statusMeta(s).label}</option>
            ))}
          </select>

          <label className="field-label">{t('المبلغ الجديد', 'New amount')}</label>
          <input
            className="login-input" dir="ltr" inputMode="decimal" placeholder={String(amount ?? '')}
            value={nextAmount} onChange={(e) => setNextAmount(e.target.value)} disabled={busy}
          />

          <label className="field-label">{t('السبب (إلزامي)', 'Reason (required)')}</label>
          <input
            className="login-input" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}
            placeholder={t('لماذا يجب تغيير هذه المعاملة؟', 'Why does this transaction need changing?')}
          />

          {(changingStatus || changingAmount) && (
            <p className={`drawer-note${hitsProvider ? '' : ' warn-text'}`} style={{ marginTop: 10 }}>
              {hitsProvider
                ? t(
                    'سيُنفَّذ هذا فعلياً على المزوّد عبر ngpay-approve، ولن تُكتب الحالة عندنا إلا بعد إعادة قراءتها من المزوّد وتأكيد تطابقها.',
                    'This will really execute on the provider through ngpay-approve, and the status is written here only after a read-back from the provider confirms it matches.',
                  )
                : t(
                    'تصحيح محلي فقط — لن يُرسَل للمزوّد. سيظهر في سجل التدقيق بعلامة local_only، وقد يختلف عن حالة المعاملة لدى المزوّد.',
                    'Local correction only — the provider is not told. It is written to the audit log flagged local_only, and may differ from the provider’s own status.',
                  )}
              {changingAmount && ` ${t('تعديل المبلغ محلي دائماً.', 'Amount edits are always local.')}`}
            </p>
          )}

          {err && <div className="card warn" style={{ marginTop: 10 }}>{err}</div>}
          {done && <div className="card" style={{ marginTop: 10 }}>{done}</div>}

          <div className="drawer-actions" style={{ marginTop: 12 }}>
            <button className="btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
              {busy
                ? t('جارٍ التنفيذ…', 'Working…')
                : isSteward ? t('طبّق التعديل', 'Apply edit') : t('أرسل الطلب', 'Send request')}
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>{t('إلغاء', 'Cancel')}</button>
          </div>
          <p className="cell-sub" style={{ marginTop: 8 }}>
            {t('المرجع', 'Ref')}: <span className="mono">{ontargetRef ?? txId}</span>
          </p>
        </>
      )}
    </section>
  )
}
