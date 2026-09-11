import { useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, CircleDollarSign, Download, Filter, Pencil, RefreshCw, Search, ShieldAlert, Smartphone, Target, WalletCards, Wifi, WifiOff } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface WalletRow {
  to_account_number: string
  device: string | null
  provider: string | null
  payment_type: string | null
  daily_limit: number | null
  merchant: string | null
  sim_slot: number | null
  updated_at: string | null
}

interface DeviceRow {
  device: string
  sim_slot: number | null
  sim_number: string | null
  battery: number | null
  online: boolean | null
  balance: number | null
  balance_at: string | null
  last_seen_at: string | null
}

interface LiveWallet { bank_id: string | null; account_name: string | null; payment_type: string | null; phone_number: string | null; last_checked: string | null }
interface WalletsResponse { wallets: WalletRow[]; devices: DeviceRow[]; live: LiveWallet[] }

const providers = ['Orange Money', 'Vodafone Cash', 'Etisalat Cash', 'WE Pay', 'InstaPay']

export default function MavenWallets() {
  const { t } = useLocale()
  const [data, setData] = useState<WalletsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [status, setStatus] = useState('all')
  const [selectedLive, setSelectedLive] = useState<string[]>([])
  const [livePage, setLivePage] = useState(1)
  const [replacementThreshold, setReplacementThreshold] = useState('85')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const refresh = async () => {
    try {
      setError(null)
      setData(await api<WalletsResponse>('/api/wallets'))
      setLastRefresh(new Date())
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض المحافظ.', 'You do not have permission to view wallets.') : t('تعذّر تحميل محافظ Maven.', 'Unable to load Maven wallets.'))
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const deviceMap = useMemo(() => {
    const map = new Map<string, DeviceRow>()
    for (const device of data?.devices ?? []) map.set(`${device.device}#${device.sim_slot ?? 0}`, device)
    return map
  }, [data])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (data?.wallets ?? []).filter((wallet) => {
      const device = wallet.device ? deviceMap.get(`${wallet.device}#${wallet.sim_slot ?? 0}`) ?? deviceMap.get(`${wallet.device}#0`) : undefined
      const matchesQuery = !needle || [wallet.to_account_number, wallet.provider, wallet.merchant, wallet.device, device?.sim_number].some((value) => value?.toLowerCase().includes(needle))
      const matchesProvider = selectedProviders.length === 0 || selectedProviders.includes(wallet.provider ?? '')
      const matchesStatus = status === 'all' || (status === 'online' ? device?.online === true : status === 'offline' ? device?.online !== true : !device)
      return matchesQuery && matchesProvider && matchesStatus
    })
  }, [data, deviceMap, query, selectedProviders, status])

  const stats = useMemo(() => {
    const wallets = data?.wallets ?? []
    const devices = data?.devices ?? []
    const balances = devices.map((device) => device.balance).filter((value): value is number => value != null)
    return {
      total: wallets.length,
      online: devices.filter((device) => device.online).length,
      balance: balances.reduce((sum, value) => sum + value, 0),
      daily: wallets.reduce((sum, wallet) => sum + (wallet.daily_limit ?? 60_000), 0),
    }
  }, [data])

  const liveRows = data?.live ?? []
  const livePageSize = 10
  const livePageCount = Math.max(1, Math.ceil(liveRows.length / livePageSize))
  const visibleLiveRows = liveRows.slice((livePage - 1) * livePageSize, livePage * livePageSize)
  const allVisibleLiveSelected = visibleLiveRows.length > 0 && visibleLiveRows.every((row) => selectedLive.includes(row.bank_id ?? ''))
  const toggleLive = (bankId: string) => setSelectedLive((current) => current.includes(bankId) ? current.filter((item) => item !== bankId) : [...current, bankId])
  const replaceLive = (_bankId: string | null) => setError(t('واجهة الاستبدال جاهزة، لكن مصدر Maven لا يوفّر endpoint تغيير الرقم في التطبيق بعد.', 'The replacement UI is ready, but Maven has not exposed a number-change endpoint to this app yet.'))

  const toggleProvider = (provider: string) => setSelectedProviders((current) => current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider])

  return (
    <PanelShell>
      <section className="maven-wallets-head">
        <div>
          <div className="maven-eyebrow"><span className="maven-live-dot" /> MAVEN · NGPay Wallet Operations</div>
          <h2>{t('محافظ Maven', 'Maven Wallets')}</h2>
          <p>{t('متابعة أرقام الاستقبال والأرصدة والحالة التشغيلية في شاشة واحدة.', 'Monitor receiving accounts, live balances, and operational health in one workspace.')}</p>
        </div>
        <div className="maven-head-actions">
          <span className="maven-sync-time">{lastRefresh ? `${t('آخر تحديث', 'Updated')} ${lastRefresh.toLocaleTimeString('en-GB')}` : t('جارٍ التحميل…', 'Loading…')}</span>
          <button className="btn-primary" type="button" onClick={() => void refresh()}><RefreshCw size={16} /> {t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      <section className="maven-kpis">
        <article className="maven-kpi"><span><WalletCards size={17} /> {t('إجمالي المحافظ', 'Total wallets')}</span><strong>{stats.total.toLocaleString()}</strong><small>{t('أرقام مرتبطة بالنظام', 'Accounts connected')}</small></article>
        <article className="maven-kpi green"><span><Wifi size={17} /> {t('متصلة الآن', 'Online now')}</span><strong>{stats.online.toLocaleString()}</strong><small>{stats.total ? `${Math.round(stats.online / stats.total * 100)}% ${t('من المحافظ', 'of wallets')}` : '—'}</small></article>
        <article className="maven-kpi gold"><span><CircleDollarSign size={17} /> {t('الرصيد الحالي', 'Current balance')}</span><strong>{money(stats.balance, 'EGP')}</strong><small>{t('آخر SMS رصيد لكل جهاز', 'Latest balance SMS per device')}</small></article>
        <article className="maven-kpi blue"><span><Activity size={17} /> {t('الحد اليومي', 'Daily capacity')}</span><strong>{money(stats.daily, 'EGP')}</strong><small>{t('الحد الافتراضي 60,000 لكل محفظة', 'Default limit 60,000 per wallet')}</small></article>
      </section>

      <section className="maven-filter-panel">
        <div className="maven-filter-title"><Filter size={16} /> {t('تصفية المحافظ', 'Filter wallets')} {selectedProviders.length > 0 && <em>{selectedProviders.length}</em>}</div>
        <label className="maven-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('بحث برقم المحفظة أو الجهاز أو التاجر…', 'Search wallet, device, or merchant…')} /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label={t('الحالة', 'Status')}><option value="all">{t('كل الحالات', 'All statuses')}</option><option value="online">{t('متصل', 'Online')}</option><option value="offline">{t('غير متصل', 'Offline')}</option><option value="unassigned">{t('بدون جهاز', 'Unassigned')}</option></select>
        <button className="btn-ghost btn-sm" type="button" onClick={() => { setQuery(''); setSelectedProviders([]); setStatus('all') }}>{t('مسح', 'Clear')}</button>
        <div className="maven-provider-chips">{providers.map((provider) => <button key={provider} className={`maven-chip ${selectedProviders.includes(provider) ? 'active' : ''}`} type="button" onClick={() => toggleProvider(provider)}>{provider}</button>)}</div>
      </section>

      {error && <div className="card warn">{error}</div>}
      <section className="card maven-live-accounts">
        <div className="recent-head"><div><h3>{t('أرقام الاستقبال الحية', 'Live receiving numbers')}</h3><p className="cell-sub">{t('البيانات القادمة من Maven — اختر عدة أرقام لإدارة الاستبدال.', 'Maven source data — select multiple numbers for replacement management.')}</p></div><button className="btn-ghost btn-sm" type="button" onClick={() => void refresh()}><RefreshCw size={15} /> {t('تحديث', 'Refresh')}</button></div>
        <div className="maven-live-toolbar"><label className="maven-select-all"><input type="checkbox" checked={allVisibleLiveSelected} onChange={() => setSelectedLive((current) => allVisibleLiveSelected ? current.filter((id) => !visibleLiveRows.some((row) => (row.bank_id ?? '') === id)) : [...new Set([...current, ...visibleLiveRows.map((row) => row.bank_id ?? '').filter(Boolean)])])} /> {t('تحديد الكل', 'Select all')}</label><span>{selectedLive.length} {t('محدد', 'selected')}</span><button className="btn-ghost btn-sm" type="button" disabled={!selectedLive.length} onClick={() => replaceLive(null)}><Pencil size={14} /> {t('غيّر المحدد لرقم واحد', 'Change selected to one number')}</button><label className="maven-threshold"><Target size={14} /> {t('الاستبدال التلقائي عند', 'Auto replacement at')} <select value={replacementThreshold} onChange={(event) => setReplacementThreshold(event.target.value)}><option value="80">80%</option><option value="85">85%</option><option value="90">90%</option></select></label></div>
        <div className="table-wrap maven-table-wrap"><table className="data-table maven-live-table"><thead><tr><th></th><th>{t('البنك', 'Bank')}</th><th>{t('النوع / التاجر', 'Type / merchant')}</th><th>{t('الرقم الحالي', 'Current number')}</th><th>{t('آخر فحص', 'Last checked')}</th><th>{t('إجراء', 'Action')}</th></tr></thead><tbody>
          {visibleLiveRows.map((row) => { const id = row.bank_id ?? ''; return <tr key={`${id}-${row.phone_number ?? ''}`}><td><input type="checkbox" checked={selectedLive.includes(id)} onChange={() => toggleLive(id)} aria-label={`${t('تحديد', 'Select')} ${id}`} /></td><td className="mono">{id || '—'}</td><td><strong>{row.payment_type ?? '—'}</strong><div className="cell-sub">{row.account_name ?? t('غير محدد', 'Not specified')}</div></td><td className="mono">{row.phone_number ?? '—'}</td><td className="cell-sub">{depositTime({ first_seen_at: row.last_checked })}</td><td><button className="btn-ghost btn-sm maven-change-btn" type="button" onClick={() => replaceLive(row.bank_id)}><Pencil size={14} /> {t('غيّر', 'Change')}</button></td></tr> })}
          {!visibleLiveRows.length && <tr><td colSpan={6} className="maven-empty">{t('لا توجد أرقام حية من Maven حالياً.', 'No live Maven receiving numbers currently available.')}</td></tr>}
        </tbody></table></div>
        <div className="maven-pagination"><span>{liveRows.length ? `${(livePage - 1) * livePageSize + 1}-${Math.min(livePage * livePageSize, liveRows.length)} / ${liveRows.length}` : '0 / 0'}</span><button className="btn-ghost btn-sm" type="button" disabled={livePage <= 1} onClick={() => setLivePage((page) => page - 1)}>{t('السابق', 'Previous')}</button><strong>{livePage} / {livePageCount}</strong><button className="btn-ghost btn-sm" type="button" disabled={livePage >= livePageCount} onClick={() => setLivePage((page) => page + 1)}>{t('التالي', 'Next')}</button></div>
      </section>
      <section className="card maven-wallet-table-card">
        <div className="recent-head"><div><h3>{t('أرقام الاستقبال — محافظ Maven', 'Maven receiving wallets')}</h3><p className="cell-sub">{rows.length.toLocaleString()} {t('محفظة مطابقة للفلاتر', 'wallets match the filters')} · {t('مزامنة تلقائية كل 60 ثانية', 'Auto-sync every 60 seconds')}</p></div><button className="btn-ghost btn-sm" type="button" onClick={() => window.print()}><Download size={15} /> {t('تصدير / طباعة', 'Export / print')}</button></div>
        <div className="table-wrap maven-table-wrap"><table className="data-table maven-table"><thead><tr><th>#</th><th>{t('رقم المحفظة / الحساب', 'Wallet / account')}</th><th>{t('المزوّد', 'Provider')}</th><th>{t('الجهاز و SIM', 'Device & SIM')}</th><th>{t('الرصيد الحالي', 'Current balance')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الحد اليومي', 'Daily limit')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('آخر تحديث', 'Last update')}</th></tr></thead><tbody>
          {rows.map((wallet, index) => {
            const device = wallet.device ? deviceMap.get(`${wallet.device}#${wallet.sim_slot ?? 0}`) ?? deviceMap.get(`${wallet.device}#0`) : undefined
            const online = device?.online === true
            return <tr key={`${wallet.to_account_number}-${wallet.sim_slot ?? 0}`}><td><span className="maven-row-number">{index + 1}</span></td><td><strong className="mono">{wallet.to_account_number}</strong><div className="cell-sub">{wallet.payment_type ?? t('استقبال', 'Receiving')}</div></td><td><span className="maven-provider">{wallet.provider ?? '—'}</span></td><td>{device ? <><strong className="mono">{device.device}</strong><div className="cell-sub">SIM {device.sim_slot ?? 0}{device.sim_number ? ` · ${device.sim_number}` : ''}</div></> : <span className="cell-sub"><Smartphone size={14} /> {t('غير مربوط', 'Unassigned')}</span>}</td><td><strong className="maven-balance">{device?.balance != null ? money(device.balance, 'EGP') : '—'}</strong>{device?.balance_at && <div className="cell-sub">{depositTime({ first_seen_at: device.balance_at })}</div>}</td><td><span className={`maven-status ${online ? 'online' : device ? 'offline' : 'unknown'}`}>{online ? <CheckCircle2 size={14} /> : device ? <WifiOff size={14} /> : <ShieldAlert size={14} />}{online ? t('متصل', 'Online') : device ? t('غير متصل', 'Offline') : t('غير معروف', 'Unknown')}</span>{device?.battery != null && <div className="cell-sub">🔋 {device.battery}%</div>}</td><td className="mono">{money(wallet.daily_limit ?? 60_000, 'EGP')}</td><td>{wallet.merchant ?? <span className="cell-sub">{t('عام', 'General')}</span>}</td><td className="cell-sub mono">{depositTime({ first_seen_at: device?.last_seen_at ?? wallet.updated_at })}</td></tr>
          })}
          {rows.length === 0 && <tr><td colSpan={9} className="maven-empty">{t('لا توجد محافظ مطابقة للفلاتر.', 'No wallets match the current filters.')}</td></tr>}
        </tbody></table></div>
      </section>
    </PanelShell>
  )
}
