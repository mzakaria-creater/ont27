import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveProviderDecision, isAmbiguousProviderError, providerStateMatches, shouldReconcileAutomationTerminal } from './ngpayExecution.js'

test('lowering a paid Maven amount verifies against UNDERPAID, not PAID', () => {
  const effective = effectiveProviderDecision('PAID', 'PAID', 400, 40)
  assert.equal(effective, 'UNDERPAID')
  assert.equal(providerStateMatches('UNDERPAID', 40, effective, 40), true)
  assert.equal(providerStateMatches('PAID', 40, effective, 40), false)
})

test('provider verification rejects a status or amount mismatch', () => {
  assert.equal(providerStateMatches('PAID', 70, 'PAID', 70), true)
  assert.equal(providerStateMatches('DECLINED', 70, 'PAID', 70), false)
  assert.equal(providerStateMatches('PAID', 700, 'PAID', 70), false)
})

test('timeouts and provider 5xx responses require read-back recovery', () => {
  assert.equal(isAmbiguousProviderError(new DOMException('The operation timed out', 'TimeoutError')), true)
  assert.equal(isAmbiguousProviderError(new Error('UpdateTransaction HTTP 500')), true)
  assert.equal(isAmbiguousProviderError(new Error('UpdateTransaction rejected: validation failed')), false)
})

test('automation repairs a stale PENDING mirror instead of reversing Maven', () => {
  assert.equal(shouldReconcileAutomationTerminal('automation-engine', 'DECLINED', 'PAID'), true)
  assert.equal(shouldReconcileAutomationTerminal('automation-engine-priority', 'PAID', 'DECLINED'), true)
  assert.equal(shouldReconcileAutomationTerminal('human.operator', 'DECLINED', 'PAID'), false)
  assert.equal(shouldReconcileAutomationTerminal('automation-engine', 'PENDING', 'PAID'), false)
})
