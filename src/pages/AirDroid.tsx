import { useEffect, useState } from 'react'
import { ExternalLink, LockKeyhole, MonitorSmartphone, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { depositTime } from '../lib/deposits'
import { useLocale } from '../lib/locale'

interface Device { device: string; sim_slot: number | null; online: boolean | null; battery: number | null; last_seen_at: string | null }
const AIRDROID_SIGNIN_URL = 'https://my.airdroid.com/user-center/signin/?type=biz&isVerifyIos=0&code=-2&redirect=https%3A%2F%2Fbiz.airdroid.com'
const AIRDROID_CONSOLE_URL = 'https://biz.airdroid.com/#/devices/list/-100'
const AIRDROID_ACCOUNT = 'info@ontarget-egy.com'
const MAVEN_SUPPLIER_URL = 'https://bo.maven-consulting.co/Supplier'

export default function AirDroid() {
  const { t } = useLocale()
  const [devices, setDevices] = useState<Device[]>([])
  const [loading, setLoading] = useState(false)
  const [frameKey, setFrameKey] = useState(0)
  const [portal, setPortal] = useState<'airdroid'|'maven'>('airdroid')
  const [error, setError] = useState<string | null>(null)
  const load = async () => { setLoading(true); try { const result = await api<{ devices: Device[] }>('/api/sms/devices'); setDevices(result.devices); setError(null) } catch { setError(t('تعذر قراءة حالة الأجهزة.', 'Could not load device status.')) } finally { setLoading(false) } }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer) }, [])

  return <PanelShell>
    <section className="page-head"><div><h2><Smartphone size={24}/> AirDroid Business</h2><p className="page-sub">{t('مساحة تحكم الأجهزة داخل التطبيق مع حالة الاتصال الحية من نظام SMS.', 'In-app device workspace with live connection state from the SMS system.')}</p></div><div className="airdroid-console-actions"><a className="btn-ghost btn-sm" href={AIRDROID_SIGNIN_URL} target="_blank" rel="noreferrer">{t('تسجيل الدخول', 'Sign in')} <ExternalLink size={15}/></a><a className="btn-primary btn-sm" href={AIRDROID_CONSOLE_URL} target="_blank" rel="noreferrer">{t('فتح التحكم الكامل', 'Open full control')} <ExternalLink size={15}/></a></div></section>
    <div className="filter-bar airdroid-portal-tabs"><div className="filter-pills"><button className={`pill${portal==='airdroid'?' active':''}`} onClick={()=>setPortal('airdroid')}><Smartphone size={15}/> AirDroid</button><button className={`pill${portal==='maven'?' active':''}`} onClick={()=>setPortal('maven')}><LockKeyhole size={15}/> Maven Supplier</button></div></div>
    <section className="card airdroid-console-card">
      <div className="recent-head"><div><h3><MonitorSmartphone size={18}/> {portal==='airdroid'?t('لوحة أجهزة AirDroid المدمجة', 'Embedded AirDroid device console'):t('بوابة Maven Supplier المدمجة','Embedded Maven Supplier portal')}</h3><span className="cell-sub">{portal==='airdroid'?'biz.airdroid.com · devices/list/-100':'bo.maven-consulting.co/Supplier'}</span></div><div className="airdroid-console-actions"><button className="btn-ghost btn-sm" onClick={()=>setFrameKey((value)=>value+1)}><RefreshCw size={14}/> {t('إعادة تحميل','Reload')}</button><a className="btn-primary btn-sm" href={portal==='airdroid'?AIRDROID_CONSOLE_URL:MAVEN_SUPPLIER_URL} target="_blank" rel="noreferrer">{t('فتح في نافذة','Open in window')} <ExternalLink size={14}/></a></div></div>
      <div className="airdroid-frame-wrap">
        <iframe key={`${portal}-${frameKey}`} className="airdroid-frame" src={portal==='airdroid'?AIRDROID_CONSOLE_URL:MAVEN_SUPPLIER_URL} title={portal==='airdroid'?t('لوحة AirDroid Business','AirDroid Business console'):t('بوابة Maven Supplier','Maven Supplier portal')} allow="clipboard-read; clipboard-write; fullscreen" referrerPolicy="strict-origin-when-cross-origin"/>
        <div className="airdroid-frame-help"><strong>{t('هل الإطار فارغ؟','Blank frame?')}</strong><span>{portal==='airdroid'?t('AirDroid قد يقيّد العرض داخل مواقع أخرى. استخدم زر فتح في نافذة للتحكم الكامل.','AirDroid may restrict display inside other sites. Use Open in window for full control.'):t('Maven يرسل X-Frame-Options: DENY وقد يمنع العرض المدمج. استخدم فتح في نافذة مع جلسة Eslam الموجودة في المتصفح.','Maven sends X-Frame-Options: DENY and may block embedding. Use Open in window with the existing Eslam browser session.')}</span></div>
      </div>
    </section>
    <section className="card airdroid-security"><ShieldCheck size={20}/><div><strong>{t('تسجيل الدخول يبقى لدى AirDroid', 'Authentication stays with AirDroid')}</strong><p>{t('حساب الدخول', 'Sign-in account')}: <span className="mono">{AIRDROID_ACCOUNT}</span> · {t('كلمة المرور لا تُخزن في التطبيق. استخدم مدير كلمات مرور المتصفح.', 'The password is not stored in this app. Use the browser password manager.')}</p></div><a className="btn-ghost btn-sm" href={AIRDROID_SIGNIN_URL} target="_blank" rel="noreferrer">{t('تسجيل الدخول الآمن','Secure sign-in')} <ExternalLink size={14}/></a></section>
    {error && <div className="card warn">{error}</div>}
    <section className="card recent-card"><div className="recent-head"><div><h3>{t('الأجهزة المرتبطة بالتشغيل', 'Operational devices')}</h3><span className="cell-sub">{devices.filter((d)=>d.online).length} / {devices.length} {t('متصلة', 'online')}</span></div><button className="btn-ghost btn-sm" disabled={loading} onClick={()=>void load()}><RefreshCw size={14} className={loading?'spin':''}/> {t('تحديث', 'Refresh')}</button></div><div className="airdroid-device-grid">{devices.map((device)=><article key={`${device.device}-${device.sim_slot}`} className="airdroid-device"><span className={`airdroid-device-icon ${device.online?'online':''}`}><Smartphone size={22}/></span><div><strong>{device.device}</strong><span>SIM {device.sim_slot ?? '—'}</span><small>{t('آخر اتصال', 'Last seen')}: {depositTime({first_seen_at:device.last_seen_at})}</small></div><div className="airdroid-device-meta"><span className={`pay-status-badge ${device.online?'st-paid':'st-dim'}`}>{device.online?t('متصل','Online'):t('غير متصل','Offline')}</span><span className="mono">{device.battery == null?'—':`${device.battery}%`}</span></div></article>)}{!loading&&devices.length===0&&<p className="sidebar-hint">{t('لا توجد أجهزة مسجلة.', 'No registered devices.')}</p>}</div></section>
  </PanelShell>
}
