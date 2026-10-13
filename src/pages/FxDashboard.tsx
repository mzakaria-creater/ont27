import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Clock3, Coins, Percent, RefreshCw, TrendingDown, TrendingUp, UserPlus, Wallet, XCircle } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// FX & operations dashboard. Rates come from the server (/api/fx/rates):
// USD cross rates plus the USDT/EGP Binance P2P mid, with the change measured
// against our own stored snapshots. KPIs are today's real figures (Cairo day).

interface Rate { pair: string; rate: number; change: number | null; change_pct: number | null }
interface FxResponse {
  rates: Rate[]
  usdt: { buy: number; sell: number; spread: number } | null
  source_updated: string | null
  kpis: {
    volume_today: number; paid_today: number; declined_today: number; transactions_today: number
    success_rate: number | null; pending_now: number; commission_today: number
    settlements_due: number; settlements_open: number; new_clients_today: number
  }
  generated_at: string
}

const REGIONS: Array<{ key: string; ar: string; en: string; match: (pair: string) => boolean }> = [
  { key: 'all', ar: 'الكل', en: 'All', match: () => true },
  { key: 'EGP', ar: 'مصر', en: 'Egypt', match: (p) => p === 'USD/EGP' },
  { key: 'SAR', ar: 'السعودية', en: 'Saudi Arabia', match: (p) => p === 'USD/SAR' },
  { key: 'AED', ar: 'الإمارات', en: 'UAE', match: (p) => p === 'USD/AED' },
  { key: 'KWD', ar: 'الكويت', en: 'Kuwait', match: (p) => p === 'USD/KWD' },
  { key: 'QAR', ar: 'قطر', en: 'Qatar', match: (p) => p === 'USD/QAR' },
  { key: 'BHD', ar: 'البحرين', en: 'Bahrain', match: (p) => p === 'USD/BHD' },
  { key: 'OMR', ar: 'عُمان', en: 'Oman', match: (p) => p === 'USD/OMR' },
  { key: 'USDT', ar: 'كريبتو', en: 'Crypto', match: (p) => p.startsWith('USDT') },
]

const FLAGS: Record<string, string> = { EGP: '🇪🇬', SAR: '🇸🇦', AED: '🇦🇪', KWD: '🇰🇼', QAR: '🇶🇦', BHD: '🇧🇭', OMR: '🇴🇲', USDT: '₮' }
const decimals = (pair: string, rate: number) => (rate < 1 ? 4 : pair === 'USD/EGP' || pair === 'USDT/EGP' ? 2 : 4)
const sign = (n: number) => (n > 0 ? '+' : '')

