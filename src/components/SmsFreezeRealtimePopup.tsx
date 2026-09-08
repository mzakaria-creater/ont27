import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { api } from '../lib/api'
import { useLocale } from '../lib/locale'

interface SmsAlert { id: number; received_at: string | null; device_name: string | null; provider: string | null; wallet_number: string | null; receiver_number: string | null; message: string | null; raw_sms: string | null; severity: string }
const KEY = 'ontarget:sms-freeze-popup-seen'
const body = (row: SmsAlert) => row.message || row.raw_sms || 'Wallet freeze warning'

export default function SmsFreezeRealtimePopup() {
  const { status } = useAuth(); const { t } = useLocale(); const navigate = useNavigate(); const seen = useRef(new Set<number>()); const initialized = useRef(false); const [row, setRow] = useState<SmsAlert | null>(null)
  useEffect(() => { try { seen.current = new Set(JSON.parse(sessionStorage.getItem(KEY) ?? '[]').map(Number)) } catch { seen.current = new Set() } }, [])
  useEffect(() => {
    if (status !== 'authed') return
    const check = () => void api<{ alerts: SmsAlert[] }>('/api/sms-notifications?severity=freeze&hours=1').then(({ alerts }) => {
      const newest = alerts.filter((item) => !seen.current.has(item.id)).sort((a, b) => Date.parse(String(b.received_at)) - Date.parse(String(a.received_at)))[0]
      if (!initialized.current) { alerts.forEach((item) => seen.current.add(item.id)); initialized.current = true; sessionStorage.setItem(KEY, JSON.stringify([...seen.current])); return }
      if (newest) { seen.current.add(newest.id); sessionStorage.setItem(KEY, JSON.stringify([...seen.current].slice(-200))); setRow(newest) }
    }).catch(() => {})
    check(); const timer = window.setInterval(check, 15_000); return () => window.clearInterval(timer)
  }, [status])
  if (!row) return null
  return <div className="sms-freeze-backdrop" role="alertdialog" aria-modal="true" aria-label={t('تحذير تجميد محفظة', 'Wallet freeze warning')}><article className="sms-freeze-modal"><button className="sms-freeze-close" onClick={() => setRow(null)} aria-label={t('إغلاق', 'Close')}><X size={18}/></button><div className="sms-freeze-icon"><AlertTriangle size={34}/></div><h2>{t('تحذير: تجميد محفظة', 'Warning: wallet freeze')}</h2><p className="sms-freeze-meta"><span className="mono">SMS #{row.id}</span> · {row.device_name ?? '—'} · {row.provider ?? '—'}</p><p className="sms-freeze-wallet mono">{row.wallet_number ?? row.receiver_number ?? '—'}</p><p className="sms-freeze-message">{body(row)}</p><div className="sms-freeze-actions"><button className="btn-primary" onClick={() => { setRow(null); navigate('/sms-notifications?severity=freeze') }}>{t('فتح تنبيهات SMS', 'Open SMS alerts')}</button><button className="btn-ghost" onClick={() => setRow(null)}>{t('إغلاق', 'Close')}</button></div></article></div>
}
