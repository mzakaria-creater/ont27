import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

// Edit one user: details, role, active flag, password, and per-user permission
// overrides.
//
// An override REPLACES the role's row for that page, so it can both grant a
// page the role does not have and take one away from this person only. Clearing
// it falls back to the role. The same rule is enforced in server/rbac.ts, so
// what is shown here is what the API actually allows.

const ACTIONS = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_export'] as const
type Action = typeof ACTIONS[number]
export type PermRow = { page_key: string } & Record<Action, boolean>
export type UserRow = {
  id: string; username: string; email: string | null; display_name: string | null
  role: string; active: boolean | null; last_login_at: string | null
}
export type UserOverride = { user_id: string } & PermRow & { note?: string | null; granted_by?: string | null }

interface Props {
  user: UserRow
  roles: { role_key: string; label: string }[]
  rolePermissions: ({ role_key: string } & PermRow)[]
  overrides: UserOverride[]
  pages: string[]
  onSaved: () => void
  onClose: () => void
}

const ERRORS: Record<string, [string, string]> = {
  cannot_change_own_access: ['لا يمكنك تغيير صلاحيات حسابك بنفسك.', 'You cannot change your own access.'],
  last_active_admin: ['هذا آخر مسؤول نشط — لا يمكن تعطيله أو تغيير دوره.', 'This is the last active admin — it cannot be disabled or demoted.'],
  email_taken: ['هذا البريد مستخدم لحساب آخر.', 'That email already belongs to another account.'],
  password_too_short: ['كلمة المرور 8 أحرف على الأقل.', 'Password must be at least 8 characters.'],
  invalid_email: ['صيغة البريد غير صحيحة.', 'That email address is not valid.'],
}

