import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Layers, Plus, RefreshCw, Search, Trash2, UserMinus, UserPlus, Users, TrendingUp, Percent, Wallet } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { Sheet, SheetFooter, SheetHeader } from '../components/Sheet'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Partners & Groups: merchant groups with commission, routing priority,
// settlement period and a daily volume cap, plus group membership.
// Every number comes from the database (groups table + merchant daily view).

interface Group {
  id: string
  name: string
  description: string | null
  color: string
  commission_rate: number
  routing_priority: number
  settlement_period: 'T+0' | 'T+1' | 'T+2' | 'T+3'
  daily_volume_cap: number | null
  active: boolean
  merchant_count: number
  volume_today: number
  volume_30d: number
}

interface Member {
  id: string
  name: string | null
  code: string | null
  country: string | null
  status: string | null
  is_active: boolean | null
  kyc_status: string | null
  tier: string | null
  group_id: string | null
  volume_today: number
  volume_30d: number
}

const COLORS = ['#3b82f6', '#06b6d4', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899']
const PERIODS: Array<[Group['settlement_period'], string]> = [['T+0', 'T+0 (Instant)'], ['T+1', 'T+1'], ['T+2', 'T+2'], ['T+3', 'T+3']]

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '··'
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

export default function MerchantGroups() {
  const { t } = useLocale()
  const { can } = useAuth()
  const canEdit = can('merchants', 'can_edit')
  const canCreate = can('merchants', 'can_create')
  const canDelete = can('merchants', 'can_delete')

  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [assignId, setAssignId] = useState('')

  // settings form
  const [rate, setRate] = useState('')
  const [priority, setPriority] = useState('')
  const [period, setPeriod] = useState<Group['settlement_period']>('T+1')
  const [cap, setCap] = useState('')
  const [description, setDescription] = useState('')

  // create form
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newColor, setNewColor] = useState(COLORS[0])

  const errText = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 403) return t('لا تملك صلاحية هذا الإجراء.', 'You do not have permission for this action.')
      if (e.code === 'group_name_exists') return t('اسم المجموعة مستخدم بالفعل.', 'A group with this name already exists.')
      if (e.code === 'group_not_empty') return t('انقل التجار خارج المجموعة قبل حذفها.', 'Move the merchants out of the group before deleting it.')
      return e.code
    }
    return t('حدث خطأ غير متوقع.', 'Unexpected error.')
  }

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    api<{ groups: Group[]; merchants: Member[] }>('/api/merchants/groups')
      .then((res) => {
        setGroups(res.groups); setMembers(res.merchants)
        setSelectedId((cur) => (cur && res.groups.some((g) => g.id === cur) ? cur : res.groups[0]?.id ?? null))
      })
      .catch((e) => setErr(errText(e)))
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { load() }, [load])

  const selected = useMemo(() => groups.find((g) => g.id === selectedId) ?? null, [groups, selectedId])
  const groupMembers = useMemo(() => members.filter((m) => m.group_id === selectedId), [members, selectedId])
  const unassigned = useMemo(() => members.filter((m) => !m.group_id), [members])

  useEffect(() => {
    if (!selected) return
    setRate(String(selected.commission_rate)); setPriority(String(selected.routing_priority))
    setPeriod(selected.settlement_period); setCap(selected.daily_volume_cap == null ? '' : String(selected.daily_volume_cap))
    setDescription(selected.description ?? ''); setAssignId('')
  }, [selected])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? groups.filter((g) => `${g.name} ${g.description ?? ''}`.toLowerCase().includes(needle)) : groups
  }, [groups, q])

  const summary = useMemo(() => ({
    groups: groups.length,
    active: groups.filter((g) => g.active).length,
    merchants: members.filter((m) => m.group_id).length,
    volume: groups.reduce((a, g) => a + g.volume_30d, 0),
  }), [groups, members])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setErr(null); setNotice(null)
    try { await fn(); if (ok) setNotice(ok); load() }
    catch (e) { setErr(errText(e)) }
    finally { setBusy(false) }
  }

  const saveSettings = () => selected && run(() => api(`/api/merchants/groups/${selected.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ commission_rate: Number(rate), routing_priority: Number(priority), settlement_period: period, daily_volume_cap: cap.trim() === '' ? null : Number(cap), description: description.trim() || null }),
  }), t('تم حفظ الإعدادات.', 'Settings saved.'))

  const toggleActive = () => selected && run(() => api(`/api/merchants/groups/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ active: !selected.active }) }))

  const createGroup = async () => {
    if (!newName.trim()) return
    setBusy(true); setErr(null)
    try {
      const res = await api<{ group: Group }>('/api/merchants/groups', { method: 'POST', body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null, color: newColor, routing_priority: groups.length + 1 }) })
      setCreating(false); setNewName(''); setNewDesc(''); setSelectedId(res.group.id); load()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  const removeGroup = () => {
    if (!selected || !window.confirm(t(`حذف المجموعة «${selected.name}»؟`, `Delete the group “${selected.name}”?`))) return
    void run(() => api(`/api/merchants/groups/${selected.id}`, { method: 'DELETE' }))
  }

  const assign = () => selected && assignId && run(() => api(`/api/merchants/groups/${selected.id}/members`, { method: 'POST', body: JSON.stringify({ merchant_id: assignId }) }))
  const unassign = (m: Member) => selected && run(() => api(`/api/merchants/groups/${selected.id}/members/${m.id}`, { method: 'DELETE' }))

  const move = (index: number, dir: -1 | 1) => {
    const ids = groups.map((g) => g.id)
    const j = index + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[index], ids[j]] = [ids[j], ids[index]]
    void run(() => api('/api/merchants/groups/order', { method: 'PUT', body: JSON.stringify({ ids }) }))
  }

  return (
    <>
      <section className="page-head admin-head">
        <span className="admin-head-icon"><Layers size={20} /></span>
        <div className="admin-head-text">
          <span className="admin-head-eyebrow">{t('إدارة التوجيه والعمولات', 'Routing & commissions')}</span>
          <h2>{t('الشركاء والمجموعات', 'Partners & Groups')}</h2>
          <p className="page-sub">{t('نظّم التجار في مجموعات بعمولة وأولوية توجيه وسقف يومي.', 'Organise merchants into groups with commission, routing priority and a daily cap.')}</p>
        </div>
        <div className="admin-head-actions">
          <button className="btn-ghost btn-sm" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />{t('تحديث', 'Refresh')}</button>
        </div>
      </section>

      {err && <div className="card warn">{err}</div>}
      {notice && <div className="card ok">{notice}</div>}

      <div className="grp-layout">
        <aside className="grp-side">
          <div className="grp-side-head">
            <h3><Layers size={16} /> {t('المجموعات', 'Groups')} <span className="cell-sub">({groups.length})</span></h3>
            {canCreate && <button className="btn-primary btn-sm" onClick={() => setCreating(true)}><Plus size={14} /> {t('إنشاء', 'Create')}</button>}
          </div>
          <label className="grp-search"><Search size={14} /><input className="login-input" placeholder={t('بحث في المجموعات…', 'Search groups…')} value={q} onChange={(e) => setQ(e.target.value)} /></label>

          <div className="grp-list">
            {loading && !groups.length && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
            {!loading && !filtered.length && <p className="cell-sub">{groups.length ? t('لا نتائج.', 'No results.') : t('لا توجد مجموعات بعد. أنشئ أول مجموعة.', 'No groups yet. Create the first one.')}</p>}
            {filtered.map((g) => (
              <button key={g.id} type="button" className={`grp-card${g.id === selectedId ? ' active' : ''}`} onClick={() => setSelectedId(g.id)}>
                <span className="grp-avatar" style={{ background: g.color }}>{initials(g.name)}</span>
                <span className="grp-card-body">
                  <span className="grp-card-top"><strong>{g.name}</strong><span className={`pay-status-badge ${g.active ? 'st-paid' : 'st-dim'}`}>{g.active ? t('نشطة', 'Active') : t('متوقفة', 'Inactive')}</span></span>
                  {g.description && <span className="cell-sub grp-desc">{g.description}</span>}
                  <span className="grp-card-meta"><span><Users size={12} /> {g.merchant_count}</span><span><TrendingUp size={12} /> {compact(g.volume_30d)}</span><span><Percent size={12} /> {g.commission_rate}%</span></span>
                </span>
              </button>
            ))}
          </div>

          <div className="grp-summary">
            <h4>{t('ملخص المنصة', 'Platform summary')}</h4>
            <div>
              <div><strong>{summary.groups}</strong><span>{t('مجموعات', 'Groups')}</span></div>
              <div><strong>{summary.merchants}</strong><span>{t('تجار مرتبطون', 'Assigned merchants')}</span></div>
              <div><strong>{summary.active}</strong><span>{t('نشطة', 'Active')}</span></div>
              <div><strong>{compact(summary.volume)}</strong><span>{t('حجم 30 يوم (EGP)', '30-day volume (EGP)')}</span></div>
            </div>
          </div>
        </aside>

        <main className="grp-main">
          {!selected && !loading && <section className="card recent-card"><p>{t('اختر مجموعة أو أنشئ واحدة جديدة.', 'Select a group or create a new one.')}</p></section>}
          {selected && (
            <>
              <section className="card grp-hero">
                <span className="grp-avatar lg" style={{ background: selected.color }}>{initials(selected.name)}</span>
                <div className="grp-hero-text">
                  <h3>{selected.name}</h3>
                  <p className="cell-sub">{selected.description ?? t('بدون وصف', 'No description')}</p>
                </div>
                <div className="grp-hero-actions">
                  <span className={`pay-status-badge ${selected.active ? 'st-paid' : 'st-dim'}`}>{selected.active ? t('نشطة', 'Active') : t('متوقفة', 'Inactive')}</span>
                  {canEdit && <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void toggleActive()}>{selected.active ? t('إيقاف', 'Deactivate') : t('تفعيل', 'Activate')}</button>}
                  {canDelete && <button className="btn-ghost btn-sm danger" disabled={busy} onClick={removeGroup}><Trash2 size={14} /></button>}
                </div>
              </section>

              <div className="grp-stats">
                <div className="kpi-card"><Users className="kpi-icon" /><div className="kpi-value">{selected.merchant_count}</div><div className="kpi-label">{t('تجار', 'Merchants')}</div></div>
                <div className="kpi-card"><TrendingUp className="kpi-icon" /><div className="kpi-value">{compact(selected.volume_30d)}</div><div className="kpi-label">{t('حجم 30 يوم', '30-day volume')}</div></div>
                <div className="kpi-card"><Percent className="kpi-icon" /><div className="kpi-value">{selected.commission_rate}%</div><div className="kpi-label">{t('العمولة', 'Commission')}</div></div>
                <div className="kpi-card"><Wallet className="kpi-icon" /><div className="kpi-value">{selected.settlement_period}</div><div className="kpi-label">{t('التسوية', 'Settlement')}</div></div>
              </div>

              <section className="card recent-card">
                <div className="recent-head"><h3>{t('إعدادات العمولة', 'Commission settings')}</h3></div>
                <div className="grp-form">
                  <label><span>{t('نسبة العمولة', 'Commission rate')} (%)</span><input className="login-input" type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} disabled={!canEdit || busy} /></label>
                  <label><span>{t('أولوية التوجيه', 'Routing priority')} <em>({t('الأقل أولاً', 'lower = first')})</em></span><input className="login-input" type="number" min="1" max="9999" step="1" value={priority} onChange={(e) => setPriority(e.target.value)} disabled={!canEdit || busy} /></label>
                  <label><span>{t('فترة التسوية', 'Settlement period')}</span><select className="login-input" value={period} onChange={(e) => setPeriod(e.target.value as Group['settlement_period'])} disabled={!canEdit || busy}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                  <label><span>{t('سقف الحجم اليومي (EGP)', 'Daily volume cap (EGP)')}</span><input className="login-input" type="number" min="0" step="1" value={cap} placeholder={t('بدون سقف', 'No cap')} onChange={(e) => setCap(e.target.value)} disabled={!canEdit || busy} /></label>
                  <label className="grp-form-wide"><span>{t('الوصف', 'Description')}</span><input className="login-input" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit || busy} /></label>
                </div>
                {selected.daily_volume_cap != null && <p className="cell-sub">{t('حجم اليوم', 'Today')}: <span className="mono">{money(selected.volume_today, 'EGP')}</span> / <span className="mono">{money(selected.daily_volume_cap, 'EGP')}</span></p>}
                {canEdit && <button className="btn-primary" disabled={busy} onClick={() => void saveSettings()}><Check size={15} /> {t('حفظ الإعدادات', 'Save settings')}</button>}
              </section>

              <section className="card recent-card">
                <div className="recent-head">
                  <h3>{t('التجار في المجموعة', 'Merchants in group')} ({groupMembers.length})</h3>
                  {canEdit && (
                    <div className="control-row">
                      <select className="login-input" value={assignId} onChange={(e) => setAssignId(e.target.value)} disabled={busy || !unassigned.length}>
                        <option value="">{unassigned.length ? t('اختر تاجراً…', 'Select a merchant…') : t('كل التجار مرتبطون', 'All merchants assigned')}</option>
                        {unassigned.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.code}</option>)}
                      </select>
                      <button className="btn-ghost btn-sm" disabled={!assignId || busy} onClick={() => void assign()}><UserPlus size={14} /> {t('إضافة تاجر', 'Assign merchant')}</button>
                    </div>
                  )}
                </div>
                {groupMembers.length === 0 ? <p className="cell-sub">{t('لا يوجد تجار في هذه المجموعة.', 'No merchants in this group.')}</p> : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead><tr><th>{t('التاجر', 'Merchant')}</th><th>{t('الدولة', 'Country')}</th><th>{t('حجم اليوم', 'Volume today')}</th><th>{t('الحالة', 'Status')}</th>{canEdit && <th />}</tr></thead>
                      <tbody>
                        {groupMembers.map((m) => (
                          <tr key={m.id}>
                            <td>{m.name ?? '—'}{m.code && <div className="cell-sub mono">{m.code}</div>}</td>
                            <td>{m.country ?? '—'}</td>
                            <td className="mono">{money(m.volume_today, 'EGP')}</td>
                            <td><span className={`pay-status-badge ${(m.is_active ?? false) ? 'st-paid' : 'st-dim'}`}>{(m.is_active ?? false) ? t('نشط', 'Active') : t('موقوف', 'Disabled')}</span></td>
                            {canEdit && <td><button className="btn-ghost btn-sm danger" disabled={busy} onClick={() => void unassign(m)} title={t('إزالة من المجموعة', 'Remove from group')}><UserMinus size={14} /></button></td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          <section className="card recent-card">
            <div className="recent-head"><h3>{t('كل المجموعات — ترتيب التوجيه', 'All groups — routing order')}</h3></div>
            {groups.length === 0 ? <p className="cell-sub">—</p> : (
              <ol className="grp-order">
                {groups.map((g, i) => (
                  <li key={g.id} className={g.id === selectedId ? 'active' : ''}>
                    <span className="grp-order-n" style={{ background: g.color }}>{i + 1}</span>
                    <button type="button" className="grp-order-name" onClick={() => setSelectedId(g.id)}>{g.name}</button>
                    <span className="cell-sub">{g.merchant_count} {t('تاجر', 'merchants')}</span>
                    {canEdit && (
                      <span className="grp-order-btns">
                        <button className="btn-ghost btn-sm" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={t('أعلى', 'Move up')}><ArrowUp size={14} /></button>
                        <button className="btn-ghost btn-sm" disabled={busy || i === groups.length - 1} onClick={() => move(i, 1)} aria-label={t('أسفل', 'Move down')}><ArrowDown size={14} /></button>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </main>
      </div>

      {creating && (
        <Sheet open onClose={() => !busy && setCreating(false)} busy={busy} ariaLabel={t('إنشاء مجموعة', 'Create group')}>
          <SheetHeader title={<><Plus size={16} /> {t('مجموعة جديدة', 'New group')}</>} onClose={() => setCreating(false)} busy={busy} />
          <label className="field-label">{t('الاسم', 'Name')}</label>
          <input className="login-input" maxLength={80} value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          <label className="field-label">{t('الوصف', 'Description')}</label>
          <input className="login-input" maxLength={300} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
          <label className="field-label">{t('اللون', 'Colour')}</label>
          <div className="grp-colors">{COLORS.map((c) => <button key={c} type="button" className={`grp-color${c === newColor ? ' on' : ''}`} style={{ background: c }} onClick={() => setNewColor(c)} aria-label={c} />)}</div>
          <SheetFooter>
            <button className="btn-primary" disabled={!newName.trim() || busy} onClick={() => void createGroup()}>{t('إنشاء', 'Create')}</button>
            <button className="btn-ghost" onClick={() => setCreating(false)} disabled={busy}>{t('إلغاء', 'Cancel')}</button>
          </SheetFooter>
        </Sheet>
      )}
    </>
  )
}
