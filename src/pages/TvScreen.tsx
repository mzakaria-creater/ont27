import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { depositTime, money, statusMeta } from '../lib/deposits'
import type { DepositRow, DepositStats } from '../lib/deposits'

// 🖥️ شاشة TV — full-screen live operations wall (from the control room's
// tvscreen view), driven by the panel's own APIs. Auto-refreshes every 10s.

const REFRESH_MS = 10_000

interface TvSms {
  id: number
  received_at: string | null
  device_name: string | null
  sender_name: string | null
  sender_number: string | null
  amount: number | null
  sms_category: string | null
  matched: boolean | null
  match_status: string | null
  trx_id: string | null
  maven_transaction_id: number | null
}

interface TvPayout {
  maven_id: number
  ontarget_ref: string | null
  status: string
  amount: number | null
  account_name: string | null
  mobile_no: string | null
  first_seen_at: string | null
  created_utc: string | null
}

interface ControlStats {
  stats: Record<string, unknown> | null
  queue: unknown[]
  settings: { automation_enabled: boolean | null } | null
}

export default function TvScreen() {
  const [stats, setStats] = useState<DepositStats | null>(null)
  const [control, setControl] = useState<ControlStats | null>(null)
  const [sms, setSms] = useState<TvSms[]>([])
  const [matched, setMatched] = useState<TvSms[]>([])
  const [payouts, setPayouts] = useState<TvPayout[]>([])
  const [now, setNow] = useState(new Date())

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api<DepositStats>('/api/deposits/stats'),
      api<{ rows: TvSms[] }>('/api/sms?limit=9'),
      api<{ rows: TvSms[] }>('/api/sms?match=linked&limit=9'),
      api<{ rows: TvPayout[] }>('/api/payouts?limit=6'),
      api<ControlStats>('/api/control/status'),
    ])
    if (results[0].status === 'fulfilled') setStats(results[0].value)
    if (results[1].status === 'fulfilled') setSms(results[1].value.rows)
    if (results[2].status === 'fulfilled') setMatched(results[2].value.rows)
    if (results[3].status === 'fulfilled') setPayouts(results[3].value.rows)
    if (results[4].status === 'fulfilled') setControl(results[4].value)
  }, [])

  useEffect(() => {
    void load()
    const iv = setInterval(() => void load(), REFRESH_MS)
    const clock = setInterval(() => setNow(new Date()), 1000)
    return () => { clearInterval(iv); clearInterval(clock) }
  }, [load])

  const cStats = control?.stats ?? {}
  const acceptRate = (cStats.approval_rate as number | undefined) ??
    (stats && stats.day.paid.count + stats.day.declined > 0
      ? Math.round((stats.day.paid.count / (stats.day.paid.count + stats.day.declined)) * 100)
      : null)

  const kpis: { label: string; value: string | number; cls?: string }[] = [
    { label: 'معلّقة الآن', value: stats?.pending ?? '…', cls: 'amber' },
    { label: 'مقبول اليوم', value: (cStats.today_approved as number | undefined) ?? stats?.day.paid.count ?? '…', cls: 'green' },
    { label: 'مرفوض اليوم', value: (cStats.today_declined as number | undefined) ?? stats?.day.declined ?? '…', cls: 'red' },
    { label: 'نسبة القبول', value: acceptRate != null ? `${acceptRate}%` : '…' },
    { label: 'حجم اليوم EGP', value: stats ? money(stats.day.paid.volume, '') : '…' },
    { label: 'طابور التحكم', value: control ? control.queue.length : '—', cls: 'amber' },
    { label: 'نُفّذ اليوم', value: (cStats.jobs_completed_today as number | undefined) ?? '—', cls: 'green' },
  ]

  const clock = now.toLocaleTimeString('en-GB', { timeZone: 'Africa/Cairo', hour12: false })

  return (
    <div className="tv-page">
      <header className="tv-head">
        <h1>⚡ OnTarget — غرفة المراقبة الحية</h1>
        <div className="tv-head-side">
          {control?.settings && (
            <span className={`pay-status-badge ${control.settings.automation_enabled ? 'st-paid' : 'st-declined'}`}>
              الأتمتة {control.settings.automation_enabled ? 'تعمل' : 'متوقفة'}
            </span>
          )}
          <span className="live-dot"><span className="ld" />مباشر</span>
          <span className="tv-clock mono">{clock}</span>
          <Link to="/" className="btn-ghost btn-sm">✕ خروج</Link>
        </div>
      </header>

      <div className="tv-kpis">
        {kpis.map((k) => (
          <div key={k.label} className={`tv-kpi ${k.cls ?? ''}`}>
            <span className="tv-kpi-value mono">{k.value}</span>
            <span className="tv-kpi-label">{k.label}</span>
          </div>
        ))}
      </div>

      <div className="tv-cols">
        <section className="tv-col">
          <h3>📨 رسائل SMS حية</h3>
          <div className="tv-feed">
            {sms.map((s) => (
              <div key={s.id} className={`tv-item${s.matched ? ' ok' : ''}`}>
                <div className="tv-item-head">
                  <span className="mono">#{s.id} · {s.device_name ?? '—'}</span>
                  <span className="mono dim">{depositTime({ first_seen_at: s.received_at })}</span>
                </div>
                <div className="tv-item-main">
                  <b className="mono">{money(s.amount, 'EGP')}</b>
                  {' '}{s.sms_category === 'withdrawal' ? '📤' : '📥'}{' '}
                  {s.sender_name ?? s.sender_number ?? '—'}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="tv-col">
          <h3>🎯 مطابقة تلقائية</h3>
          <div className="tv-feed">
            {matched.map((s) => (
              <div key={s.id} className="tv-item ok">
                <div className="tv-item-head">
                  <span className="mono">SMS #{s.id}</span>
                  <span className="mono dim">{depositTime({ first_seen_at: s.received_at })}</span>
                </div>
                <div className="tv-item-main">
                  <b className="mono">{money(s.amount, 'EGP')}</b> ← معاملة{' '}
                  <span className="mono">{s.maven_transaction_id ?? s.trx_id ?? '—'}</span>
                </div>
              </div>
            ))}
            {matched.length === 0 && <p className="dim">لا توجد مطابقات بعد.</p>}
          </div>
        </section>

        <section className="tv-col">
          <h3>💳 معاملات حية</h3>
          <div className="tv-feed">
            {(stats?.recent ?? []).slice(0, 9).map((r: DepositRow) => {
              const st = statusMeta(r.status)
              return (
                <div key={r.tx_id} className={`tv-item${r.status === 'PENDING' ? ' warn' : ''}`}>
                  <div className="tv-item-head">
                    <span className="mono">{r.ontarget_ref ?? r.tx_id}</span>
                    <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
                  </div>
                  <div className="tv-item-main">
                    <b className="mono">{money(r.amount, r.currency)}</b>
                    {' '}{r.sender_name ?? '—'} · {r.merchant ?? '—'}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <footer className="tv-payouts">
        <h3>💸 السحب الصادر</h3>
        <div className="tv-payout-row">
          {payouts.map((p) => {
            const st = statusMeta(p.status)
            return (
              <div key={p.maven_id} className="tv-payout">
                <span className="mono">{p.ontarget_ref ?? p.maven_id}</span>
                <b className="mono">{money(p.amount, 'EGP')}</b>
                <span>{p.account_name ?? p.mobile_no ?? '—'}</span>
                <span className={`pay-status-badge ${st.cls}`}>{st.label}</span>
              </div>
            )
          })}
        </div>
      </footer>
    </div>
  )
}
