import { useEffect, useMemo, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime } from '../lib/deposits'

// Admin — panel users, permission matrix, merchant API keys (metadata only), webhooks.

interface UserRow { id: string; username: string; display_name: string | null; role: string; active: boolean | null; last_login_at: string | null; failed_login_count: number | null; locked_until: string | null; created_at: string | null }
interface PermRow { role_key: string; page_key: string; can_view: boolean; can_edit: boolean; can_approve: boolean }
interface KeyRow { id: string; merchant_id: string | null; key_name: string | null; environment: string | null; is_active: boolean | null; request_count: number | null; secret_prefix: string | null; last_used_at: string | null; created_at: string | null }
interface HookRow { id: string; name: string | null; callback_url: string | null }

type Tab = 'users' | 'permissions' | 'keys' | 'webhooks'

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')
  const [data, setData] = useState<{ users: UserRow[]; permissions: PermRow[]; apiKeys: KeyRow[]; webhooks: HookRow[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api<NonNullable<typeof data>>('/api/admin')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الإدارة.' : 'تعذّر تحميل بيانات الإدارة.'))
  }, [])

  const permsByPage = useMemo(() => {
    const map = new Map<string, PermRow[]>()
    for (const p of data?.permissions ?? []) {
      if (!map.has(p.page_key)) map.set(p.page_key, [])
      map.get(p.page_key)!.push(p)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [data])

  return (
    <PanelShell>
      <section className="page-head">
        <h2>⚙️ الإدارة والإعدادات</h2>
        <p className="page-sub">المستخدمون والصلاحيات ومفاتيح الـ API (الأسرار لا تُعرض أبداً — الإدارة الكاملة تدفّق منفصل)</p>
      </section>

      <div className="filter-bar">
        <div className="filter-pills">
          <button className={`pill${tab === 'users' ? ' active' : ''}`} onClick={() => setTab('users')}>👤 المستخدمون</button>
          <button className={`pill${tab === 'permissions' ? ' active' : ''}`} onClick={() => setTab('permissions')}>🛡️ الصلاحيات</button>
          <button className={`pill${tab === 'keys' ? ' active' : ''}`} onClick={() => setTab('keys')}>🔑 مفاتيح API</button>
          <button className={`pill${tab === 'webhooks' ? ' active' : ''}`} onClick={() => setTab('webhooks')}>🔗 Webhooks</button>
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}

      {data && tab === 'users' && (
        <section className="card recent-card">
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>المستخدم</th><th>الدور</th><th>الحالة</th><th>آخر دخول</th><th>محاولات فاشلة</th></tr></thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.display_name ?? u.username}<div className="cell-sub mono">{u.username}</div></td>
                    <td className="mono">{u.role}</td>
                    <td>
                      <span className={`pay-status-badge ${u.active ? 'st-paid' : 'st-dim'}`}>{u.active ? 'نشط' : 'موقوف'}</span>
                      {u.locked_until && new Date(u.locked_until) > new Date() && (
                        <span className="pay-status-badge st-declined"> مقفول</span>
                      )}
                    </td>
                    <td className="mono">{u.last_login_at ? depositTime({ first_seen_at: u.last_login_at }) : 'لم يدخل بعد'}</td>
                    <td className="mono">{u.failed_login_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && tab === 'permissions' && (
        <section className="card recent-card">
          <p className="page-sub">لكل صفحة: الأدوار المسموح لها (👁 عرض · ✏️ تعديل · ✅ اعتماد)</p>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>الصفحة</th><th>الأدوار</th></tr></thead>
              <tbody>
                {permsByPage.map(([pageKey, perms]) => (
                  <tr key={pageKey}>
                    <td className="mono">{pageKey}</td>
                    <td>
                      <div className="perm-chips">
                        {perms.filter((p) => p.can_view || p.can_edit || p.can_approve).map((p) => (
                          <span key={p.role_key} className="pay-status-badge st-dim perm-chip">
                            {p.role_key} {p.can_view && '👁'}{p.can_edit && '✏️'}{p.can_approve && '✅'}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data && tab === 'keys' && (
        <section className="card recent-card">
          {data.apiKeys.length === 0 && <p>لا توجد مفاتيح.</p>}
          {data.apiKeys.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>الاسم</th><th>البيئة</th><th>البادئة</th><th>الطلبات</th><th>الحالة</th><th>آخر استخدام</th></tr></thead>
                <tbody>
                  {data.apiKeys.map((k) => (
                    <tr key={k.id}>
                      <td>{k.key_name ?? '—'}</td>
                      <td className="mono">{k.environment ?? '—'}</td>
                      <td className="mono">{k.secret_prefix ? `${k.secret_prefix}…` : '—'}</td>
                      <td className="mono">{k.request_count ?? 0}</td>
                      <td><span className={`pay-status-badge ${k.is_active ? 'st-paid' : 'st-dim'}`}>{k.is_active ? 'نشط' : 'موقوف'}</span></td>
                      <td className="mono">{k.last_used_at ? depositTime({ first_seen_at: k.last_used_at }) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {data && tab === 'webhooks' && (
        <section className="card recent-card">
          {data.webhooks.length === 0 && <p>لا توجد webhooks مسجّلة.</p>}
          {data.webhooks.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>التاجر</th><th>Callback URL</th></tr></thead>
                <tbody>
                  {data.webhooks.map((h) => (
                    <tr key={h.id}>
                      <td>{h.name ?? '—'}</td>
                      <td className="mono small">{h.callback_url ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </PanelShell>
  )
}
