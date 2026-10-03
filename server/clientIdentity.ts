import { db } from './db.js'
import { oldDb } from './oldDb.js'

const phoneKey = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10)
const cleanName = (value: unknown) => {
  const name = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (name.length < 4 || name.length > 60 || /[\r\n]/.test(name) || /sms_sub_id|رصيد/i.test(name)) return null
  return name
}

// Appends the wallet a deposit was approved into onto the client's known
// wallet history (crm_clients.wallets_used) — same append-dedup shape as
// sms_names above, written to both this project's mirror and the old
// project's authoritative crm_clients (the live automation engine's
// use_crm_matching reads the old one). This builds the data an operator
// or a future rule can use to recognize "this client always deposits into
// wallet X" — it does not itself change what use_crm_matching evaluates,
// since that matching logic lives in the old project's own engine, not
// this codebase.
export async function recordClientWalletUsage(txId: number): Promise<void> {
  const { data: tx } = await db.from('maven_transactions').select('tx_id, sender_number, to_account_number, receiving_wallet').eq('tx_id', txId).maybeSingle()
  const key = phoneKey(tx?.sender_number)
  const wallet = String(tx?.to_account_number ?? tx?.receiving_wallet ?? '').trim()
  if (!key || !wallet) return

  const variants = [key, `0${key}`, `20${key}`]
  const old = oldDb()
  for (const database of old ? [db, old] : [db]) {
    const { data: clients } = await database.from('crm_clients').select('id, wallets_used').in('normalized_phone', variants)
    for (const client of clients ?? []) {
      const known = client.wallets_used ?? []
      if (known.includes(wallet)) continue
      await database.from('crm_clients').update({ wallets_used: [...known, wallet], updated_at: new Date().toISOString() }).eq('id', client.id)
    }
  }
}

// Learn a bank-provided SMS name only after a human/verified approval tied
// the SMS to a client number. The SMS itself may omit the sender number; the
// transaction number remains the CRM identity. Ambiguous names are rejected.
export async function learnTrustedSmsName(txId: number, smsId?: number): Promise<{ learned: boolean; reason: string }> {
  const { data: tx } = await db.from('maven_transactions').select('tx_id, sender_number').eq('tx_id', txId).maybeSingle()
  const key = phoneKey(tx?.sender_number)
  if (!key) return { learned: false, reason: 'transaction_has_no_client_number' }

  let smsQuery = db.from('inbound_sms').select('id, sender_name, sender_number')
  smsQuery = smsId ? smsQuery.eq('id', smsId) : smsQuery.eq('consumed_by_tx_id', txId)
  const { data: sms } = await smsQuery.limit(1).maybeSingle()
  if (!sms) return { learned: false, reason: 'matched_sms_not_found' }
  if (phoneKey(sms.sender_number)) return { learned: false, reason: 'sms_already_has_sender_number' }
  const name = cleanName(sms.sender_name)
  if (!name) return { learned: false, reason: 'sms_name_not_safe' }

  const old = oldDb()
  if (!old) return { learned: false, reason: 'old_db_not_configured' }
  const [localVariants, sourceVariants, localSaved, sourceSaved] = await Promise.all([
    db.from('crm_client_names').select('normalized_phone').ilike('name_variant', name).limit(20),
    old.from('crm_client_names').select('normalized_phone').ilike('name_variant', name).limit(20),
    db.from('crm_clients').select('normalized_phone').contains('sms_names', [name]).limit(20),
    old.from('crm_clients').select('normalized_phone').contains('sms_names', [name]).limit(20),
  ])
  const ownerResults = [localVariants, sourceVariants, localSaved, sourceSaved]
  if (ownerResults.some((result) => result.error)) return { learned: false, reason: 'identity_uniqueness_check_failed' }
  const owners = ownerResults.flatMap((result) => result.data ?? [])
  if (owners.some((owner) => phoneKey(owner.normalized_phone) !== key)) {
    return { learned: false, reason: 'sms_name_is_shared' }
  }

  const variants = [key, `0${key}`, `20${key}`]
  const { data: clients } = await db
    .from('crm_clients')
    .select('id, sms_names')
    .in('normalized_phone', variants)
  for (const client of clients ?? []) {
    const names = [...new Set([...(client.sms_names ?? []), name])]
    await db.from('crm_clients').update({ sms_names: names, updated_at: new Date().toISOString() }).eq('id', client.id)
  }

  // The live automation engine runs on the old project. Its existing RPC
  // stores the same trusted name against the transaction's CRM client.
  const { error } = await old.rpc('crm_learn_sms_name', { p_tx_id: txId, p_sms_id: Number(sms.id) })
  if (error) return { learned: false, reason: `old_rpc_failed: ${error.message}` }
  return { learned: true, reason: 'saved_for_retention_matching' }
}
