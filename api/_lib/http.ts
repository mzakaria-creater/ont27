import type { VercelRequest, VercelResponse } from '@vercel/node'

export function sendJson(res: VercelResponse, status: number, body: unknown): void {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.send(JSON.stringify(body))
}

export function methodGuard(
  req: VercelRequest,
  res: VercelResponse,
  method: 'GET' | 'POST',
): boolean {
  if (req.method !== method) {
    res.setHeader('Allow', method)
    sendJson(res, 405, { error: 'method_not_allowed' })
    return false
  }
  return true
}

/** Neutral, security-preserving error for any bad credential path. */
export const INVALID_CREDENTIALS = { error: 'invalid_credentials' as const }

export function readJsonBody(req: VercelRequest): Record<string, unknown> {
  const b = req.body
  if (b == null) return {}
  if (typeof b === 'string') {
    try {
      return JSON.parse(b) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  if (typeof b === 'object') return b as Record<string, unknown>
  return {}
}
