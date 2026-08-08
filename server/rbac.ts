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

export function requirePerm(pageKey: string, action: PermAction) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const actor = c.get('actor')
    const { data } = await db
      .from('role_page_permissions')
      .select(action)
      .eq('role_key', actor.role)
      .eq('page_key', pageKey)
      .maybeSingle()
    if (!(data as Record<string, boolean> | null)?.[action]) {
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
    const { data } = await db
      .from('role_page_permissions')
      .select(`page_key, ${action}`)
      .eq('role_key', actor.role)
      .in('page_key', pageKeys)
    const rows = (data ?? []) as unknown as Record<string, boolean>[]
    if (!rows.some((r) => r[action])) {
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
