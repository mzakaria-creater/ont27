import { useCallback, useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'

interface Chat { id: number; chat_id: string; label: string | null; is_active: boolean; created_at: string | null }
interface Gate { alert_type: string; label: string | null; enabled: boolean; updated_at: string | null }
interface Alert { id: number; alert_type: string; chat_id: string | null; ok: boolean; error: string | null; created_at: string | null }
interface Data { token_configured: boolean; chats: Chat[]; gates: Gate[]; alerts: Alert[] }

export default function Telegram() {
  const { t } = useLocale(); const { can } = useAuth()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null)
  const [token, setToken] = useState(''); const [chat, setChat] = useState({ chat_id: '', label: '' })
  const canEdit = can('telegram_bot', 'can_edit') || can('automation', 'can_edit')

  const load = useCallback(async () => {
    try { setData(await api('/api/telegram')); setErr(null) }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية Telegram.', 'No Telegram permission.') : t('تعذر التحميل.', 'Unable to load.')) }
  }, [t])
  useEffect(() => { void load() }, [load])

  const saveToken = async (e: React.FormEvent) => { e.preventDefault(); try { await api('/api/telegram/token', { method: 'PUT', body: JSON.stringify({ token }) }); setToken(''); setMsg(t('تم حفظ التوكن.', 'Token saved.')); await load() } catch { setErr(t('صيغة التوكن غير صحيحة.', 'Invalid token format.')) } }
  const addChat = async (e: React.FormEvent) => { e.preventDefault(); try { await api('/api/telegram/chats', { method: 'POST', body: JSON.stringify(chat) }); setChat({ chat_id: '', label: '' }); await load() } catch { setErr(t('تعذر إضافة المحادثة.', 'Unable to add chat.')) } }
  const toggleChat = async (row: Chat) => { try { await api(`/api/telegram/chats/${row.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !row.is_active }) }); await load() } catch { setErr(t('تعذر الحفظ.', 'Unable to save.')) } }
  const toggleGate = async (g: Gate) => { try { await api(`/api/telegram/gates/${g.alert_type}`, { method: 'PATCH', body: JSON.stringify({ enabled: !g.enabled }) }); await load() } catch { setErr(t('تعذر الحفظ.', 'Unable to save.')) } }
  const sendTest = async () => { setMsg(null); try { const r = await api<{ sent?: number; skipped?: string }>('/api/telegram/test', { method: 'POST' }); setMsg(r.skipped ? t(`تم التخطي: ${r.skipped}`, `Skipped: ${r.skipped}`) : t(`أُرسلت لـ ${r.sent ?? 0} محادثة.`, `Sent to ${r.sent ?? 0} chat(s).`)); await load() } catch { setErr(t('فشل إرسال الاختبار.', 'Test send failed.')) } }

  return <PanelShell>
    <section className="page-head"><h2>📨 {t('تنبيهات Telegram', 'Telegram alerts')}</h2><p className="page-sub">{t('توكن البوت يُخزَّن مشفّراً في الإعدادات ولا يُعرض. أرسل تنبيهات تشغيلية لحظية لقنوات محددة.', 'Bot token is stored server-side and never shown. Send live operational alerts to specific chats.')}</p></section>
    {err && <div className="card warn">{err}</div>}
    {msg && <div className="card">{msg}</div>}
    {!data && !err && <p className="sidebar-hint">{t('جار التحميل…', 'Loading…')}</p>}
    {data && <>
      <section className="card recent-card"><div className="recent-head"><h3>{t('التوكن', 'Bot token')}</h3>
        <span className={`pay-status-badge ${data.token_configured ? 'st-paid' : 'st-pending'}`}>{data.token_configured ? t('مُهيَّأ', 'Configured') : t('لم يُهيَّأ', 'Not configured')}</span></div>
        {canEdit && <form className="control-row" onSubmit={saveToken}><input className="login-input" type="password" placeholder="123456:ABC-..." aria-label={t('توكن بوت Telegram', 'Telegram bot token')} value={token} onChange={(e) => setToken(e.target.value)} /><button className="btn-primary btn-sm">{t('حفظ', 'Save')}</button>{data.token_configured && data.chats.some((ch) => ch.is_active) && <button type="button" className="btn-ghost btn-sm" onClick={() => void sendTest()}>{t('إرسال اختبار', 'Send test')}</button>}</form>}
      </section>

      <section className="card recent-card"><div className="recent-head"><h3>{t('المحادثات', 'Chats')}</h3></div>
        {canEdit && <form className="control-row" onSubmit={addChat}><input required className="login-input" placeholder="chat_id (-100...)" aria-label="chat_id" value={chat.chat_id} onChange={(e) => setChat({ ...chat, chat_id: e.target.value })} /><input className="login-input" placeholder={t('تسمية', 'Label')} aria-label={t('تسمية المحادثة', 'Chat label')} value={chat.label} onChange={(e) => setChat({ ...chat, label: e.target.value })} /><button className="btn-primary btn-sm">{t('إضافة', 'Add')}</button></form>}
        <div className="table-wrap"><table className="data-table"><thead><tr><th>chat_id</th><th>{t('التسمية', 'Label')}</th><th>{t('الحالة', 'Status')}</th><th /></tr></thead>
          <tbody>{data.chats.length ? data.chats.map((row) => <tr key={row.id}><td className="mono">{row.chat_id}</td><td>{row.label ?? '—'}</td><td><span className={`pay-status-badge ${row.is_active ? 'st-paid' : 'st-dim'}`}>{row.is_active ? t('نشط', 'Active') : t('موقوف', 'Off')}</span></td><td>{canEdit && <button className="btn-ghost btn-sm" onClick={() => void toggleChat(row)}>{row.is_active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>}</td></tr>) : <tr><td colSpan={4} className="sidebar-hint">{t('لا توجد محادثات.', 'No chats.')}</td></tr>}</tbody>
        </table></div>
      </section>

      <section className="card recent-card"><div className="recent-head"><h3>{t('أنواع التنبيهات', 'Alert types')}</h3></div>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('النوع', 'Type')}</th><th>{t('الوصف', 'Label')}</th><th>{t('مفعّل', 'Enabled')}</th></tr></thead>
          <tbody>{data.gates.map((g) => <tr key={g.alert_type}><td className="mono">{g.alert_type}</td><td>{g.label ?? '—'}</td><td><button className={`pill${g.enabled ? ' active' : ''}`} disabled={!canEdit} onClick={() => void toggleGate(g)} aria-label={`${g.enabled ? t('تعطيل', 'Disable') : t('تفعيل', 'Enable')} ${g.label ?? g.alert_type}`} aria-pressed={g.enabled}>{g.enabled ? '✓' : '—'}</button></td></tr>)}</tbody>
        </table></div>
      </section>

      <section className="card recent-card"><div className="recent-head"><h3>{t('آخر التنبيهات', 'Recent alerts')}</h3></div>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('النوع', 'Type')}</th><th>chat</th><th>{t('النتيجة', 'Result')}</th><th>{t('الوقت', 'Time')}</th></tr></thead>
          <tbody>{data.alerts.length ? data.alerts.map((a) => <tr key={a.id}><td className="mono">{a.alert_type}</td><td className="mono">{a.chat_id ?? '—'}</td><td>{a.ok ? <span className="pay-status-badge st-paid">OK</span> : <span className="pay-status-badge st-declined" title={a.error ?? ''}>{t('فشل', 'Failed')}</span>}</td><td className="mono">{a.created_at ? depositTime({ first_seen_at: a.created_at }) : '—'}</td></tr>) : <tr><td colSpan={4} className="sidebar-hint">{t('لا توجد تنبيهات بعد.', 'No alerts yet.')}</td></tr>}</tbody>
        </table></div>
      </section>
    </>}
  </PanelShell>
}