export default function FxDashboard() {
  const { t } = useLocale()
  const [data, setData] = useState<FxResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [region, setRegion] = useState('all')

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    api<FxResponse>('/api/fx/rates')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض هذه الصفحة.', 'You do not have permission to view this page.') : t('تعذّر تحميل الأسعار.', 'Failed to load rates.')))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { load(); const id = setInterval(load, 5 * 60_000); return () => clearInterval(id) }, [load])

  const filter = REGIONS.find((r) => r.key === region) ?? REGIONS[0]
  const visible = useMemo(() => (data?.rates ?? []).filter((r) => filter.match(r.pair)), [data, filter])
  const usdtEgp = data?.rates.find((r) => r.pair === 'USDT/EGP')
  const k = data?.kpis

  return (
    <>
      <section className="page-head admin-head">
        <span className="admin-head-icon"><Coins size={20} /></span>
        <div className="admin-head-text">
          <span className="admin-head-eyebrow">{t('الأسعار والتشغيل', 'Rates & operations')}</span>
          <h2>{t('لوحة الأسعار', 'FX dashboard')}</h2>
          <p className="page-sub">{data && <>{t('آخر تحديث', 'Updated')}: <span className="mono">{new Date(data.generated_at).toLocaleTimeString('en-GB')}</span>{data.source_updated && <> · {t('مصدر الأسعار اليومي', 'Daily rate source')}: <span className="mono">{data.source_updated.slice(5, 16)}</span></>}</>}</p>
        </div>
        <div className="admin-head-actions">
          <button className="btn-ghost btn-sm" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />{t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      {err && <div className="card warn">{err}</div>}

      <section className="fx-hero">
        <div className="fx-hero-top"><span>USDT / EGP</span>{usdtEgp && <span className="fx-live">● {t('مباشر', 'LIVE')}</span>}</div>
        {usdtEgp && data?.usdt ? (
          <>
            <div className="fx-hero-rate mono">{usdtEgp.rate.toFixed(2)}</div>
            <div className="fx-hero-sub">
              {usdtEgp.change != null && <span className={usdtEgp.change >= 0 ? 'fx-up' : 'fx-down'}>{usdtEgp.change >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />} {sign(usdtEgp.change)}{usdtEgp.change.toFixed(2)}</span>}
              <span>{t('شراء', 'Buy')} {data.usdt.buy.toFixed(2)} · {t('بيع', 'Sell')} {data.usdt.sell.toFixed(2)} · {t('الفرق', 'Spread')}: {data.usdt.spread.toFixed(2)}</span>
            </div>
          </>
        ) : <div className="fx-hero-sub">{loading ? t('جارٍ التحميل…', 'Loading…') : t('سعر Binance P2P غير متاح حالياً.', 'Binance P2P price is unavailable right now.')}</div>}
      </section>

      <div className="fx-filters" role="tablist">
        <span className="cell-sub">{t('تصفية', 'Filter')}:</span>
        {REGIONS.map((r) => <button key={r.key} type="button" className={`pill${region === r.key ? ' active' : ''}`} onClick={() => setRegion(r.key)}>{r.key !== 'all' && <span aria-hidden="true">{FLAGS[r.key]} </span>}{t(r.ar, r.en)}</button>)}
      </div>

      <div className="fx-rates">
        {visible.map((r) => (
          <div key={r.pair} className="fx-rate">
            <div className="fx-rate-top"><span>{r.pair}</span><span aria-hidden="true">{FLAGS[r.pair.split('/')[1]] ?? ''}</span></div>
            <div className="fx-rate-val mono">{r.rate.toFixed(decimals(r.pair, r.rate))}</div>
            {r.change_pct != null ? <div className={r.change_pct >= 0 ? 'fx-up' : 'fx-down'}>{r.change_pct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />} {sign(r.change_pct)}{r.change_pct.toFixed(2)}%</div> : <div className="cell-sub">{t('لا يوجد تاريخ بعد', 'No history yet')}</div>}
          </div>
        ))}
        {!loading && visible.length === 0 && <p className="cell-sub">{t('لا توجد أسعار لهذا الفلتر.', 'No rates for this filter.')}</p>}
      </div>

      <h3 className="fx-section">{t('تشغيل اليوم', "Today's operations")}</h3>
      <div className="fx-kpis">
        <Kpi icon={<Wallet size={18} />} value={k ? money(k.volume_today, 'EGP') : '—'} label={t('حجم اليوم المدفوع', 'Paid volume today')} sub={k ? `${k.paid_today.toLocaleString()} ${t('معاملة مدفوعة', 'paid transactions')}` : ''} />
        <Kpi icon={<Activity size={18} />} value={k ? k.transactions_today.toLocaleString() : '—'} label={t('معاملات اليوم', 'Transactions today')} sub={k ? `${k.declined_today.toLocaleString()} ${t('مرفوضة', 'declined')}` : ''} />
        <Kpi icon={<CheckCircle2 size={18} />} value={k?.success_rate != null ? `${k.success_rate.toFixed(1)}%` : '—'} label={t('نسبة النجاح اليوم', 'Success rate today')} sub={t('مدفوع / (مدفوع + مرفوض)', 'paid / (paid + declined)')} />
        <Kpi icon={<Clock3 size={18} />} value={k ? k.pending_now.toLocaleString() : '—'} label={t('قيد الانتظار الآن', 'Pending now')} sub={t('بانتظار إجراء', 'Awaiting action')} />
        <Kpi icon={<Percent size={18} />} value={k ? money(k.commission_today, 'EGP') : '—'} label={t('عمولة اليوم', 'Commission today')} sub={t('من المعاملات المدفوعة', 'On paid transactions')} />
        <Kpi icon={<XCircle size={18} />} value={k ? k.declined_today.toLocaleString() : '—'} label={t('مرفوضة اليوم', 'Declined today')} sub="" />
        <Kpi icon={<Coins size={18} />} value={k ? money(k.settlements_due, 'EGP') : '—'} label={t('تسويات مستحقة', 'Settlements due')} sub={k ? `${k.settlements_open} ${t('مفتوحة', 'open')}` : ''} />
        <Kpi icon={<UserPlus size={18} />} value={k ? k.new_clients_today.toLocaleString() : '—'} label={t('عملاء جدد اليوم', 'New clients today')} sub={t('مسجّلون اليوم', 'Registered today')} />
      </div>
    </>
  )
}

function Kpi({ icon, value, label, sub }: { icon: React.ReactNode; value: string; label: string; sub: string }) {
  return (
    <div className="fx-kpi">
      <span className="fx-kpi-icon">{icon}</span>
      <div className="fx-kpi-value mono">{value}</div>
      <div className="fx-kpi-label">{label}</div>
      {sub && <div className="cell-sub">{sub}</div>}
    </div>
  )
}
