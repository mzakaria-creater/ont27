import { useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

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

export default function Wallets() {
  const { t } = useLocale()
  const [data, setData] = useState<WalletsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [editor, setEditor] = useState<WalletRow | null>(null)
  const [targetDevice, setTargetDevice] = useState('')
  const [targetSim, setTargetSim] = useState('0')
  const [saving, setSaving] = useState(false)

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
            <h3>✅ المحافظ النشطة الآن (Maven مباشر)</h3>
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