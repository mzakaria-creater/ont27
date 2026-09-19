const DUPLICATE_WINDOW_MS = 5 * 60_000

export interface DuplicateCandidateRow {
  tx_id: number
  sender_number: string | null
  amount: number | null
  first_seen_at: string | null
  hasSms: boolean
}

// Groups rows sharing the same sender+amount into time-proximity clusters
// (a chain of gaps each <= windowMs — not full pairwise distance, but a
// good-enough approximation for "submitted close together in a burst").
function clusterBySenderAmount<T extends { sender_number: string | null; amount: number | null; first_seen_at: string | null }>(
  rows: T[],
): T[][] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const sender = row.sender_number?.trim()
    if (!sender || row.amount == null || !row.first_seen_at) continue
    const key = `${sender}|${row.amount}`
    const list = groups.get(key)
    if (list) list.push(row); else groups.set(key, [row])
  }
  const clusters: T[][] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => Date.parse(a.first_seen_at!) - Date.parse(b.first_seen_at!))
    let start = 0
    for (let i = 1; i <= sorted.length; i++) {
      const broken = i === sorted.length || Date.parse(sorted[i].first_seen_at!) - Date.parse(sorted[i - 1].first_seen_at!) > DUPLICATE_WINDOW_MS
      if (!broken) continue
      const cluster = sorted.slice(start, i)
      if (cluster.length >= 2) clusters.push(cluster)
      start = i
    }
  }
  return clusters
}

// For the SMS-candidate picker: candidates there already exclude anything
// with SMS evidence (that's the point of the list), so the useful warning is
// simply "two or more of these candidates are the same client/amount within
// 5 minutes — pick carefully", without the hasSms gate below.
export function flagAmbiguousCandidates<T extends { tx_id: number; sender_number: string | null; amount: number | null; first_seen_at: string | null }>(
  rows: T[],
): Set<number> {
  const flagged = new Set<number>()
  for (const cluster of clusterBySenderAmount(rows)) for (const row of cluster) flagged.add(row.tx_id)
  return flagged
}

// A transaction is flagged "duplicate" when another transaction from the
// same sender, for the same amount, was created within 5 minutes of it, and
// across that whole cluster only ONE of them has real SMS evidence that
// money actually arrived — the "client submitted the same payment claim
// twice" case. Both/all transactions in the cluster get flagged, not just
// the unconfirmed one, so an operator sees the pair together and can tell
// which one is the real payment.
export function detectDuplicateTransactions(rows: DuplicateCandidateRow[]): Set<number> {
  const flagged = new Set<number>()
  for (const cluster of clusterBySenderAmount(rows)) {
    const smsTotal = cluster.reduce((sum, row) => sum + (row.hasSms ? 1 : 0), 0)
    if (smsTotal === 1) for (const row of cluster) flagged.add(row.tx_id)
  }
  return flagged
}
