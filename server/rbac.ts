import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { db } from './db.js'
import { ACCESS_COOKIE, verifyAccessToken } from './tokens.js'
import type { AccessClaims } from './tokens.js'

export type AuthEnv = { Variables: { actor: AccessClaims } }

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getCookie(c, ACCESS_COOKIE)
  const claims = token ? await verifyAccessToken(token) : null
  if (!claims) return c.json({ error: 'unauthenticated' }, 401)
  c.set('actor', claims)
  await next()
})

type PermAction = 'can_view' | 'can_create' | 'can_edit' | 'can_delete' | 'can_approve' | 'can_export'

// Permissions come from the role matrix, with any per-user override for that
// page swapped in. The override REPLACES the role's row rather than being OR'd
// onto it, so one person can be granted an extra page or have one taken away
// without touching everyone else who shares the role.
//
// This resolution lives here, in the guard, not only in what the UI is told:
// a per-user grant that the API did not honour would be a lie, and a per-user
// revoke that the API ignored would be a hole.
async function effectivePerms(userId: string, role: string, pageKeys: string[]): Promise<Record<string, Record<string, boolean>>> {
  const [roleRes, overrideRes] = await Promise.all([
    db.from('role_page_permissions').select('page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export')
      .eq('role_key', role).in('page_key', pageKeys),
    db.from('user_page_permissions').select('page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export')
      .eq('user_id', userId).in('page_key', pageKeys),
  ])
  type PermRow = { page_key: string } & Record<string, boolean>
  const merged: Record<string, Record<string, boolean>> = {}
  // Role first, then overrides on top — last write wins, which is the replace
  // semantics the override is meant to have.
  for (const rows of [roleRes.data, overrideRes.data]) {
    for (const row of (rows ?? []) as unknown as PermRow[]) {
      const { page_key, ...actions } = row
      merged[page_key] = actions
    }
  }
  return merged
}

export function requirePerm(pageKey: string, action: PermAction) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const actor = c.get('actor')
    const perms = await effectivePerms(actor.sub, actor.role, [pageKey])
    if (!perms[pageKey]?.[action]) {
      return c.json({ error: 'forbidden', page: pageKey, action }, 403)
    }
    await next()
  })
}

// A category page is reachable through ANY of its page_keys (the legacy
// permission matrix splits one screen across several keys per role).
export function requireAnyPerm(pageKeys: string[], action: PermAction) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const actor = c.get('actor')
    const perms = await effectivePerms(actor.sub, actor.role, pageKeys)
    if (!Object.values(perms).some((p) => p[action])) {
      return c.json({ error: 'forbidden', pages: pageKeys, action }, 403)
    }
    await next()
  })
}

// Administrative configuration is limited to the stewardship roles. A plain
// permission row must not accidentally grant an operator access to user
// management, API secrets, or the global matrix — but super_admin is the
// top role and holds full access everywhere.
const ADMIN_ROLES = new Set(['owner', 'admin', 'super_admin'])
export const requireAdminRole = createMiddleware<AuthEnv>(async (c, next) => {
  if (!ADMIN_ROLES.has(c.get('actor').role)) {
    return c.json({ error: 'admin_role_required' }, 403)
  }
  await next()
})

// Security-sensitive integrations are deliberately stricter than the editable
// permission matrix: neither owner/admin nor a per-user override may grant
// access to credentials or trading limits.
export const requireSuperAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.get('actor').role !== 'super_admin') {
    return c.json({ error: 'super_admin_required' }, 403)
  }
  await next()
})
