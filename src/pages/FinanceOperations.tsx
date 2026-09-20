import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Building2, CalendarDays, Coins, Landmark, RefreshCw, Settings, WalletCards } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

type Tab = 'settings'|'daily'|'wallets'|'merchants'|'commissions'|'debts'|'monthly'
type DailyRow = { merchant:string;payInCount:number;payInAmount:number;payOutCount:number;payOutAmount:number;gross:number;fees:number;commission:number;providerCommission:number;totalCommission:number;commissionRate:number;net:number;usdtEquivalent:number;usdEquivalent:number }
type WalletRow = { id:string;walletNumber:string|null;accountName:string|null;label:string|null;operator:string|null;status:'OPEN'|'CLOSED';currency:string;dailyLimit:number|null;dailyUsed:number|null;monthlyLimit:number|null;openingBalance:number|null;incoming:number;outgoing:number;currentBalance:number|null;balanceUpdatedAt:string|null }
type MerchantRow = { id:string;name:string;code:string|null;status:string|null;isActive:boolean;email:string|null;phone:string|null;businessType:string|null;country:string|null;baseCurrency:string|null;kycStatus:string|null;blockedAmount:number;mid:string|null;logoUrl:string|null }
type CommissionRow = { merchant:string;gross:number;fees:number;commission:number;providerCommission:number;totalCommission:number;commissionRate:number;usdt:number;usd:number }
type DebtRow = { id:string;settlementPeriod:string|null;balanceDueEgp:number;balanceDueUsdt:number;totalNetEgp:number;totalNetUsdt:number;alreadySettledEgp:number;alreadySettledUsdt:number;status:string|null;settlementDate:string|null;subMerchantId:string|null }
type MonthlyRow = { month:string;payInCount:number;payInAmount:number;fees:number;commission:number }
type FinanceData = { generatedAt:string;range:{from:string;to:string};settings:{usdEgp:number;usdtEgp:number;usdtSource:string;usdtAsOf:string;liveRates:Array<{currency_pair:string;rate:number;fetched_at:string}>};daily:DailyRow[];wallets:WalletRow[];merchants:MerchantRow[];commissions:CommissionRow[];debts:DebtRow[];monthly:MonthlyRow[] }

