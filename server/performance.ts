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

    const { data, error } = await db.rpc('panel_performance_slice', {
      p_dimension: dimension,
      p_gateway: gateway,
      p_days: days,
      p_bucket: bucket,
    })
    if (error) return c.json({ error: 'db_error', detail: error.message }, 500)

    return c.json({
      ...(data as Record<string, unknown>),
      dimensions: DIMENSIONS,
      gateways: GATEWAYS,
      generatedAt: new Date().toISOString(),
    })
  },
)
