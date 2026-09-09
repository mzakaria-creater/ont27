import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, RotateCcw, Search } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import MethodLogo from '../components/MethodLogo'
import { api } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// PSP and merchant performance.
//
// Deliberately absent: a forecast. Every number here is measured from rows we
// hold. The nearest thing to prediction is the deviation score — how far a
// group's approval rate has moved from its own previous-window rate, in
// standard errors of that baseline — which explains what already changed and
// is labelled as such.
//
// Trend is withheld entirely when the two windows are not comparable. NGPay
// volume ran at 8–63 transactions/day from 23 July to 16 August and at
// 400–780/day since, so a 7-day window straddles two operating regimes; a
// comparison across that line reads as a dramatic improvement that is really
// just the business getting busier.

interface Baseline { total: number; decided: number; volume: number; approvalRate: number | null }
interface Group {
  key: string
  total: number; paid: number; declined: number; expired: number; pending: number; mismatched: number
  decided: number; volume: number; avgTicket: number | null
  approvalRate: number | null; declineRate: number | null
  p50SettleSec: number | null; p90SettleSec: number | null
  baseline: Baseline
  deltaPp: number | null; z: number | null
  signal: 'up' | 'down' | 'flat' | 'insufficient' | 'incomparable'
}
interface Bucket {
  bucket: string; total: number; paid: number; declined: number; expired: number; pending: number
  volume: number; approvalRate: number | null
}
interface Slice {
  dimension: string; gateway: string; days: number; bucket: string
  from: string; to: string; baselineFrom: string
  windowCount: number; baselineCount: number
  comparable: boolean; regimeFrom: string | null
  groups: Group[]; series: Bucket[]
  generatedAt: string
}

const DIMENSIONS = [
  { id: 'payment_method', ar: 'طريقة الدفع', en: 'Payment method' },
  { id: 'merchant', ar: 'التاجر', en: 'Merchant' },
  { id: 'sub_merchant', ar: 'التاجر الفرعي', en: 'Sub-merchant' },
  { id: 'wallet', ar: 'المحفظة', en: 'Wallet' },
  { id: 'gateway', ar: 'المزوّد', en: 'Provider' },
] as const

const WINDOWS = [
  { days: 1, ar: '24 ساعة', en: '24h', bucket: 'hour' },
  { days: 2, ar: 'يومان', en: '2 days', bucket: 'hour' },
  { days: 7, ar: '7 أيام', en: '7 days', bucket: 'day' },
  { days: 30, ar: '30 يوماً', en: '30 days', bucket: 'day' },
] as const

const secs = (v: number | null, t: (a: string, e: string) => string): string => {
  if (v == null) return '—'
  if (v < 90) return t(`${Math.round(v)} ث`, `${Math.round(v)}s`)
  const m = v / 60
  if (m < 90) return t(`${Math.round(m)} د`, `${Math.round(m)}m`)
  return t(`${(m / 60).toFixed(1)} س`, `${(m / 60).toFixed(1)}h`)
}

// Stacked paid/declined/other bars over the window. A zero bucket still draws
// its slot, so an outage reads as a gap rather than disappearing from the axis.
function Series({ rows, t }: { rows: Bucket[]; t: (a: string, e: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.total))
  return (
    <div className="hchart">
      <div className="hchart-plot">
        {rows.map((r, i) => {
          const other = Math.max(0, r.total - r.paid - r.declined)
          const label = new Date(r.bucket).toLocaleString()
          return (
            <div
              className="hchart-col"
              key={r.bucket}
              title={`${label} — ${t('معتمد', 'paid')} ${r.paid} · ${t('مرفوض', 'declined')} ${r.declined} · ${t('أخرى', 'other')} ${other}${r.approvalRate == null ? '' : ` · ${r.approvalRate}%`}`}
            >
              <div className="hchart-stack">
                {r.paid > 0 && <div className="hchart-seg seg-0" style={{ height: `${(r.paid / max) * 100}%` }} />}
                {r.declined > 0 && <div className="hchart-seg seg-1" style={{ height: `${(r.declined / max) * 100}%` }} />}
                {other > 0 && <div className="hchart-seg seg-2" style={{ height: `${(other / max) * 100}%` }} />}
              </div>
              {i % Math.max(1, Math.round(rows.length / 8)) === 0 && (
                <div className="hchart-x">{new Date(r.bucket).toISOString().slice(11, 16)}</div>
              )}
              {r.total === 0 && <div className="hchart-zero" />}
            </div>
          )
        })}
      </div>
      <div className="hchart-legend">
        <span><i className="seg-0" />{t('معتمد', 'Paid')}</span>
        <span><i className="seg-1" />{t('مرفوض', 'Declined')}</span>
        <span><i className="seg-2" />{t('أخرى', 'Other')}</span>
      </div>
    </div>
  )
}

