import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { depositTime } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Device { device: string; sim_slot: number | null; online: boolean | null; battery: number | null; last_seen_at: string | null }

export default function AirDroid() {
  const { t } = useLocale()
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async () => { setLoading(true); try { const result = await api<{ devices: Device[] }>('/api/sms/devices'); setDevices(result.devices); setError(null) } catch { setError(t('تعذر قراءة حالة الأجهزة.', 'Could not load device status.')) } finally { setLoading(false) } }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer) }, [])

  return <PanelShell>
    <section className="page-head"><div><h2><Smartphone size={24}/> AirDroid</h2><p className="page-sub">{t('وصول آمن للأجهزة مع حالة الاتصال الحية من نظام SMS.', 'Secure device access with live connection state from the SMS system.')}</p></div><a className="btn-primary btn-sm" href="https://web.airdroid.com/" target="_blank" rel="noreferrer">{t('فتح AirDroid Web', 'Open AirDroid Web')} <ExternalLink size={15}/></a></section>
    <section className="card airdroid-security"><ShieldCheck size={20}/><div><strong>{t('تسجيل الدخول يبقى لدى AirDroid', 'Authentication stays with AirDroid')}</strong><p>{t('لا نخزن كلمة مرور AirDroid ولا نعرض الموقع داخل iframe. افتح اللوحة الرسمية في تبويب منفصل.', 'We do not store an AirDroid password or embed the site in an iframe. Open the official console in a separate tab.')}</p></div></section>
    {error && <div className="card warn">{error}</div>}
    <section className="card recent-card"><div className="recent-head"><div><h3>{t('الأجهزة المرتبطة بالتشغيل', 'Operational devices')}</h3><span className="cell-sub">{devices.filter((d)=>d.online).length} / {devices.length} {t('متصلة', 'online')}</span></div><button className="btn-ghost btn-sm" disabled={loading} onClick={()=>void load()}><RefreshCw size={14} className={loading?'spin':''}/> {t('تحديث', 'Refresh')}</button></div><div className="airdroid-device-grid">{devices.map((device)=><article key={`${device.device}-${device.sim_slot}`} className="airdroid-device"><span className={`airdroid-device-icon ${device.online?'online':''}`}><Smartphone size={22}/></span><div><strong>{device.device}</strong><span>SIM {device.sim_slot ?? '—'}</span><small>{t('آخر اتصال', 'Last seen')}: {depositTime({first_seen_at:device.last_seen_at})}</small></div><div className="airdroid-device-meta"><span className={`pay-status-badge ${device.online?'st-paid':'st-dim'}`}>{device.online?t('متصل','Online'):t('غير متصل','Offline')}</span><span className="mono">{device.battery == null?'—':`${device.battery}%`}</span></div></article>)}{!loading&&devices.length===0&&<p className="sidebar-hint">{t('لا توجد أجهزة مسجلة.', 'No registered devices.')}</p>}</div></section>
  </PanelShell>
}
