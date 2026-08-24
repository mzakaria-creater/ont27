import { useEffect, useState } from 'react'
import { ExternalLink, LockKeyhole, MonitorSmartphone, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { depositTime } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Device { device: string; sim_slot: number | null; online: boolean | null; battery: number | null; last_seen_at: string | null }
const AIRDROID_BUSINESS_URL = 'https://biz.airdroid.com/#/devices/list/-100'
const MAVEN_SUPPLIER_URL = 'https://bo.maven-consulting.co/Supplier'

export default function AirDroid() {
  const { t } = useLocale()
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const load = async () => { setLoading(true); try { const result = await api<{ devices: Device[] }>('/api/sms/devices'); setDevices(result.devices); setError(null) } catch { setError(t('تعذر قراءة حالة الأجهزة.', 'Could not load device status.')) } finally { setLoading(false) } }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer) }, [])

  return <PanelShell>
    <section className="page-head"><div><h2><Smartphone size={24}/> AirDroid Business</h2><p className="page-sub">{t('وصول آمن للأجهزة مع حالة الاتصال الحية من نظام SMS.', 'Secure device access with live connection state from the SMS system.')}</p></div><a className="btn-primary btn-sm" href={AIRDROID_BUSINESS_URL} target="_blank" rel="noreferrer">{t('فتح AirDroid Business', 'Open AirDroid Business')} <ExternalLink size={15}/></a></section>
    <section className="card airdroid-security"><ShieldCheck size={20}/><div><strong>{t('تسجيل الدخول يبقى لدى AirDroid', 'Authentication stays with AirDroid')}</strong><p>{t('لا نخزن بيانات دخول AirDroid. قد يمنع AirDroid العرض المدمج، وفي هذه الحالة استخدم زر الفتح في تبويب.', 'We never store AirDroid credentials. AirDroid may block embedded access; use the open-in-tab action when it does.')}</p></div></section>
    <section className="card airdroid-console-card">
      <div className="recent-head"><div><h3><MonitorSmartphone size={18}/> {t('لوحة AirDroid Business المدمجة', 'Embedded AirDroid Business console')}</h3><span className="cell-sub">biz.airdroid.com</span></div><div className="airdroid-console-actions"><button className="btn-ghost btn-sm" onClick={()=>setFrameKey((value)=>value+1)}><RefreshCw size={14}/> {t('إعادة تحميل','Reload')}</button><a className="btn-primary btn-sm" href={AIRDROID_BUSINESS_URL} target="_blank" rel="noreferrer">{t('فتح بأمان','Open securely')} <ExternalLink size={14}/></a></div></div>
      <div className="airdroid-frame-wrap">
        <iframe key={frameKey} className="airdroid-frame" src={AIRDROID_BUSINESS_URL} title={t('لوحة AirDroid Business','AirDroid Business console')} allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="strict-origin-when-cross-origin"/>
        <div className="airdroid-frame-help"><strong>{t('هل الإطار فارغ؟','Blank frame?')}</strong><span>{t('AirDroid يقيّد العرض داخل مواقع أخرى. افتحه في تبويب آمن للتحكم الكامل.','AirDroid restricts display inside other sites. Open it in a secure tab for full control.')}</span></div>
      </div>
    </section>
    <section className="card airdroid-security maven-frame-blocked">
      <LockKeyhole size={20}/>
      <div>
        <strong>{t('بوابة Maven Supplier · جلسة Eslam', 'Maven Supplier portal · Eslam session')}</strong>
        <p>{t('Maven يمنع العرض داخل iframe أمنياً (X-Frame-Options: DENY). افتح البوابة في تبويب جديد لاستخدام جلسة Eslam الموجودة في المتصفح.', 'Maven blocks iframe embedding (X-Frame-Options: DENY). Open the portal in a new tab to use the browser’s existing Eslam session.')}</p>
      </div>
      <a className="btn-primary btn-sm" href={MAVEN_SUPPLIER_URL} target="_blank" rel="noreferrer">{t('فتح Maven Supplier', 'Open Maven Supplier')} <ExternalLink size={14}/></a>
    </section>
    {error && <div className="card warn">{error}</div>}
    <section className="card recent-card"><div className="recent-head"><div><h3>{t('الأجهزة المرتبطة بالتشغيل', 'Operational devices')}</h3><span className="cell-sub">{devices.filter((d)=>d.online).length} / {devices.length} {t('متصلة', 'online')}</span></div><button className="btn-ghost btn-sm" disabled={loading} onClick={()=>void load()}><RefreshCw size={14} className={loading?'spin':''}/> {t('تحديث', 'Refresh')}</button></div><div className="airdroid-device-grid">{devices.map((device)=><article key={`${device.device}-${device.sim_slot}`} className="airdroid-device"><span className={`airdroid-device-icon ${device.online?'online':''}`}><Smartphone size={22}/></span><div><strong>{device.device}</strong><span>SIM {device.sim_slot ?? '—'}</span><small>{t('آخر اتصال', 'Last seen')}: {depositTime({first_seen_at:device.last_seen_at})}</small></div><div className="airdroid-device-meta"><span className={`pay-status-badge ${device.online?'st-paid':'st-dim'}`}>{device.online?t('متصل','Online'):t('غير متصل','Offline')}</span><span className="mono">{device.battery == null?'—':`${device.battery}%`}</span></div></article>)}{!loading&&devices.length===0&&<p className="sidebar-hint">{t('لا توجد أجهزة مسجلة.', 'No registered devices.')}</p>}</div></section>
  </PanelShell>
}
