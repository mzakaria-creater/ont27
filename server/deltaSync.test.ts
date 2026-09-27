import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ??= 'http://localhost:54321'
process.env.SUPABASE_SECRET_KEY ??= 'test-service-key'
process.env.PANEL_JWT_SECRET ??= 'test-panel-secret'
const { buildKeysetOr } = await import('./deltaSync.js')

test('keyset pagination keeps same-timestamp rows after a page boundary', () => {
  const cursor = { value: '2026-09-27T10:00:00.000Z', key: '138481892' }
  const predicate = buildKeysetOr('first_seen_at', 'tx_id', cursor)

  // This is the exact PostgREST predicate emitted by the worker. The strict
  // primary-key comparison is what prevents a new row inserted between page
  // reads from being skipped by offset pagination.
  assert.equal(
    predicate,
    'first_seen_at.gt.2026-09-27T10:00:00.000Z,and(first_seen_at.eq.2026-09-27T10:00:00.000Z,tx_id.gt.138481892)',
  )

  const rows = [
    { first_seen_at: cursor.value, tx_id: 138481891 },
    { first_seen_at: cursor.value, tx_id: 138481892 },
    { first_seen_at: cursor.value, tx_id: 138481893 },
    { first_seen_at: '2026-09-27T10:00:01.000Z', tx_id: 138481894 },
  ]
  const nextPage = rows.filter((row) =>
    row.first_seen_at > cursor.value ||
    (row.first_seen_at === cursor.value && row.tx_id > Number(cursor.key)),
  )

  assert.deepEqual(nextPage.map((row) => row.tx_id), [138481893, 138481894])
})