export default function UserEditor({ user, roles, rolePermissions, overrides, pages, onSaved, onClose }: Props) {
  const { t } = useLocale()
  const { user: me } = useAuth()
  const isSelf = me?.id === user.id

  const [form, setForm] = useState({
    display_name: user.display_name ?? '',
    email: user.email ?? '',
    role: user.role,
    active: user.active !== false,
    password: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const say = (e: unknown, fallback: string) => {
    const code = e instanceof ApiError ? e.code : undefined
    const msg = code && ERRORS[code]
    return msg ? t(msg[0], msg[1]) : fallback
  }

  const save = async () => {
    setBusy(true); setErr(null); setDone(null)
    try {
      await api(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: form.display_name,
          email: form.email,
          role: form.role,
          active: form.active,
          ...(form.password ? { password: form.password } : {}),
        }),
      })
      setForm((f) => ({ ...f, password: '' }))
      setDone(t('تم الحفظ.', 'Saved.'))
      onSaved()
    } catch (e) {
      setErr(say(e, t('تعذّر الحفظ.', 'Could not save.')))
    } finally { setBusy(false) }
  }

  const roleRow = (page: string) => rolePermissions.find((p) => p.role_key === user.role && p.page_key === page)
  const overrideRow = (page: string) => overrides.find((o) => o.page_key === page)
  const effective = (page: string): Record<Action, boolean> => {
    const o = overrideRow(page)
    if (o) return Object.fromEntries(ACTIONS.map((a) => [a, o[a]])) as Record<Action, boolean>
    const r = roleRow(page)
    return Object.fromEntries(ACTIONS.map((a) => [a, r?.[a] ?? false])) as Record<Action, boolean>
  }

  const toggle = async (page: string, action: Action) => {
    if (isSelf) return
    setBusy(true); setErr(null); setDone(null)
    const next = { ...effective(page), [action]: !effective(page)[action] }
    try {
      await api(`/api/admin/users/${user.id}/permissions/${encodeURIComponent(page)}`, {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      onSaved()
    } catch (e) {
      setErr(say(e, t('تعذّر تغيير الصلاحية.', 'Could not change the permission.')))
    } finally { setBusy(false) }
  }

  const clearOverride = async (page: string) => {
    setBusy(true); setErr(null); setDone(null)
    try {
      await api(`/api/admin/users/${user.id}/permissions/${encodeURIComponent(page)}`, { method: 'DELETE' })
      onSaved()
    } catch (e) {
      setErr(say(e, t('تعذّر الإرجاع للدور.', 'Could not revert to the role default.')))
    } finally { setBusy(false) }
  }

  const overriddenPages = new Set(overrides.map((o) => o.page_key))

  return (
    <div className="drawer-backdrop" onClick={() => !busy && onClose()}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{user.display_name || user.username}<div className="cell-sub mono">{user.username}</div></h3>
          <button className="btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        {isSelf && (
          <div className="card warn">
            {t('هذا حسابك — لا يمكنك تغيير دورك أو تعطيله أو تعديل صلاحياتك بنفسك.',
               'This is your own account — you cannot change your own role, disable it, or edit your own permissions.')}
          </div>
        )}

        <label className="field-label">{t('الاسم الظاهر', 'Display name')}</label>
        <input className="login-input" value={form.display_name} disabled={busy}
               onChange={(e) => setForm({ ...form, display_name: e.target.value })} />

        <label className="field-label">{t('البريد', 'Email')}</label>
        <input className="login-input" type="email" dir="ltr" value={form.email} disabled={busy}
               onChange={(e) => setForm({ ...form, email: e.target.value })} />

        <label className="field-label">{t('الدور', 'Role')}</label>
        <select className="login-input" value={form.role} disabled={busy || isSelf}
                onChange={(e) => setForm({ ...form, role: e.target.value })}>
          {roles.map((r) => <option key={r.role_key} value={r.role_key}>{r.label} ({r.role_key})</option>)}
        </select>

        <label className="field-label">{t('كلمة مرور جديدة (اختياري)', 'New password (optional)')}</label>
        <input className="login-input" type="password" dir="ltr" minLength={8} value={form.password} disabled={busy}
               placeholder={t('اتركه فارغاً لعدم التغيير', 'Leave blank to keep the current one')}
               onChange={(e) => setForm({ ...form, password: e.target.value })} />

        <label className="user-active-row">
          <input type="checkbox" checked={form.active} disabled={busy || isSelf}
                 onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          <span>{form.active ? t('الحساب نشط', 'Account is active') : t('الحساب موقوف — لا يستطيع الدخول', 'Account is disabled — cannot sign in')}</span>
        </label>

        {err && <div className="card warn">{err}</div>}
        {done && <div className="card">{done}</div>}

        <div className="drawer-actions">
          <button className="btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('جارٍ الحفظ…', 'Saving…') : t('حفظ', 'Save')}
          </button>
          <button className="btn-ghost" disabled={busy} onClick={onClose}>{t('إغلاق', 'Close')}</button>
        </div>

        <div className="section-label">{t('صلاحيات هذا المستخدم', "This user's permissions")}</div>
        <p className="drawer-note">
          {t(
            'الافتراضي يأتي من الدور. أي تعديل هنا يصنع استثناءً لهذا المستخدم وحده — يمنح صفحة لا يملكها دوره أو يسحب صفحة يملكها، دون التأثير على بقية أصحاب الدور. «إرجاع» يحذف الاستثناء ويعيد الصفحة لإعداد الدور.',
            'The default comes from the role. Changing anything here creates an exception for this user alone — granting a page the role lacks, or taking one away — without affecting anyone else with that role. "Revert" removes the exception and restores the role default.',
          )}
        </p>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('الصفحة', 'Page')}</th>
                {ACTIONS.map((a) => <th key={a} className="mono">{a.replace('can_', '')}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {pages.map((page) => {
                const eff = effective(page)
                const isOverride = overriddenPages.has(page)
                return (
                  <tr key={page} className={isOverride ? 'row-pending' : undefined}>
                    <td className="mono">
                      {page}
                      {isOverride && <div className="cell-sub">{t('استثناء', 'exception')}</div>}
                    </td>
                    {ACTIONS.map((a) => (
                      <td key={a}>
                        <button className={`pill${eff[a] ? ' active' : ''}`} disabled={busy || isSelf}
                                onClick={() => void toggle(page, a)} aria-label={`${a} ${page}`}>
                          {eff[a] ? '✓' : '—'}
                        </button>
                      </td>
                    ))}
                    <td>
                      {isOverride && (
                        <button className="btn-ghost btn-sm" disabled={busy || isSelf}
                                onClick={() => void clearOverride(page)}>
                          {t('إرجاع', 'Revert')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  )
}
