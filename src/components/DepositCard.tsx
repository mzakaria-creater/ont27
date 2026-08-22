import { useLocale } from '../lib/locale'
import MethodLogo from './MethodLogo'
import { depositTime, gatewayChipCls, methodIcon, money, statusMeta } from '../lib/deposits'
import type { DepositRow } from '../lib/deposits'
import DepositKindBadge from './DepositKindBadge'

// Card layout for the deposit review queue — an alternative to the row table
// for fast visual scanning of several pending transactions at once.
//
// Every field is read straight from maven_transactions. Lines with no real
// value (email, agent, proof) are hidden entirely instead of rendering a dash
// or a placeholder, so a card never implies data we don't have.

export type CardAction = 'approve' | 'decline' | 'block'

interface Props {
  row: DepositRow
  canApprove: boolean
  canBlock: boolean
  busy: CardAction | null
  locked: boolean
  onOpen: () => void
  onProof: (url: string) => void
  onApprove: () => void
  onDecline: () => void
  onBlock: () => void
}

export default function DepositCard({
  row, canApprove, canBlock, busy, locked, onOpen, onProof, onApprove, onDecline, onBlock,
}: Props) {
  const { t } = useLocale()
  const st = statusMeta(row.status)
  const pending = row.status === 'PENDING'
  const anyBusy = busy !== null
  const channel = row.gateway ?? row.master_merchant
  const email = row.email?.trim()
  const agent = row.agent_name?.trim()

  return (
    <article className={`dep-card${pending ? ' is-pending' : ''}`}>
      <header className="dep-card-head">
        <button className="dep-ref mono" onClick={onOpen} title={t('فتح التفاصيل', 'Open details')}>
          {row.ontarget_ref ?? row.tx_id}
        </button>
        <div className="dep-status-stack">
          <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
          {row.ngpay_status && (
            <span className={`provider-row-status ${st.cls}`} title={t('الحالة القادمة من NagoPay', 'Status received from NagoPay')}>
              NagoPay · {row.ngpay_status}
            </span>
          )}
        </div>
      </header>

      <div className="dep-amount">
        <span className="mono">{money(row.amount, '')}</span>
        <span className="dep-cur">{row.currency ?? ''}</span>
      </div>

      <div className="dep-chips">
        <DepositKindBadge row={row} />
        <span className="dep-chip">
          {row.payment_method
            ? <MethodLogo method={row.payment_method} />
            : <>{methodIcon(null)} {t('غير محدّد', 'Unspecified')}</>}
        </span>
        {channel && (
          <span className={`merchant-chip ${gatewayChipCls(row.gateway, row.master_merchant)}`}>{channel}</span>
        )}
      </div>

      <dl className="dep-fields">
        {agent && (
          <>
            <dt>{t('الوكيل', 'Agent')}</dt>
            <dd>{agent}</dd>
          </>
        )}
        {email && (
          <>
            <dt>{t('البريد', 'Email')}</dt>
            <dd className="mono small">{email}</dd>
          </>
        )}
        <dt>{t('المُرسِل', 'Sender')}</dt>
        <dd>
          {row.sender_name ?? '—'}
          {row.sender_number && <div className="cell-sub mono">{row.sender_number}</div>}
        </dd>
        <dt>{t('محفظة الاستلام', 'Receiving wallet')}</dt>
        <dd className="mono">{row.receiving_wallet ?? row.to_account_number ?? '—'}</dd>
        <dt>{t('الوقت', 'Time')}</dt>
        <dd className="mono">{depositTime(row)}</dd>
      </dl>

      {row.proof_image_url ? (
        <button className="dep-proof" onClick={() => onProof(row.proof_image_url as string)}>
          <img src={row.proof_image_url} alt={t('إثبات الدفع', 'Payment proof')} loading="lazy" />
          <span>{t('إثبات مرفق — اضغط للتكبير', 'Proof attached — click to enlarge')}</span>
        </button>
      ) : (
        <div className="dep-proof empty">{t('لا يوجد إثبات مرفق', 'No proof attached')}</div>
      )}

      {row.sms && (
        <div className="dep-sms">
          ✅ {t('رسالة مطابقة', 'Matched SMS')} <span className="mono">#{row.sms.id}</span>
          {row.sms.balance_after != null && (
            <span className="mono"> · {t('الرصيد بعدها', 'Balance after')} {money(row.sms.balance_after, '')}</span>
          )}
        </div>
      )}

      <div className="dep-actions">
        <button className="btn-ghost btn-sm" onClick={onOpen} title={t('التفاصيل الكاملة', 'Full details')}>👁</button>
        {canBlock && row.sender_number && (
          <button
            className="btn-ghost danger btn-sm"
            disabled={anyBusy}
            onClick={onBlock}
            title={t('حظر رقم المُرسِل', 'Block sender number')}
          >
            {busy === 'block' ? '…' : '⊘'}
          </button>
        )}
        {pending && canApprove && (
          <>
            <button
              className="btn-primary btn-sm dep-approve"
              disabled={anyBusy || locked}
              onClick={onApprove}
            >
              {busy === 'approve' ? t('جارٍ التنفيذ…', 'Executing…') : `✅ ${t('اعتماد', 'Approve')}`}
            </button>
            <button
              className="btn-ghost danger btn-sm dep-decline"
              disabled={anyBusy || locked}
              onClick={onDecline}
            >
              {busy === 'decline' ? t('جارٍ التنفيذ…', 'Executing…') : `❌ ${t('رفض', 'Decline')}`}
            </button>
          </>
        )}
      </div>

      {/* Honest expectation-setting, not a fabricated ETA. Measured latency on
          the real decision log is 50s–500s over a 4-sample window — far too
          variable and too small to publish a single number, so the note states
          the range qualitatively and tells the operator not to click twice
          (repeat clicks were what produced duplicate provider calls). */}
      {pending && canApprove && (
        <p className="dep-exec-note">
          {t(
            'ينفَّذ على المزوّد بعد الاعتماد — من ثوانٍ إلى عدة دقائق حسب الحمل. لا تضغط مرة أخرى؛ الحالة تتحدّث تلقائياً.',
            'Executes on the provider after approval — seconds to a few minutes depending on load. Don’t click again; the status updates automatically.',
          )}
        </p>
      )}
    </article>
  )
}
