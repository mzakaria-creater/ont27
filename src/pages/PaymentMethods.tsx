import { useCallback, useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'
import { Building2, CreditCard, LayoutGrid, Search, TableProperties, Upload, UsersRound, WalletCards } from 'lucide-react'
import MethodLogo from '../components/MethodLogo'
import { refreshBrandLogos } from '../lib/brandLogos'

interface Method { id: string; method_code: string; method_name: string; channel_type: string; is_active: boolean; sort_order: number }
interface Account {
  id: string; payment_method_id: string; payment_pool_id: string | null; account_number: string
  account_name: string | null; iban: string | null; bank_name: string | null; currency: string | null
  country_code: string | null; device_name: string | null; label: string | null; is_active: boolean
  current_balance: number | null; balance_updated_at: string | null
}
interface Pool { id: string; master_merchant_id: string; pool_name: string; pool_code: string; is_active: boolean; notes: string | null }
interface PoolMember { id: string; payment_pool_id: string; merchant_hierarchy_id: number; is_active: boolean }
interface HierarchyRow { id: number; name: string; payin_commission_pct: number | null }
interface Master { id: string; name: string; code: string }
type Data = { methods: Method[]; accounts: Account[]; pools: Pool[]; poolMembers: PoolMember[]; hierarchy: HierarchyRow[]; masters: Master[] }

const emptyAccount = { account_number: '', label: '', device_name: '', bank_name: '' }
const emptyPool = { pool_name: '', pool_code: '', master_merchant_id: '' }

// Balance freshness — matches the 15-minute window used when the SMS→wallet
// sync was built, so a figure that stopped updating never reads as live.
const STALE_MINUTES = 15
function balanceAge(iso: string | null, t: (ar: string, en: string) => string): { text: string; stale: boolean } | null {
  if (!iso) return null
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  const stale = mins > STALE_MINUTES
  const text = mins < 1 ? t('الآن', 'just now')
    : mins < 60 ? t(`منذ ${mins} د`, `${mins}m ago`)
    : mins < 1440 ? t(`منذ ${Math.round(mins / 60)} س`, `${Math.round(mins / 60)}h ago`)
    : t(`منذ ${Math.round(mins / 1440)} يوم`, `${Math.round(mins / 1440)}d ago`)
  return { text, stale }
}

function masterCls(code: string | undefined): string {
  if (code === 'ngpay') return 'ngpay'
  if (code === 'payfuture') return 'payfuture'
  return 'other'
}

export default function PaymentMethods() {
  const { t } = useLocale(); const { can, user } = useAuth()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'methods' | 'accounts'>('methods')
  const [open, setOpen] = useState<string | null>(null)
  const [account, setAccount] = useState(emptyAccount)
  const [newMethod, setNewMethod] = useState({ method_code: '', method_name: '', channel_type: 'sms_device' })
  const [newPool, setNewPool] = useState(emptyPool)
  const [assign, setAssign] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [accountStatus, setAccountStatus] = useState('all')
  const [accountView, setAccountView] = useState<'table' | 'cards'>(() => localStorage.getItem('payment-account-view') === 'cards' ? 'cards' : 'table')
  const [logoBusy, setLogoBusy] = useState<string | null>(null)
  const editable = can('payment_methods', 'can_edit')
  const create = can('payment_methods', 'can_create')
  const canUploadLogo = ['owner', 'admin', 'super_admin'].includes(user?.role ?? '') && can('settings', 'can_edit')

  const load = useCallback(async () => {
    try { setData(await api<Data>('/api/payment-methods')); setError(null) } catch (e) {
      setError(e instanceof ApiError && e.status === 403
        ? t('لا تملك صلاحية طرق الدفع.', 'You do not have payment-method permission.')
        : t('تعذر التحميل.', 'Unable to load.'))
    }
  }, [t])
  useEffect(() => { void load() }, [load])

  const toggle = async (m: Method) => { try { await api(`/api/payment-methods/${m.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !m.is_active }) }); await load() } catch { setError(t('تعذر الحفظ.', 'Unable to save.')) } }
  const addMethod = async (e: React.FormEvent) => { e.preventDefault(); try { await api('/api/payment-methods', { method: 'POST', body: JSON.stringify(newMethod) }); setNewMethod({ method_code: '', method_name: '', channel_type: 'sms_device' }); await load() } catch { setError(t('تعذر إضافة الطريقة.', 'Unable to add method.')) } }
  const addAccount = async (e: React.FormEvent) => { e.preventDefault(); if (!open) return; try { await api(`/api/payment-methods/${open}/accounts`, { method: 'POST', body: JSON.stringify(account) }); setAccount(emptyAccount); setOpen(null); await load() } catch { setError(t('تعذر إضافة الحساب.', 'Unable to add account.')) } }
  const toggleAccount = async (r: Account) => { try { await api(`/api/payment-methods/accounts/${r.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !r.is_active }) }); await load() } catch { setError(t('تعذر الحفظ.', 'Unable to save.')) } }
  const setAccountPool = async (r: Account, poolId: string) => { try { await api(`/api/payment-methods/accounts/${r.id}`, { method: 'PATCH', body: JSON.stringify({ payment_pool_id: poolId || null }) }); await load() } catch { setError(t('تعذر الحفظ.', 'Unable to save.')) } }
  const addPool = async (e: React.FormEvent) => { e.preventDefault(); try { await api('/api/payment-methods/pools', { method: 'POST', body: JSON.stringify(newPool) }); setNewPool(emptyPool); await load() } catch { setError(t('تعذر إنشاء الـ pool.', 'Unable to create pool.')) } }
  const assignMerchant = async (poolId: string) => { const mh = assign[poolId]; if (!mh) return; try { await api(`/api/payment-methods/pools/${poolId}/merchants`, { method: 'POST', body: JSON.stringify({ merchant_hierarchy_id: Number(mh) }) }); setAssign({ ...assign, [poolId]: '' }); await load() } catch { setError(t('تعذر إسناد التاجر.', 'Unable to assign merchant.')) } }
  const toggleMember = async (m: PoolMember) => { try { await api(`/api/payment-methods/pools/members/${m.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !m.is_active }) }); await load() } catch { setError(t('تعذر الحفظ.', 'Unable to save.')) } }
  const uploadMethodLogo = async (method: Method, file: File | null) => {
    if (!file) return
    setLogoBusy(method.id); setError(null)
    try {
      const form = new FormData(); form.set('file', file); form.set('asset_type', 'method'); form.set('asset_key', method.method_name)
      await api('/api/admin/branding/logo', { method: 'POST', body: form }); await refreshBrandLogos()
    } catch (e) { setError(e instanceof ApiError ? e.code : t('تعذر رفع الشعار.', 'Could not upload logo.')) }
    finally { setLogoBusy(null) }
  }

  // account → pool → master merchant + the sub-merchants sharing that pool.
  const poolOf = (a: Account) => data?.pools.find((p) => p.id === a.payment_pool_id) ?? null
  const masterOf = (a: Account) => { const p = poolOf(a); return p ? data?.masters.find((m) => m.id === p.master_merchant_id) ?? null : null }
  const subsOf = (a: Account): string[] => {
    const p = poolOf(a); if (!p || !data) return []
    return data.poolMembers
      .filter((m) => m.payment_pool_id === p.id && m.is_active)
      .map((m) => data.hierarchy.find((h) => h.id === m.merchant_hierarchy_id)?.name)
      .filter((n): n is string => !!n)
  }

  const activeMethods = data?.methods.filter((m) => m.is_active).length ?? 0
  const activeAccounts = data?.accounts.filter((a) => a.is_active).length ?? 0
  const linkedSubs = data ? new Set(data.poolMembers.filter((m) => m.is_active).map((m) => m.merchant_hierarchy_id)).size : 0
  const filteredAccounts = (data?.accounts ?? []).filter((row) => {
    const method = data?.methods.find((item) => item.id === row.payment_method_id)
    const q = search.trim().toLowerCase()
    if (q && ![row.account_number, row.label, row.device_name, method?.method_name].filter(Boolean).join(' ').toLowerCase().includes(q)) return false
    if (accountStatus === 'active' && !row.is_active) return false
    if (accountStatus === 'disabled' && row.is_active) return false
    if (accountStatus === 'stale' && !balanceAge(row.balance_updated_at, t)?.stale) return false
    if (accountStatus === 'unassigned' && row.payment_pool_id) return false
    return true
  })
  const changeAccountView = (view: 'table' | 'cards') => { setAccountView(view); localStorage.setItem('payment-account-view', view) }

  return (
    <PanelShell>
      <section className="page-head payment-page-head">
        <div><h2><CreditCard size={25}/> {t('طرق الدفع والحسابات', 'Payment methods & accounts')}</h2>
        <p className="page-sub">{t('مركز تشغيل الطرق والحسابات والتخصيص وصحة الرصيد.', 'Operations center for methods, accounts, allocation, and balance health.')}</p></div>
      </section>

      {error && <div className="card warn">{error}</div>}

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label"><CreditCard size={16}/> {t('طرق دفع نشطة', 'Active methods')}</span>
          <span className="stat-value">{data ? activeMethods : '…'}</span>
          <span className="stat-sub">{data ? t(`من ${data.methods.length} طريقة`, `of ${data.methods.length} total`) : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label"><WalletCards size={16}/> {t('حسابات نشطة', 'Active accounts')}</span>
          <span className="stat-value">{data ? activeAccounts : '…'}</span>
          <span className="stat-sub">{data ? t(`من ${data.accounts.length} حساب`, `of ${data.accounts.length} total`) : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label"><Building2 size={16}/> {t('تجار رئيسيون', 'Master merchants')}</span>
          <span className="stat-value">{data ? data.masters.length : '…'}</span>
          <span className="stat-sub">{data ? data.masters.map((m) => m.name).join(' · ') : ''}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label"><UsersRound size={16}/> {t('تجار فرعيون مرتبطون', 'Sub-merchants linked')}</span>
          <span className="stat-value">{data ? linkedSubs : '…'}</span>
          <span className="stat-sub">{data ? t(`عبر ${data.pools.length} تجمّع`, `across ${data.pools.length} pools`) : ''}</span>
        </div>
      </div>

      <div className="filter-pills" role="tablist" style={{ marginBlock: 14 }}>
        <button role="tab" aria-selected={tab === 'methods'} className={`pill${tab === 'methods' ? ' active' : ''}`} onClick={() => setTab('methods')}>
          {t('طرق الدفع', 'Payment methods')} <span className="mono">{data?.methods.length ?? 0}</span>
        </button>
        <button role="tab" aria-selected={tab === 'accounts'} className={`pill${tab === 'accounts' ? ' active' : ''}`} onClick={() => setTab('accounts')}>
          {t('الحسابات المُسندة', 'Assigned accounts')} <span className="mono">{data?.accounts.length ?? 0}</span>
        </button>
      </div>

      {!data && <p className="sidebar-hint">{t('جار التحميل…', 'Loading…')}</p>}

      {data && tab === 'methods' && (
        <>
          {create && (
            <form className="card payment-method-create" onSubmit={addMethod}>
              <div><strong>{t('إضافة طريقة دفع جديدة', 'Add new payment method')}</strong><span>{t('أنشئ الطريقة أولاً، ثم ارفع شعارها من بطاقتها.', 'Create the method first, then upload its logo from its card.')}</span></div>
              <input className="login-input" required placeholder="CODE" value={newMethod.method_code} onChange={(e) => setNewMethod({ ...newMethod, method_code: e.target.value })} />
              <input className="login-input" required placeholder={t('الاسم', 'Name')} value={newMethod.method_name} onChange={(e) => setNewMethod({ ...newMethod, method_name: e.target.value })} />
              <select className="login-input" value={newMethod.channel_type} onChange={(e) => setNewMethod({ ...newMethod, channel_type: e.target.value })}>
                <option value="sms_device">SMS device</option>
                <option value="bank_transfer">Bank transfer</option>
                <option value="other">Other</option>
              </select>
              <button className="btn-primary btn-sm">{t('إضافة الطريقة', 'Add method')}</button>
            </form>
          )}
          {data.methods.map((method) => {
            const rows = data.accounts.filter((r) => r.payment_method_id === method.id)
            return (
              <section className="card recent-card" key={method.id}>
                <div className="recent-head">
                  <h3 className="payment-method-title"><MethodLogo method={method.method_name}/><span>{method.method_name}<small className="mono">{method.method_code}</small></span></h3>
                  <div className="control-row">
                    <span className="pay-status-badge st-dim">{method.channel_type}</span>
                    <span className={`pay-status-badge ${method.is_active ? 'st-paid' : 'st-dim'}`}>{method.is_active ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</span>
                    <span className="cell-sub">{t(`${rows.length} حساب`, `${rows.length} accounts`)}</span>
                    {canUploadLogo && <label className={`btn-ghost btn-sm method-logo-upload${logoBusy===method.id?' disabled':''}`}><Upload size={14}/>{logoBusy===method.id?t('جارٍ الرفع…','Uploading…'):t('رفع شعار','Upload logo')}<input type="file" hidden disabled={logoBusy!==null} accept="image/png,image/jpeg,image/webp" onChange={(e)=>{void uploadMethodLogo(method,e.target.files?.[0]??null);e.currentTarget.value='' }}/></label>}
                    {editable && <button className="btn-ghost btn-sm" onClick={() => void toggle(method)}>{method.is_active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>}
                    {create && <button className="btn-primary btn-sm" onClick={() => setOpen(open === method.id ? null : method.id)}>{t('إسناد حساب جديد', 'Assign new account')}</button>}
                  </div>
                </div>
                {open === method.id && (
                  <form className="control-row" onSubmit={addAccount}>
                    <input required className="login-input" placeholder={t('رقم الحساب', 'Account number')} value={account.account_number} onChange={(e) => setAccount({ ...account, account_number: e.target.value })} />
                    <input className="login-input" placeholder={t('تسمية', 'Label')} value={account.label} onChange={(e) => setAccount({ ...account, label: e.target.value })} />
                    <input className="login-input" placeholder={t('الجهاز', 'Device')} value={account.device_name} onChange={(e) => setAccount({ ...account, device_name: e.target.value })} />
                    <button className="btn-primary btn-sm">{t('حفظ', 'Save')}</button>
                  </form>
                )}
              </section>
            )
          })}
        </>
      )}

      {data && tab === 'accounts' && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>🏦 {t('الحسابات المُسندة', 'Assigned accounts')}</h3>
            <span className="cell-sub">{t('الرصيد يأتي من رسائل SMS الواردة لكل جهاز — ليس قيمة يدوية.', 'Balance comes from each device’s inbound SMS — not a manually entered figure.')}</span>
          </div>
          <div className="payment-account-toolbar">
            <label><Search size={16}/><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder={t('بحث برقم الحساب أو الجهاز أو الطريقة','Search account, device, or method')}/></label>
            <select value={accountStatus} onChange={(e)=>setAccountStatus(e.target.value)}><option value="all">{t('كل الحسابات','All accounts')}</option><option value="active">{t('نشطة','Active')}</option><option value="disabled">{t('موقوفة','Disabled')}</option><option value="stale">{t('رصيد قديم','Stale balance')}</option><option value="unassigned">{t('بدون Pool','Unassigned')}</option></select>
            <span className="mono cell-sub">{filteredAccounts.length} / {data.accounts.length}</span>
            <div className="view-switch"><button className={accountView==='table'?'active':''} onClick={()=>changeAccountView('table')}><TableProperties size={15}/></button><button className={accountView==='cards'?'active':''} onClick={()=>changeAccountView('cards')}><LayoutGrid size={15}/></button></div>
          </div>
          {accountView === 'table' && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('الحساب', 'Account')}</th>
                  <th>{t('الطريقة', 'Method')}</th>
                  <th>{t('الجهاز', 'Device')}</th>
                  <th>{t('الرصيد الحالي', 'Current balance')}</th>
                  <th>{t('التاجر الرئيسي', 'Master merchant')}</th>
                  <th>{t('التجار الفرعيون', 'Sub-merchants')}</th>
                  <th>{t('التجمّع', 'Pool')}</th>
                  <th>{t('الحالة', 'Status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((r) => {
                  const method = data.methods.find((m) => m.id === r.payment_method_id)
                  const master = masterOf(r)
                  const subs = subsOf(r)
                  const age = balanceAge(r.balance_updated_at, t)
                  return (
                    <tr key={r.id}>
                      <td className="mono">{r.account_number}{r.label && <div className="cell-sub">{r.label}</div>}</td>
                      <td><MethodLogo method={method?.method_name}/></td>
                      <td className="mono">{r.device_name ?? '—'}</td>
                      <td>
                        {r.current_balance == null
                          ? <span className="cell-sub">{t('غير معروف', 'Unknown')}</span>
                          : <>
                              <span className="mono" style={{ color: Number(r.current_balance) > 0 ? 'var(--status-paid)' : undefined }}>
                                {Number(r.current_balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {r.currency ?? ''}
                              </span>
                              {age && <div className={`cell-sub${age.stale ? ' warn-text' : ''}`}>{age.stale ? t(`قديم — ${age.text}`, `Stale — ${age.text}`) : age.text}</div>}
                            </>}
                      </td>
                      <td>{master ? <span className={`merchant-chip ${masterCls(master.code)}`}>{master.name}</span> : <span className="cell-sub">—</span>}</td>
                      <td>{subs.length ? subs.join('، ') : <span className="cell-sub">{t('غير مُسند', 'Unassigned')}</span>}</td>
                      <td>
                        {editable
                          ? <select className="login-input" aria-label={t(`تجمّع الحساب ${r.account_number}`, `Pool for account ${r.account_number}`)} value={r.payment_pool_id ?? ''} onChange={(e) => void setAccountPool(r, e.target.value)}>
                              <option value="">{t('بدون', 'None')}</option>
                              {data.pools.map((p) => <option key={p.id} value={p.id}>{p.pool_name}</option>)}
                            </select>
                          : (data.pools.find((p) => p.id === r.payment_pool_id)?.pool_name ?? '—')}
                      </td>
                      <td><span className={`pay-status-badge ${r.is_active ? 'st-paid' : 'st-dim'}`}>{r.is_active ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</span></td>
                      <td>{editable && <button className="btn-ghost btn-sm" onClick={() => void toggleAccount(r)}>{r.is_active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>}</td>
                    </tr>
                  )
                })}
                {filteredAccounts.length === 0 && <tr><td colSpan={9} className="sidebar-hint">{t('لا توجد حسابات مطابقة.', 'No matching accounts.')}</td></tr>}
              </tbody>
            </table>
          </div>
          )}
          {accountView === 'cards' && <div className="payment-account-grid">{filteredAccounts.map((r)=>{const method=data.methods.find((m)=>m.id===r.payment_method_id);const master=masterOf(r);const subs=subsOf(r);const age=balanceAge(r.balance_updated_at,t);return <article className="payment-account-card" key={r.id}><div className="payment-account-card-head"><MethodLogo method={method?.method_name}/><span className={`pay-status-badge ${r.is_active?'st-paid':'st-dim'}`}>{r.is_active?t('نشط','Active'):t('موقوف','Disabled')}</span></div><strong className="mono">{r.account_number}</strong><span className="cell-sub">{r.label??r.device_name??'—'}</span><div className="payment-account-balance"><small>{t('الرصيد الحالي','Current balance')}</small><b className="mono">{r.current_balance==null?'—':Number(r.current_balance).toLocaleString('en-US',{minimumFractionDigits:2})} {r.currency??''}</b>{age&&<span className={age.stale?'warn-text':''}>{age.stale?t(`قديم — ${age.text}`,`Stale — ${age.text}`):age.text}</span>}</div><dl><div><dt>{t('الجهاز','Device')}</dt><dd>{r.device_name??'—'}</dd></div><div><dt>Master</dt><dd>{master?.name??'—'}</dd></div><div><dt>{t('التجار','Merchants')}</dt><dd>{subs.join('، ')||'—'}</dd></div></dl>{editable&&<><select className="login-input" value={r.payment_pool_id??''} onChange={(e)=>void setAccountPool(r,e.target.value)}><option value="">{t('بدون Pool','No pool')}</option>{data.pools.map((p)=><option key={p.id} value={p.id}>{p.pool_name}</option>)}</select><button className="btn-ghost btn-sm" onClick={()=>void toggleAccount(r)}>{r.is_active?t('إيقاف الحساب','Disable account'):t('تفعيل الحساب','Enable account')}</button></>}</article>})}</div>}
        </section>
      )}

      <section className="page-head">
        <h2>{t('تجمّعات الدفع (Pools)', 'Payment pools')}</h2>
        <p className="page-sub">{t('التجمّع يتبع master merchant واحداً ويمكن مشاركته بين عدة تجار فرعيين. الحسابات غير المصنّفة تبقى بدون تجمّع.', 'A pool belongs to one master merchant and can be shared across sub-merchants. Unclassified accounts stay unpooled.')}</p>
      </section>
      {data && create && (
        <form className="card control-row" onSubmit={addPool}>
          <strong>{t('تجمّع جديد', 'New pool')}</strong>
          <input required className="login-input" placeholder={t('الاسم', 'Name')} value={newPool.pool_name} onChange={(e) => setNewPool({ ...newPool, pool_name: e.target.value })} />
          <input required className="login-input" placeholder="code" value={newPool.pool_code} onChange={(e) => setNewPool({ ...newPool, pool_code: e.target.value })} />
          <select required className="login-input" value={newPool.master_merchant_id} onChange={(e) => setNewPool({ ...newPool, master_merchant_id: e.target.value })}>
            <option value="">Master…</option>
            {data.masters.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code})</option>)}
          </select>
          <button className="btn-primary btn-sm">{t('إنشاء', 'Create')}</button>
        </form>
      )}
      {data?.pools.map((pool) => {
        const members = data.poolMembers.filter((m) => m.payment_pool_id === pool.id)
        const accountsInPool = data.accounts.filter((a) => a.payment_pool_id === pool.id)
        const master = data.masters.find((m) => m.id === pool.master_merchant_id)
        const available = data.hierarchy.filter((h) => !members.some((m) => m.merchant_hierarchy_id === h.id && m.is_active))
        return (
          <section className="card recent-card" key={pool.id}>
            <div className="recent-head">
              <h3>{pool.pool_name} <span className="cell-sub mono">{pool.pool_code}{master ? ` · ${master.name}` : ''} · {t(`${accountsInPool.length} حساب`, `${accountsInPool.length} accounts`)}</span></h3>
              {editable && (
                <div className="control-row">
                  <select className="login-input" aria-label={t(`إسناد تاجر إلى ${pool.pool_name}`, `Assign merchant to ${pool.pool_name}`)} value={assign[pool.id] ?? ''} onChange={(e) => setAssign({ ...assign, [pool.id]: e.target.value })}>
                    <option value="">{t('إسناد تاجر…', 'Assign merchant…')}</option>
                    {available.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                  <button className="btn-primary btn-sm" onClick={() => void assignMerchant(pool.id)}>{t('إسناد', 'Assign')}</button>
                </div>
              )}
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>{t('التاجر الفرعي', 'Sub-merchant')}</th><th>{t('نسبة Payin', 'Payin %')}</th><th>{t('الحالة', 'Status')}</th><th /></tr></thead>
                <tbody>
                  {members.length ? members.map((member) => {
                    const h = data.hierarchy.find((row) => row.id === member.merchant_hierarchy_id)
                    return (
                      <tr key={member.id}>
                        <td>{h?.name ?? member.merchant_hierarchy_id}</td>
                        <td className="mono">{h?.payin_commission_pct ?? '—'}%</td>
                        <td><span className={`pay-status-badge ${member.is_active ? 'st-paid' : 'st-dim'}`}>{member.is_active ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</span></td>
                        <td>{editable && <button className="btn-ghost btn-sm" onClick={() => void toggleMember(member)}>{member.is_active ? t('إزالة', 'Remove') : t('تفعيل', 'Enable')}</button>}</td>
                      </tr>
                    )
                  }) : <tr><td colSpan={4} className="sidebar-hint">{t('لا يوجد تجار مسندون.', 'No merchants assigned.')}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </PanelShell>
  )
}
