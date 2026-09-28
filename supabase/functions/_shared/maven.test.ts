import test from 'node:test'
import assert from 'node:assert/strict'
import { listTransactions } from './maven.ts'

test('listTransactions returns rows from the normalized full-list response', async (t) => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return new Response(JSON.stringify({
      data: [{ TransactionId: 138483315, Status: 'PENDING', Amount: 30 }],
      recordsTotal: 1,
      errorMessage: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await listTransactions('session=test', 0, '28-Sep-2026 14:00:00', '28-Sep-2026 14:15:00')

  assert.equal(result.total, 1)
  assert.deepEqual(result.rows.map((row) => row.TransactionId), [138483315])
  assert.equal(calls.length, 1, 'pending compatibility endpoint is skipped when the full list has rows')
})

test('listTransactions falls back to pending rows when the full list is empty', async (t) => {
  const originalFetch = globalThis.fetch
  let call = 0
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    call += 1
    urls.push(String(input))
    const payload = call === 1
      ? { data: [], recordsTotal: 0, errorMessage: null }
      : { data: [{ TransactionId: 138483316 }], recordsTotal: 1, errorMessage: null }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await listTransactions('session=test', 0, '28-Sep-2026 14:00:00', '28-Sep-2026 14:15:00', 'SupplierOperator')

  assert.equal(call, 2)
  assert.equal(result.total, 1)
  assert.deepEqual(result.rows.map((row) => row.TransactionId), [138483316])
  assert.ok(urls.every((url) => url.includes('/SupplierOperator/Transactions/')), 'operator cookie is only sent to the exact operator area')
})

test('live polling prefers the fast pending endpoint and skips the full list when rows exist', async (t) => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ data: [{ TransactionId: 138483317 }], recordsTotal: 1 }), { status: 200 })
  }) as typeof fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const result = await listTransactions('session=test', 0, '28-Sep-2026 14:00:00', '28-Sep-2026 14:15:00', 'SupplierOperator', true)

  assert.equal(result.total, 1)
  assert.equal(urls.length, 1)
  assert.ok(urls[0].endsWith('/SupplierOperator/Transactions/GetP2PPendingTransactions'))
})
