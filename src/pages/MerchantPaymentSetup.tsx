import { useCallback, useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import MethodLogo from '../components/MethodLogo'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'
import { Building2, Check, CreditCard, Search, WalletCards, X } from 'lucide-react'

interface Method { id: string; method_name: string; method_code: string; is_active: boolean }
interface Account { id: string; payment_method_id: string; payment_pool_id: string | null; account_number: string; account_name: string | null; bank_name: string | null; currency: string | null; device_name: string | null; label: string | null; is_active: boolean; current_balance: number | null }
interface Pool { id: string; master_merchant_id: string; pool_name: string; is_active: boolean }
interface PoolMember { id: string; payment_pool_id: string; merchant_hierarchy_id: number; is_active: boolean }
interface Merchant { id: number; name: string; master_merchant_id: string | null }
interface Master { id: string; name: string; code: string }
interface MethodCountry { id: string; payment_method_id: string; country_code: string; currency_code: string; is_active: boolean }
interface CountryMerchant { id: string; method_country_id: string; merchant_hierarchy_id: number; is_active: boolean }
interface Data { methods: Method[]; accounts: Account[]; pools: Pool[]; poolMembers: PoolMember[]; hierarchy: Merchant[]; masters: Master[]; methodCountries: MethodCountry[]; countryMerchants: CountryMerchant[] }

type MerchantRow = Merchant & { master: Master | null; methods: Method[]; accounts: Account[] }

function masterClass(code: string | undefined) {
  return code === 'ngpay' ? 'ngpay' : code === 'payfuture' ? 'payfuture' : 'other'
}

export default function MerchantPaymentSetup() {
  const { t } = useLocale()
  const { can } = useAuth()
  const [data, setData] = useState<Data | null>(null)
  const [masterFilter, setMasterFilter] = useState('all')
  const [merchantFilter, setMerchantFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const editable = can('payment_methods', 'can_edit')

  const load = useCallback(async () => {
    try {
      const response = await api<Data>('/api/payment-methods')
      setData(response)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403
        ? t('لا تملك صلاحية إعدادات طرق الدفع.', 'You do not have permission to view payment setup.')
        : t('تعذر تحميل إعدادات الدفع.', 'Unable to load payment setup.'))
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  const merchants = useMemo<MerchantRow[]>(() => {
    if (!data) return []
    return data.hierarchy.map((merchant) => {
      const master = data.masters.find((item) => item.id === merchant.master_merchant_id) ?? null
      const activeMethodIds = new Set(
        data.countryMerchants
          .filter((assignment) => assignment.merchant_hierarchy_id === merchant.id && assignment.is_active)
          .map((assignment) => assignment.method_country_id),
      )
      const methods = data.methods.filter((method) => method.is_active && data.methodCountries.some((country) => country.payment_method_id === method.id && country.is_active && activeMethodIds.has(country.id)))
      const poolIds = new Set(data.poolMembers.filter((member) => member.merchant_hierarchy_id === merchant.id && member.is_active).map((member) => member.payment_pool_id))
      const accounts = data.accounts.filter((account) => account.is_active && account.payment_pool_id != null && poolIds.has(account.payment_pool_id))
      return { ...merchant, master, methods, accounts }
    })
  }, [data])

  const visibleMerchants = merchants.filter((merchant) => {
    if (masterFilter !== 'all' && merchant.master_merchant_id !== masterFilter) return false
    if (merchantFilter !== 'all' && String(merchant.id) !== merchantFilter) return false
    if (query.trim() && !`${merchant.name} ${merchant.master?.name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) return false
    return true
  })

  const toggleMethod = async (merchant: MerchantRow, method: Method) => {
    if (!data || !editable) return
    const country = data.methodCountries.find((item) => item.payment_method_id === method.id && item.is_active && item.country_code === 'EG')
      ?? data.methodCountries.find((item) => item.payment_method_id === method.id && item.is_active)
    if (!country) return
    const existing = data.countryMerchants.find((item) => item.method_country_id === country.id && item.merchant_hierarchy_id === merchant.id)
    setBusy(`${merchant.id}:${method.id}`)
    setError(null)
    try {
      if (existing) {
        await api(`/api/payment-methods/countries/merchants/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !existing.is_active }) })
      } else {
        await api(`/api/payment-methods/countries/${country.id}/merchants`, { method: 'POST', body: JSON.stringify({ merchant_hierarchy_id: merchant.id }) })
      }
      await load()
    } catch {
      setError(t('تعذر تحديث الطريقة لهذا التاجر.', 'Unable to update this merchant payment method.'))
    } finally {
      setBusy(null)
    }
  }

  const activeMethods = data?.methods.filter((method) => method.is_active).length ?? 0
  const activeAccounts = data?.accounts.filter((account) => account.is_active).length ?? 0
  const assignedMerchants = visibleMerchants.filter((merchant) => merchant.methods.length > 0 || merchant.accounts.length > 0).length

  return (
    <PanelShell>
      <section className="page-head">
        <div>
          <h2><WalletCards size={24} /> {t('إعداد دفع التجار', 'Merchant payment setup')}</h2>
          <p className="page-sub">{t('طرق الدفع والحسابات المخصصة لكل تاجر رئيسي وتاجر فرعي.', 'Payment methods and receiving accounts assigned to each master and sub-merchant.')}</p>
        </div>
      </section>

      {error && <div className="card warn">{error}</div>}

      <section className="stat-grid">
        <div className="stat-card"><span className="stat-label"><Building2 size={16} /> {t('التجار الفرعيون', 'Sub-merchants')}</span><span className="stat-value">{data ? visibleMerchants.length : '…'}</span><span className="stat-sub">{assignedMerchants} {t('لديهم إعدادات', 'configured')}</span></div>
        <div className="stat-card"><span className="stat-label"><CreditCard size={16} /> {t('طرق الدفع النشطة', 'Active methods')}</span><span className="stat-value">{data ? activeMethods : '…'}</span><span className="stat-sub">{t('متاحة للتخصيص', 'available to assign')}</span></div>
        <div className="stat-card"><span className="stat-label"><WalletCards size={16} /> {t('الحسابات النشطة', 'Active accounts')}</span><span className="stat-value">{data ? activeAccounts : '…'}</span><span className="stat-sub">{t('حسابات استقبال', 'receiving accounts')}</span></div>
      </section>

      <section className="card recent-card">
        <div className="payment-account-toolbar">
          <label><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('بحث بالتاجر الرئيسي أو الفرعي', 'Search master or sub-merchant')} /></label>
          <select value={masterFilter} onChange={(event) => { setMasterFilter(event.target.value); setMerchantFilter('all') }} aria-label={t('التاجر الرئيسي', 'Master merchant')}>
            <option value="all">{t('كل التجار الرئيسيين', 'All master merchants')}</option>
            {data?.masters.map((master) => <option key={master.id} value={master.id}>{master.name}</option>)}
          </select>
          <select value={merchantFilter} onChange={(event) => setMerchantFilter(event.target.value)} aria-label={t('التاجر الفرعي', 'Sub-merchant')}>
            <option value="all">{t('كل التجار الفرعيين', 'All sub-merchants')}</option>
            {merchants.filter((merchant) => masterFilter === 'all' || merchant.master_merchant_id === masterFilter).map((merchant) => <option key={merchant.id} value={merchant.id}>{merchant.name}</option>)}
          </select>
        </div>
      </section>

      {!data && !error && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
      {data && visibleMerchants.map((merchant) => {
        const pools = data.pools.filter((pool) => merchant.accounts.some((account) => account.payment_pool_id === pool.id))
        return (
          <section className="card recent-card merchant-payment-setup-card" key={merchant.id}>
            <div className="recent-head">
              <div>
                <h3>{merchant.name}</h3>
                <span className="cell-sub">{merchant.master ? <span className={`merchant-chip ${masterClass(merchant.master.code)}`}>{merchant.master.name}</span> : t('بدون تاجر رئيسي', 'No master merchant')} · ID {merchant.id}</span>
              </div>
              <span className="cell-sub mono">{merchant.methods.length} {t('طرق', 'methods')} · {merchant.accounts.length} {t('حسابات', 'accounts')}</span>
            </div>
            <div className="merchant-payment-setup-grid">
              <div>
                <div className="section-label">{t('طرق الدفع', 'Payment methods')}</div>
                <div className="merchant-payment-method-list">
                  {data.methods.filter((method) => method.is_active).map((method) => {
                    const enabled = merchant.methods.some((item) => item.id === method.id)
                    const key = `${merchant.id}:${method.id}`
                    return <button type="button" key={method.id} disabled={!editable || busy === key} className={`merchant-payment-method-toggle${enabled ? ' active' : ''}`} onClick={() => void toggleMethod(merchant, method)}><MethodLogo method={method.method_name} /><span>{method.method_name}</span>{busy === key ? <span className="mono">…</span> : enabled ? <Check size={15} /> : <X size={15} />}</button>
                  })}
                  {!data.methods.some((method) => method.is_active) && <span className="sidebar-hint">{t('لا توجد طرق نشطة.', 'No active methods.')}</span>}
                </div>
              </div>
              <div>
                <div className="section-label">{t('حسابات الدفع', 'Payment accounts')}</div>
                {merchant.accounts.length ? <div className="merchant-payment-account-list">{merchant.accounts.map((account) => { const method = data.methods.find((item) => item.id === account.payment_method_id); const pool = data.pools.find((item) => item.id === account.payment_pool_id); return <div className="merchant-payment-account-row" key={account.id}><WalletCards size={16} /><div><strong className="mono">{account.account_number}</strong><span>{account.label ?? account.account_name ?? method?.method_name ?? '—'}</span></div><small>{method?.method_name ?? '—'} · {pool?.pool_name ?? '—'}{account.device_name ? ` · ${account.device_name}` : ''}</small></div> })}</div> : <div className="empty-state"><WalletCards size={18} /><span>{t('لا توجد حسابات مخصصة لهذا التاجر.', 'No accounts assigned to this merchant.')}</span></div>}
                {pools.length > 1 && <div className="cell-sub" style={{ marginTop: 8 }}>{pools.length} {t('تجمّعات حسابات', 'account pools')}</div>}
              </div>
            </div>
          </section>
        )
      })}
      {data && visibleMerchants.length === 0 && <div className="card empty-state"><Building2 size={20} /><span>{t('لا يوجد تاجر مطابق للفلاتر.', 'No merchant matches the filters.')}</span></div>}
    </PanelShell>
  )
}
