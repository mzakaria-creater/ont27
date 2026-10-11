import { handle } from 'hono/vercel'
import { app } from '../server/app.js'

// Default function duration is too tight for the login path's two sequential
// upstream calls (edge-function fallback + direct DB lookup retry) on a slow
// day; raising the ceiling here means a real transient stall surfaces as a
// slightly slower login instead of a hard "can't connect" platform timeout.
export const config = { maxDuration: 30 }

const handler = handle(app)

export const GET = handler
export const POST = handler
export const PATCH = handler
export const PUT = handler
export const DELETE = handler
export const OPTIONS = handler
