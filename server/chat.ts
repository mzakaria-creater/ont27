import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const chatRoutes = new Hono<AuthEnv>()
chatRoutes.use('*', requireAuth)

async function member(roomId: string, userId: string) {
  const { data } = await db.from('internal_chat_members').select('room_id').eq('room_id', roomId).eq('user_id', userId).maybeSingle()
  return !!data
}

chatRoutes.get('/', async (c) => {
  const actor = c.get('actor'); const now = new Date().toISOString()
  await db.from('internal_chat_presence').upsert({ user_id: actor.sub, last_seen_at: now }, { onConflict: 'user_id' })
  const [{ data: users, error: usersError }, { data: memberships, error: memberError }, { data: presence }] = await Promise.all([
    db.from('panel_users').select('id, username, display_name, role, active').eq('active', true).order('display_name'),
    db.from('internal_chat_members').select('room_id, last_read_at, internal_chat_rooms(id, name, kind, created_at, updated_at)').eq('user_id', actor.sub),
    db.from('internal_chat_presence').select('user_id, last_seen_at'),
  ])
  if (usersError || memberError) return c.json({ error: 'db_error', detail: (usersError ?? memberError)?.message }, 500)
  const roomIds = (memberships ?? []).map((row: any) => row.room_id)
  const [{ data: allMembers }, { data: messages }] = await Promise.all([
    roomIds.length ? db.from('internal_chat_members').select('room_id, user_id, last_read_at').in('room_id', roomIds) : Promise.resolve({ data: [] }),
    roomIds.length ? db.from('internal_chat_messages').select('id, room_id, sender_id, body, created_at').in('room_id', roomIds).order('created_at', { ascending: false }).limit(1000) : Promise.resolve({ data: [] }),
  ])
  const userMap = new Map((users ?? []).map((u: any) => [u.id, u]))
  const rooms = (memberships ?? []).map((membership: any) => {
    const room: any = membership.internal_chat_rooms
    const roomMembers = (allMembers ?? []).filter((m: any) => m.room_id === membership.room_id)
    const roomMessages = (messages ?? []).filter((m: any) => m.room_id === membership.room_id)
    const other = roomMembers.map((m: any) => userMap.get(m.user_id)).find((u: any) => u?.id !== actor.sub)
    return { ...room, name: room.kind === 'direct' ? (other?.display_name ?? other?.username ?? 'Direct message') : room.name,
      members: roomMembers.map((m: any) => ({ ...userMap.get(m.user_id), last_read_at: m.last_read_at })).filter((u: any) => u.id),
      last_message: roomMessages[0] ?? null,
      unread: roomMessages.filter((m: any) => m.sender_id !== actor.sub && (!membership.last_read_at || m.created_at > membership.last_read_at)).length }
  }).sort((a: any, b: any) => String(b.last_message?.created_at ?? b.updated_at).localeCompare(String(a.last_message?.created_at ?? a.updated_at)))
  return c.json({ me: actor.sub, users: users ?? [], rooms, presence: presence ?? [], generated_at: now })
})

chatRoutes.post('/rooms', async (c) => {
  const actor = c.get('actor'); const body = await c.req.json().catch(() => null)
  const ids = [...new Set([actor.sub, ...((Array.isArray(body?.member_ids) ? body.member_ids : []).filter((id: unknown) => typeof id === 'string'))])]
  if (ids.length < 2 || ids.length > 50) return c.json({ error: 'invalid_members' }, 400)
  const kind = body?.kind === 'direct' && ids.length === 2 ? 'direct' : 'group'
  if (kind === 'direct') {
    const { data: mine } = await db.from('internal_chat_members').select('room_id, internal_chat_rooms!inner(kind)').eq('user_id', actor.sub)
    for (const row of mine ?? []) { if ((row as any).internal_chat_rooms?.kind !== 'direct') continue; const { data: peer } = await db.from('internal_chat_members').select('user_id').eq('room_id', row.room_id).neq('user_id', actor.sub).maybeSingle(); if (peer?.user_id === ids.find((id) => id !== actor.sub)) return c.json({ room_id: row.room_id }) }
  }
  const name = kind === 'group' ? String(body?.name ?? '').trim().slice(0, 100) : null
  if (kind === 'group' && !name) return c.json({ error: 'name_required' }, 400)
  const { data: room, error } = await db.from('internal_chat_rooms').insert({ name, kind, created_by: actor.sub }).select('id').single()
  if (error || !room) return c.json({ error: 'db_error', detail: error?.message }, 500)
  const { error: membersError } = await db.from('internal_chat_members').insert(ids.map((user_id) => ({ room_id: room.id, user_id, last_read_at: new Date().toISOString() })))
  if (membersError) { await db.from('internal_chat_rooms').delete().eq('id', room.id); return c.json({ error: 'db_error', detail: membersError.message }, 500) }
  return c.json({ room_id: room.id }, 201)
})

chatRoutes.get('/rooms/:id/messages', async (c) => {
  const actor = c.get('actor'); const roomId = c.req.param('id')
  if (!await member(roomId, actor.sub)) return c.json({ error: 'forbidden' }, 403)
  const { data, error } = await db.from('internal_chat_messages').select('id, room_id, sender_id, body, created_at, edited_at').eq('room_id', roomId).order('created_at', { ascending: true }).limit(300)
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await db.from('internal_chat_members').update({ last_read_at: new Date().toISOString() }).eq('room_id', roomId).eq('user_id', actor.sub)
  return c.json({ messages: data ?? [] })
})

chatRoutes.post('/rooms/:id/messages', async (c) => {
  const actor = c.get('actor'); const roomId = c.req.param('id'); const payload = await c.req.json().catch(() => null); const body = String(payload?.body ?? '').trim()
  if (!await member(roomId, actor.sub)) return c.json({ error: 'forbidden' }, 403)
  if (!body || body.length > 4000) return c.json({ error: 'invalid_message' }, 400)
  const now = new Date().toISOString(); const { data, error } = await db.from('internal_chat_messages').insert({ room_id: roomId, sender_id: actor.sub, body, created_at: now }).select('id, room_id, sender_id, body, created_at').single()
  if (error) return c.json({ error: 'db_error', detail: error.message }, 500)
  await Promise.all([db.from('internal_chat_rooms').update({ updated_at: now }).eq('id', roomId), db.from('internal_chat_members').update({ last_read_at: now }).eq('room_id', roomId).eq('user_id', actor.sub), db.from('internal_chat_presence').upsert({ user_id: actor.sub, last_seen_at: now }, { onConflict: 'user_id' })])
  return c.json({ message: data }, 201)
})

chatRoutes.post('/presence', async (c) => { const actor = c.get('actor'); const last_seen_at = new Date().toISOString(); const { error } = await db.from('internal_chat_presence').upsert({ user_id: actor.sub, last_seen_at }, { onConflict: 'user_id' }); return error ? c.json({ error: 'db_error' }, 500) : c.json({ ok: true, last_seen_at }) })