const today=()=>new Date().toISOString().slice(0,10)
const monthStart=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`}
const tabs: Array<{key:Tab;ar:string;en:string;icon:typeof Settings}> = [
  {key:'settings',ar:'الإعدادات',en:'Settings',icon:Settings},
  {key:'daily',ar:'اليومية',en:'Daily',icon:CalendarDays},
  {key:'wallets',ar:'المحافظ',en:'Wallets',icon:WalletCards},
  {key:'merchants',ar:'التجار',en:'Merchants',icon:Building2},
  {key:'commissions',ar:'العمولات الداخلية',en:'Internal commissions',icon:Coins},
  {key:'debts',ar:'المديونيات',en:'Debts',icon:Landmark},
  {key:'monthly',ar:'الشهرية',en:'Monthly',icon:BarChart3},
]

export default function FinanceOperations(){
  const {t}=useLocale(); const [tab,setTab]=useState<Tab>('settings'); const [from,setFrom]=useState(monthStart); const [to,setTo]=useState(today)
  const [data,setData]=useState<FinanceData|null>(null); const [loading,setLoading]=useState(true); const [error,setError]=useState('')
  const load=useCallback(async()=>{setLoading(true);setError('');try{setData(await api<FinanceData>(`/api/finance-ops?${new URLSearchParams({from,to})}`))}catch(e){setError(e instanceof ApiError&&e.status===403?t('لا تملك صلاحية المركز المالي.','You do not have finance center access.'):t('تعذر تحميل بيانات العمليات المالية.','Unable to load finance operations data.'))}finally{setLoading(false)}},[from,to,t])
  useEffect(()=>{void load()},[load])
  const totals=useMemo(()=>data?.daily.reduce((a,r)=>({count:a.count+r.payInCount+r.payOutCount,gross:a.gross+r.gross,commission:a.commission+r.totalCommission,net:a.net+r.net}),{count:0,gross:0,commission:0,net:0})??{count:0,gross:0,commission:0,net:0},[data])
  return <>
    <header className="revenue-head"><div><span className="revenue-eyebrow">FINANCE OPERATIONS V2</span><h2>{t('الإدارة المالية والتشغيلية','Finance Operations')}</h2><p>{t('بيانات مباشرة من Supabase V2 للحركة اليومية والمحافظ والتجار والعمولات والمديونيات.','Live Supabase V2 data for daily activity, wallets, merchants, commissions and dues.')}</p></div><div className="revenue-head-status"><span className="pay-status-badge st-paid">{t('مباشر','Live')}</span><small>{data?new Date(data.generatedAt).toLocaleString():'—'}</small></div></header>
    <form className="revenue-filter-bar" onSubmit={(e)=>{e.preventDefault();void load()}}><label>{t('من','From')}<input className="login-input" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>{t('إلى','To')}<input className="login-input" type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><button className="btn-primary btn-sm" disabled={loading}><RefreshCw size={15}/>{loading?t('تحميل…','Loading…'):t('تحديث','Refresh')}</button></form>
    {error&&<div className="card warn" role="alert">{error}</div>}
    <section className="revenue-kpis"><Kpi label={t('عدد العمليات','Transactions')} value={totals.count.toLocaleString()} /><Kpi label={t('إجمالي الحركة','Gross flow')} value={money(totals.gross,'EGP')} /><Kpi label={t('العمولات','Commission')} value={money(totals.commission,'EGP')} /><Kpi label={t('الصافي','Net')} value={money(totals.net,'EGP')} /></section>
    <nav className="revenue-tabs">{tabs.map(({key,ar,en,icon:Icon})=><button type="button" key={key} className={tab===key?'active':''} onClick={()=>setTab(key)}><Icon size={16}/>{t(ar,en)}</button>)}</nav>
    {loading&&!data?<div className="card">{t('جارٍ تحميل البيانات…','Loading data…')}</div>:null}
    {data&&tab==='settings'?<SettingsView data={data}/>:null}
    {data&&tab==='daily'?<DailyView rows={data.daily}/>:null}
    {data&&tab==='wallets'?<WalletsView rows={data.wallets}/>:null}
    {data&&tab==='merchants'?<MerchantsView rows={data.merchants}/>:null}
    {data&&tab==='commissions'?<CommissionsView rows={data.commissions}/>:null}
    {data&&tab==='debts'?<DebtsView rows={data.debts}/>:null}
    {data&&tab==='monthly'?<MonthlyView rows={data.monthly} usd={data.settings.usdEgp} usdt={data.settings.usdtEgp}/>:null}
  </>
}

function Kpi({label,value}:{label:string;value:string}){return <article className="revenue-kpi"><span>{label}</span><strong>{value}</strong></article>}
function SettingsView({data}:{data:FinanceData}){const {t}=useLocale();return <div className="revenue-two-col"><section className="card"><h3>{t('سعر الدولار التقديري','Estimated USD rate')}</h3><strong className="revenue-rate">{data.settings.usdEgp.toFixed(2)} EGP</strong><p className="cell-sub">USD / EGP</p></section><section className="card"><h3>{t('سعر USDT','USDT rate')}</h3><strong className="revenue-rate">{data.settings.usdtEgp.toFixed(2)} EGP</strong><p className="cell-sub">{data.settings.usdtSource} · {data.settings.usdtAsOf}</p></section><section className="card recent-card" style={{gridColumn:'1/-1'}}><div className="recent-head"><h3>{t('أسعار مسجلة حديثاً في قاعدة البيانات','Recent database rates')}</h3></div><Table headers={[t('الزوج','Pair'),t('السعر','Rate'),t('وقت القراءة','Fetched at')]} rows={data.settings.liveRates.map(r=>[r.currency_pair,Number(r.rate).toFixed(4),new Date(r.fetched_at).toLocaleString()])}/></section></div>}
function DailyView({rows}:{rows:DailyRow[]}){const {t}=useLocale();return <section className="card recent-card"><div className="recent-head"><h3>{t('الحركة اليومية PayIn / PayOut','Daily PayIn / PayOut')}</h3></div><Table headers={[t('التاجر','Merchant'),'PayIn #','PayIn EGP','PayOut #','PayOut EGP',t('الإجمالي','Gross'),t('العمولة %','Commission %'),t('قيمة العمولة','Commission'),t('الصافي','Net'),'USDT','USD']} rows={rows.map(r=>[r.merchant,r.payInCount,money(r.payInAmount,'EGP'),r.payOutCount,money(r.payOutAmount,'EGP'),money(r.gross,'EGP'),`${r.commissionRate.toFixed(2)}%`,money(r.totalCommission,'EGP'),money(r.net,'EGP'),r.usdtEquivalent.toFixed(2),r.usdEquivalent.toFixed(2)])}/></section>}
function WalletsView({rows}:{rows:WalletRow[]}){const {t}=useLocale();return <section className="card recent-card"><div className="recent-head"><h3>{t('المحافظ والأرصدة','Wallets & balances')}</h3></div><Table headers={[t('المحفظة','Wallet'),t('الحالة','Status'),t('المشغل','Operator'),t('الحد اليومي','Daily limit'),t('المستخدم اليوم','Used today'),t('الحد الشهري','Monthly limit'),t('الرصيد الافتتاحي','Opening'),t('الوارد','Incoming'),t('الصادر','Outgoing'),t('الرصيد الحالي','Current balance')]} rows={rows.map(r=>[r.walletNumber??r.label??'—',r.status==='OPEN'?t('مفتوحة','Open'):t('مغلقة','Closed'),r.operator??'—',r.dailyLimit==null?'—':money(r.dailyLimit,r.currency),r.dailyUsed==null?'—':money(r.dailyUsed,r.currency),r.monthlyLimit==null?t('غير مسجل','Not recorded'):money(r.monthlyLimit,r.currency),r.openingBalance==null?'—':money(r.openingBalance,r.currency),money(r.incoming,r.currency),money(r.outgoing,r.currency),r.currentBalance==null?'—':money(r.currentBalance,r.currency)])}/></section>}
function MerchantsView({rows}:{rows:MerchantRow[]}){const {t}=useLocale();return <section className="card recent-card"><div className="recent-head"><h3>{t('التجار','Merchants')}</h3></div><Table headers={[t('التاجر','Merchant'),'MID',t('الحالة','Status'),t('النشاط','Active'),t('الدولة','Country'),t('العملة','Currency'),'KYC',t('مبلغ محجوز','Blocked amount')]} rows={rows.map(r=>[r.name,r.mid??r.code??'—',r.status??'—',r.isActive?t('نعم','Yes'):t('لا','No'),r.country??'—',r.baseCurrency??'—',r.kycStatus??'—',money(r.blockedAmount,r.baseCurrency??'EGP')])}/></section>}
function CommissionsView({rows}:{rows:CommissionRow[]}){const {t}=useLocale();return <section className="card recent-card"><div className="recent-head"><h3>{t('العمولات الداخلية','Internal commissions')}</h3></div><Table headers={[t('التاجر','Merchant'),t('الإجمالي','Gross'),t('رسوم','Fees'),t('عمولة','Commission'),t('عمولة مزود','Provider commission'),t('الإجمالي المحتسب','Total recorded'),'%','USDT','USD']} rows={rows.map(r=>[r.merchant,money(r.gross,'EGP'),money(r.fees,'EGP'),money(r.commission,'EGP'),money(r.providerCommission,'EGP'),money(r.totalCommission,'EGP'),`${r.commissionRate.toFixed(2)}%`,r.usdt.toFixed(2),r.usd.toFixed(2)])}/></section>}
function DebtsView({rows}:{rows:DebtRow[]}){const {t}=useLocale();return <section className="card recent-card"><div className="recent-head"><h3>{t('المديونيات ومستحقات التسوية','Settlement dues')}</h3></div><Table headers={[t('الفترة','Period'),t('مستحق EGP','Due EGP'),t('مستحق USDT','Due USDT'),t('صافي EGP','Net EGP'),t('صافي USDT','Net USDT'),t('تم سداده EGP','Settled EGP'),t('الحالة','Status'),t('تاريخ التسوية','Settlement date')]} rows={rows.map(r=>[r.settlementPeriod??'—',money(r.balanceDueEgp,'EGP'),`${r.balanceDueUsdt.toFixed(2)} USDT`,money(r.totalNetEgp,'EGP'),`${r.totalNetUsdt.toFixed(2)} USDT`,money(r.alreadySettledEgp,'EGP'),r.status??'—',r.settlementDate?new Date(r.settlementDate).toLocaleString():'—'])}/></section>}
function MonthlyView({rows,usd,usdt}:{rows:MonthlyRow[];usd:number;usdt:number}){const {t}=useLocale();return <section className="card recent-card"><div className="recent-head"><h3>{t('التجميع الشهري','Monthly aggregation')}</h3></div><Table headers={[t('الشهر','Month'),t('عدد PayIn','PayIn count'),t('إجمالي PayIn','PayIn volume'),t('الرسوم','Fees'),t('العمولات','Commission'),t('الإيراد المسجل','Recorded revenue'),'USDT','USD']} rows={rows.map(r=>{const rev=r.fees+r.commission;return [r.month,r.payInCount,money(r.payInAmount,'EGP'),money(r.fees,'EGP'),money(r.commission,'EGP'),money(rev,'EGP'),(rev/usdt).toFixed(2),(rev/usd).toFixed(2)]})}/></section>}
function Table({headers,rows}:{headers:string[];rows:Array<Array<string|number>>}){
  const isMobile=useIsMobile()
  if(isMobile){
    return <div className="risk-card-list">
      {rows.length?rows.map((r,i)=><div key={i} className="risk-row-card">
        <div className="risk-row-card-head"><strong>{r[0]}</strong></div>
        {r.slice(1).map((v,j)=><div key={j} className="cell-sub"><span className="muted">{headers[j+1]}: </span><span className="mono">{v}</span></div>)}
      </div>):<p className="maven-empty">—</p>}
    </div>
  }
  return <div className="table-wrap"><table className="data-table"><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.length?rows.map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j} className={j>0?'mono':''}>{v}</td>)}</tr>):<tr><td colSpan={headers.length}>—</td></tr>}</tbody></table></div>
}
