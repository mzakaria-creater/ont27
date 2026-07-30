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
