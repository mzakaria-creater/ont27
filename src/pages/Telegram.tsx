import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { depositTime } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'
import { Send, Settings2 } from 'lucide-react'

interface Chat { id: number; chat_id: string; label: string | null; is_active: boolean; created_at: string | null }
interface Gate { alert_type: string; label: string | null; enabled: boolean; updated_at: string | null }
interface Alert { id: number; alert_type: string; chat_id: string | null; message: string | null; ok: boolean; error: string | null; created_at: string | null }
interface Bot { username: string | null; name: string | null; webhook: string | null }
interface Data { token_configured: boolean; bot: Bot | null; chats: Chat[]; gates: Gate[]; alerts: Alert[] }

function plainText(html: string | null): string {
  return (html ?? '').replace(/<[^>]+>/g, '').trim()
}

export default function Telegram() {
  const { t } = useLocale(); const { can } = useAuth(); const isMobile = useIsMobile()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [chat, setChat] = useState({ chat_id: '', label: '' })
  const [activeChatId, setActiveChatId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const canEdit = can('telegram_bot', 'can_edit') || can('automation', 'can_edit')
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async (silent = false) => {
    try {
      const res = await api<Data>('/api/telegram')
      setData(res)
      setErr(null)
      setActiveChatId((current) => current ?? res.chats.find((c) => c.is_active)?.id ?? res.chats[0]?.id ?? null)
    } catch (e) {
      if (!silent) setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية Telegram.', 'No Telegram permission.') : t('تعذر التحميل.', 'Unable to load.'))
    }
  }, [t])
  useEffect(() => { void load() }, [load])
  // Live-ish: the chat view is only useful if new sends/alerts show up
  // without a manual refresh.
  useEffect(() => { const iv = setInterval(() => void load(true), 15_000); return () => clearInterval(iv) }, [load])

  const activeChat = useMemo(() => data?.chats.find((c) => c.id === activeChatId) ?? null, [data, activeChatId])
  const thread = useMemo(() => {
    if (!data || !activeChat) return []
    return data.alerts.filter((a) => a.chat_id === activeChat.chat_id).slice().reverse()
  }, [data, activeChat])

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [thread.length, activeChatId])

  const saveToken = async (e: React.FormEvent) => { e.preventDefault(); try { await api('/api/telegram/token', { method: 'PUT', body: JSON.stringify({ token }) }); setToken(''); setMsg(t('تم حفظ التوكن.', 'Token saved.')); await load() } catch { setErr(t('صيغة التوكن غير صحيحة.', 'Invalid token format.')) } }
  const addChat = async (e: React.FormEvent) => { e.preventDefault(); try { await api('/api/telegram/chats', { method: 'POST', body: JSON.stringify(chat) }); setChat({ chat_id: '', label: '' }); await load() } catch { setErr(t('تعذر إضافة المحادثة.', 'Unable to add chat.')) } }
  const toggleChat = async (row: Chat) => { try { await api(`/api/telegram/chats/${row.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !row.is_active }) }); await load() } catch { setErr(t('تعذر الحفظ.', 'Unable to save.')) } }
  const toggleGate = async (g: Gate) => { try { await api(`/api/telegram/gates/${g.alert_type}`, { method: 'PATCH', body: JSON.stringify({ enabled: !g.enabled }) }); await load() } catch { setErr(t('تعذر الحفظ.', 'Unable to save.')) } }
  const sendTest = async () => { setMsg(null); try { const r = await api<{ sent?: number; skipped?: string }>('/api/telegram/test', { method: 'POST' }); setMsg(r.skipped ? t(`تم التخطي: ${r.skipped}`, `Skipped: ${r.skipped}`) : t(`أُرسلت لـ ${r.sent ?? 0} محادثة.`, `Sent to ${r.sent ?? 0} chat(s).`)); await load() } catch { setErr(t('فشل إرسال الاختبار.', 'Test send failed.')) } }

  const sendMessage = async () => {
    if (!activeChat || !draft.trim() || sending) return
    setSending(true)
    try {
      await api(`/api/telegram/chats/${activeChat.id}/send`, { method: 'POST', body: JSON.stringify({ text: draft.trim() }) })
      setDraft('')
      await load(true)
    } catch {
      setErr(t('تعذر إرسال الرسالة.', 'Could not send the message.'))
    } finally {
      setSending(false)
    }
  }

  return <>
    <section className="page-head">
      <div><h2>✈️ {t('Telegram', 'Telegram')}</h2><p className="page-sub">{t('محادثة مباشرة داخل اللوحة، وتنبيهات تشغيلية تلقائية.', 'A live conversation right inside the panel, plus automatic operational alerts.')}</p></div>
      <div className="page-actions"><button className="btn-ghost btn-sm" onClick={() => setShowSettings((v) => !v)}><Settings2 size={15}/> {t('الإعدادات', 'Settings')}</button></div>
    </section>
    {err && <div className="card warn">{err}</div>}
    {msg && <div className="card">{msg}</div>}
    {!data && !err && <p className="sidebar-hint">{t('جار التحميل…', 'Loading…')}</p>}

    {data && <>
      {data.bot?.username && (
        <section className="card tg-bot-card">
          <span className="tg-bot-avatar">🤖</span>
          <div className="tg-bot-info">
            <strong className="mono">@{data.bot.username}</strong>{data.bot.name && <span className="cell-sub"> · {data.bot.name}</span>}
            <div className="cell-sub">
              {data.bot.webhook
                ? t('⚠️ محدَّث خارجياً عبر webhook — الرسائل الواردة لا تظهر هنا.', '⚠️ Updates are routed to an external webhook — incoming messages do not appear here.')
                : t('لا يوجد webhook خارجي مرتبط حالياً.', 'No external webhook currently bound.')}
            </div>
          </div>
          <a className="btn-ghost btn-sm" href={`https://t.me/${data.bot.username}`} target="_blank" rel="noreferrer">{t('فتح في تيليجرام ↗', 'Open in Telegram ↗')}</a>
        </section>
      )}

      <section className="card tg-chat-shell">
        <div className="tg-chat-sidebar">
          <div className="tg-chat-sidebar-head">{t('المحادثات', 'Chats')}</div>
          {data.chats.length === 0 && <p className="sidebar-hint">{t('أضف محادثة من الإعدادات أولاً.', 'Add a chat from Settings first.')}</p>}
          {data.chats.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`tg-chat-list-item${activeChatId === c.id ? ' active' : ''}${!c.is_active ? ' is-off' : ''}`}
              onClick={() => setActiveChatId(c.id)}
            >
              <span className="tg-chat-list-label">{c.label || c.chat_id}</span>
              <span className={`tg-chat-list-dot ${c.is_active ? 'ok' : 'off'}`} />
            </button>
          ))}
        </div>

        <div className="tg-chat-main">
          {!activeChat && <div className="tg-chat-empty">{t('اختر محادثة للبدء.', 'Select a chat to get started.')}</div>}
          {activeChat && <>
            <div className="tg-chat-head">
              <strong>{activeChat.label || activeChat.chat_id}</strong>
              <span className={`pay-status-badge ${activeChat.is_active ? 'st-paid' : 'st-dim'}`}>{activeChat.is_active ? t('نشطة', 'Active') : t('موقوفة', 'Off')}</span>
            </div>
            <div className="tg-chat-thread">
              {thread.length === 0 && <div className="tg-chat-empty">{t('لا توجد رسائل بعد في هذه المحادثة.', 'No messages in this chat yet.')}</div>}
              {thread.map((a) => (
                <div key={a.id} className={`tg-bubble${a.ok ? '' : ' is-failed'}`}>
                  {a.alert_type !== 'manual_message' && <div className="tg-bubble-type mono">{a.alert_type.replaceAll('_', ' ')}</div>}
                  <div className="tg-bubble-text">{plainText(a.message) || '—'}</div>
                  <div className="tg-bubble-meta mono">
                    {a.created_at ? depositTime({ first_seen_at: a.created_at }) : '—'}
                    {!a.ok && <span className="tg-bubble-error" title={a.error ?? ''}> · {t('فشل الإرسال', 'send failed')}</span>}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            {canEdit && (
              <form className="tg-chat-composer" onSubmit={(e) => { e.preventDefault(); void sendMessage() }}>
                <input
                  className="login-input"
                  placeholder={t('اكتب رسالة…', 'Type a message…')}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={sending}
                />
                <button className="btn-primary btn-sm" disabled={sending || !draft.trim()}><Send size={14}/> {sending ? t('جارٍ الإرسال…', 'Sending…') : t('إرسال', 'Send')}</button>
              </form>
            )}
          </>}
        </div>
      </section>

      {showSettings && <>
        <section className="card recent-card"><div className="recent-head"><h3>{t('التوكن', 'Bot token')}</h3>
          <span className={`pay-status-badge ${data.token_configured ? 'st-paid' : 'st-pending'}`}>{data.token_configured ? t('مُهيَّأ', 'Configured') : t('لم يُهيَّأ', 'Not configured')}</span></div>
          {canEdit && <form className="control-row" onSubmit={saveToken}><input className="login-input" type="password" placeholder="123456:ABC-..." aria-label={t('توكن بوت Telegram', 'Telegram bot token')} value={token} onChange={(e) => setToken(e.target.value)} /><button className="btn-primary btn-sm">{t('حفظ', 'Save')}</button>{data.token_configured && data.chats.some((ch) => ch.is_active) && <button type="button" className="btn-ghost btn-sm" onClick={() => void sendTest()}>{t('إرسال اختبار', 'Send test')}</button>}</form>}
        </section>

        <section className="card recent-card"><div className="recent-head"><h3>{t('إدارة المحادثات', 'Manage chats')}</h3></div>
          {canEdit && <form className="control-row" onSubmit={addChat}><input required className="login-input" placeholder="chat_id (-100...)" aria-label="chat_id" value={chat.chat_id} onChange={(e) => setChat({ ...chat, chat_id: e.target.value })} /><input className="login-input" placeholder={t('تسمية', 'Label')} aria-label={t('تسمية المحادثة', 'Chat label')} value={chat.label} onChange={(e) => setChat({ ...chat, label: e.target.value })} /><button className="btn-primary btn-sm">{t('إضافة', 'Add')}</button></form>}
          {isMobile ? (
            <div className="risk-card-list">
              {data.chats.length ? data.chats.map((row) => (
                <div key={row.id} className="risk-row-card">
                  <div className="risk-row-card-head"><span className="mono">{row.chat_id}</span><span className={`pay-status-badge ${row.is_active ? 'st-paid' : 'st-dim'}`}>{row.is_active ? t('نشط', 'Active') : t('موقوف', 'Off')}</span></div>
                  <div className="cell-sub">{row.label ?? '—'}</div>
                  {canEdit && <div className="risk-row-card-foot"><button className="btn-ghost btn-sm" onClick={() => void toggleChat(row)}>{row.is_active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button></div>}
                </div>
              )) : <p className="maven-empty">{t('لا توجد محادثات.', 'No chats.')}</p>}
            </div>
          ) : (
          <div className="table-wrap"><table className="data-table"><thead><tr><th>chat_id</th><th>{t('التسمية', 'Label')}</th><th>{t('الحالة', 'Status')}</th><th /></tr></thead>
            <tbody>{data.chats.length ? data.chats.map((row) => <tr key={row.id}><td className="mono">{row.chat_id}</td><td>{row.label ?? '—'}</td><td><span className={`pay-status-badge ${row.is_active ? 'st-paid' : 'st-dim'}`}>{row.is_active ? t('نشط', 'Active') : t('موقوف', 'Off')}</span></td><td>{canEdit && <button className="btn-ghost btn-sm" onClick={() => void toggleChat(row)}>{row.is_active ? t('إيقاف', 'Disable') : t('تفعيل', 'Enable')}</button>}</td></tr>) : <tr><td colSpan={4} className="sidebar-hint">{t('لا توجد محادثات.', 'No chats.')}</td></tr>}</tbody>
          </table></div>
          )}
        </section>

        <section className="card recent-card"><div className="recent-head"><h3>{t('أنواع التنبيهات', 'Alert types')}</h3></div>
          {isMobile ? (
            <div className="risk-card-list">
              {data.gates.map((g) => (
                <div key={g.alert_type} className="risk-row-card">
                  <div className="risk-row-card-head"><span className="mono">{g.alert_type}</span><button className={`pill${g.enabled ? ' active' : ''}`} disabled={!canEdit} onClick={() => void toggleGate(g)} aria-label={`${g.enabled ? t('تعطيل', 'Disable') : t('تفعيل', 'Enable')} ${g.label ?? g.alert_type}`} aria-pressed={g.enabled}>{g.enabled ? '✓' : '—'}</button></div>
                  <div className="cell-sub">{g.label ?? '—'}</div>
                </div>
              ))}
            </div>
          ) : (
          <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('النوع', 'Type')}</th><th>{t('الوصف', 'Label')}</th><th>{t('مفعّل', 'Enabled')}</th></tr></thead>
            <tbody>{data.gates.map((g) => <tr key={g.alert_type}><td className="mono">{g.alert_type}</td><td>{g.label ?? '—'}</td><td><button className={`pill${g.enabled ? ' active' : ''}`} disabled={!canEdit} onClick={() => void toggleGate(g)} aria-label={`${g.enabled ? t('تعطيل', 'Disable') : t('تفعيل', 'Enable')} ${g.label ?? g.alert_type}`} aria-pressed={g.enabled}>{g.enabled ? '✓' : '—'}</button></td></tr>)}</tbody>
          </table></div>
          )}
        </section>
      </>}
    </>}
  </>
}