function Signal({ g, t }: { g: Group; t: (a: string, e: string) => string }) {
  if (g.signal === 'incomparable') {
    return <span className="cell-sub" title={t('النافذتان من حجمَي نشاط مختلفين', 'The two windows come from different activity levels')}>{t('غير قابل للمقارنة', 'not comparable')}</span>
  }
  if (g.signal === 'insufficient') {
    return <span className="cell-sub" title={t('عيّنة أصغر من أن تُميّز التغيّر عن الضجيج', 'Sample too small to separate change from noise')}>{t('عيّنة صغيرة', 'small sample')}</span>
  }
  const cls = g.signal === 'up' ? 'st-paid' : g.signal === 'down' ? 'st-declined' : 'st-dim'
  const arrow = g.signal === 'up' ? '▲' : g.signal === 'down' ? '▼' : '—'
  return (
    <span className={`pay-status-badge ${cls}`} title={`z = ${g.z}`}>
      {arrow} {g.deltaPp == null ? '' : `${g.deltaPp > 0 ? '+' : ''}${g.deltaPp} pp`}
    </span>
  )
}

export default function Performance() {
  const { t } = useLocale()
  const [dimension, setDimension] = useState<string>('payment_method')
  const [win, setWin] = useState<(typeof WINDOWS)[number]>(WINDOWS[2])
  const [gateway, setGateway] = useState<string>('NagupayP2P')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<Slice | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setBusy(true)
    const params = new URLSearchParams({ dimension, gateway, days: String(win.days), bucket: win.bucket })
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    api<Slice>(`/api/performance?${params.toString()}`)
      .then((d) => { setData(d); setErr(null) })
      .catch(() => setErr(t('تعذّر تحميل مقاييس الأداء.', 'Could not load performance metrics.')))
      .finally(() => setBusy(false))
  }, [dimension, gateway, win, from, to, t])

  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (data?.groups ?? []).filter((g) => !needle || g.key.toLowerCase().includes(needle))
  }, [data, search])

  useEffect(() => {
    load()
    const iv = setInterval(load, 30_000)
    return () => clearInterval(iv)
  }, [load])

  const totals = useMemo(() => {
    const g = visibleGroups
    const paid = g.reduce((a, b) => a + b.paid, 0)
    const declined = g.reduce((a, b) => a + b.declined, 0)
    const volume = g.reduce((a, b) => a + b.volume, 0)
    const decided = paid + declined
    return { paid, declined, volume, decided, rate: decided ? (paid / decided) * 100 : null }
  }, [visibleGroups])

  // Only groups the deviation score actually judged. A "small sample" row is
  // not evidence of health, and surfacing it as an alert would be noise.
  const alerts = useMemo(
    () => visibleGroups.filter((g) => g.signal === 'down').sort((a, b) => (a.z ?? 0) - (b.z ?? 0)),
    [visibleGroups],
  )

  const maxVolume = Math.max(1, ...visibleGroups.map((g) => g.volume))

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('أداء المزوّدين والتجار', 'Provider & merchant performance')}</h2>
        <p className="page-sub">
          {t(
            'كل رقم هنا محسوب من معاملات فعلية. لا يوجد تنبؤ: مؤشّر الاتجاه يقيس كم ابتعدت نسبة الاعتماد عن نافذتها السابقة، بوحدة الخطأ المعياري، ليفصل التغيّر الحقيقي عن ضجيج العيّنات الصغيرة.',
            'Every number is computed from real transactions. There is no forecast: the trend score measures how far a group\'s approval rate has moved from its own previous window, in standard errors, to separate a real shift from small-sample noise.',
          )}
          {data && <> · {t('تحديث', 'Updated')} {new Date(data.generatedAt).toLocaleTimeString()}</>}
        </p>
        <div className="filter-bar">
          {DIMENSIONS.map((d) => (
            <button key={d.id} className={dimension === d.id ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setDimension(d.id)}>
              {t(d.ar, d.en)}
            </button>
          ))}
        </div>
        <div className="filter-bar">
          {WINDOWS.map((w) => (
            <button key={w.days} className={win.days === w.days ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setWin(w)}>
              {t(w.ar, w.en)}
            </button>
          ))}
          <span className="cell-sub">·</span>
          {/* NGPay is live money; RSC and AVADAPAY are PayFuture test data and
              stay on their own filter so a test row can never move a live rate. */}
          <button className={gateway === 'NagupayP2P' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setGateway('NagupayP2P')}>NGPay</button>
          <button className={gateway === 'AVADAPAY' ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'} onClick={() => setGateway('AVADAPAY')}>{t('اختبار', 'Test')}</button>
          <button className="btn-ghost btn-sm" onClick={load} disabled={busy}>{t('تحديث', 'Refresh')}</button>
        </div>
        <div className="filter-bar analytics-filter-bar performance-filter-bar">
          <label className="analytics-date-field">
            <span><CalendarDays size={13} /> {t('من تاريخ', 'From date')}</span>
            <input className="login-input" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="analytics-date-field">
            <span><CalendarDays size={13} /> {t('إلى تاريخ', 'To date')}</span>
            <input className="login-input" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="analytics-filter-search" aria-label={t('بحث في المجموعات', 'Search groups')}>
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('ابحث في النتائج…', 'Search results…')} />
          </label>
          <button className="btn-ghost btn-sm" onClick={() => { setFrom(''); setTo(''); setSearch('') }}>
            <RotateCcw size={14} /> {t('مسح', 'Clear')}
          </button>
          <span className="cell-sub">{from || to ? `${from || '…'} → ${to || '…'}` : t('آخر 7 أيام', 'Last 7 days')}</span>
        </div>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <div className="card">{t('جارٍ التحميل…', 'Loading…')}</div>}

      {data && (
        <>
          {!data.comparable && (
            <div className="card warn">
              <strong>{t('الاتجاه محجوب لهذه النافذة.', 'Trend withheld for this window.')}</strong>{' '}
              {t(
                `النافذة الحالية تحوي ${data.windowCount} معاملة مقابل ${data.baselineCount} في النافذة السابقة — نشاطان مختلفان، والمقارنة بينهما تُظهر تحسّناً وهمياً سببه ازدياد الحجم لا تحسّن الأداء.`,
                `This window holds ${data.windowCount} transactions against ${data.baselineCount} in the previous one — different activity levels, and comparing them shows a phantom improvement caused by rising volume rather than better performance.`,
              )}
              {data.regimeFrom && (
                <> {t(`المقارنة السليمة تبدأ من ${data.regimeFrom}؛ اختر نافذة أقصر.`, `Comparable history starts ${data.regimeFrom}; pick a shorter window.`)}</>
              )}
            </div>
          )}

          {alerts.length > 0 && (
            <div className="card warn">
              <strong>{t('تراجع ملموس في نسبة الاعتماد', 'Material drop in approval rate')}</strong>
              <ul className="plain-list">
                {alerts.map((g) => (
                  <li key={g.key}>
                    {g.key} — {g.baseline.approvalRate}% → {g.approvalRate}% ({g.deltaPp} pp، z = {g.z})،{' '}
                    {t(`على ${g.decided} قراراً`, `over ${g.decided} decisions`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-value">{totals.rate == null ? '—' : `${totals.rate.toFixed(1)}%`}</div>
              <div className="kpi-label">{t('نسبة الاعتماد', 'Approval rate')}</div>
              <div className="cell-sub">{t(`${totals.decided} قرار`, `${totals.decided} decided`)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{money(totals.volume, 'EGP')}</div>
              <div className="kpi-label">{t('حجم معتمد', 'Approved volume')}</div>
              <div className="cell-sub">{t(`${totals.paid} عملية`, `${totals.paid} transactions`)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-value">{totals.declined}</div>
              <div className="kpi-label">{t('مرفوضة', 'Declined')}</div>
              <div className="cell-sub">{data.windowCount} {t('إجمالي', 'total')}</div>
            </div>
            <div className="kpi-card">
            <div className="kpi-value">{visibleGroups.length}</div>
              <div className="kpi-label">{t('مجموعات نشطة', 'Active groups')}</div>
              <div className="cell-sub">{data.regimeFrom ? t(`بيانات متّصلة منذ ${data.regimeFrom}`, `continuous since ${data.regimeFrom}`) : '—'}</div>
            </div>
          </div>

          <section className="card">
            <div className="section-label">{t('السلسلة الزمنية', 'Time series')}</div>
            {data.series.length === 0
              ? <div className="cell-sub">{t('لا توجد معاملات في هذه النافذة.', 'No transactions in this window.')}</div>
              : <Series rows={data.series} t={t} />}
          </section>

          <section className="card">
            <div className="section-label">{t('التفصيل', 'Breakdown')}</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{DIMENSIONS.find((d) => d.id === dimension)?.[t('ar', 'en') as 'ar' | 'en']}</th>
                    <th>{t('الحجم المعتمد', 'Approved volume')}</th>
                    <th>{t('نسبة الاعتماد', 'Approval rate')}</th>
                    <th>{t('الاتجاه', 'Trend')}</th>
                    <th>{t('معتمد / مرفوض', 'Paid / declined')}</th>
                    <th>{t('متوسط العملية', 'Avg ticket')}</th>
                    <th>{t('زمن التسوية p50 / p90', 'Settle p50 / p90')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleGroups.length === 0 && (
                    <tr><td colSpan={7} className="cell-sub">{t('لا توجد بيانات في هذه النافذة.', 'No data in this window.')}</td></tr>
                  )}
                  {visibleGroups.map((g) => (
                    <tr key={g.key}>
                      <td>
                        {dimension === 'payment_method'
                          ? <span className="method-cell"><MethodLogo method={g.key} /><span className="method-name">{g.key}</span></span>
                          : <span className="mono">{g.key}</span>}
                      </td>
                      <td className="mono">
                        {money(g.volume, 'EGP')}
                        <div className="analytics-bar"><i style={{ width: `${(g.volume / maxVolume) * 100}%` }} /></div>
                      </td>
                      <td className="mono">{g.approvalRate == null ? '—' : `${g.approvalRate}%`}</td>
                      <td><Signal g={g} t={t} /></td>
                      <td className="mono">{g.paid} / {g.declined}</td>
                      <td className="mono">{g.avgTicket == null ? '—' : money(g.avgTicket, 'EGP')}</td>
                      <td className="mono">{secs(g.p50SettleSec, t)} / {secs(g.p90SettleSec, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="cell-sub">
              {t(
                'زمن التسوية يُقاس من إنشاء المزوّد للمعاملة حتى الحالة التي نحملها الآن، وهو يشمل تأخير المُجمِّع لدينا (~85 ثانية وسيطاً) — فهو زمن ملحوظ لا زمن قرارنا وحده.',
                'Settle time runs from the provider creating the transaction to the status we now hold, and includes our own collector lag (~85s median) — it is observed latency, not our decision time alone.',
              )}
            </p>
          </section>
        </>
      )}
    </PanelShell>
  )
}
