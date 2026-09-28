import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL ??= 'http://localhost:54321'
process.env.SUPABASE_SECRET_KEY ??= 'test-service-key'
process.env.PANEL_JWT_SECRET ??= 'test-panel-secret'
const { buildKeysetOr, guardLegacyAmount } = await import('./deltaSync.js')

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

test('legacy mirror cannot revert a provider-confirmed amount with an older snapshot', () => {
  const guarded = guardLegacyAmount({
    tx_id: 138482059,
    amount: 300,
    modified_at_utc: '2026-09-28T09:59:00.000Z',
    local_amount: 300,
    provider_amount: 300,
    amount_sync_status: 'matched',
  }, {
    amount: 30,
    local_amount: 30,
    amount_confirmed_at: '2026-09-28T10:00:00.000Z',
  })

  assert.equal(guarded.amount, 30)
  assert.equal('local_amount' in guarded, false)
  assert.equal('provider_amount' in guarded, false)
  assert.equal('amount_sync_status' in guarded, false)
})

test('a genuinely newer Maven amount remains authoritative', () => {
  const guarded = guardLegacyAmount({
    tx_id: 138482059,
    amount: 45,
    modified_at_utc: '2026-09-28T10:01:00.000Z',
  }, {
    amount: 30,
    local_amount: 30,
    amount_confirmed_at: '2026-09-28T10:00:00.000Z',
  })

  assert.equal(guarded.amount, 45)
})
