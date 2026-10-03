// Maven wallet switch v3. All calls require the project's server-only service
// key. Authentication is enforced here so it also works with Supabase's newer
// opaque secret keys, which the platform's legacy JWT verifier cannot parse.
// Bulk modes share one Maven login and run a small bounded request pool so a
// multi-wallet replacement does not pay the login cost for every row.
const BASE = 'https://bo.maven-consulting.co/Supplier'
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Bank = Record<string, string>
type SwitchResult = { bank_id: string; ok: boolean; error?: string; current?: Bank; changed_from?: string; changed_to?: string; post_status?: number }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type': 'application/json' } })
}

function validServiceKey(request: Request): boolean {
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!expected || supplied.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index)
  return difference === 0
}

function packedCookies(value: string | null): string {
  if (!value) return ''
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/g).flatMap((cookie) => cookie.split('\n'))
    .map((cookie) => cookie.split(';')[0].trim()).filter(Boolean).join('; ')
}

function field(html: string, name: string): string {
  const match = html.match(new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i'))
    || html.match(new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'))
  return match?.[1] ?? ''
}

async function login(username: string, password: string): Promise<string> {
  const page = await fetch(`${BASE}/Login`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(12_000) })
  if (!page.ok) throw new Error(`maven_login_page_${page.status}`)
  const html = await page.text()
  const initialCookies = packedCookies(page.headers.get('set-cookie'))
  const csrf = html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)?.[1] ?? ''
  const form = new URLSearchParams({ Username: username, Password: password })
  if (csrf) form.set('__RequestVerificationToken', csrf)
  const response = await fetch(`${BASE}/Login/PostV2`, {
    method: 'POST',
    headers: { cookie: initialCookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://bo.maven-consulting.co', referer: `${BASE}/Login` },
    body: form,
    redirect: 'manual',
    signal: AbortSignal.timeout(12_000),
  })
  if (response.status >= 400) throw new Error(`maven_login_${response.status}`)
  return [initialCookies, packedCookies(response.headers.get('set-cookie'))].filter(Boolean).join('; ')
}

async function readBank(cookies: string, bankId: string): Promise<Bank> {
  const response = await fetch(`${BASE}/P2PBanks/Details/${encodeURIComponent(bankId)}`, {
    headers: { cookie: cookies, accept: 'text/html' }, signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error(`maven_read_${response.status}`)
  const html = await response.text()
  const current = {
    id: field(html, 'id') || bankId,
    PaymentType: field(html, 'PaymentType'),
    p2ppaymenttypeID: field(html, 'p2ppaymenttypeID'),
    PhoneNumber: field(html, 'PhoneNumber'),
    AccountName: field(html, 'AccountName'),
    AccountNumber: field(html, 'AccountNumber'),
    BankName: field(html, 'BankName'),
    Motif: field(html, 'Motif'),
    URL: field(html, 'URL'),
    AgentId: field(html, 'AgentId') || '27',
  }
  if (!current.PhoneNumber || !current.p2ppaymenttypeID) throw new Error('maven_bank_not_found')
  return current
}

async function postBank(cookies: string, refererId: string, fields: Bank): Promise<number> {
  const response = await fetch(`${BASE}/P2PBanks/Post`, {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://bo.maven-consulting.co', referer: `${BASE}/P2PBanks/Details/${refererId}` },
    body: new URLSearchParams(fields),
    redirect: 'manual',
    signal: AbortSignal.timeout(12_000),
  })
  return response.status
}

async function editBank(cookies: string, bankId: string, newNumber: string): Promise<SwitchResult> {
  try {
    const current = await readBank(cookies, bankId)
    const status = await postBank(cookies, bankId, {
      id: current.id, p2ppaymenttypeID: current.p2ppaymenttypeID, PaymentType: current.PaymentType,
      PhoneNumber: newNumber, AccountName: current.AccountName, AccountNumber: newNumber,
      BankName: current.BankName, Motif: current.Motif, URL: current.URL, AgentId: current.AgentId, IsActive: 'true',
    })
    const after = await readBank(cookies, bankId)
    return { bank_id: bankId, ok: status < 400 && after.PhoneNumber === newNumber, changed_from: current.PhoneNumber, changed_to: after.PhoneNumber, post_status: status }
  } catch (error) {
    return { bank_id: bankId, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index])
    }
  }))
  return results
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
  if (!validServiceKey(request)) return json({ ok: false, error: 'unauthorized' }, 401)

  let body: { bank_id?: string; bank_ids?: string[]; new_number?: string; new_name?: string; mode?: string; confirm?: boolean } = {}
  try { body = await request.json() } catch { return json({ ok: false, error: 'invalid_json' }, 400) }
  const mode = body.mode ?? 'read'
  const bankIds = [...new Set((body.bank_ids ?? (body.bank_id ? [body.bank_id] : [])).map(String).map((id) => id.trim()).filter(Boolean))].slice(0, 150)
  if (!bankIds.length) return json({ ok: false, error: 'bank_id required' }, 400)
  if ((mode === 'edit' || mode === 'bulk_edit' || mode === 'add_new') && !/^\d{8,20}$/.test(body.new_number ?? '')) {
    return json({ ok: false, error: 'new_number required' }, 400)
  }
  if ((mode === 'edit' || mode === 'bulk_edit' || mode === 'add_new') && body.confirm !== true) {
    return json({ ok: false, error: 'confirmation_required' }, 400)
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` }
    const configValue = async (name: string) => {
      const response = await fetch(`${supabaseUrl}/rest/v1/maven_runtime_config?select=value&name=eq.${name}&owner_name=eq.global&limit=1`, { headers, signal: AbortSignal.timeout(8_000) })
      if (!response.ok) throw new Error(`config_${name}_${response.status}`)
      return String((await response.json())?.[0]?.value ?? '')
    }
    // These two independent reads used to run serially on every invocation.
    const [username, password] = await Promise.all([configValue('MAVEN_COLLECTOR_USERNAME'), configValue('MAVEN_COLLECTOR_PASSWORD')])
    if (!username || !password) throw new Error('maven_credentials_missing')
    const cookies = await login(username, password)

    if (mode === 'read') return json({ ok: true, bank_id: bankIds[0], current: await readBank(cookies, bankIds[0]) })
    if (mode === 'bulk_read') {
      const results = await mapConcurrent(bankIds, 6, async (bankId): Promise<SwitchResult> => {
        try { return { bank_id: bankId, ok: true, current: await readBank(cookies, bankId) } }
        catch (error) { return { bank_id: bankId, ok: false, error: error instanceof Error ? error.message : String(error) } }
      })
      return json({ ok: true, results })
    }
    if (mode === 'edit') {
      const result = await editBank(cookies, bankIds[0], body.new_number!)
      return json({ ...result, mode })
    }
    if (mode === 'bulk_edit') {
      const results = await mapConcurrent(bankIds, 4, (bankId) => editBank(cookies, bankId, body.new_number!))
      return json({ ok: true, results })
    }
    if (mode === 'add_new') {
      const bankId = bankIds[0]
      const current = await readBank(cookies, bankId)
      const newName = body.new_name?.trim() || current.AccountName
      const addStatus = await postBank(cookies, bankId, {
        id: '0', p2ppaymenttypeID: current.p2ppaymenttypeID, PaymentType: current.PaymentType,
        PhoneNumber: body.new_number!, AccountName: newName, AccountNumber: body.new_number!,
        BankName: current.BankName, Motif: current.Motif, URL: current.URL, AgentId: current.AgentId, IsActive: 'true',
      })
      const disableStatus = await postBank(cookies, bankId, { ...current, IsActive: 'false' })
      return json({ ok: addStatus < 400 && disableStatus < 400, mode, added_number: body.new_number, disabled_old_id: current.id, old_number: current.PhoneNumber, add_status: addStatus, disable_status: disableStatus })
    }
    return json({ ok: false, error: 'unknown_mode' }, 400)
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502)
  }
})
