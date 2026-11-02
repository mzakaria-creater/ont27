import { useEffect, useMemo, useState } from 'react'
import { Phone, RefreshCw, Settings2, Send, ShieldAlert } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

type Network = 'orange' | 'vodafone'
type HookState = { active: boolean; has_key: boolean; updated_at: string } | null
type DeviceRow = { device: string; label: string | null; active: boolean; orange: HookState; vodafone: HookState }
type RequestRow = { id: number; device: string; network: Network; phone: string; amount: string; status: 'sent' | 'failed'; http_status: number | null; error: string | null; requested_by: string | null; created_at: string }
type Stage = 'idle' | 'confirm' | 'dialing' | 'sent' | 'failed'

// The two USSD strings the macros dial on the device (the macro receives phone/amount/pin as webhook parameters).
const CODES: Record<Network, (phone: string, amount: string, pin: string) => string> = {
  orange: (p, a, pin) => `*7115*1*1*${p}*${a}*${pin}#`,
  vodafone: (p, a, pin) => `*9*7*${p}*${a}*${pin}#`,
}
const NETWORK_LABEL: Record<Network, string> = { orange: 'Orange Cash', vodafone: 'Vodafone Cash' }

export default function Ussd() {
  const { t } = useLocale()
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [maxAmount, setMaxAmount] = useState(50000)
  const [history, setHistory] = useState<RequestRow[]>([])
  const [device, setDevice] = useState('')
  const [network, setNetwork] = useState<Network>('orange')
  const [phone, setPhone] = useState('')
  const [amount, setAmount] = useState('')
  const [pin, setPin] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [configOpen, setConfigOpen] = useState(false)

  const load = async () => {
    try {
      const [cfg, req] = await Promise.all([
        api<{ devices: DeviceRow[]; max_amount: number }>('/api/ussd/config'),
        api<{ requests: RequestRow[] }>('/api/ussd/requests'),
      ])
      setDevices(cfg.devices)
      setMaxAmount(cfg.max_amount)
      setHistory(req.requests)
      setDevice((current) => current || cfg.devices.find((d) => d.active)?.device || '')
      setError('')
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية صفحة USSD.', 'You do not have access to the USSD page.') : t('تعذر تحميل البيانات.', 'Could not load data.'))
    }
  }
  useEffect(() => { void load() }, [])

  const selected = devices.find((d) => d.device === device)
  const hook = selected?.[network] ?? null
  const phoneOk = /^01[0-9]{9}$/.test(phone)
  const amountNum = Number(amount)
  const amountOk = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= maxAmount && Math.round(amountNum * 100) === amountNum * 100
  const pinOk = /^[0-9]{4,6}$/.test(pin)
  const ready = !!device && phoneOk && amountOk && pinOk && !!hook?.active
  const shown = useMemo(() => CODES[network](phone || 'phone', amount || 'amount', pin ? '•'.repeat(pin.length) : 'pin'), [network, phone, amount, pin])

  const reset = () => { setStage('idle'); setMessage('') }

  const send = async () => {
    setStage('dialing')
    setMessage('')
    try {
      await api('/api/ussd/send', { method: 'POST', body: JSON.stringify({ device, network, phone, amount: amountNum, pin }) })
      setStage('sent')
      setMessage(t(`أُرسل الطلب إلى ${device}. النتيجة الفعلية ستظهر في SMS الجهاز.`, `Request sent to ${device}. The real result arrives as an SMS on the device.`))
      setPin('')
      setPhone('')
      setAmount('')
    } catch (e) {
      setStage('failed')
      const code = e instanceof ApiError ? (e.message || String(e.status)) : 'network_error'
      setMessage(code === 'webhook_not_configured' ? t('لم يُضبط رابط الـ webhook لهذا الجهاز/الشبكة.', 'No webhook configured for this device/network.') : t(`فشل الإرسال (${code}).`, `Send failed (${code}).`))
    } finally { void load() }
  }

  return <>
    <section className="page-head admin-head">
      <span className="admin-head-icon"><Phone size={20}/></span>
      <div className="admin-head-text">
        <span className="admin-head-eyebrow">{t('المدفوعات والمحافظ', 'Payments & wallets')}</span>
        <h2>{t('إرسال USSD', 'USSD sender')}</h2>
        <p className="page-sub">{t('أرسل تحويلًا من محفظة جهاز محدد عبر MacroDroid. الـ PIN لا يُحفظ في أي مكان.', 'Send a transfer from a chosen device wallet via MacroDroid. The PIN is never stored.')}</p>
      </div>
      <div className="admin-head-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-ghost btn-sm" onClick={() => void load()}><RefreshCw size={15}/> {t('تحديث', 'Refresh')}</button>
        <button className="btn-ghost btn-sm" onClick={() => setConfigOpen(true)}><Settings2 size={15}/> {t('روابط الأجهزة', 'Device webhooks')}</button>
      </div>
    </section>
    {error && <div className="card warn">{error}</div>}

    <div className="ussd-layout">
      <form className="card ussd-form" onSubmit={(e) => { e.preventDefault(); if (ready) setStage('confirm') }}>
        <label>{t('الجهاز', 'Device')}
          <select value={device} onChange={(e) => { setDevice(e.target.value); reset() }}>
            {devices.map((d) => <option key={d.device} value={d.device} disabled={!d.active}>{d.device}{d.label ? ` · ${d.label}` : ''}</option>)}
          </select>
        </label>
        <div className="ussd-network" role="radiogroup" aria-label={t('الشبكة', 'Network')}>
          {(['orange', 'vodafone'] as Network[]).map((n) => (
            <button type="button" key={n} role="radio" aria-checked={network === n} className={`ussd-net ussd-net-${n}${network === n ? ' active' : ''}`} onClick={() => { setNetwork(n); reset() }}>{NETWORK_LABEL[n]}</button>
          ))}
        </div>
        <label>{t('رقم المستلم', 'Recipient number')}
          <input inputMode="numeric" maxLength={11} placeholder="01XXXXXXXXX" value={phone} onChange={(e) => { setPhone(e.target.value.replace(/\D/g, '')); reset() }}/>
          {phone && !phoneOk && <small className="ussd-hint">{t('11 رقمًا يبدأ بـ 01', '11 digits starting with 01')}</small>}
        </label>
        <label>{t('المبلغ (EGP)', 'Amount (EGP)')}
          <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, '')); reset() }}/>
          {amount && !amountOk && <small className="ussd-hint">{t(`أقل من أو يساوي ${maxAmount.toLocaleString()}`, `Up to ${maxAmount.toLocaleString()}`)}</small>}
        </label>
        <label>{t('PIN المحفظة', 'Wallet PIN')}
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); reset() }}/>
        </label>
        {device && !hook?.active && <div className="ussd-hint"><ShieldAlert size={14}/> {t('لا يوجد رابط webhook مفعّل لهذا الجهاز على هذه الشبكة.', 'No active webhook for this device on this network.')}</div>}
        <button className="btn-primary" type="submit" disabled={!ready || stage === 'dialing'}><Send size={15}/> {t('إرسال إلى الجهاز', 'Send to device')}</button>
      </form>

      <div className="ussd-phone-wrap" aria-live="polite">
        <div className={`ussd-phone ussd-phone-${network}`}>
          <div className="ussd-notch"/>
          <div className="ussd-statusbar"><span>{device || '—'}</span><span>{NETWORK_LABEL[network]}</span></div>
          <div className="ussd-screen">
            {stage === 'idle' && <>
              <div className="ussd-dial-label">{t('سيتم الطلب', 'Will dial')}</div>
              <div className="ussd-dial-code mono" dir="ltr">{shown}</div>
              <div className="ussd-keys" aria-hidden="true">{['1','2','3','4','5','6','7','8','9','*','0','#'].map((k) => <span key={k}>{k}</span>)}</div>
            </>}
            {stage === 'confirm' && <div className="ussd-dialog">
              <strong>{t('تأكيد التحويل', 'Confirm transfer')}</strong>
              <p>{t(`إرسال ${amount} جنيه إلى ${phone} من ${device} (${NETWORK_LABEL[network]})؟`, `Send ${amount} EGP to ${phone} from ${device} (${NETWORK_LABEL[network]})?`)}</p>
              <div className="ussd-dial-code mono" dir="ltr">{shown}</div>
              <div className="ussd-dialog-actions">
                <button type="button" className="btn-ghost btn-sm" onClick={reset}>{t('إلغاء', 'Cancel')}</button>
                <button type="button" className="btn-primary btn-sm" onClick={() => void send()}>{t('تأكيد وإرسال', 'Confirm & send')}</button>
              </div>
            </div>}
            {stage === 'dialing' && <div className="ussd-dialog"><div className="ussd-spinner"/><p>{t('جارٍ إرسال الطلب إلى الجهاز…', 'Sending the request to the device…')}</p></div>}
            {stage === 'sent' && <div className="ussd-dialog ussd-ok"><strong>✔ {t('تم الإرسال', 'Sent')}</strong><p>{message}</p><button type="button" className="btn-ghost btn-sm" onClick={reset}>{t('عملية جديدة', 'New transfer')}</button></div>}
            {stage === 'failed' && <div className="ussd-dialog ussd-bad"><strong>✖ {t('فشل', 'Failed')}</strong><p>{message}</p><button type="button" className="btn-ghost btn-sm" onClick={reset}>{t('حاول مرة أخرى', 'Try again')}</button></div>}
          </div>
        </div>
      </div>
    </div>

    <section className="card recent-card">
      <div className="recent-head"><h3>{t('آخر الطلبات', 'Recent requests')}</h3><span className="cell-sub">{t('بدون PIN. الحالة هنا تعني وصول الطلب للجهاز فقط، وليس نجاح التحويل.', 'No PIN stored. "Sent" only means the device received the request, not that the transfer succeeded.')}</span></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>#</th><th>{t('الوقت', 'Time')}</th><th>{t('الجهاز', 'Device')}</th><th>{t('الشبكة', 'Network')}</th><th>{t('المستلم', 'Recipient')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الحالة', 'Status')}</th><th>{t('بواسطة', 'By')}</th></tr></thead>
        <tbody>{history.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td>{new Date(r.created_at).toLocaleString()}</td><td className="mono">{r.device}</td><td>{NETWORK_LABEL[r.network]}</td><td className="mono">{r.phone}</td><td className="mono">{Number(r.amount).toLocaleString()}</td><td><span className={`pay-status-badge ${r.status === 'sent' ? 'st-paid' : 'st-dim'}`}>{r.status === 'sent' ? t('وصل للجهاز', 'Sent') : `${t('فشل', 'Failed')}${r.error ? ` · ${r.error}` : ''}`}</span></td><td>{r.requested_by ?? '—'}</td></tr>)}
          {!history.length && <tr><td colSpan={8} className="empty-cell">{t('لا توجد طلبات بعد.', 'No requests yet.')}</td></tr>}</tbody></table></div>
    </section>

    {configOpen && <WebhookConfig devices={devices} onClose={() => { setConfigOpen(false); void load() }}/>}
  </>
}

