import { Hono } from 'hono'
import { db } from './db.js'
import { requireAuth, requirePerm } from './rbac.js'
import type { AuthEnv } from './rbac.js'

export const financeOpsRoutes = new Hono<AuthEnv>()
financeOpsRoutes.use('*', requireAuth)

const isPaid = (status: unknown) => ['PAID', 'APPROVED'].includes(String(status ?? '').toUpperCase())
const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0
const validDate = (v: string | undefined) => v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null

financeOpsRoutes.get('/', requirePerm('revenue_center', 'can_view'), async (c) => {
  const today = new Date().toISOString().slice(0, 10)
  const from = validDate(c.req.query('from')) ?? `${today.slice(0, 8)}01`
  const to = validDate(c.req.query('to')) ?? today
  if (from > to) return c.json({ error: 'invalid_date_range' }, 400)

  try {
    const since = `${from}T00:00:00+03:00`
    const until = `${to}T23:59:59.999+03:00`

    const [dailyRes, payoutRes, accountsRes, limitsRes, movesRes, merchantsRes, debtsRes, rateRes] = await Promise.all([
      db.from('v_merchant_daily_cairo').select('merchant,day_cairo,paid_n,paid_amt,declined_n,declined_amt,other_n,other_amt,fees,commission,provider_commission').gte('day_cairo', from).lte('day_cairo', to).order('day_cairo', { ascending: false }).limit(5000),
      db.from('maven_payout_transactions').select('merchant,status,amount,commission,first_seen_at').gte('first_seen_at', since).lte('first_seen_at', until).limit(20000),
      db.from('payment_accounts').select('id,account_number,account_name,currency,device_name,label,is_active,current_balance,balance_updated_at').order('created_at', { ascending: false }).limit(1000),
      db.from('wallet_capacity_limits').select('payment_account_id,daily_limit,current_daily_used,updated_at').limit(1000),
      db.from('wallet_balance_movements').select('wallet_number,movement_type,amount,balance_before,balance_after,balance_source,occurred_at').gte('occurred_at', since).lte('occurred_at', until).order('occurred_at', { ascending: true }).limit(10000),
      db.from('merchants').select('id,name,code,status,is_active,active,email,phone,business_type,country,base_currency,kyc_status,blocked_amount,MID,logo_url').order('name').limit(1000),
      db.from('merchant_settlements').select('id,settlement_period,total_net_usdt,total_net_egp,already_settled_usdt,already_settled_egp,balance_due_usdt,balance_due_egp,settlement_date,status,sub_merchant_id').order('settlement_date', { ascending: false }).limit(1000),
      db.from('exchange_rates').select('currency_pair,rate,fetched_at').in('currency_pair', ['USD/EGP','USDT/EGP']).order('fetched_at', { ascending: false }).limit(20),
    ])

    for (const r of [dailyRes,payoutRes,accountsRes,limitsRes,movesRes,merchantsRes,debtsRes,rateRes]) {
      if (r.error) throw new Error(r.error.message)
    }

    const USD_EGP = 47.5
    const USDT_EGP = 54.45

    const payOutByMerchant = new Map<string, { count:number; amount:number; commission:number }>()
    for (const row of payoutRes.data ?? []) {
      if (!isPaid(row.status)) continue
      const key = row.merchant || 'Unassigned'
      const cur = payOutByMerchant.get(key) ?? { count:0, amount:0, commission:0 }
      cur.count += 1
      cur.amount += num(row.amount)
      cur.commission += num(row.commission)
      payOutByMerchant.set(key, cur)
    }

    const dailyByMerchant = new Map<string, { merchant:string; payInCount:number; payInAmount:number; payOutCount:number; payOutAmount:number; fees:number; commission:number; providerCommission:number }>()
    for (const row of dailyRes.data ?? []) {
      const key = row.merchant || 'Unassigned'
      const cur = dailyByMerchant.get(key) ?? { merchant:key,payInCount:0,payInAmount:0,payOutCount:0,payOutAmount:0,fees:0,commission:0,providerCommission:0 }
      cur.payInCount += num(row.paid_n)
      cur.payInAmount += num(row.paid_amt)
      cur.fees += num(row.fees)
      cur.commission += num(row.commission)
      cur.providerCommission += num(row.provider_commission)
      dailyByMerchant.set(key, cur)
    }
    for (const [key, po] of payOutByMerchant) {
      const cur = dailyByMerchant.get(key) ?? { merchant:key,payInCount:0,payInAmount:0,payOutCount:0,payOutAmount:0,fees:0,commission:0,providerCommission:0 }
      cur.payOutCount = po.count
      cur.payOutAmount = po.amount
      cur.commission += po.commission
      dailyByMerchant.set(key, cur)
    }

    const daily = [...dailyByMerchant.values()].map((r) => {
      const gross = r.payInAmount + r.payOutAmount
      const totalCommission = r.fees + r.commission
      const net = gross - totalCommission
      return { ...r, gross, totalCommission, commissionRate: gross > 0 ? totalCommission / gross * 100 : 0, net, usdtEquivalent: net / USDT_EGP, usdEquivalent: net / USD_EGP }
    }).sort((a,b) => b.gross - a.gross)

    const limits = new Map((limitsRes.data ?? []).map((r) => [String(r.payment_account_id), r]))
    const movementMap = new Map<string, { incoming:number; outgoing:number; opening:number|null; closing:number|null; lastAt:string|null }>()
    for (const m of movesRes.data ?? []) {
      const key = String(m.wallet_number ?? '')
      if (!key) continue
      const cur = movementMap.get(key) ?? { incoming:0,outgoing:0,opening:null,closing:null,lastAt:null }
      const kind = String(m.movement_type ?? '').toLowerCase()
      if (['in','incoming','credit','deposit','received'].some((x) => kind.includes(x))) cur.incoming += num(m.amount)
      else if (['out','outgoing','debit','payout','sent','withdraw'].some((x) => kind.includes(x))) cur.outgoing += num(m.amount)
      if (cur.opening == null) cur.opening = m.balance_before == null ? null : num(m.balance_before)
      if (m.balance_after != null) cur.closing = num(m.balance_after)
      cur.lastAt = m.occurred_at ?? cur.lastAt
      movementMap.set(key, cur)
    }

    const wallets = (accountsRes.data ?? []).map((a) => {
      const flow = movementMap.get(String(a.account_number ?? '')) ?? { incoming:0,outgoing:0,opening:null,closing:null,lastAt:null }
      const cap = limits.get(String(a.id))
      return {
        id:a.id, walletNumber:a.account_number, accountName:a.account_name, label:a.label, operator:a.device_name || a.account_name || null,
        status:a.is_active ? 'OPEN' : 'CLOSED', currency:a.currency || 'EGP', dailyLimit:cap ? num(cap.daily_limit) : null,
        dailyUsed:cap ? num(cap.current_daily_used) : null, monthlyLimit:null,
        openingBalance:flow.opening, incoming:flow.incoming, outgoing:flow.outgoing,
        currentBalance:a.current_balance == null ? flow.closing : num(a.current_balance), balanceUpdatedAt:a.balance_updated_at || flow.lastAt,
      }
    })

    const merchants = (merchantsRes.data ?? []).map((m) => ({
      id:m.id,name:m.name,code:m.code,status:m.status,isActive:Boolean(m.is_active ?? m.active),email:m.email,phone:m.phone,
      businessType:m.business_type,country:m.country,baseCurrency:m.base_currency,kycStatus:m.kyc_status,blockedAmount:num(m.blocked_amount),mid:m.MID,logoUrl:m.logo_url,
    }))

    const debts = (debtsRes.data ?? []).filter((r) => num(r.balance_due_egp) !== 0 || num(r.balance_due_usdt) !== 0).map((r) => ({
      id:r.id,settlementPeriod:r.settlement_period,balanceDueEgp:num(r.balance_due_egp),balanceDueUsdt:num(r.balance_due_usdt),
      totalNetEgp:num(r.total_net_egp),totalNetUsdt:num(r.total_net_usdt),alreadySettledEgp:num(r.already_settled_egp),alreadySettledUsdt:num(r.already_settled_usdt),status:r.status,settlementDate:r.settlement_date,subMerchantId:r.sub_merchant_id,
    }))

    const monthlyMap = new Map<string, { month:string; payInCount:number; payInAmount:number; fees:number; commission:number }>()
    for (const row of dailyRes.data ?? []) {
      const month = String(row.day_cairo).slice(0,7)
      const cur = monthlyMap.get(month) ?? { month,payInCount:0,payInAmount:0,fees:0,commission:0 }
      cur.payInCount += num(row.paid_n); cur.payInAmount += num(row.paid_amt); cur.fees += num(row.fees); cur.commission += num(row.commission)
      monthlyMap.set(month, cur)
    }

    const latestRates = rateRes.data ?? []
    return c.json({
      generatedAt:new Date().toISOString(), range:{from,to},
      settings:{ usdEgp:USD_EGP, usdtEgp:USDT_EGP, usdtSource:'EZInvest settlement', usdtAsOf:'2026-07-18', liveRates:latestRates },
      daily, wallets, merchants, commissions:daily.map((r)=>({merchant:r.merchant,gross:r.gross,fees:r.fees,commission:r.commission,providerCommission:r.providerCommission,totalCommission:r.totalCommission,commissionRate:r.commissionRate,usdt:r.totalCommission/USDT_EGP,usd:r.totalCommission/USD_EGP})),
      debts, monthly:[...monthlyMap.values()].sort((a,b)=>b.month.localeCompare(a.month)),
    })
  } catch (e) {
    return c.json({ error:'finance_ops_failed', detail:e instanceof Error ? e.message : 'query_failed' }, 500)
  }
})
