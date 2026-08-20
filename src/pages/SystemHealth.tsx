import { useCallback, useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { useLocale } from '../lib/locale'

// System health.
//
// Deliberately absent: CPU, RAM and disk dials. Those are Supabase's own
// infrastructure metrics and the app has no truthful source for them, so a gauge
// here would be decoration that looks authoritative. Everything below is derived
// from rows we hold, and anything with no data in the window renders as "no
// data" rather than a confident 0%.

interface Gauge { value: number | null; of: number; unit: string }
interface HealthData {
  generatedAt: string
  gauges: { smsMatchRate: Gauge; devicesOnline: Gauge; telegramDelivery: Gauge; approvalRate: Gauge }
  freshness: { newestTransactionAgeSec: number | null; newestSmsAgeSec: number | null }
  queues: { pendingDeposits: number; pendingPayouts: number; editRequestsPending: number }
  series: {
    txByHour: { hour: string; paid: number; declined: number; pending: number; other: number }[]
    smsByHour: { hour: string; total: number; matched: number }[]
  }
  devices: {
    device: string; sim_number: string | null; operator: string | null
    battery: number | null; charging: boolean | null; net_type: string | null
    online: boolean | null; balance: number | null; balance_at: string | null; last_seen_at: string | null
  }[]
  telegram: { alert_type: string; ok: number; failed: number; lastError: string | null }[]
}

// Green until it slips, amber, then red. Higher is better for every gauge here.
function band(v: number | null): string {
  if (v == null) return 'none'
  if (v >= 90) return 'good'
  if (v >= 60) return 'warn'
  return 'bad'
}

function Arc({ value }: { value: number | null }) {
  // Semicircle, 180° sweep. r=52 gives a 163.4 arc length, so the dash offset is
  // just the remaining fraction of that.
  const len = Math.PI * 52
  const frac = value == null ? 0 : Math.min(Math.max(value, 0), 100) / 100
  return (
    <svg viewBox="0 0 120 66" className="gauge-svg" role="img">
      <path d="M 8 60 A 52 52 0 0 1 112 60" className="gauge-track" strokeDasharray={len} />
      {value != null && (
        <path d="M 8 60 A 52 52 0 0 1 112 60" className="gauge-fill" strokeDasharray={`${len * frac} ${len}`} />
      )}
    </svg>
  )
}

function GaugeTile({ title, gauge, sub }: { title: string; gauge: Gauge; sub: string }) {
  return (
    <div className={`gauge-tile band-${band(gauge.value)}`}>
      <div className="gauge-title">{title}</div>
      <div className="gauge-body">
        <Arc value={gauge.value} />
        <div className="gauge-value">
          {gauge.value == null ? '—' : <>{gauge.value}<span className="gauge-unit">{gauge.unit}</span></>}
        </div>
      </div>
      <div className="gauge-sub">{sub}</div>
    </div>
  )
}

// Stacked hourly bars. A zero hour still draws its slot so a gap in traffic is
// visible as a gap rather than vanishing from the axis.
function HourBars({ rows, keys, labels }: {
  rows: Record<string, number | string>[]
  keys: string[]
  labels: string[]
}) {
  const max = Math.max(1, ...rows.map((r) => keys.reduce((a, k) => a + Number(r[k] ?? 0), 0)))
  return (
    <div className="hchart">
      <div className="hchart-plot">
        {rows.map((r, i) => {
          const total = keys.reduce((a, k) => a + Number(r[k] ?? 0), 0)
          const hour = String(r.hour).slice(11)
          return (
            <div className="hchart-col" key={i} title={`${hour}:00 — ${keys.map((k, j) => `${labels[j]} ${r[k] ?? 0}`).join(' · ')}`}>
              <div className="hchart-stack">
                {keys.map((k, j) => {
                  const v = Number(r[k] ?? 0)
                  return v > 0
                    ? <div key={k} className={`hchart-seg seg-${j}`} style={{ height: `${(v / max) * 100}%` }} />
                    : null
                })}
              </div>
              {i % 4 === 0 && <div className="hchart-x">{hour}</div>}
              {total === 0 && <div className="hchart-zero" />}
            </div>
          )
        })}
      </div>
      <div className="hchart-legend">
        {labels.map((l, j) => <span key={l}><i className={`seg-${j}`} />{l}</span>)}
      </div>
    </div>
  )
}

const ago = (sec: number | null, t: (a: string, e: string) => string): string => {
  if (sec == null) return t('لا بيانات', 'no data')
  if (sec < 90) return t(`${sec} ث`, `${sec}s`)
  const m = Math.round(sec / 60)
  if (m < 90) return t(`${m} د`, `${m}m`)
  return t(`${Math.round(m / 60)} س`, `${Math.round(m / 60)}h`)
}

export default function SystemHealth() {
  const { t } = useLocale()
  const [data, setData] = useState<HealthData | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api<HealthData>('/api/system-health')
      .then((d) => { setData(d); setErr(null) })
      .catch(() => setErr(t('تعذّر تحميل حالة النظام.', 'Could not load system health.')))
  }, [t])

  useEffect(() => {
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [load])

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('حالة النظام', 'System health')}</h2>
        <p className="page-sub">
          {t(
            'مقاييس محسوبة من بياناتنا الفعلية خلال 24 ساعة، تُحدَّث كل 30 ثانية. لا تُعرض مقاييس البنية التحتية (CPU/RAM/القرص) لأنها لا تتوفر لنا من داخل التطبيق.',
            'Metrics computed from our own data over 24 hours, refreshed every 30s. Infrastructure metrics (CPU/RAM/disk) are not shown because the app has no truthful source for them.',
          )}
        </p>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <div className="card">{t('جارٍ التحميل…', 'Loading…')}</div>}

      {data && (
        <>
          <div className="gauge-grid">
            <GaugeTile
              title={t('مطابقة SMS', 'SMS match rate')}
              gauge={data.gauges.smsMatchRate}
              sub={t(`من ${data.gauges.smsMatchRate.of} رسالة إيداع`, `of ${data.gauges.smsMatchRate.of} deposit SMS`)}
            />
            <GaugeTile
              title={t('الأجهزة المتصلة', 'Devices online')}
              gauge={data.gauges.devicesOnline}
              sub={t(`من ${data.gauges.devicesOnline.of} جهاز`, `of ${data.gauges.devicesOnline.of} devices`)}
            />
            <GaugeTile
              title={t('تسليم Telegram', 'Telegram delivery')}
              gauge={data.gauges.telegramDelivery}
              sub={t(`من ${data.gauges.telegramDelivery.of} رسالة`, `of ${data.gauges.telegramDelivery.of} sends`)}
            />
            <GaugeTile
              title={t('نسبة الاعتماد', 'Approval rate')}
              gauge={data.gauges.approvalRate}
              sub={t(`من ${data.gauges.approvalRate.of} قرار`, `of ${data.gauges.approvalRate.of} decided`)}
            />

            <div className="stat-tile">
              <div className="gauge-title">{t('أحدث معاملة', 'Newest transaction')}</div>
              <div className="stat-big mono">{ago(data.freshness.newestTransactionAgeSec, t)}</div>
              <div className="gauge-sub">{t('منذ وصولها', 'since it arrived')}</div>
            </div>
            <div className="stat-tile">
              <div className="gauge-title">{t('أحدث SMS', 'Newest SMS')}</div>
              <div className="stat-big mono">{ago(data.freshness.newestSmsAgeSec, t)}</div>
              <div className="gauge-sub">{t('منذ وصولها', 'since it arrived')}</div>
            </div>
            <div className="stat-tile">
              <div className="gauge-title">{t('إيداعات معلّقة', 'Pending deposits')}</div>
              <div className="stat-big mono">{data.queues.pendingDeposits}</div>
              <div className="gauge-sub">{t('خلال 24 ساعة', 'in 24h')}</div>
            </div>
            <div className="stat-tile">
              <div className="gauge-title">{t('سحوبات معلّقة', 'Pending payouts')}</div>
              <div className="stat-big mono">{data.queues.pendingPayouts}</div>
              <div className="gauge-sub">
                {data.queues.editRequestsPending > 0
                  ? t(`+${data.queues.editRequestsPending} طلب تعديل`, `+${data.queues.editRequestsPending} edit requests`)
                  : t('لا طلبات تعديل', 'no edit requests')}
              </div>
            </div>
          </div>

          <div className="health-charts">
            <div className="card chart-card">
              <div className="section-label">{t('المعاملات في الساعة (24 ساعة)', 'Transactions per hour (24h)')}</div>
              <HourBars
                rows={data.series.txByHour}
                keys={['paid', 'declined', 'pending', 'other']}
                labels={[t('مدفوعة', 'Paid'), t('مرفوضة', 'Declined'), t('معلّقة', 'Pending'), t('أخرى', 'Other')]}
              />
            </div>
            <div className="card chart-card">
              <div className="section-label">{t('رسائل SMS في الساعة (24 ساعة)', 'SMS per hour (24h)')}</div>
              <HourBars
                rows={data.series.smsByHour.map((r) => ({ ...r, unmatched: r.total - r.matched }))}
                keys={['matched', 'unmatched']}
                labels={[t('مطابَقة', 'Matched'), t('غير مطابَقة', 'Unmatched')]}
              />
            </div>
          </div>

          <div className="section-label">{t('الأجهزة', 'Devices')}</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('الجهاز', 'Device')}</th>
                  <th>{t('الحالة', 'State')}</th>
                  <th>{t('الشبكة', 'Network')}</th>
                  <th>{t('البطارية', 'Battery')}</th>
                  <th>{t('الرصيد', 'Balance')}</th>
                  <th>{t('آخر ظهور', 'Last seen')}</th>
                </tr>
              </thead>
              <tbody>
                {data.devices.length === 0 && (
                  <tr><td colSpan={6} className="cell-sub">{t('لا توجد أجهزة مسجّلة.', 'No devices registered.')}</td></tr>
                )}
                {data.devices.map((d) => (
                  <tr key={d.device} className={d.online ? undefined : 'row-pending'}>
                    <td className="mono">
                      {d.device}
                      {d.sim_number && <div className="cell-sub mono">{d.sim_number}</div>}
                    </td>
                    <td>
                      <span className={`pill${d.online ? ' active' : ''}`}>
                        {d.online ? t('متصل', 'Online') : t('غير متصل', 'Offline')}
                      </span>
                    </td>
                    <td>{d.net_type ?? '—'}{d.operator ? <div className="cell-sub">{d.operator}</div> : null}</td>
                    <td className="mono">
                      {d.battery == null ? '—' : `${d.battery}%`}
                      {d.charging ? ' ⚡' : ''}
                    </td>
                    <td className="mono">{d.balance == null ? '—' : d.balance}</td>
                    <td className="mono small">{d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-label">{t('تسليم تنبيهات Telegram (24 ساعة)', 'Telegram alert delivery (24h)')}</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('النوع', 'Alert type')}</th>
                  <th>{t('نجح', 'Delivered')}</th>
                  <th>{t('فشل', 'Failed')}</th>
                  <th>{t('آخر خطأ', 'Last error')}</th>
                </tr>
              </thead>
              <tbody>
                {data.telegram.length === 0 && (
                  <tr><td colSpan={4} className="cell-sub">{t('لم تُرسَل أي تنبيهات خلال 24 ساعة.', 'No alerts sent in the last 24h.')}</td></tr>
                )}
                {data.telegram.map((r) => (
                  <tr key={r.alert_type} className={r.failed > 0 ? 'row-pending' : undefined}>
                    <td className="mono">{r.alert_type}</td>
                    <td className="mono">{r.ok}</td>
                    <td className="mono">{r.failed}</td>
                    <td className="cell-sub">{r.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="drawer-note">
            {t('آخر تحديث: ', 'Last updated: ')}
            <span className="mono">{new Date(data.generatedAt).toLocaleTimeString()}</span>
          </p>
        </>
      )}
    </PanelShell>
  )
}
