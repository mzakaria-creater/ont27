import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, CheckCircle2, CircleDollarSign, Download, Filter, Pencil, Plus, RefreshCw, RotateCw, Search, ShieldAlert, Smartphone, Target, Trash2, WalletCards, Wifi, WifiOff, X } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
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

interface LiveWallet { bank_id?: string | null; id?: string | null; BankId?: string | null; account_name?: string | null; AccountName?: string | null; payment_type?: string | null; PaymentType?: string | null; phone_number?: string | null; PhoneNumber?: string | null; last_checked?: string | null; updated_at?: string | null }
interface WalletsResponse { wallets: WalletRow[]; devices: DeviceRow[]; live: LiveWallet[] }
interface RotationGroup {
  id: string
  wallet_numbers: string[]
  mode: 'time' | 'amount'
  interval_minutes: number | null
  amount_threshold: number | null
  current_index: number
  last_rotated_at: string | null
  amount_received_since_rotation: number
  active: boolean
  created_by: string | null
  created_at: string
}
const providers = ['Orange Money', 'Vodafone Cash', 'Etisalat Cash', 'WE Pay', 'InstaPay']
const emptyNewWallet = { wallet_number: '', provider: 'Orange Money', merchant: '', daily_limit: '' }

export default function MavenWallets() {
  const { t } = useLocale()
  const { can } = useAuth()
  const [data, setData] = useState<WalletsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedProviders, setSelectedProviders] = useState<string[]>([])
  const [status, setStatus] = useState('all')
  const [selectedLive, setSelectedLive] = useState<string[]>([])
  const [livePage, setLivePage] = useState(1)
  const [replacementThreshold, setReplacementThreshold] = useState('85')
  const [replaceTarget, setReplaceTarget] = useState<string[] | null>(null)
  const [replaceNewNumber, setReplaceNewNumber] = useState('')
  const [replacePreview, setReplacePreview] = useState<Record<string, { loading: boolean; current: string | null; error: string | null }>>({})
  const [replaceResults, setReplaceResults] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [replaceBusy, setReplaceBusy] = useState(false)
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null)

  const [addNewTarget, setAddNewTarget] = useState<string | null>(null)
  const [addNewNumber, setAddNewNumber] = useState('')
  const [addNewName, setAddNewName] = useState('')
  const [addNewPreview, setAddNewPreview] = useState<{ loading: boolean; current: { PhoneNumber?: string; AccountName?: string; BankName?: string } | null; error: string | null } | null>(null)
  const [addNewResult, setAddNewResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [addNewBusy, setAddNewBusy] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const refreshSequence = useRef(0)

  const [selectedWallets, setSelectedWallets] = useState<string[]>([])
  const [addWalletOpen, setAddWalletOpen] = useState(false)
  const [newWallet, setNewWallet] = useState({ wallet_number: '', provider: 'Orange Money', merchant: '', daily_limit: '' })
  const [addWalletBusy, setAddWalletBusy] = useState(false)
  const [addWalletError, setAddWalletError] = useState<string | null>(null)

  const [rotationGroups, setRotationGroups] = useState<RotationGroup[]>([])
  const [rotationModalOpen, setRotationModalOpen] = useState(false)
  const [rotationMode, setRotationMode] = useState<'time' | 'amount'>('time')
  const [rotationInterval, setRotationInterval] = useState('60')
  const [rotationThreshold, setRotationThreshold] = useState('10000')
  const [rotationBusy, setRotationBusy] = useState(false)
  const [rotationError, setRotationError] = useState<string | null>(null)

  const canManageRotation = can('wallets', 'can_edit')
  const canCreateWallet = can('wallets', 'can_create')

  const loadRotationGroups = useCallback(async () => {
    try { setRotationGroups((await api<{ groups: RotationGroup[] }>('/api/wallets/rotation-groups')).groups) }
    catch { /* the rotation panel is optional chrome; a failed load just leaves the list empty */ }
  }, [])
  useEffect(() => { if (canManageRotation) void loadRotationGroups() }, [canManageRotation, loadRotationGroups])

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      setError(null)
      // Local wallet/device data is enough to paint and search the page. Do
      // not hold it behind the slower legacy Maven RPC.
      const base = await api<WalletsResponse>('/api/wallets?include_live=false')
      if (sequence !== refreshSequence.current) return
      setData((current) => ({ ...base, live: current?.live ?? [] }))
      setLastRefresh(new Date())
      void api<{ live: LiveWallet[] }>('/api/wallets/live').then(({ live }) => {
        if (sequence !== refreshSequence.current) return
        setData((current) => current ? { ...current, live } : current)
      }).catch(() => { /* Local mirror stays usable when the legacy source is slow. */ })
    } catch (e) {
      if (sequence !== refreshSequence.current) return
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض المحافظ.', 'You do not have permission to view wallets.') : t('تعذّر تحميل محافظ Maven.', 'Unable to load Maven wallets.'))
    }
  }, [t])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => { window.clearInterval(timer); refreshSequence.current++ }
  }, [refresh])

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
  const liveBankId = (row: LiveWallet) => String(row.bank_id ?? row.id ?? row.BankId ?? '').trim()
  const livePhone = (row: LiveWallet) => row.phone_number ?? row.PhoneNumber ?? null
  const liveAccountName = (row: LiveWallet) => row.account_name ?? row.AccountName ?? null
  const livePaymentType = (row: LiveWallet) => row.payment_type ?? row.PaymentType ?? null
  const livePageSize = 10
  const livePageCount = Math.max(1, Math.ceil(liveRows.length / livePageSize))
  const visibleLiveRows = liveRows.slice((livePage - 1) * livePageSize, livePage * livePageSize)
  // "Select all" covers every live wallet across all pages, not just the
  // page currently on screen — an operator picking a bulk action expects
  // "all" to mean all 106, not the 10 they can see.
  const allLiveSelected = liveRows.length > 0 && liveRows.every((row) => selectedLive.includes(liveBankId(row)))
  const toggleLive = (bankId: string) => setSelectedLive((current) => current.includes(bankId) ? current.filter((item) => item !== bankId) : [...current, bankId])
  const toggleAllLive = () => setSelectedLive(allLiveSelected ? [] : [...new Set(liveRows.map(liveBankId).filter(Boolean))])
  const changeAllLive = () => {
    const bankIds = [...new Set(liveRows.map(liveBankId).filter(Boolean))]
    if (bankIds.length) openReplace(bankIds)
  }

  // Real change against Maven's admin back office — always preview (read-only,
  // shows the current number) before the operator can confirm a commit.
  const openReplace = (bankIds: string[]) => {
    const targets = bankIds.filter(Boolean)
    setReplaceTarget(targets); setReplaceNewNumber(''); setReplaceResults({})
    setReplacePreview(Object.fromEntries(targets.map((id) => [id, { loading: true, current: null, error: null }])))
    for (const bankId of targets) {
      void api<{ current: { PhoneNumber?: string } }>('/api/wallets/live/replacement/preview', { method: 'POST', body: JSON.stringify({ bank_id: bankId }) })
        .then((res) => setReplacePreview((prev) => ({ ...prev, [bankId]: { loading: false, current: res.current?.PhoneNumber ?? null, error: null } })))
        .catch(() => setReplacePreview((prev) => ({ ...prev, [bankId]: { loading: false, current: null, error: t('تعذّر جلب الرقم الحالي', 'Could not fetch the current number') } })))
    }
  }
  const previewReady = replaceTarget?.length ? replaceTarget.every((id) => replacePreview[id] && !replacePreview[id].loading && !replacePreview[id].error) : false
  const submitReplace = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!replaceTarget || !/^\d{8,20}$/.test(replaceNewNumber)) return
    setReplaceBusy(true)
    for (const bankId of replaceTarget) {
      try {
        const res = await api<{ changed_from: string; changed_to: string }>('/api/wallets/live/replacement/commit', {
          method: 'POST', body: JSON.stringify({ bank_id: bankId, new_wallet_number: replaceNewNumber }),
        })
        setReplaceResults((prev) => ({ ...prev, [bankId]: { ok: true, message: t(`تم التغيير: ${res.changed_from} → ${res.changed_to}`, `Changed: ${res.changed_from} → ${res.changed_to}`) } }))
      } catch (error) {
        const message = error instanceof ApiError ? error.message : ''
        setReplaceResults((prev) => ({ ...prev, [bankId]: { ok: false, message: message || t('فشل التغيير على Maven', 'Change failed on Maven') } }))
      }
    }
    setReplaceBusy(false)
    setReplaceNotice(t('انتهى تنفيذ التغيير — راجع النتائج لكل رقم أدناه.', 'Change run finished — review each number’s result below.'))
    void refresh()
  }

  // add_new needs an existing bank_id as a template (Maven has no pure "add"
  // action) — it copies that wallet's bank/payment-type info onto a new
  // entry, then disables the reference wallet. The live count stays 106.
  const openAddNew = (bankId: string) => {
    setAddNewTarget(bankId); setAddNewNumber(''); setAddNewName(''); setAddNewResult(null)
    setAddNewPreview({ loading: true, current: null, error: null })
    void api<{ current: { PhoneNumber?: string; AccountName?: string; BankName?: string } }>('/api/wallets/live/replacement/preview', { method: 'POST', body: JSON.stringify({ bank_id: bankId }) })
      .then((res) => setAddNewPreview({ loading: false, current: res.current, error: null }))
      .catch(() => setAddNewPreview({ loading: false, current: null, error: t('تعذّر جلب بيانات المحفظة المرجعية', 'Could not fetch the reference wallet') }))
  }
  const submitAddNew = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!addNewTarget || !/^\d{8,20}$/.test(addNewNumber)) return
    setAddNewBusy(true)
    try {
      const res = await api<{ added_number: string; disabled_old_id: string; old_number: string }>('/api/wallets/live/add-new/commit', {
        method: 'POST', body: JSON.stringify({ bank_id: addNewTarget, new_wallet_number: addNewNumber, new_name: addNewName || undefined }),
      })
      setAddNewResult({ ok: true, message: t(`أُضيف ${res.added_number} وأُوقف ${res.old_number}`, `Added ${res.added_number}, disabled ${res.old_number}`) })
      void refresh()
    } catch {
      setAddNewResult({ ok: false, message: t('فشلت الإضافة على Maven', 'Add failed on Maven') })
    } finally { setAddNewBusy(false) }
  }

  const toggleProvider = (provider: string) => setSelectedProviders((current) => current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider])

  const visibleWalletNumbers = rows.map((wallet) => wallet.to_account_number)
  const allVisibleWalletsSelected = visibleWalletNumbers.length > 0 && visibleWalletNumbers.every((number) => selectedWallets.includes(number))
  const toggleWallet = (number: string) => setSelectedWallets((current) => current.includes(number) ? current.filter((item) => item !== number) : [...current, number])
  const toggleAllWallets = () => setSelectedWallets((current) => allVisibleWalletsSelected
    ? current.filter((number) => !visibleWalletNumbers.includes(number))
    : [...new Set([...current, ...visibleWalletNumbers])])

  const addWallet = async (event: React.FormEvent) => {
    event.preventDefault(); setAddWalletBusy(true); setAddWalletError(null)
    try {
      await api('/api/wallets', { method: 'POST', body: JSON.stringify(newWallet) })
      setNewWallet(emptyNewWallet); setAddWalletOpen(false); await refresh()
    } catch (e) {
      setAddWalletError(e instanceof ApiError && e.code === 'wallet_already_exists'
        ? t('هذه المحفظة موجودة بالفعل.', 'This wallet already exists.')
        : t('فشل إضافة المحفظة.', 'Failed to add wallet.'))
    } finally { setAddWalletBusy(false) }
  }

  const createRotationGroup = async (event: React.FormEvent) => {
    event.preventDefault(); setRotationBusy(true); setRotationError(null)
    try {
      await api('/api/wallets/rotation-groups', {
        method: 'POST',
        body: JSON.stringify({
          wallet_numbers: selectedWallets,
          mode: rotationMode,
          interval_minutes: rotationMode === 'time' ? Number(rotationInterval) : undefined,
          amount_threshold: rotationMode === 'amount' ? Number(rotationThreshold) : undefined,
        }),
      })
      setSelectedWallets([]); setRotationModalOpen(false); await loadRotationGroups()
    } catch (e) {
      setRotationError(e instanceof ApiError && e.code === 'at_least_two_wallets_required'
        ? t('اختر محفظتين على الأقل.', 'Select at least two wallets.')
        : t('تعذّر إنشاء قاعدة الدوران.', 'Unable to create the rotation rule.'))
    } finally { setRotationBusy(false) }
  }

  const toggleRotationGroupActive = async (group: RotationGroup) => {
    try { await api(`/api/wallets/rotation-groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ active: !group.active }) }); await loadRotationGroups() }
    catch { setRotationError(t('تعذّر تحديث قاعدة الدوران.', 'Unable to update the rotation rule.')) }
  }
  const deleteRotationGroup = async (group: RotationGroup) => {
    if (!window.confirm(t('حذف قاعدة الدوران دي؟', 'Delete this rotation rule?'))) return
    try { await api(`/api/wallets/rotation-groups/${group.id}`, { method: 'DELETE' }); await loadRotationGroups() }
    catch { setRotationError(t('تعذّر حذف قاعدة الدوران.', 'Unable to delete the rotation rule.')) }
  }

  return (
    <>
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
      {replaceNotice && <div className="card">{replaceNotice} <button type="button" className="btn-ghost btn-sm" onClick={() => setReplaceNotice(null)}>{t('إغلاق', 'Dismiss')}</button></div>}
      <section className="card maven-live-accounts">
        <div className="recent-head"><div><h3>{t('أرقام الاستقبال الحية', 'Live receiving numbers')}</h3><p className="cell-sub">{t('البيانات القادمة من Maven — اختر عدة أرقام لإدارة الاستبدال.', 'Maven source data — select multiple numbers for replacement management.')}</p></div><button className="btn-ghost btn-sm" type="button" onClick={() => void refresh()}><RefreshCw size={15} /> {t('تحديث', 'Refresh')}</button></div>
        <div className="maven-live-toolbar"><label className="maven-select-all"><input type="checkbox" checked={allLiveSelected} onChange={toggleAllLive} /> {t('تحديد الكل', 'Select all')} <span className="cell-sub">({liveRows.length})</span></label><span>{selectedLive.length} {t('محدد', 'selected')}</span><button className="btn-ghost btn-sm" type="button" disabled={!selectedLive.length} onClick={() => openReplace(selectedLive)}><Pencil size={14} /> {t('غيّر المحدد لرقم واحد', 'Change selected to one number')}</button><button className="btn-ghost btn-sm" type="button" disabled={!liveRows.length} onClick={changeAllLive}><Pencil size={14} /> {t('غيّر كل المحافظ', 'Change all wallets')}</button><label className="maven-threshold"><Target size={14} /> {t('الاستبدال التلقائي عند', 'Auto replacement at')} <select value={replacementThreshold} onChange={(event) => setReplacementThreshold(event.target.value)}><option value="80">80%</option><option value="85">85%</option><option value="90">90%</option></select></label></div>
        <div className="table-wrap maven-table-wrap"><table className="data-table maven-live-table"><thead><tr><th></th><th>{t('البنك', 'Bank')}</th><th>{t('النوع / التاجر', 'Type / merchant')}</th><th>{t('الرقم الحالي', 'Current number')}</th><th>{t('آخر فحص', 'Last checked')}</th><th>{t('إجراء', 'Action')}</th></tr></thead><tbody>
          {visibleLiveRows.map((row) => { const id = liveBankId(row); const phone = livePhone(row); return <tr key={`${id}-${phone ?? ''}`}><td><input type="checkbox" checked={selectedLive.includes(id)} onChange={() => toggleLive(id)} aria-label={`${t('تحديد', 'Select')} ${id}`} disabled={!id} /></td><td className="mono">{id || '—'}</td><td><strong>{livePaymentType(row) ?? '—'}</strong><div className="cell-sub">{liveAccountName(row) ?? t('غير محدد', 'Not specified')}</div></td><td className="mono">{phone ?? '—'}</td><td className="cell-sub">{depositTime({ first_seen_at: row.last_checked ?? row.updated_at })}</td><td className="maven-live-row-actions"><button className="btn-ghost btn-sm maven-change-btn" type="button" disabled={!id} onClick={() => openReplace([id])}><Pencil size={14} /> {t('غيّر', 'Change')}</button><button className="btn-ghost btn-sm" type="button" disabled={!id} onClick={() => openAddNew(id)}><Plus size={14} /> {t('استبدال بجديد', 'Replace w/ new')}</button></td></tr> })}
          {!visibleLiveRows.length && <tr><td colSpan={6} className="maven-empty">{t('لا توجد أرقام حية من Maven حالياً.', 'No live Maven receiving numbers currently available.')}</td></tr>}
        </tbody></table></div>
        <div className="maven-pagination"><span>{liveRows.length ? `${(livePage - 1) * livePageSize + 1}-${Math.min(livePage * livePageSize, liveRows.length)} / ${liveRows.length}` : '0 / 0'}</span><button className="btn-ghost btn-sm" type="button" disabled={livePage <= 1} onClick={() => setLivePage((page) => page - 1)}>{t('السابق', 'Previous')}</button><strong>{livePage} / {livePageCount}</strong><button className="btn-ghost btn-sm" type="button" disabled={livePage >= livePageCount} onClick={() => setLivePage((page) => page + 1)}>{t('التالي', 'Next')}</button></div>
      </section>
      <section className="card maven-wallet-table-card">
        <div className="recent-head"><div><h3>{t('أرقام الاستقبال — محافظ Maven', 'Maven receiving wallets')}</h3><p className="cell-sub">{rows.length.toLocaleString()} {t('محفظة مطابقة للفلاتر', 'wallets match the filters')} · {t('مزامنة تلقائية كل 60 ثانية', 'Auto-sync every 60 seconds')}</p></div><div className="maven-wallet-table-actions">
          {selectedWallets.length > 0 && <span className="cell-sub">{selectedWallets.length} {t('محددة', 'selected')}</span>}
          {canManageRotation && <button className="btn-ghost btn-sm" type="button" disabled={selectedWallets.length < 2} onClick={() => setRotationModalOpen(true)}><RotateCw size={14} /> {t('إنشاء ترتيب دوران للمحدد', 'Create rotation rule for selected')}</button>}
          {canCreateWallet && <button className="btn-ghost btn-sm" type="button" onClick={() => setAddWalletOpen(true)}><Plus size={14} /> {t('إضافة محفظة جديدة', 'Add new wallet')}</button>}
          <button className="btn-ghost btn-sm" type="button" onClick={() => window.print()}><Download size={15} /> {t('تصدير / طباعة', 'Export / print')}</button>
        </div></div>
        <div className="table-wrap maven-table-wrap"><table className="data-table maven-table"><thead><tr>{canManageRotation && <th><input type="checkbox" checked={allVisibleWalletsSelected} onChange={toggleAllWallets} aria-label={t('تحديد كل المحافظ الظاهرة', 'Select all visible wallets')} /></th>}<th>#</th><th>{t('رقم المحفظة / الحساب', 'Wallet / account')}</th><th>{t('المزوّد', 'Provider')}</th><th>{t('الجهاز و SIM', 'Device & SIM')}</th><th>{t('الرصيد الحالي', 'Current balance')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الحد اليومي', 'Daily limit')}</th><th>{t('التاجر', 'Merchant')}</th><th>{t('آخر تحديث', 'Last update')}</th>{can('wallets', 'can_edit') && <th>{t('إجراء', 'Action')}</th>}</tr></thead><tbody>
          {rows.map((wallet, index) => {
            const device = wallet.device ? deviceMap.get(`${wallet.device}#${wallet.sim_slot ?? 0}`) ?? deviceMap.get(`${wallet.device}#0`) : undefined
            const online = device?.online === true
            const matchingLive = liveRows.find((live) => livePhone(live)?.replace(/\D/g, '') === wallet.to_account_number.replace(/\D/g, '') && liveBankId(live))
            return <tr key={`${wallet.to_account_number}-${wallet.sim_slot ?? 0}`}>{canManageRotation && <td><input type="checkbox" checked={selectedWallets.includes(wallet.to_account_number)} onChange={() => toggleWallet(wallet.to_account_number)} aria-label={`${t('تحديد', 'Select')} ${wallet.to_account_number}`} /></td>}<td><span className="maven-row-number">{index + 1}</span></td><td><strong className="mono">{wallet.to_account_number}</strong><div className="cell-sub">{wallet.payment_type ?? t('استقبال', 'Receiving')}</div></td><td><span className="maven-provider">{wallet.provider ?? '—'}</span></td><td>{device ? <><strong className="mono">{device.device}</strong><div className="cell-sub">SIM {device.sim_slot ?? 0}{device.sim_number ? ` · ${device.sim_number}` : ''}</div></> : <span className="cell-sub"><Smartphone size={14} /> {t('غير مربوط', 'Unassigned')}</span>}</td><td><strong className="maven-balance">{device?.balance != null ? money(device.balance, 'EGP') : '—'}</strong>{device?.balance_at && <div className="cell-sub">{depositTime({ first_seen_at: device.balance_at })}</div>}</td><td><span className={`maven-status ${online ? 'online' : device ? 'offline' : 'unknown'}`}>{online ? <CheckCircle2 size={14} /> : device ? <WifiOff size={14} /> : <ShieldAlert size={14} />}{online ? t('متصل', 'Online') : device ? t('غير متصل', 'Offline') : t('غير معروف', 'Unknown')}</span>{device?.battery != null && <div className="cell-sub">🔋 {device.battery}%</div>}</td><td className="mono">{money(wallet.daily_limit ?? 60_000, 'EGP')}</td><td>{wallet.merchant ?? <span className="cell-sub">{t('عام', 'General')}</span>}</td><td className="cell-sub mono">{depositTime({ first_seen_at: device?.last_seen_at ?? wallet.updated_at })}</td>{can('wallets', 'can_edit') && <td className="row-actions">{matchingLive ? <button className="btn-ghost btn-sm" type="button" onClick={() => openReplace([liveBankId(matchingLive)])}><Pencil size={14} /> {t('غيّر الرقم', 'Change number')}</button> : <span className="cell-sub">{t('غير ظاهر في Maven', 'Not in Maven live list')}</span>}</td>}</tr>
          })}
          {rows.length === 0 && <tr><td colSpan={(canManageRotation ? 10 : 9) + (can('wallets', 'can_edit') ? 1 : 0)} className="maven-empty">{t('لا توجد محافظ مطابقة للفلاتر.', 'No wallets match the current filters.')}</td></tr>}
        </tbody></table></div>
      </section>

      {canManageRotation && (
        <section className="card maven-rotation-card">
          <div className="recent-head">
            <div><h3><RotateCw size={17} /> {t('قواعد دوران الأولوية', 'Priority rotation rules')}</h3><p className="cell-sub">{t('محاكاة داخلية فقط — لا تغيّر الرقم الذي يستقبل فلوس العملاء فعلياً؛ Maven هو من يحدد ذلك ولم يوفّر endpoint لتغييره بعد.', 'Internal simulation only — it never changes the number that actually receives customer funds; Maven controls that and has not exposed an endpoint to change it yet.')}</p></div>
          </div>
          {rotationError && <div className="card warn">{rotationError}</div>}
          {rotationGroups.length === 0 && <p className="sidebar-hint">{t('لا توجد قواعد دوران. حدد محفظتين أو أكتر من الجدول فوق وأنشئ قاعدة.', 'No rotation rules yet. Select two or more wallets in the table above to create one.')}</p>}
          {rotationGroups.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>{t('المحافظ', 'Wallets')}</th><th>{t('النمط', 'Mode')}</th><th>{t('آخر دوران', 'Last rotated')}</th><th>{t('الحالة', 'Status')}</th><th /></tr></thead>
                <tbody>
                  {rotationGroups.map((group) => (
                    <tr key={group.id}>
                      <td className="mono">{group.wallet_numbers.join('، ')}</td>
                      <td>{group.mode === 'time' ? `${t('كل', 'every')} ${group.interval_minutes} ${t('دقيقة', 'min')}` : `${t('بعد استقبال', 'after receiving')} ${money(group.amount_threshold, 'EGP')} (${money(group.amount_received_since_rotation, 'EGP')})`}</td>
                      <td className="cell-sub mono">{group.last_rotated_at ? depositTime({ first_seen_at: group.last_rotated_at }) : t('لم يحدث بعد', 'Not yet')}</td>
                      <td><span className={`pay-status-badge ${group.active ? 'st-paid' : 'st-dim'}`}>{group.active ? t('نشط', 'Active') : t('موقوف', 'Paused')}</span></td>
                      <td className="row-actions">
                        <button className="btn-ghost btn-sm" type="button" onClick={() => void toggleRotationGroupActive(group)}>{group.active ? t('إيقاف', 'Pause') : t('تفعيل', 'Resume')}</button>
                        <button className="btn-ghost danger btn-sm" type="button" onClick={() => void deleteRotationGroup(group)}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {addWalletOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !addWalletBusy) setAddWalletOpen(false) }}>
          <section className="card" style={{ maxWidth: 440 }} role="dialog" aria-modal="true" aria-labelledby="add-wallet-title">
            <div className="recent-head"><h3 id="add-wallet-title">{t('إضافة محفظة جديدة', 'Add new wallet')}</h3><button type="button" className="icon-action" disabled={addWalletBusy} onClick={() => setAddWalletOpen(false)} aria-label={t('إغلاق', 'Close')}><X size={17} /></button></div>
            <form className="control-row" onSubmit={addWallet}>
              <input className="login-input" required inputMode="tel" placeholder={t('رقم المحفظة', 'Wallet phone number')} value={newWallet.wallet_number} onChange={(e) => setNewWallet({ ...newWallet, wallet_number: e.target.value })} />
              <select className="login-input" value={newWallet.provider} onChange={(e) => setNewWallet({ ...newWallet, provider: e.target.value })}>{providers.map((p) => <option key={p}>{p}</option>)}</select>
              <input className="login-input" placeholder={t('التاجر (اختياري)', 'Merchant (optional)')} value={newWallet.merchant} onChange={(e) => setNewWallet({ ...newWallet, merchant: e.target.value })} />
              <input className="login-input" type="number" min="1" placeholder={t('الحد اليومي', 'Daily limit')} value={newWallet.daily_limit} onChange={(e) => setNewWallet({ ...newWallet, daily_limit: e.target.value })} />
              {addWalletError && <div className="card warn">{addWalletError}</div>}
              <button className="btn-primary btn-sm" disabled={addWalletBusy}>{addWalletBusy ? t('جارٍ الحفظ…', 'Saving…') : t('إضافة', 'Add')}</button>
            </form>
          </section>
        </div>
      )}

      {rotationModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !rotationBusy) setRotationModalOpen(false) }}>
          <section className="card" style={{ maxWidth: 460 }} role="dialog" aria-modal="true" aria-labelledby="rotation-title">
            <div className="recent-head"><h3 id="rotation-title"><RotateCw size={17} /> {t('ترتيب دوران تلقائي', 'Automatic rotation rule')}</h3><button type="button" className="icon-action" disabled={rotationBusy} onClick={() => setRotationModalOpen(false)} aria-label={t('إغلاق', 'Close')}><X size={17} /></button></div>
            <p className="cell-sub">{t('المحافظ المحددة:', 'Selected wallets:')} <span className="mono">{selectedWallets.join('، ')}</span></p>
            <form className="control-row" onSubmit={createRotationGroup}>
              <label className="filter-field">{t('النمط', 'Mode')}
                <select className="login-input" value={rotationMode} onChange={(e) => setRotationMode(e.target.value as 'time' | 'amount')}>
                  <option value="time">{t('كل فترة زمنية', 'Every time interval')}</option>
                  <option value="amount">{t('بعد استقبال مبلغ', 'After receiving an amount')}</option>
                </select>
              </label>
              {rotationMode === 'time'
                ? <label className="filter-field">{t('الفترة (دقائق)', 'Interval (minutes)')}<input className="login-input" type="number" min="5" value={rotationInterval} onChange={(e) => setRotationInterval(e.target.value)} /></label>
                : <label className="filter-field">{t('المبلغ (EGP)', 'Amount (EGP)')}<input className="login-input" type="number" min="1" value={rotationThreshold} onChange={(e) => setRotationThreshold(e.target.value)} /></label>}
              {rotationError && <div className="card warn">{rotationError}</div>}
              <button className="btn-primary btn-sm" disabled={rotationBusy}>{rotationBusy ? t('جارٍ الإنشاء…', 'Creating…') : t('إنشاء القاعدة', 'Create rule')}</button>
            </form>
          </section>
        </div>
      )}

      {replaceTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !replaceBusy) setReplaceTarget(null) }}>
          <section className="card" style={{ maxWidth: 520 }} role="dialog" aria-modal="true" aria-labelledby="replace-title">
            <div className="recent-head"><h3 id="replace-title"><Pencil size={17} /> {t('استبدال رقم الاستقبال', 'Change receiving number')}</h3><button type="button" className="icon-action" disabled={replaceBusy} onClick={() => setReplaceTarget(null)} aria-label={t('إغلاق', 'Close')}><X size={17} /></button></div>
            <div className="card warn">{t('هذا تغيير حقيقي على لوحة تحكم Maven مباشرة — وليس محاكاة. راجع الأرقام الحالية بعناية قبل التأكيد.', 'This is a real change on Maven’s admin back office, not a simulation — review the current numbers carefully before confirming.')}</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Bank ID</th><th>{t('الرقم الحالي', 'Current number')}</th><th>{t('النتيجة', 'Result')}</th></tr></thead>
                <tbody>
                  {replaceTarget.map((bankId) => {
                    const preview = replacePreview[bankId]
                    const result = replaceResults[bankId]
                    return <tr key={bankId}>
                      <td className="mono">{bankId}</td>
                      <td className="mono">{preview?.loading ? '…' : preview?.error ? <span className="danger-text">{preview.error}</span> : (preview?.current ?? '—')}</td>
                      <td>{result ? <span style={{ color: result.ok ? 'var(--status-paid)' : 'var(--status-declined)' }}>{result.message}</span> : '—'}</td>
                    </tr>
                  })}
                </tbody>
              </table>
            </div>
            <form className="control-row" onSubmit={submitReplace}>
              <input className="login-input" required inputMode="tel" placeholder={t('رقم المحفظة الجديد لكل ما سبق', 'New wallet number for all rows above')} value={replaceNewNumber} onChange={(e) => setReplaceNewNumber(e.target.value.replace(/\D/g, ''))} />
              <button className="btn-primary btn-sm" disabled={replaceBusy || !previewReady || !/^\d{8,20}$/.test(replaceNewNumber)}>{replaceBusy ? t('جارٍ التنفيذ على Maven…', 'Applying on Maven…') : t('تأكيد التغيير الفعلي', 'Confirm real change')}</button>
            </form>
          </section>
        </div>
      )}

      {addNewTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !addNewBusy) setAddNewTarget(null) }}>
          <section className="card" style={{ maxWidth: 480 }} role="dialog" aria-modal="true" aria-labelledby="add-new-title">
            <div className="recent-head"><h3 id="add-new-title"><Plus size={17} /> {t('استبدال بمحفظة جديدة', 'Replace with a new wallet')}</h3><button type="button" className="icon-action" disabled={addNewBusy} onClick={() => setAddNewTarget(null)} aria-label={t('إغلاق', 'Close')}><X size={17} /></button></div>
            <div className="card warn">{t('تغيير حقيقي على Maven — سيُضاف رقم جديد وسيُوقف هذا الرقم المرجعي (bank_id). العدد الكلي (106) لن يتغيّر.', 'Real change on Maven — a new number is added and this reference wallet (bank_id) is disabled. The total count (106) does not change.')}</div>
            <dl className="detail-grid">
              <dt>Bank ID</dt><dd className="mono">{addNewTarget}</dd>
              <dt>{t('سيُوقف', 'Will be disabled')}</dt>
              <dd className="mono">
                {addNewPreview?.loading ? '…' : addNewPreview?.error ? <span className="danger-text">{addNewPreview.error}</span> : (addNewPreview?.current?.PhoneNumber ?? '—')}
                {addNewPreview?.current?.AccountName && <div className="cell-sub">{addNewPreview.current.AccountName} · {addNewPreview.current.BankName ?? '—'}</div>}
              </dd>
            </dl>
            {addNewResult && <div className="card" style={{ borderColor: addNewResult.ok ? 'var(--green-border)' : 'var(--red-border)' }}>{addNewResult.message}</div>}
            <form className="control-row" onSubmit={submitAddNew}>
              <input className="login-input" required inputMode="tel" placeholder={t('رقم المحفظة الجديد', 'New wallet number')} value={addNewNumber} onChange={(e) => setAddNewNumber(e.target.value.replace(/\D/g, ''))} />
              <input className="login-input" placeholder={t('اسم الحساب (اختياري)', 'Account name (optional)')} value={addNewName} onChange={(e) => setAddNewName(e.target.value)} />
              <button className="btn-primary btn-sm" disabled={addNewBusy || addNewPreview?.loading || !/^\d{8,20}$/.test(addNewNumber)}>{addNewBusy ? t('جارٍ التنفيذ على Maven…', 'Applying on Maven…') : t('تأكيد الاستبدال الفعلي', 'Confirm real replacement')}</button>
            </form>
          </section>
        </div>
      )}
    </>
  )
}
