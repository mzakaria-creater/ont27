import { Hono } from 'hono'
import { db } from './db.js'
import { requireAnyPerm, requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// AI Gateway (All Transactions page): an operator describes a transaction
// or error pattern in free text and gets back likely causes + next steps,
// grounded in this panel's actual mechanics — not a generic chatbot. Same
// server-side-only API key pattern as server/proofExtract.ts: the key
// never reaches the browser.

export const transactionsAiRoutes = new Hono<AuthEnv>()
transactionsAiRoutes.use('*', requireAuth)
transactionsAiRoutes.use('*', requireAnyPerm(['transactions', 'all_transactions'], 'can_view'))

const SYSTEM_PROMPT = `You are a troubleshooting assistant embedded in OnTarget's payment operations panel, on the All Transactions page. An operator describes a transaction symptom or error pattern in free text (Arabic or English, often mixed); you answer with the most likely causes and concrete next steps, grounded in how this platform actually works:

- Deposits and payouts mirror a payment provider (Maven) into two tables, shown merged on this page. Status values: PENDING, PAID/APPROVED, DECLINED, EXPIRED, UNDERPAID.
- Deposits are matched against inbound SMS messages by amount/wallet/sender; a confirmed match can auto-approve the deposit ("Auto-approved — rules matched SMS #N, linked it, and approved the transaction").
- Automation rules, scoped by merchant/amount range/provider/time window, can auto-approve or auto-decline a deposit; a rule match is logged as a rule reference and shown on the row as "Auto-approve/decline rule · scope · amount range · priority".
- An entry attributed to "Maven team" / "Provider status correction" means Maven's own side changed the status independently of this panel — not an action taken here, and not something the panel's own worker can re-decide.
- Known automation-worker failure patterns: sender phone blacklisted (auto-decline, amount-independent), the provider's GetTransactionDetails API returning HTTP 500 (Maven flaking, usually transient — retry later), "refusing reversal" when the live provider status no longer matches what the worker expected (the worker will not reverse a provider-side PAID/DECLINED to avoid double-processing), duplicate transactions from the same sender.
- An operator can: search/filter this table by status, type, date range, merchant, method, amount; open the Live SMS rail (bottom-right button, or docked beside this table on wide screens) to search for or link a matching message; open a row's detail view for its "Complete action history" timeline (every decision, edit request, provider sync, and automation event for that transaction, in order); check the Automation page for rule conflicts or disabled rules; escalate to Maven support if the provider side is confirmed to be the blocker.

Reply in the same language the operator wrote in. Structure the answer as: likely cause(s) (ranked, most probable first), then concrete next step(s) to take in this panel. Be concise — this is read by someone mid-shift, not a report. If the description is too vague to diagnose, say what additional detail (a transaction ID, a status, a time window) would narrow it down, rather than guessing.`

transactionsAiRoutes.post('/diagnose', async (c) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return c.json({ error: 'ai_not_configured' }, 501)

  const body = await c.req.json().catch(() => null)
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 2000) : ''
  if (!description) return c.json({ error: 'description_required' }, 400)

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 900,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: description }],
      }),
    })
    const aiBody = await aiRes.json().catch(() => null) as { content?: Array<{ text?: string }>; error?: { message?: string } } | null
    if (!aiRes.ok) return c.json({ error: 'ai_request_failed', detail: aiBody?.error?.message ?? `HTTP ${aiRes.status}` }, 502)
    const answer = (aiBody?.content ?? []).map((block) => block.text ?? '').join('').trim()
    if (!answer) return c.json({ error: 'ai_empty_response' }, 502)

    const actor = c.get('actor')
    await db.from('audit_log').insert({
      actor_type: 'manual_panel', actor_id: actor.sub, actor_name: actor.username,
      action: 'transactions.ai_diagnose', entity: 'ai_gateway', entity_id: String(Date.now()),
      after: { description, answer },
    }).then(({ error }) => { if (error) console.error('ai_gateway audit insert failed:', error.message) })

    return c.json({ answer })
  } catch (error) {
    return c.json({ error: 'ai_request_failed', detail: error instanceof Error ? error.message : 'unknown' }, 500)
  }
})