function WebhookConfig({ devices, onClose }: { devices: DeviceRow[]; onClose: () => void }) {
  const { t } = useLocale()
  const [device, setDevice] = useState(devices[0]?.device ?? '')
  const [network, setNetwork] = useState<Network>('orange')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [active, setActive] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg('')
    try {
      await api(`/api/ussd/webhooks/${device}/${network}`, { method: 'PUT', body: JSON.stringify({ webhook_url: url, active, ...(secret ? { secret } : {}) }) })
      setMsg(t('تم الحفظ.', 'Saved.')); setUrl(''); setSecret('')
    } catch (err) { setMsg(err instanceof ApiError && err.status === 403 ? t('لا تملك صلاحية تعديل الروابط.', 'You cannot edit webhooks.') : t('فشل الحفظ. تأكد أن الرابط يبدأ بـ https://', 'Save failed. The URL must start with https://')) }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <form className="modal-card" onSubmit={save}>
      <h3>{t('روابط webhook للأجهزة', 'Device webhooks')}</h3>
      <p className="cell-sub">{t('الصق رابط MacroDroid بدون أي parameters: https://trigger.macrodroid.com/DEVICE_ID/orange_send (أو vodafone_send). الرابط والمفتاح لا يظهران بعد الحفظ.', 'Paste the MacroDroid URL without parameters: https://trigger.macrodroid.com/DEVICE_ID/orange_send (or vodafone_send). The URL and key are hidden after saving.')}</p>
      <div className="form-grid">
        <label>{t('الجهاز', 'Device')}<select value={device} onChange={(e) => setDevice(e.target.value)}>{devices.map((d) => <option key={d.device} value={d.device}>{d.device}</option>)}</select></label>
        <label>{t('الشبكة', 'Network')}<select value={network} onChange={(e) => setNetwork(e.target.value as Network)}><option value="orange">Orange Cash</option><option value="vodafone">Vodafone Cash</option></select></label>
        <label className="span-2">Webhook URL<input type="url" required placeholder="https://trigger.macrodroid.com/…/orange_send" value={url} onChange={(e) => setUrl(e.target.value)}/></label>
        <label className="span-2">{t('المفتاح السري (key)', 'Secret key (key)')}<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t('اتركه فارغًا للإبقاء على الحالي', 'Leave empty to keep the current one')}/></label>
      </div>
      <label className="check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/> {t('مفعّل', 'Active')}</label>
      {msg && <div className="cell-sub">{msg}</div>}
      <div className="modal-actions"><button type="button" className="btn-ghost" onClick={onClose}>{t('إغلاق', 'Close')}</button><button className="btn-primary" type="submit" disabled={busy}>{t('حفظ', 'Save')}</button></div>
    </form>
  </div>
}
