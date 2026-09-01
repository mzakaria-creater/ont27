import { useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { useAuth } from '../auth/AuthContext'
import { Activity, BadgeCheck, Calculator, Gauge, HeartPulse, MessageSquareText, Route, WalletCards } from 'lucide-react'

// Wallet pool: wallet_device_map rows (receiving wallets) + live device_status
// + local_deposit_channels (allocation config).

interface WalletRow {
  to_account_number: string
  device: string | null
  provider: string | null
  confidence: number | null
  auto_inferred: boolean | null
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
  operator: string | null
  battery: number | null
  charging: boolean | null
  net_type: string | null
  online: boolean | null
  balance: number | null
  balance_at: string | null
  last_seen_at: string | null
}

interface ChannelRow {
  id: string
  channel_type: string | null
  country_code: string | null
  currency_code: string | null
  display_name: string | null
  active: boolean | null
}

interface LiveWallet {
  bank_id: string | null
  account_name: string | null
  payment_type: string | null
  phone_number: string | null
  last_checked: string | null
}

interface WalletsResponse {
  live: LiveWallet[]
  wallets: WalletRow[]
  devices: DeviceRow[]
  channels: ChannelRow[]
}

type Strategy = 'lowest_usage' | 'priority' | 'dedicated_merchant' | 'smart_split'

interface AllocationCandidate {
  wallet_number: string
  provider: string | null
  merchant: string | null
  device: string | null
  priority: number
  balance: number
  daily_usage: number
  monthly_usage: number
  daily_cap: number
  monthly_cap: number
  health: 'healthy' | 'degraded' | 'offline' | 'unknown'
  last_sms_match: string | null
  eligible: boolean
  rejection_reasons: string[]
}

interface AllocationResult {
  deterministic: boolean
  amount: number
  strategy: Strategy
  selected: AllocationCandidate | null
  allocations: { wallet_number: string; amount: number }[]
  unallocated_amount: number
  candidates: AllocationCandidate[]
  evaluated_at: string
}

export default function Wallets() {
  const { t } = useLocale()
  const { can } = useAuth()
  const [data, setData] = useState<WalletsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [editor, setEditor] = useState<WalletRow | null>(null)
  const [targetDevice, setTargetDevice] = useState('')
  const [targetSim, setTargetSim] = useState('0')
  const [saving, setSaving] = useState(false)
  const [amount, setAmount] = useState('')
  const [strategy, setStrategy] = useState<Strategy>('lowest_usage')
  const [merchant, setMerchant] = useState('')
  const [simulating, setSimulating] = useState(false)
  const [simulationError, setSimulationError] = useState<string | null>(null)
  const [result, setResult] = useState<AllocationResult | null>(null)
  const [newWallet, setNewWallet] = useState({ wallet_number: '', provider: 'Orange Money', merchant: '', daily_limit: '' })
  const [walletBusy, setWalletBusy] = useState(false)
  const [walletMessage, setWalletMessage] = useState<string | null>(null)

  const refreshWallets = async () => setData(await api<WalletsResponse>('/api/wallets'))
  const importLiveWallets = async () => {
    setWalletBusy(true); setWalletMessage(null)
    try { const res = await api<{ imported: number }>('/api/wallets/sync-live', { method: 'POST' }); await refreshWallets(); setWalletMessage(t(`تم استيراد ${res.imported} محفظة من OnTarget.`, `Imported ${res.imported} wallets from OnTarget.`)) }
    catch (e) { setWalletMessage(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية استيراد المحافظ.', 'You do not have permission to import wallets.') : t('فشل استيراد المحافظ الحية.', 'Live wallet import failed.')) }
    finally { setWalletBusy(false) }
  }
  const createWallet = async (event: React.FormEvent) => {
    event.preventDefault(); setWalletBusy(true); setWalletMessage(null)
    try { await api('/api/wallets', { method: 'POST', body: JSON.stringify(newWallet) }); await refreshWallets(); setNewWallet({ wallet_number: '', provider: 'Orange Money', merchant: '', daily_limit: '' }); setWalletMessage(t('تمت إضافة المحفظة.', 'Wallet added.')) }
    catch (e) { setWalletMessage(e instanceof ApiError && e.code === 'wallet_already_exists' ? t('هذه المحفظة موجودة بالفعل.', 'This wallet already exists.') : t('فشل إضافة المحفظة.', 'Failed to add wallet.')) }
    finally { setWalletBusy(false) }
  }

  useEffect(() => {
    api<WalletsResponse>('/api/wallets')
      .then(setData)
      .catch((e) => {
        setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض المحافظ.' : 'تعذّر تحميل المحافظ.')
      })
  }, [])

  const reassign = async () => {
    if (!editor || !targetDevice) return
    setSaving(true)
    setErr(null)
    try {
      await api(`/api/wallets/${encodeURIComponent(editor.to_account_number)}/assignment`, {
        method: 'POST',
        body: JSON.stringify({ device: targetDevice, sim_slot: Number(targetSim) }),
      })
      setData(await api<WalletsResponse>('/api/wallets'))
      setEditor(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403
        ? t('لا تملك صلاحية تعديل المحافظ.', 'You do not have permission to edit wallets.')
        : t('تعذّر تغيير ربط المحفظة.', 'Unable to change the wallet mapping.'))
    } finally {
      setSaving(false)
    }
  }

  const deviceInfo = useMemo(() => {
    const map = new Map<string, DeviceRow>()
    for (const d of data?.devices ?? []) map.set(`${d.device}#${d.sim_slot ?? 0}`, d)
    return (w: WalletRow) =>
      (w.device ? map.get(`${w.device}#${w.sim_slot ?? 0}`) ?? map.get(`${w.device}#0`) : undefined) ??
      (data?.devices ?? []).find((d) => d.device === w.device)
  }, [data])

  const filtered = useMemo(() => {
    if (!data) return null
    const needle = q.trim().toLowerCase()
    if (!needle) return data.wallets
    return data.wallets.filter((w) =>
      [w.to_account_number, w.provider, w.payment_type, w.merchant, w.device]
        .some((v) => v?.toLowerCase().includes(needle)),
    )
  }, [data, q])

  const onlineDevices = data?.devices.filter((d) => d.online).length ?? 0

  const simulate = async (event: React.FormEvent) => {
    event.preventDefault()
    setSimulationError(null)
    setResult(null)
    const parsed = Number(amount)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setSimulationError(t('أدخل مبلغاً صحيحاً أكبر من صفر.', 'Enter a valid amount greater than zero.'))
      return
    }
    setSimulating(true)
    try {
      setResult(await api<AllocationResult>('/api/wallets/allocation/simulate', {
        method: 'POST', body: JSON.stringify({ amount: parsed, strategy, merchant }),
      }))
    } catch (error) {
      const code = error instanceof ApiError ? error.code : ''
      setSimulationError(code === 'merchant_required'
        ? t('اسم التاجر مطلوب لهذه الاستراتيجية.', 'Merchant is required for this strategy.')
        : code === 'amount_exceeds_monthly_cap'
          ? t('المبلغ يتجاوز الحد الشهري 200,000 EGP.', 'Amount exceeds the 200,000 EGP monthly cap.')
          : t('تعذّرت محاكاة التخصيص. راجع بيانات المحافظ والأجهزة.', 'Allocation simulation failed. Check wallet and device data.'))
    } finally {
      setSimulating(false)
    }
  }

  const reasonLabel = (reason: string) => ({
    retired_wallet: t('محفظة مستبدلة/متوقفة', 'Retired/replaced wallet'),
    inactive_account: t('الحساب غير نشط', 'Inactive account'),
    health_offline: t('الجهاز غير متصل', 'Device offline'),
    health_unknown: t('لا توجد بيانات جهاز', 'No device health data'),
    health_degraded: t('اتصال الجهاز قديم', 'Device heartbeat is stale'),
    daily_cap_exceeded: t('تجاوز الحد اليومي', 'Daily cap exceeded'),
    monthly_cap_exceeded: t('تجاوز الحد الشهري', 'Monthly cap exceeded'),
    merchant_mismatch: t('غير مخصصة لهذا التاجر', 'Not dedicated to this merchant'),
  }[reason] ?? reason)

  return (
    <PanelShell>
      <section className="page-head">
        <h2>{t('👛 المحافظ', '👛 Wallets')}</h2>
        <p className="page-sub">
          {data && (
            <>
              {data.wallets.length} محفظة مستقبِلة · {data.devices.length} جهاز
              ({onlineDevices} متصل) · {data.channels.filter((c) => c.active).length} قناة إيداع نشطة
            </>
          )}
        </p>
      </section>

      <section className="card recent-card allocation-engine">
        <div className="recent-head allocation-head">
          <div>
            <div className="allocation-title"><Route size={19} aria-hidden="true" /><h3>{t('محرك تخصيص المحافظ', 'Wallet Allocation Engine')}</h3></div>
            <p className="cell-sub">{t('محاكاة فقط — لا تحجز محفظة ولا تغيّر مسار الدفع.', 'Simulation only — no wallet is reserved and payment routing is unchanged.')}</p>
          </div>
          <span className="allocation-deterministic"><BadgeCheck size={15} aria-hidden="true" />{t('حتمي · غير عشوائي', 'Deterministic · not random')}</span>
        </div>

        <div className="allocation-caps" aria-label={t('حدود المحرك', 'Engine caps')}>
          <div><Gauge size={18} aria-hidden="true" /><span>{t('الحد اليومي', 'Daily cap')}</span><strong>60,000 EGP</strong></div>
          <div><WalletCards size={18} aria-hidden="true" /><span>{t('الحد الشهري', 'Monthly cap')}</span><strong>200,000 EGP</strong></div>
        </div>

        <form className="allocation-form" onSubmit={(event) => void simulate(event)}>
          <label>
            <span>{t('المبلغ (EGP)', 'Amount (EGP)')}</span>
            <input className="login-input control-input" type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="5,000" required />
          </label>
          <label>
            <span>{t('استراتيجية التخصيص', 'Allocation strategy')}</span>
            <select className="login-input control-input" value={strategy} onChange={(event) => setStrategy(event.target.value as Strategy)}>
              <option value="lowest_usage">{t('الأقل استخداماً أولاً', 'Lowest usage first')}</option>
              <option value="priority">{t('حسب الأولوية', 'Priority-based')}</option>
              <option value="dedicated_merchant">{t('محفظة مخصصة للتاجر', 'Dedicated merchant')}</option>
              <option value="smart_split">{t('تقسيم ذكي', 'Smart split')}</option>
            </select>
          </label>
          <label>
            <span>{t('التاجر', 'Merchant')} {strategy !== 'dedicated_merchant' && <small>{t('(اختياري)', '(optional)')}</small>}</span>
            <input className="login-input control-input" value={merchant} onChange={(event) => setMerchant(event.target.value)} required={strategy === 'dedicated_merchant'} placeholder="NGPay-MelBet-Prod" />
          </label>
          <button className="btn-primary allocation-submit" type="submit" disabled={simulating}>
            <Calculator size={17} aria-hidden="true" />
            {simulating ? t('جارٍ الحساب…', 'Calculating…') : t('اختيار المحفظة', 'Select wallet')}
          </button>
        </form>
        {simulationError && <div className="allocation-error" role="alert">{simulationError}</div>}

        {result && (
          <div className="allocation-results" aria-live="polite">
            {result.selected ? (
              <div className="allocation-pick">
                <div className="allocation-pick-icon"><WalletCards size={24} aria-hidden="true" /></div>
                <div><span>{t('المحفظة المختارة', 'Selected wallet')}</span><strong className="mono">{result.selected.wallet_number}</strong><small>{result.selected.provider ?? '—'} · {result.selected.device ?? t('بدون جهاز', 'No device')}</small></div>
                <div className="allocation-pick-amount"><span>{t('التخصيص', 'Allocation')}</span><strong>{money(result.allocations[0]?.amount ?? 0, 'EGP')}</strong></div>
              </div>
            ) : (
              <div className="allocation-error" role="status">{t('لا توجد محفظة مؤهلة لهذا المبلغ وفق الحدود والحالة الحالية.', 'No wallet is eligible for this amount under the current caps and health checks.')}</div>
            )}
            {result.allocations.length > 1 && <div className="allocation-split">{result.allocations.map((item, index) => <span key={item.wallet_number}>{index + 1}. <b className="mono">{item.wallet_number}</b> · {money(item.amount, 'EGP')}</span>)}</div>}
            <div className="table-wrap allocation-table">
              <table className="data-table">
                <thead><tr><th>{t('المحفظة', 'Wallet')}</th><th>{t('الرصيد', 'Balance')}</th><th>{t('الاستخدام اليومي', 'Daily usage')}</th><th>{t('الاستخدام الشهري', 'Monthly usage')}</th><th>{t('الحالة', 'Health')}</th><th>{t('آخر SMS مطابق', 'Last SMS match')}</th><th>{t('القرار', 'Decision')}</th></tr></thead>
                <tbody>{result.candidates.map((candidate) => (
                  <tr key={candidate.wallet_number} className={result.selected?.wallet_number === candidate.wallet_number ? 'allocation-selected-row' : ''}>
                    <td><strong className="mono">{candidate.wallet_number}</strong><div className="cell-sub">{candidate.provider ?? '—'} · P{candidate.priority}</div></td>
                    <td className="mono">{money(candidate.balance, 'EGP')}</td>
                    <td><div className="allocation-usage"><span>{money(candidate.daily_usage, 'EGP')}</span><span>{Math.min(100, Math.round(candidate.daily_usage / candidate.daily_cap * 100))}%</span></div><progress max={candidate.daily_cap} value={Math.min(candidate.daily_usage, candidate.daily_cap)} /></td>
                    <td><div className="allocation-usage"><span>{money(candidate.monthly_usage, 'EGP')}</span><span>{Math.min(100, Math.round(candidate.monthly_usage / candidate.monthly_cap * 100))}%</span></div><progress max={candidate.monthly_cap} value={Math.min(candidate.monthly_usage, candidate.monthly_cap)} /></td>
                    <td><span className={`allocation-health health-${candidate.health}`}><HeartPulse size={14} aria-hidden="true" />{candidate.health}</span></td>
                    <td><span className="allocation-sms"><MessageSquareText size={14} aria-hidden="true" />{candidate.last_sms_match ? depositTime({ first_seen_at: candidate.last_sms_match }) : '—'}</span></td>
                    <td>{candidate.eligible ? <span className="pay-status-badge st-paid"><Activity size={13} aria-hidden="true" />{t('مؤهلة', 'Eligible')}</span> : <div className="allocation-reasons">{candidate.rejection_reasons.map((reason) => <span key={reason}>{reasonLabel(reason)}</span>)}</div>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <div className="filter-bar">
        <form className="search-row" onSubmit={(e) => e.preventDefault()}>
          <input
            className="login-input search-input"
            placeholder={t('بحث: رقم محفظة / مزوّد / تاجر / جهاز…', 'Search wallet number, provider, merchant, or device…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </form>
      </div>

      {can('wallets', 'can_create') && <section className="card wallet-admin-tools">
        <div className="recent-head"><div><h3>{t('إضافة وإدارة محافظ الهاتف', 'Add & manage phone wallets')}</h3><p className="cell-sub">{t('استيراد المحافظ النشطة من OnTarget أو إضافة رقم جديد يدوياً.', 'Import active wallets from OnTarget or add a new phone wallet manually.')}</p></div><button className="btn-ghost btn-sm" type="button" onClick={() => void importLiveWallets()} disabled={walletBusy}>{walletBusy ? t('جارٍ التحديث…', 'Syncing…') : t('↻ استيراد المحافظ الحية', '↻ Import live wallets')}</button></div>
        <form className="wallet-create-form" onSubmit={(event) => void createWallet(event)}>
          <input className="login-input" required inputMode="tel" placeholder={t('رقم المحفظة', 'Wallet phone number')} value={newWallet.wallet_number} onChange={(e) => setNewWallet({ ...newWallet, wallet_number: e.target.value })} />
          <select className="login-input" value={newWallet.provider} onChange={(e) => setNewWallet({ ...newWallet, provider: e.target.value })}><option>Orange Money</option><option>Vodafone Cash</option><option>Etisalat Cash</option><option>WE Pay</option><option>InstaPay</option></select>
          <input className="login-input" placeholder={t('التاجر (اختياري)', 'Merchant (optional)')} value={newWallet.merchant} onChange={(e) => setNewWallet({ ...newWallet, merchant: e.target.value })} />
          <input className="login-input" type="number" min="1" placeholder={t('الحد اليومي', 'Daily limit')} value={newWallet.daily_limit} onChange={(e) => setNewWallet({ ...newWallet, daily_limit: e.target.value })} />
          <button className="btn-primary btn-sm" disabled={walletBusy}>{t('إضافة محفظة', 'Add wallet')}</button>
        </form>
        {walletMessage && <div className="cell-sub" role="status">{walletMessage}</div>}
      </section>}

      {editor && data && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>{t('تغيير ربط المحفظة', 'Change wallet mapping')}</h3>
            <button className="btn-ghost btn-sm" onClick={() => setEditor(null)}>{t('إلغاء', 'Cancel')}</button>
          </div>
          <p className="cell-sub mono">{editor.to_account_number}</p>
          <div className="control-row">
            <select className="login-input control-input" value={targetDevice} onChange={(e) => {
              setTargetDevice(e.target.value)
              const first = data.devices.find((device) => device.device === e.target.value)
              if (first) setTargetSim(String(first.sim_slot ?? 0))
            }}>
              <option value="">{t('اختر الجهاز', 'Select device')}</option>
              {[...new Set(data.devices.map((device) => device.device))].map((device) => <option key={device} value={device}>{device}</option>)}
            </select>
            <select className="login-input control-input" value={targetSim} onChange={(e) => setTargetSim(e.target.value)} disabled={!targetDevice}>
              {data.devices.filter((device) => device.device === targetDevice).map((device) => <option key={device.sim_slot ?? 0} value={String(device.sim_slot ?? 0)}>SIM {device.sim_slot ?? 0}</option>)}
            </select>
            <button className="btn-primary btn-sm" disabled={saving || !targetDevice} onClick={() => void reassign()}>
              {saving ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ التغيير', 'Save mapping')}
            </button>
          </div>
        </section>
      )}

      {err && <div className="card warn">{err}</div>}

      {data && data.live.length > 0 && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>✅ المحافظ النشطة الآن (بيانات حيّة)</h3>
            <span className="cell-sub">المصدر الرسمي — بيتفحص كل دقايق</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>bank_id</th><th>القناة</th><th>النوع</th><th>رقم المحفظة</th><th>آخر فحص</th></tr></thead>
              <tbody>
                {data.live.map((w, i) => (
                  <tr key={`${w.bank_id}-${i}`}>
                    <td className="mono">{w.bank_id ?? '—'}</td>
                    <td>{w.account_name ?? '—'}</td>
                    <td>{w.payment_type ?? '—'}</td>
                    <td className="mono">{w.phone_number ?? '—'}</td>
                    <td className="mono">{depositTime({ first_seen_at: w.last_checked })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card recent-card">
        <div className="recent-head">
          <h3>🗺️ ربط المحافظ بالأجهزة (wallet_device_map)</h3>
          <span className="cell-sub">الصفوف "استنتاج آلي" قد تكون قديمة — القايمة الحية فوق هي المرجع</span>
        </div>
        {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {filtered && filtered.length === 0 && <p>لا توجد نتائج مطابقة.</p>}
        {filtered && filtered.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>المحفظة</th>
                  <th>المزوّد</th>
                  <th>النوع</th>
                  <th>التاجر</th>
                  <th>الجهاز</th>
                  <th>حالة الجهاز</th>
                  <th>الحد اليومي</th>
                  <th>آخر تحديث</th><th>{t('إجراء', 'Action')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => {
                  const d = deviceInfo(w)
                  return (
                    <tr key={`${w.to_account_number}#${w.sim_slot ?? 0}`}>
                      <td className="mono">
                        {w.to_account_number}
                        {w.auto_inferred && <div className="cell-sub">⚙️ استنتاج آلي — غير مؤكد</div>}
                      </td>
                      <td>{w.provider ?? '—'}</td>
                      <td>{w.payment_type ?? '—'}</td>
                      <td>{w.merchant ?? '—'}</td>
                      <td className="mono">
                        {w.device ?? '—'}
                        {w.sim_slot != null && <div className="cell-sub mono">SIM {w.sim_slot}</div>}
                      </td>
                      <td>
                        {d ? (
                          <>
                            <span className={`pay-status-badge ${d.online ? 'st-paid' : 'st-declined'}`}>
                              {d.online ? 'متصل' : 'غير متصل'}
                            </span>
                            <div className="cell-sub mono">
                              {d.battery != null && <>🔋{d.battery}%</>}
                              {d.balance != null && <> · رصيد {money(d.balance, 'EGP')}</>}
                            </div>
                          </>
                        ) : (
                          <span className="pay-status-badge st-dim">لا بيانات</span>
                        )}
                      </td>
                      <td className="mono">{w.daily_limit != null ? money(w.daily_limit, 'EGP') : '—'}</td>
                      <td className="mono">{depositTime({ first_seen_at: w.updated_at })}</td>
                      <td><button className="btn-ghost btn-sm" onClick={() => { setEditor(w); setTargetDevice(w.device ?? ''); setTargetSim(String(w.sim_slot ?? 0)) }}>{t('تغيير', 'Change')}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data && data.channels.length > 0 && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>قنوات الإيداع المحلية</h3>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>القناة</th>
                  <th>النوع</th>
                  <th>الدولة / العملة</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {data.channels.map((ch) => (
                  <tr key={ch.id}>
                    <td>{ch.display_name ?? '—'}</td>
                    <td className="mono">{ch.channel_type ?? '—'}</td>
                    <td className="mono">{ch.country_code ?? '—'} · {ch.currency_code ?? '—'}</td>
                    <td>
                      <span className={`pay-status-badge ${ch.active ? 'st-paid' : 'st-dim'}`}>
                        {ch.active ? 'نشطة' : 'موقوفة'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </PanelShell>
  )
}
