import { useCallback, useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Money in and out per wallet, both directions.
//
// Grouped on inbound_sms.wallet_number rather than receiver_number. The two
// agree on deposits but not on withdrawals: receiver_number there holds the
// customer being paid, not the wallet paying them (121 of 150 withdrawals in
// a 7-day sample), so the old grouping filed outgoing money under a stranger's
// phone number and no wallet balance built from it could be right.

interface WalletRow {
  wallet: string
  device: string | null
  simSlot: string | null
  provider: string | null
  mapped: boolean
  smsTotal: number
  deposits: number
  withdrawals: number
  inAmount: number
  outAmount: number
  net: number
  matched: number
  unmatched: number
  matchRate: number | null
  balance: number | null
  balanceAt: string | null
  lastSmsAt: string | null
  firstSmsAt: string | null
}
interface Silent { wallet: string; device: string | null; simSlot: number | null }
interface Movements {
  days: number
  generatedAt: string
  wallets: WalletRow[]
  silentWallets: Silent[]
}

const WINDOWS = [
  { days: 1, ar: '24 ساعة', en: '24h' },
  { days: 7, ar: '7 أيام', en: '7 days' },
  { days: 30, ar: '30 يوماً', en: '30 days' },
] as const

// A wallet that has taken money in but is nearly empty cannot fund the next
// payout, which is the one thing a treasury view exists to catch early.
const LOW_BALANCE = 500

export default function WalletMovements() {
  const { t } = useLocale()
  const [days, setDays] = useState<number>(7)
  const [data, setData] = useState<Movements | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api<Movements>(`/api/wallets/movements?days=${days}`)
      .then((d) => { setData(d); setErr(null) })
      .catch(() => setErr(t('تعذّر تحميل حركة المحافظ.', 'Could not load wallet movements.')))
  }, [days, t])

  useEffect(() => {
    load()
    const iv = setInterval(load, 60_000)
    return () => clearInterval(iv)
  }, [load])

  const totals = useMemo(() => {
    const w = data?.wallets ?? []
    return {
      in: w.reduce((a, b) => a + Number(b.inAmount), 0),
      out: w.reduce((a, b) => a + Number(b.outAmount), 0),
      deposits: w.reduce((a, b) => a + b.deposits, 0),
      withdrawals: w.reduce((a, b) => a + b.withdrawals, 0),
      unmatched: w.reduce((a, b) => a + b.unmatched, 0),
    }
  }, [data])

  const lowBalance = (data?.wallets ?? []).filter(
    (w) => w.balance != null && Number(w.balance) < LOW_BALANCE && Number(w.outAmount) > 0,
  )
  const maxFlow = Math.max(1, ...(data?.wallets ?? []).map((w) => Number(w.inAmount) + Number(w.outAmount)))

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('حركة المحافظ', 'Wallet movements')}</h2>
        <p className="page-sub">
          {t(
            'وارد وصادر لكل محفظة من رسائل SMS الفعلية. السحوبات مُسنَدة إلى المحفظة التي خرج منها المال، لا إلى رقم العميل المستلم.',
            'Money in and out per wallet from real SMS. Withdrawals are attributed to the wallet the money left, not to the customer who received it.',
          )}
          {data && <> · {t('تحديث', 'Updated')} {new Date(data.generatedAt).toLocaleTimeString()}</>}
        </p>
        <div className="filter-bar">
          {WINDOWS.map((w) => (
            <button key={w.days} className={days === w.days ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setDays(w.days)}>
              {t(w.ar, w.en)}
            </button>
          ))}
          <button className="btn-ghost btn-sm" onClick={load}>{t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <div className="card">{t('جارٍ التحميل…', 'Loading…')}</div>}

      {data && (
        <>
          {lowBalance.length > 0 && (
            <div className="card warn">
              <strong>{t('رصيد منخفض على محفظة تدفع', 'Low balance on a paying wallet')}</strong>
              <ul className="plain-list">
                {lowBalance.map((w) => (
                  <li key={w.wallet}>
                    <span className="mono">{w.wallet}</span> ({w.device ?? '—'}) — {money(w.balance, 'EGP')}،{' '}
                    {t(`صرفت ${money(w.outAmount, 'EGP')} في هذه النافذة`, `paid out ${money(w.outAmount, 'EGP')} in this window`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.silentWallets.length > 0 && (
            <div className="card">
              <div className="section-label">{t('محافظ بلا أي رسالة في هذه النافذة', 'Wallets with no SMS in this window')}</div>
              <p className="cell-sub">
                {t(
                  'مُسجَّلة في خريطة الأجهزة لكنها لم تُنتج أي حركة — لا تظهر في الجدول أدناه لأنه مبنيّ على رسائل موجودة.',
                  'Mapped in the device table but produced no traffic — they cannot appear below, which is built from SMS that exist.',
                )}
              </p>
              <div className="chip-row">
                {data.silentWallets.map((s) => (
                  <span key={s.wallet} className="pay-status-badge st-dim">
                    <span className="mono">{s.wallet}</span>{s.device ? ` · ${s.device}` : ` · ${t('بلا جهاز', 'no device')}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-value">{money(totals.in, 'EGP')}</div>
              <div className="kpi-label">{t('وارد', 'Money in')}</div>
              <div className="cell-sub">{totals.deposits} {t('رسالة إيداع', 'deposit SMS')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{money(totals.out, 'EGP')}</div>
              <div className="kpi-label">{t('صادر', 'Money out')}</div>
              <div className="cell-sub">{totals.withdrawals} {t('رسالة سحب', 'withdrawal SMS')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{money(totals.in - totals.out, 'EGP')}</div>
              <div className="kpi-label">{t('الصافي', 'Net')}</div>
              <div className="cell-sub">{t('وارد ناقص صادر', 'in less out')}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{totals.unmatched}</div>
              <div className="kpi-label">{t('إيداعات بلا مطابقة', 'Unmatched deposits')}</div>
              <div className="cell-sub">{t('رسالة لم تُطالِب بها معاملة', 'SMS no transaction claimed')}</div>
            </div>
          </div>

          <section className="card">
            <div className="section-label">{t('لكل محفظة', 'Per wallet')}</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('المحفظة', 'Wallet')}</th>
                    <th>{t('الجهاز', 'Device')}</th>
                    <th>{t('وارد', 'In')}</th>
                    <th>{t('صادر', 'Out')}</th>
                    <th>{t('الصافي', 'Net')}</th>
                    <th>{t('الرصيد', 'Balance')}</th>
                    <th>{t('مطابقة الإيداعات', 'Deposit match')}</th>
                    <th>{t('آخر رسالة', 'Last SMS')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.wallets.map((w) => {
                    const flow = (Number(w.inAmount) + Number(w.outAmount)) / maxFlow
                    return (
                      <tr key={w.wallet}>
                        <td className="mono">
                          {w.wallet}
                          {!w.mapped && <div className="cell-sub">{t('غير مُعرَّفة في خريطة الأجهزة', 'not in the device map')}</div>}
                        </td>
                        <td>{w.device ?? '—'}{w.simSlot ? ` / SIM${w.simSlot}` : ''}</td>
                        <td className="mono">
                          {money(w.inAmount, 'EGP')}
                          <div className="cell-sub">{w.deposits}</div>
                        </td>
                        <td className="mono">
                          {money(w.outAmount, 'EGP')}
                          <div className="cell-sub">{w.withdrawals}</div>
                        </td>
                        <td className="mono">
                          {money(w.net, 'EGP')}
                          <div className="analytics-bar"><i style={{ width: `${flow * 100}%` }} /></div>
                        </td>
                        <td className="mono">
                          {w.balance == null ? '—' : money(w.balance, 'EGP')}
                          {w.balanceAt && <div className="cell-sub">{new Date(w.balanceAt).toLocaleString()}</div>}
                        </td>
                        <td className="mono">
                          {w.matchRate == null ? '—' : `${w.matchRate}%`}
                          {w.deposits > 0 && <div className="cell-sub">{w.matched}/{w.deposits}</div>}
                        </td>
                        <td className="mono">{w.lastSmsAt ? new Date(w.lastSmsAt).toLocaleString() : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="cell-sub">
              {t(
                'الرصيد هو آخر قيمة أعلنتها رسالة من المحفظة، لا استعلام حيّ من المزوّد — فهو صحيح لحظة تلك الرسالة فقط.',
                'Balance is the last figure an SMS from that wallet reported, not a live query to the provider — accurate as of that message only.',
              )}
            </p>
          </section>
        </>
      )}
    </PanelShell>
  )
}
