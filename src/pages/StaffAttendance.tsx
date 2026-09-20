import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, Clock3, Download, RefreshCw, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

type SessionMetrics = { transaction_count: number; transaction_amount: number; approved_count: number; approved_amount: number; automation_count: number; automation_amount: number; withdrawal_count: number; withdrawal_amount: number; wallet: string | null; balance_start: number | null; balance_end: number | null; net_balance: number | null }
type Session = { id: string; user_id: string; wallet_number: string | null; checked_in_at: string; checked_out_at: string | null; note: string | null; metrics?: SessionMetrics }
type StaffAction = { action: string; entity: string | null; entity_id: string | null; at: string }
type Staff = { user_id: string; username: string; display_name: string | null; role: string; last_login_at: string | null; login_count: number; check_in_count: number; check_out_count: number; action_count: number; action_amount: number; recent_actions: StaffAction[]; active_session: { wallet_number: string | null; checked_in_at: string } | null; sessions: number; hours: number; transaction_count: number; approved_count: number; transaction_amount: number; approved_amount: number; sms_count: number; wallets: string[]; session_reports?: Session[] }
type Attendance = { from: string; to: string; wallet: string | null; users: Staff[]; sessions: Session[] }
const cairoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const cairoTime = (value: string) => new Intl.DateTimeFormat(undefined, { timeZone: 'Africa/Cairo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))

export default function StaffAttendance() {
  const { t } = useLocale()
  const isMobile = useIsMobile()
  const [searchParams] = useSearchParams()
  const [from, setFrom] = useState(cairoToday); const [to, setTo] = useState(cairoToday); const [wallet, setWallet] = useState(''); const [agent, setAgent] = useState(() => searchParams.get('user') ?? ''); const [selected, setSelected] = useState<string | null>(() => searchParams.get('user')); const [data, setData] = useState<Attendance | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => { setBusy(true); try { const q = new URLSearchParams({ from, to }); if (wallet) q.set('wallet', wallet); if (agent) q.set('user_id', agent); setData(await api<Attendance>(`/api/reports/attendance?${q}`)); setError(null) } catch (e) { setError(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية التقرير.', 'You do not have report permission.') : t('تعذر تحميل الحضور.', 'Unable to load attendance.')) } finally { setBusy(false) } }, [from, to, wallet, agent, t])
  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(interval)
  }, [load])
  const action = async (userId: string, kind: 'check-in' | 'check-out') => { setBusy(true); try { await api(`/api/reports/attendance/${kind}`, { method: 'POST', body: JSON.stringify({ user_id: userId, wallet_number: wallet || undefined }) }); await load() } catch (e) { setError(e instanceof ApiError ? e.code : 'attendance_failed') } finally { setBusy(false) } }
  const wallets = useMemo(() => [...new Set((data?.users ?? []).flatMap((row) => row.wallets))].sort(), [data])
  const totals = useMemo(() => (data?.users ?? []).reduce((a, r) => ({ tx: a.tx + r.transaction_count, approved: a.approved + r.approved_count, amount: a.amount + r.approved_amount, sms: a.sms + r.sms_count, hours: a.hours + r.hours, logins: a.logins + r.login_count, checkins: a.checkins + r.check_in_count, actions: a.actions + r.action_count }), { tx: 0, approved: 0, amount: 0, sms: 0, hours: 0, logins: 0, checkins: 0, actions: 0 }), [data])
  const profile = useMemo(() => { const row = data?.users.find((item) => item.user_id === selected); if (!row) return null; return (row.session_reports ?? []).reduce((a, session) => { const m = session.metrics; return { ...a, approved: a.approved + Number(m?.approved_amount ?? 0), approvedCount: a.approvedCount + Number(m?.approved_count ?? 0), automation: a.automation + Number(m?.automation_amount ?? 0), automationCount: a.automationCount + Number(m?.automation_count ?? 0), withdrawals: a.withdrawals + Number(m?.withdrawal_amount ?? 0), withdrawalCount: a.withdrawalCount + Number(m?.withdrawal_count ?? 0), hours: a.hours + (new Date(session.checked_out_at ?? new Date().toISOString()).getTime() - new Date(session.checked_in_at).getTime()) / 3600000, start: m?.balance_start ?? a.start, end: m?.balance_end ?? a.end } }, { name: row.display_name || row.username, role: row.role, approved: 0, approvedCount: 0, automation: 0, automationCount: 0, withdrawals: 0, withdrawalCount: 0, hours: 0, start: null as number | null, end: null as number | null }) }, [data, selected])
  const exportCsv = () => {
    if (!data) return
    const esc = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const rows = [
      ['employee', 'username', 'role', 'last_login_cairo', 'login_count', 'check_in_count', 'check_out_count', 'action_count', 'action_amount_egp', 'check_in_cairo', 'check_out_cairo', 'wallet', 'hours', 'transaction_count', 'transaction_amount_egp', 'approved_count', 'approved_amount_egp', 'automation_count', 'automation_amount_egp', 'withdrawal_count', 'withdrawal_amount_egp', 'balance_start', 'balance_end', 'net_balance'],
      ...data.users.flatMap((row) => (row.session_reports ?? []).map((session) => [row.display_name || row.username, row.username, row.role, row.last_login_at ? cairoTime(row.last_login_at) : '', row.login_count, row.check_in_count, row.check_out_count, row.action_count, row.action_amount.toFixed(2), cairoTime(session.checked_in_at), session.checked_out_at ? cairoTime(session.checked_out_at) : '', session.metrics?.wallet ?? '', session.metrics ? ((new Date(session.checked_out_at ?? new Date().toISOString()).getTime() - new Date(session.checked_in_at).getTime()) / 3600000).toFixed(2) : '', session.metrics?.transaction_count ?? '', session.metrics?.transaction_amount?.toFixed(2) ?? '', session.metrics?.approved_count ?? '', session.metrics?.approved_amount?.toFixed(2) ?? '', session.metrics?.automation_count ?? '', session.metrics?.automation_amount?.toFixed(2) ?? '', session.metrics?.withdrawal_count ?? '', session.metrics?.withdrawal_amount?.toFixed(2) ?? '', session.metrics?.balance_start ?? '', session.metrics?.balance_end ?? '', session.metrics?.net_balance ?? ''])),
    ]
    const blob = new Blob([rows.map((row) => row.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `ont27-hr-${data.from}-${data.to}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  const monthly = from.slice(0, 7) !== to.slice(0, 7) ? t('نطاق مخصص', 'Custom range') : from.slice(8) === '01' && to.slice(8) === '01' ? t('شهري', 'Monthly') : t('يومي', 'Daily')
  return <PanelShell><section className="page-head"><div><h2>{t('الموارد البشرية', 'HR workspace')}</h2><p className="page-sub">{t('حضور وانصراف كل agent/operator مع أداء المعاملات والتدفق النقدي حسب الموظف والمحفظة.', 'Check in/out every agent/operator with employee, wallet, transaction, and cash-flow performance.')}</p></div><button className="btn-ghost btn-sm" onClick={exportCsv} disabled={!data || busy}><Download size={15}/>{t('تصدير HR', 'Export HR')}</button></section>
    <section className="card reports-filter-card"><div className="reports-scope-grid"><label>{t('من', 'From')}<input className="login-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>{t('إلى', 'To')}<input className="login-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><label>{t('Agent / Operator', 'Agent / Operator')}<select className="login-input" value={agent} onChange={(e) => { setAgent(e.target.value); setSelected(e.target.value || null) }}><option value="">{t('كل الموظفين', 'All staff')}</option>{(data?.users ?? []).map((row) => <option key={row.user_id} value={row.user_id}>{row.display_name || row.username} · {row.role}</option>)}</select></label><label>{t('المحفظة', 'Wallet')}<select className="login-input" value={wallet} onChange={(e) => setWallet(e.target.value)}><option value="">{t('كل المحافظ', 'All wallets')}</option>{wallets.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><button className="btn-ghost btn-sm reports-refresh" onClick={() => void load()} disabled={busy}><RefreshCw size={15} className={busy ? 'spin' : ''}/>{t('تحديث', 'Refresh')}</button><span className="reports-range"><CalendarDays size={14}/>{monthly}</span></div></section>
    {error && <div className="card warn">{error}</div>}
    <div className="reports-kpis live-financial-kpis"><article><span className="reports-kpi-icon"><Clock3 size={18}/></span><small>{t('ساعات العمل', 'Work hours')}</small><strong>{totals.hours.toFixed(1)}</strong><em>{t('بتوقيت القاهرة', 'Cairo time')}</em></article><article><span className="reports-kpi-icon"><WalletCards size={18}/></span><small>{t('إجمالي المعاملات', 'Total transactions')}</small><strong>{totals.tx}</strong><em>{totals.approved} {t('معتمدة', 'approved')}</em></article><article><span className="reports-kpi-icon positive"><WalletCards size={18}/></span><small>{t('إجمالي المبلغ', 'Total amount')}</small><strong>{money((data?.users ?? []).reduce((sum, row) => sum + row.transaction_amount, 0), 'EGP')}</strong><em>{money(totals.amount, 'EGP')} {t('معتمد', 'approved')}</em></article><article><span className="reports-kpi-icon"><Clock3 size={18}/></span><small>{t('دخول / حضور / إجراءات', 'Logins / check-ins / actions')}</small><strong>{totals.logins} / {totals.checkins} / {totals.actions}</strong><em>{t('للفترة المحددة', 'Selected period')}</em></article></div>
    {profile && <section className="reports-kpis live-financial-kpis"><article><small>{profile.name} · {profile.role}</small><strong>{profile.hours.toFixed(2)}h</strong><em>{t('ساعات العمل', 'Work hours')}</em></article><article><small>{t('اعتمادات الموظف', 'Employee approvals')}</small><strong>{profile.approvedCount} · {money(profile.approved, 'EGP')}</strong><em>{t('المعاملات التي اعتمدها', 'Approved by employee')}</em></article><article><small>{t('الأتمتة', 'Automation')}</small><strong>{profile.automationCount} · {money(profile.automation, 'EGP')}</strong><em>{t('أثناء وقت العمل', 'During work time')}</em></article><article><small>{t('السحب / صافي الرصيد', 'Withdrawals / net balance')}</small><strong>{money(profile.withdrawals, 'EGP')}</strong><em>{money(profile.start, 'EGP')} → {money(profile.end, 'EGP')}</em></article></section>}
    <section className="card recent-card"><div className="recent-head"><div><h3>{t('وكلاء التشغيل', 'Operations staff')}</h3><span className="cell-sub">{t('تسجيل الدخول والحضور والإجراءات لكل موظف خلال الفترة المحددة.', 'Login, attendance, and actions for each employee in the selected period.')}</span></div></div>
      {isMobile ? (
        <div className="risk-card-list">
          {(data?.users ?? []).map((row) => (
            <div key={row.user_id} className="risk-row-card">
              <div className="risk-row-card-head">
                <button className="btn-link" onClick={() => setSelected(selected === row.user_id ? null : row.user_id)}><strong>{row.display_name || row.username}</strong></button>
                {row.active_session ? <span className="pay-status-badge st-paid">{t('داخل الآن', 'Active')}</span> : <span className="pay-status-badge st-dim">{t('خارج', 'Out')}</span>}
              </div>
              <div className="cell-sub mono">{row.username} · {row.role}</div>
              <div className="cell-sub">{t('آخر دخول', 'Last login')}: {row.last_login_at ? cairoTime(row.last_login_at) : '—'} ({row.login_count} {t('دخول', 'logins')})</div>
              <div className="cell-sub">{t('حضور', 'Check-in')} {row.check_in_count} · {t('Check-out', 'Check-out')} {row.check_out_count} · {t('إجراءات', 'Actions')} {row.action_count} ({money(row.action_amount, 'EGP')})</div>
              <div className="risk-row-card-foot"><span className="mono">{row.transaction_count} {t('معاملة', 'tx')} ({row.approved_count} {t('مدفوعة', 'paid')})</span><span className="mono">{money(row.transaction_amount, 'EGP')}</span></div>
              <button className={row.active_session ? 'btn-ghost btn-sm danger' : 'btn-primary btn-sm'} disabled={busy} onClick={() => void action(row.user_id, row.active_session ? 'check-out' : 'check-in')}>{row.active_session ? t('Check out', 'Check out') : t('Check in', 'Check in')}</button>
            </div>
          ))}
          {!data && !error && <div className="executive-empty">{t('جار التحميل…', 'Loading…')}</div>}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table hr-staff-table"><thead><tr><th>{t('الموظف', 'Staff')}</th><th>{t('آخر دخول للنظام', 'Last login')}</th><th>{t('دخول / حضور', 'Login / check-in')}</th><th>{t('Check-out', 'Check-out')}</th><th>{t('الإجراءات', 'Actions')}</th><th>{t('المعاملات', 'Transactions')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('إجراء الحضور', 'Attendance action')}</th></tr></thead><tbody>{(data?.users ?? []).map((row) => <tr key={row.user_id}><td><button className="btn-link" onClick={() => setSelected(selected === row.user_id ? null : row.user_id)}><strong>{row.display_name || row.username}</strong></button><div className="cell-sub mono">{row.username} · {row.role}</div></td><td className="mono">{row.last_login_at ? cairoTime(row.last_login_at) : '—'}<div className="cell-sub">{row.login_count} {t('دخول', 'logins')}</div></td><td className="mono">{row.check_in_count}<div className="cell-sub">{row.active_session ? <span className="pay-status-badge st-paid">{t('داخل الآن', 'Active')}</span> : t('خارج', 'Out')}</div></td><td className="mono">{row.check_out_count}</td><td className="mono">{row.action_count}<div className="cell-sub">{money(row.action_amount, 'EGP')}</div></td><td className="mono">{row.transaction_count}<div className="cell-sub">{row.approved_count} {t('مدفوعة', 'paid')}</div></td><td className="mono">{money(row.transaction_amount, 'EGP')}</td><td><button className={row.active_session ? 'btn-ghost btn-sm danger' : 'btn-primary btn-sm'} disabled={busy} onClick={() => void action(row.user_id, row.active_session ? 'check-out' : 'check-in')}>{row.active_session ? t('Check out', 'Check out') : t('Check in', 'Check in')}</button></td></tr>)}</tbody></table>{!data && !error && <div className="executive-empty">{t('جار التحميل…', 'Loading…')}</div>}</div>
      )}
    </section>
    {selected && data && <section className="card recent-card"><div className="recent-head"><div><h3>{t('تقرير الوردية', 'Work-session report')} · {data.users.find((row) => row.user_id === selected)?.display_name}</h3><span className="cell-sub">{t('كل الأوقات بتوقيت القاهرة', 'All times are Cairo time')}</span></div></div>
      {isMobile ? (
        <div className="risk-card-list">
          {(data.users.find((row) => row.user_id === selected)?.session_reports ?? data.sessions.filter((row) => row.user_id === selected)).map((row) => { const end = row.checked_out_at ? new Date(row.checked_out_at) : new Date(); const hours = Math.max(0, (end.getTime() - new Date(row.checked_in_at).getTime()) / 3600000); const m = row.metrics; return (
            <div key={row.id} className="risk-row-card">
              <div className="risk-row-card-head"><span className="mono">{cairoTime(row.checked_in_at)} → {row.checked_out_at ? cairoTime(row.checked_out_at) : <span className="pay-status-badge st-paid">{t('مفتوح', 'Open')}</span>}</span><span className="mono">{hours.toFixed(2)}h</span></div>
              <div className="cell-sub">{t('المحفظة', 'Wallet')}: {row.wallet_number || '—'}</div>
              <div className="cell-sub">{t('كل المعاملات', 'All tx')}: {m ? `${m.transaction_count} · ${money(m.transaction_amount, 'EGP')}` : '—'} · {t('اعتمد', 'Approved')}: {m ? `${m.approved_count} · ${money(m.approved_amount, 'EGP')}` : '—'}</div>
              <div className="cell-sub">{t('Automation', 'Automation')}: {m ? `${m.automation_count} · ${money(m.automation_amount, 'EGP')}` : '—'} · {t('السحب', 'Withdrawals')}: {m ? `${m.withdrawal_count} · ${money(m.withdrawal_amount, 'EGP')}` : '—'}</div>
              <div className="risk-row-card-foot"><span className="mono">{t('الصافي', 'Net')}: {m ? money(m.net_balance, 'EGP') : '—'}</span></div>
            </div>
          ) })}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('دخول', 'Check-in')}</th><th>{t('خروج', 'Check-out')}</th><th>{t('الساعات', 'Hours')}</th><th>{t('المحفظة', 'Wallet')}</th><th>{t('كل المعاملات', 'All transactions')}</th><th>{t('اعتمد', 'Approved')}</th><th>{t('Automation', 'Automation')}</th><th>{t('السحب', 'Withdrawals')}</th><th>{t('الصافي', 'Net')}</th></tr></thead><tbody>{(data.users.find((row) => row.user_id === selected)?.session_reports ?? data.sessions.filter((row) => row.user_id === selected)).map((row) => { const end = row.checked_out_at ? new Date(row.checked_out_at) : new Date(); const hours = Math.max(0, (end.getTime() - new Date(row.checked_in_at).getTime()) / 3600000); const m = row.metrics; return <tr key={row.id}><td className="mono">{cairoTime(row.checked_in_at)}</td><td className="mono">{row.checked_out_at ? cairoTime(row.checked_out_at) : <span className="pay-status-badge st-paid">{t('مفتوح', 'Open')}</span>}</td><td className="mono">{hours.toFixed(2)}</td><td className="mono">{row.wallet_number || '—'}</td><td className="mono">{m ? `${m.transaction_count} · ${money(m.transaction_amount, 'EGP')}` : '—'}</td><td className="mono">{m ? `${m.approved_count} · ${money(m.approved_amount, 'EGP')}` : '—'}</td><td className="mono">{m ? `${m.automation_count} · ${money(m.automation_amount, 'EGP')}` : '—'}</td><td className="mono">{m ? `${m.withdrawal_count} · ${money(m.withdrawal_amount, 'EGP')}` : '—'}</td><td className="mono">{m ? money(m.net_balance, 'EGP') : '—'}</td></tr>})}</tbody></table></div>
      )}
    </section>}
    {selected && data && <section className="card recent-card hr-actions-card"><div className="recent-head"><div><h3>{t('سجل إجراءات الموظف', 'Employee action log')}</h3><span className="cell-sub">{t('الإجراءات المسجلة خلال النطاق الزمني المحدد.', 'Audited actions in the selected date range.')}</span></div></div>
      {isMobile ? (
        <div className="risk-card-list">
          {(data.users.find((row) => row.user_id === selected)?.recent_actions ?? []).map((row, index) => (
            <div key={`${row.at}-${row.action}-${index}`} className="risk-row-card">
              <div className="risk-row-card-head"><span className="pay-status-badge st-dim">{row.action}</span><span className="mono muted">{cairoTime(row.at)}</span></div>
              <div className="cell-sub">{row.entity ?? '—'} <span className="mono">{row.entity_id ?? '—'}</span></div>
            </div>
          ))}
          {(data.users.find((row) => row.user_id === selected)?.recent_actions ?? []).length === 0 && <p className="maven-empty">{t('لا توجد إجراءات مدققة في الفترة.', 'No audited actions in this period.')}</p>}
        </div>
      ) : (
      <div className="table-wrap"><table className="data-table"><thead><tr><th>{t('الوقت', 'Time')}</th><th>{t('الإجراء', 'Action')}</th><th>{t('الكيان', 'Entity')}</th><th>{t('المرجع', 'Reference')}</th></tr></thead><tbody>{(data.users.find((row) => row.user_id === selected)?.recent_actions ?? []).map((row, index) => <tr key={`${row.at}-${row.action}-${index}`}><td className="mono">{cairoTime(row.at)}</td><td><span className="pay-status-badge st-dim">{row.action}</span></td><td>{row.entity ?? '—'}</td><td className="mono">{row.entity_id ?? '—'}</td></tr>)}{(data.users.find((row) => row.user_id === selected)?.recent_actions ?? []).length === 0 && <tr><td colSpan={4} className="cell-sub">{t('لا توجد إجراءات مدققة في الفترة.', 'No audited actions in this period.')}</td></tr>}</tbody></table></div>
      )}
    </section>}
  </PanelShell>
}
