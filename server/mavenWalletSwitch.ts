const MAVEN_WALLET_SWITCH_URL = `${process.env.SUPABASE_URL ?? 'https://iwhjmhazcvctvipoasct.supabase.co'}/functions/v1/maven-wallet-switch`

export async function callMavenWalletSwitch(body: Record<string, unknown>, timeoutMs = 20_000): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  if (!serviceKey) return { ok: false, status: 0, body: { error: 'maven_switch_not_configured' } }
  try {
    const res = await fetch(MAVEN_WALLET_SWITCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await res.json().catch(() => ({})) as Record<string, unknown>
    return { ok: res.ok, status: res.status, body: json }
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message } }
  }
}
