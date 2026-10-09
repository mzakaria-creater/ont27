// Every other edge function in this project is called server-to-server
// (panel backend → Supabase, with a service-role bearer token), so none of
// them need CORS. payment-api is the first one a browser calls directly —
// the public checkout/payout pages, same as the unauthenticated /api/pay/*
// routes they're replacing — so every response needs these headers, and
// OPTIONS preflights must be answered before any route logic runs.
export const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, idempotency-key, x-client-info, apikey',
}

export function withCors(res: Response): Response {
  for (const [key, value] of Object.entries(corsHeaders)) res.headers.set(key, value)
  return res
}

export function handlePreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response(null, { status: 204, headers: corsHeaders })
}
