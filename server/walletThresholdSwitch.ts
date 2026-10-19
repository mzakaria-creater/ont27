import { db } from './db.js'
import { callMavenWalletSwitch } from './mavenWalletSwitch.js'

const normalizePhone = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
const phoneVariants = (value: unknown) => {
  const raw = String(value ?? '').replace(/\D/g, '')
  const local = normalizePhone(raw)
  return [...new Set([raw, `0${local}`, `20${local}`].filter(Boolean))]
}
const RECEIVED_SMS_CATEGORIES = ['deposit', 'received', 'income']

type Rule = {
  id: string
  bank_id: string
  merchant: string
  payment_type: string
  source_wallet: string
  target_wallet: string
  amount_threshold: number
  amount_received_since_check: number
  last_checked_at: string
}

export async function runWalletThresholdSwitch(actorName = 'wallet-threshold-switch') {
  const { data: rules, error } = await db
    .from('maven_wallet_threshold_switch_rules')
    .select('id, bank_id, merchant, payment_type, source_wallet, target_wallet, amount_threshold, amount_received_since_check, last_checked_at')
    .eq('active', true)
    .eq('status', 'active')
  if (error) throw new Error(`threshold switch rules: ${error.message}`)

  const results: Record<string, unknown>[] = []
  for (const rule of (rules ?? []) as Rule[]) {
    const source = normalizePhone(rule.source_wallet)
    const target = normalizePhone(rule.target_wallet)
    const sourceVariants = phoneVariants(rule.source_wallet)
    const since = rule.last_checked_at || new Date(0).toISOString()
    const { data: smsRows, error: smsError } = await db
      .from('inbound_sms')
      .select('id, amount, balance_after, provider, receiver_number, wallet_number, confirmed_wallet_number, received_at')
      .gte('received_at', since)
      .in('sms_category', RECEIVED_SMS_CATEGORIES)
      .or(sourceVariants.flatMap((number) => [`receiver_number.eq.${number}`, `wallet_number.eq.${number}`, `confirmed_wallet_number.eq.${number}`]).join(','))
      .not('is_blocked', 'is', true)
      .not('is_duplicate', 'is', true)
    if (smsError) throw new Error(`threshold switch SMS ${rule.id}: ${smsError.message}`)

    // Some Maven deposits arrive in V2 before their corresponding inbound SMS
    // is linked (or when the provider did not expose the raw SMS). Use the
    // provider transaction mirror as a verified fallback, without double
    // counting when SMS evidence exists for this evaluation window.
    let received = (smsRows ?? []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
    let observedBalance = (smsRows ?? []).reduce((max, row) => Math.max(max, Number(row.balance_after) || 0), 0)
    let evidenceSource = 'inbound_sms'
    if (!smsRows?.length) {
      // Orange Cash confirmations may omit the receiving wallet because the
      // forwarder has no resolved device. The provider/payment type is still
      // an explicit match to the configured Maven rule, so use its live SMS
      // balance before falling back to Maven transaction amounts.
      const { data: providerSms, error: providerSmsError } = await db
        .from('inbound_sms')
        .select('id, amount, balance_after, provider, received_at')
        .gte('received_at', since)
        .in('sms_category', RECEIVED_SMS_CATEGORIES)
        .eq('provider', rule.payment_type)
        .not('is_blocked', 'is', true)
        .not('is_duplicate', 'is', true)
      if (providerSmsError) throw new Error(`threshold switch provider SMS ${rule.id}: ${providerSmsError.message}`)
      observedBalance = (providerSms ?? []).reduce((max, row) => Math.max(max, Number(row.balance_after) || 0), 0)
      if (providerSms?.length) evidenceSource = 'provider_balance_sms'

      const { data: transactions, error: transactionError } = await db
        .from('maven_transactions')
        .select('tx_id, amount, receiving_wallet, to_account_number, first_seen_at')
        .gte('first_seen_at', since)
        .in('status', ['PAID', 'APPROVED', 'SUCCESS', 'COMPLETED'])
        .or(sourceVariants.flatMap((number) => [`receiving_wallet.eq.${number}`, `to_account_number.eq.${number}`]).join(','))
      if (transactionError) throw new Error(`threshold switch transactions ${rule.id}: ${transactionError.message}`)
      received = (transactions ?? []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
      if (!providerSms?.length) evidenceSource = 'maven_transactions'
    }
    const total = Number(rule.amount_received_since_check || 0) + received
    const checkedAt = new Date().toISOString()
    await db.from('maven_wallet_threshold_switch_rules').update({ amount_received_since_check: total, last_checked_at: checkedAt, updated_at: checkedAt }).eq('id', rule.id)

    const threshold = Number(rule.amount_threshold)
    if (total < threshold && observedBalance < threshold) {
      results.push({ id: rule.id, status: 'below_threshold', amount_received: total, observed_balance: observedBalance || null, evidence_source: evidenceSource })
      continue
    }

    const { data: live, error: liveError } = await db.from('maven_banks_live_cache').select('bank_id, payment_type, phone_number, account_name').eq('bank_id', rule.bank_id).maybeSingle()
    if (liveError) throw new Error(`threshold switch live cache ${rule.id}: ${liveError.message}`)
    if (!live || normalizePhone(live.phone_number) !== source) {
      const message = `Maven bank ${rule.bank_id} is not ${rule.source_wallet}; refusing to switch.`
      await db.from('maven_wallet_threshold_switch_rules').update({ status: 'error', last_error: message, updated_at: checkedAt }).eq('id', rule.id)
      await db.from('audit_log').insert({ actor_type: 'system', actor_name: actorName, action: 'maven_wallet_threshold_switch_refused', entity: 'maven_wallet_threshold_switch_rules', entity_id: rule.id, after: { ...rule, amount_received: total, reason: message } })
      results.push({ id: rule.id, status: 'refused', error: message })
      continue
    }

    const { data: targetLive } = await db.from('maven_banks_live_cache').select('bank_id, phone_number').neq('bank_id', rule.bank_id).eq('phone_number', rule.target_wallet).maybeSingle()
    if (targetLive) {
      const message = `Target wallet ${rule.target_wallet} already belongs to Maven bank ${targetLive.bank_id}.`
      await db.from('maven_wallet_threshold_switch_rules').update({ status: 'error', last_error: message, updated_at: checkedAt }).eq('id', rule.id)
      await db.from('audit_log').insert({ actor_type: 'system', actor_name: actorName, action: 'maven_wallet_threshold_switch_refused', entity: 'maven_wallet_threshold_switch_rules', entity_id: rule.id, after: { ...rule, amount_received: total, reason: message } })
      results.push({ id: rule.id, status: 'refused', error: message })
      continue
    }

    const provider = await callMavenWalletSwitch({ bank_id: rule.bank_id, mode: 'edit', new_number: rule.target_wallet, confirm: true }, 45_000)
    const switched = provider.ok && provider.body.ok === true && normalizePhone(provider.body.changed_to) === target
    if (!switched) {
      const message = String(provider.body.error ?? 'Maven did not confirm the wallet switch.')
      await db.from('maven_wallet_threshold_switch_rules').update({ status: 'error', last_error: message, updated_at: checkedAt }).eq('id', rule.id)
      await db.from('audit_log').insert({ actor_type: 'system', actor_name: actorName, action: 'maven_wallet_threshold_switch_failed', entity: 'maven_wallet_threshold_switch_rules', entity_id: rule.id, after: { ...rule, amount_received: total, provider } })
      results.push({ id: rule.id, status: 'failed', error: message })
      continue
    }

    await db.from('maven_wallet_threshold_switch_rules').update({ active: false, status: 'switched', amount_received_since_check: total, last_checked_at: checkedAt, switched_at: checkedAt, last_error: null, updated_at: checkedAt }).eq('id', rule.id)
    await db.from('audit_log').insert({ actor_type: 'system', actor_name: actorName, action: 'maven_wallet_threshold_switch_succeeded', entity: 'maven_wallet_threshold_switch_rules', entity_id: rule.id, before: { source_wallet: rule.source_wallet, amount_threshold: rule.amount_threshold }, after: { target_wallet: rule.target_wallet, amount_received: total, observed_balance: observedBalance || null, provider } })
    results.push({ id: rule.id, status: 'switched', amount_received: total, observed_balance: observedBalance || null, changed_to: rule.target_wallet })
  }
  return { ok: true, results }
}
