import { db } from './supabase.js'

export interface PagePermission {
  page_key: string
  can_view: boolean
  can_create: boolean
  can_edit: boolean
  can_delete: boolean
  can_approve: boolean
  can_export: boolean
}

export type PermAction = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'export'

/**
 * True when the role holds `can_approve` on ANY page. Such roles are treated as
 * privileged and are required to use 2FA (task rule §5).
 */
export async function roleRequires2FA(role: string): Promise<boolean> {
  const { data, error } = await db()
    .from('role_page_permissions')
    .select('page_key')
    .eq('role_key', role)
    .eq('can_approve', true)
    .limit(1)
  if (error) throw error
  return (data?.length ?? 0) > 0
}

export async function getPermissions(role: string): Promise<PagePermission[]> {
  const { data, error } = await db()
    .from('role_page_permissions')
    .select(
      'page_key, can_view, can_create, can_edit, can_delete, can_approve, can_export',
    )
    .eq('role_key', role)
    .order('page_key')
  if (error) throw error
  return (data ?? []) as PagePermission[]
}

/** Server-side authorization check for a single page + action. */
export async function authorize(
  role: string,
  pageKey: string,
  action: PermAction,
): Promise<boolean> {
  const { data, error } = await db()
    .from('role_page_permissions')
    .select(`can_${action}`)
    .eq('role_key', role)
    .eq('page_key', pageKey)
    .maybeSingle()
  if (error) throw error
  if (!data) return false
  return Boolean((data as Record<string, boolean>)[`can_${action}`])
}
