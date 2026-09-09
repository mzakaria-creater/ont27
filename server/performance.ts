import { Hono } from 'hono'
import { db } from './db.js'
import { requireAnyPerm, requireAuth } from './rbac.js'
import type { AuthEnv } from './rbac.js'

// PSP and merchant performance metrics.
//
// The aggregation runs inside Postgres (panel_performance_slice) rather than
// here: there are 17k transactions and PostgREST pages at 1,000 rows, so doing
// it in this process would be both slower and quietly truncated — the report
// would look complete while missing everything past the first page.
//
// Everything this returns is computed from rows we hold. There is no forecast
// and no model. The one forward-looking number is `z`, a deviation score: how
// far a group's approval rate has moved from its own previous-window rate,
// measured in standard errors of that baseline at the current sample size.
// That distinguishes a real shift from small-sample noise, which a plain
// percentage-point delta cannot do — but it describes what already happened,
// so the payload never labels it a prediction.

export const performanceRoutes = new Hono<AuthEnv>()
performanceRoutes.use('*', requireAuth)

const DIMENSIONS = ['payment_method', 'merchant', 'sub_merchant', 'master_merchant', 'wallet', 'gateway'] as const
type Dimension = (typeof DIMENSIONS)[number]

// NGPay is live money; RSC and AVADAPAY are PayFuture test data. They are
// selectable separately and never merged by default, so a test row can never
// quietly move a live approval rate.
const GATEWAYS = ['NagupayP2P', 'RSC', 'AVADAPAY', 'ALL'] as const

const CAIRO_TIME_ZONE = 'Africa/Cairo'
function cairoOffset(date: string): string {
  const guess = new Date(`${date}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CAIRO_TIME_ZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(guess)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute))
  const offsetMinutes = Math.round((asUtc - guess.getTime()) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
}
function cairoBoundary(date: string, end = false): string {
  return `${date}T${end ? '23:59:59.999' : '00:00:00'}${cairoOffset(date)}`
}

performanceRoutes.get(
  '/',
  requireAnyPerm(['reports', 'analytics', 'dashboard', 'transactions', 'merchants'], 'can_view'),
  async (c) => {
    const rawDim = (c.req.query('dimension') ?? '').trim()
    const dimension: Dimension = (DIMENSIONS as readonly string[]).includes(rawDim)
      ? (rawDim as Dimension)
      : 'payment_method'

    const rawGw = (c.req.query('gateway') ?? '').trim()
    const gateway = (GATEWAYS as readonly string[]).includes(rawGw) ? rawGw : 'NagupayP2P'

    // Clamped here as well as in SQL. The function is the last line of defence,
    // but a rejected value should not travel that far to be ignored.
    const days = Math.min(Math.max(Number(c.req.query('days')) || 7, 0.5), 90)
    const bucket = c.req.query('bucket') === 'hour' ? 'hour' : 'day'
    const from = (c.req.query('from') ?? '').trim() || null
    const to = (c.req.query('to') ?? '').trim() || null
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    if ((from && !datePattern.test(from)) || (to && !datePattern.test(to)) || (from && to && from > to)) {
      return c.json({ error: 'invalid_date_range' }, 400)
    }

    const rpcName = from || to ? 'panel_performance_slice_range' : 'panel_performance_slice'
    const rpcParams = {
      p_dimension: dimension,
      p_gateway: gateway,
      p_days: days,
      p_bucket: bucket,
      ...(rpcName === 'panel_performance_slice_range' ? {
        p_from: from ? cairoBoundary(from) : null,
        p_to: to ? cairoBoundary(to, true) : null,
      } : {}),
    }
    const { data, error } = await db.rpc(rpcName, rpcParams)
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)

    return c.json({
      ...(data as Record<string, unknown>),
      dimensions: DIMENSIONS,
      gateways: GATEWAYS,
      generatedAt: new Date().toISOString(),
    })
  },
)
