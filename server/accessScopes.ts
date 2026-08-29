import { db } from './db.js'
import type { AccessClaims } from './tokens.js'

export type ScopeLevel='view'|'edit'|'approve'
type ScopeRow={scope_type:string;scope_value:string;access_level:ScopeLevel}
const rank:Record<ScopeLevel,number>={view:1,edit:2,approve:3}

export async function actorScopes(actor:AccessClaims,level:ScopeLevel='view'){
  const {data,error}=await db.from('user_access_scopes').select('scope_type,scope_value,access_level').eq('user_id',actor.sub)
  if(error)throw new Error(error.message)
  return ((data??[]) as ScopeRow[]).filter((row)=>rank[row.access_level]>=rank[level])
}

// Scope rows are opt-in restrictions: no rows preserves the role's full data
// set; once any rows exist, each configured dimension is enforced as an AND.
export async function applyDepositScopes(query:any,actor:AccessClaims,level:ScopeLevel='view'){
  const rows=await actorScopes(actor,level)
  const values=(type:string)=>rows.filter((r)=>r.scope_type===type).map((r)=>r.scope_value)
  const countries=values('country'),methods=values('payment_method'),merchants=values('merchant'),types=values('deposit_type')
  if(countries.length)query=query.in('country',countries)
  if(methods.length)query=query.in('payment_method',methods)
  if(merchants.length)query=query.in('merchant',merchants)
  if(types.length)query=query.in('request_type',types)
  return query
}

export async function applyPayoutScopes(query:any,actor:AccessClaims,level:ScopeLevel='view'){
  const rows=await actorScopes(actor,level)
  const values=(type:string)=>rows.filter((r)=>r.scope_type===type).map((r)=>r.scope_value)
  const methods=values('payment_method'),merchants=values('merchant')
  if(methods.length)query=query.in('pay_by',methods)
  if(merchants.length)query=query.in('merchant',merchants)
  return query
}

export async function rowAllowed(actor:AccessClaims,row:Record<string,unknown>,level:ScopeLevel){
  const {data,error}=await db.from('user_access_scopes').select('scope_type,scope_value,access_level').eq('user_id',actor.sub)
  if(error)throw new Error(error.message)
  const configured=(data??[]) as ScopeRow[]
  if(!configured.length)return true
  const rows=configured.filter((scope)=>rank[scope.access_level]>=rank[level])
  // A user scoped as view-only must not gain unrestricted edit/approve simply
  // because no rows qualify at the higher level.
  if(!rows.length)return false
  const checks:[string,unknown][]=[['country',row.country],['payment_method',row.payment_method??row.pay_by],['merchant',row.merchant],['deposit_type',row.request_type]]
  for(const [type,value] of checks){
    const assigned=rows.filter((r)=>r.scope_type===type)
    if(assigned.length&&!assigned.some((r)=>r.scope_value.toLowerCase()===String(value??'').toLowerCase()))return false
  }
  return true
}
