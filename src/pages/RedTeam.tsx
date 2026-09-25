import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, Search, ShieldAlert } from 'lucide-react'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'

type CheckStatus = 'protected' | 'review'
type Severity = 'critical' | 'high' | 'medium'
interface RedTeamCheck { id: string; area: string; threat: string; control: string; next: string; severity: Severity; status: CheckStatus }

const checks: RedTeamCheck[] = [
  { id: 'provider', area: 'Provider sync', threat: 'Local status differs from Maven / NGPay', control: 'Provider read-back and reconciliation', next: 'Review mismatch queue', severity: 'critical', status: 'protected' },
  { id: 'replay', area: 'SMS integrity', threat: 'The same SMS is reused for multiple transactions', control: 'Exact SMS identity, UTR and assignment audit', next: 'Keep duplicate in review', severity: 'high', status: 'protected' },
  { id: 'permissions', area: 'Access control', threat: 'Operator performs an action outside the assigned role', control: 'PageGate plus server-side role and permission checks', next: 'Inspect audit log', severity: 'critical', status: 'protected' },
  { id: 'stale', area: 'Queue safety', threat: 'Old pending payout is approved without current proof', control: 'Age and proof checks before execution', next: 'Escalate to human review', severity: 'high', status: 'review' },
  { id: 'blacklist', area: 'Risk controls', threat: 'Blacklisted customer passes automatic approval', control: 'Blacklist override is visible and decision is logged', next: 'Confirm exception reason', severity: 'high', status: 'protected' },
  { id: 'amount', area: 'Amount changes', threat: 'Local amount differs from provider amount', control: 'Maven update plus provider confirmation', next: 'Block settlement until confirmed', severity: 'critical', status: 'review' },
  { id: 'notifications', area: 'Operations', threat: 'A critical event is not delivered to the team', control: 'Telegram and in-app alert delivery monitoring', next: 'Check notification health', severity: 'medium', status: 'protected' },
]

export default function RedTeam() {
  const { t } = useLocale(); const isMobile = useIsMobile(); const [filter, setFilter] = useState<'all' | CheckStatus | 'critical'>('all'); const [query, setQuery] = useState(''); const [run, setRun] = useState(0)
  const visible = useMemo(() => checks.filter((row) => (filter === 'all' || row.status === filter || row.severity === filter) && `${row.area} ${row.threat} ${row.control}`.toLowerCase().includes(query.toLowerCase())), [filter, query])
  const reviewCount = checks.filter((row) => row.status === 'review').length; const criticalCount = checks.filter((row) => row.severity === 'critical').length
  return <>
    <section className="page-head redteam-head"><div><span className="redteam-eyebrow"><ShieldAlert size={14} /> {t('مراجعة دفاعية', 'Defensive review')}</span><h2>{t('Red Team — اختبار نقاط الضعف', 'Red Team — threat review')}</h2><p className="page-sub">{t('مراجعة آمنة للضوابط الحالية لاختبار أين قد تفشل المطابقة أو الصلاحيات أو التسوية.', 'A safe review of current controls to expose where matching, permissions, or settlement could fail.')}</p></div><button className="btn-ghost btn-sm" onClick={() => setRun((value) => value + 1)}><RefreshCw size={14} /> {t('إعادة الفحص', 'Run review')} {run > 0 && `· ${run}`}</button></section>
    <div className="card redteam-notice"><AlertTriangle size={18} /><div><strong>{t('وضع محاكاة للقراءة فقط', 'Read-only simulation')}</strong><p>{t('هذه الصفحة لا ترسل هجمات أو تغيّر حالة أي معاملة أو مزوّد؛ تعرض نقاط الفحص والضوابط التشغيلية فقط.', 'This page sends no attack traffic and changes no transaction or provider state; it only presents checks and controls.')}</p></div></div>
    <section className="redteam-kpis"><div className="risk-kpi good"><span className="risk-kpi-icon"><CheckCircle2 size={18} /></span><div><strong>{checks.length - reviewCount}</strong><span>{t('ضوابط محمية', 'Protected controls')}</span></div></div><div className="risk-kpi warn"><span className="risk-kpi-icon"><AlertTriangle size={18} /></span><div><strong>{reviewCount}</strong><span>{t('تحتاج مراجعة', 'Needs review')}</span></div></div><div className="risk-kpi danger"><span className="risk-kpi-icon"><ShieldAlert size={18} /></span><div><strong>{criticalCount}</strong><span>{t('حرجة', 'Critical')}</span></div></div><div className="risk-kpi blue"><span className="risk-kpi-icon"><Search size={18} /></span><div><strong>{visible.length}</strong><span>{t('نتيجة معروضة', 'Shown results')}</span></div></div></section>
    <section className="card redteam-card"><div className="redteam-toolbar"><div className="risk-tabs" role="tablist">{(['all', 'protected', 'review', 'critical'] as const).map((item) => <button key={item} type="button" className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'all' ? t('الكل', 'All') : item === 'protected' ? t('محمية', 'Protected') : item === 'review' ? t('مراجعة', 'Review') : t('حرجة', 'Critical')}</button>)}</div><label className="risk-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('بحث في التهديدات والضوابط…', 'Search threats and controls…')} /></label></div>{isMobile ? (
      <div className="risk-card-list">
        {visible.map((row) => (
          <div key={row.id} className="risk-row-card">
            <div className="risk-row-card-head"><strong>{row.area}</strong><span className={`pay-status-badge ${row.status === 'protected' ? 'st-paid' : 'st-pending'}`}>{row.status === 'protected' ? t('محمية', 'Protected') : t('مراجعة', 'Review')}</span></div>
            <div className={`redteam-severity ${row.severity}`}>{row.severity}</div>
            <div className="cell-sub">{row.threat}</div>
            <div className="cell-sub">{t('الضابط الحالي', 'Current control')}: {row.control}</div>
            <div className="cell-sub">{t('الخطوة التالية', 'Next action')}: {row.next}</div>
          </div>
        ))}
        {visible.length === 0 && <p className="risk-empty">{t('لا توجد نتائج.', 'No results.')}</p>}
      </div>
      ) : (
      <div className="table-wrap"><table className="data-table redteam-table"><thead><tr><th>{t('المجال', 'Area')}</th><th>{t('التهديد المحتمل', 'Potential threat')}</th><th>{t('الضابط الحالي', 'Current control')}</th><th>{t('الخطوة التالية', 'Next action')}</th><th>{t('الحالة', 'Status')}</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><strong>{row.area}</strong><div className={`redteam-severity ${row.severity}`}>{row.severity}</div></td><td>{row.threat}</td><td>{row.control}</td><td className="cell-sub">{row.next}</td><td><span className={`pay-status-badge ${row.status === 'protected' ? 'st-paid' : 'st-pending'}`}>{row.status === 'protected' ? t('محمية', 'Protected') : t('مراجعة', 'Review')}</span></td></tr>)}{visible.length === 0 && <tr><td colSpan={5} className="risk-empty">{t('لا توجد نتائج.', 'No results.')}</td></tr>}</tbody></table></div>
      )}</section>
  </>
}
