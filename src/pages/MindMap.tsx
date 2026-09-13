import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, BarChart3, Bot, CheckCircle2, Clock3, Database, ExternalLink, GitBranch, MessageSquareText, RefreshCw, Server, ShieldCheck, Users, WalletCards, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api } from '../lib/api'
import { useLocale } from '../lib/locale'

const nodes = [
  { title: 'مصادر البيانات', subtitle: 'Data sources', icon: Database, tone: 'blue', items: ['Maven / NGPay transactions', 'SMS Forwarder inbox', 'Agents and operators'] },
  { title: 'المطابقة', subtitle: 'Matching engine', icon: GitBranch, tone: 'gold', items: ['Amount + wallet + time', 'Phone or sender name', 'Balance continuity'] },
  { title: 'القرار', subtitle: 'Decision layer', icon: Bot, tone: 'purple', items: ['Automation rules', 'Maven team action', 'Human review queue'] },
  { title: 'الدليل والتدقيق', subtitle: 'Evidence & audit', icon: ShieldCheck, tone: 'green', items: ['SMS proof and UTR', 'Provider read-back', 'Action history'] },
  { title: 'التشغيل والتقارير', subtitle: 'Operations & reporting', icon: BarChart3, tone: 'orange', items: ['Live monitor', 'Wallet and settlement reports', 'Telegram notifications'] },
]

interface MindMapLiveData {
  generatedAt: string
  lastSync: string | null
  queues: { pendingDeposits: number | null; pendingPayouts: number | null; editRequests: number | null }
  sms: { id: number; sms_category: string | null; assigned_tx_id: number | string | null }[]
  transactions: { tx_id: number; status: string; amount: number | null }[]
  devices: { device: string; online: boolean | null }[]
  sources: Record<string, { ok: boolean; error?: string | null }>
}

const age = (value: string | null, t: (ar: string, en: string) => string) => {
  if (!value) return t('غير متاح', 'Unavailable')
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))
  return seconds < 60 ? t(`منذ ${seconds} ثانية`, `${seconds}s ago`) : t(`منذ ${Math.round(seconds / 60)} دقيقة`, `${Math.round(seconds / 60)}m ago`)
}

export default function MindMap() {
  const { t } = useLocale()
  const [live, setLive] = useState<MindMapLiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const load = useCallback(async () => {
    try { setLive(await api<MindMapLiveData>('/api/monitoring')); setError(false) }
    catch { setError(true) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(timer) }, [load])
  const pending = live?.transactions.filter((row) => row.status === 'PENDING').length ?? 0
  const paid = live?.transactions.filter((row) => ['PAID', 'APPROVED'].includes(row.status)).length ?? 0
  const declined = live?.transactions.filter((row) => ['DECLINED', 'FAILED'].includes(row.status)).length ?? 0
  const unlinkedSms = live?.sms.filter((row) => !row.assigned_tx_id && ['deposit', 'withdrawal'].includes(row.sms_category ?? '')).length ?? 0
  const onlineDevices = live?.devices.filter((row) => row.online).length ?? 0
  const sourcesOk = live ? Object.values(live.sources).filter((source) => source.ok).length : 0
  const sourceTotal = live ? Object.keys(live.sources).length : 0
  return <PanelShell>
    <section className="page-head mindmap-head">
      <div>
        <span className="mindmap-eyebrow"><GitBranch size={14} /> {t('خريطة التشغيل', 'Operations map')}</span>
        <h2>{t('خريطة النظام والعمليات', 'System mind map')}</h2>
        <p className="page-sub">{t('صورة واحدة توضح كيف تنتقل المعاملة من المصدر إلى المطابقة والقرار ثم التقارير.', 'One view of how a transaction moves from source to matching, decision, evidence, and reporting.')}</p>
      </div>
      <div className="mindmap-head-actions"><span className="mindmap-live"><span /> {live ? t('مباشر', 'Live') : t('جارٍ الاتصال', 'Connecting')}</span><button className="btn-ghost btn-sm" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : ''} /> {t('تحديث', 'Refresh')}</button></div>
    </section>

    {error && <div className="card warn">{t('تعذّر تحميل مؤشرات الخريطة المباشرة.', 'Live mind map metrics are unavailable.')}</div>}

    <section className="mindmap-live-kpis" aria-label={t('مؤشرات التشغيل', 'Operations metrics')}>
      <Link to="/approvals" className="card mindmap-kpi"><Clock3 size={18} /><span>{t('قيد القرار', 'Awaiting decision')}</span><strong>{live ? pending : '—'}</strong><small>{t('معاملات معلقة', 'Pending transactions')}</small></Link>
      <Link to="/sms?match=unmatched" className="card mindmap-kpi warning"><MessageSquareText size={18} /><span>{t('SMS غير مرتبطة', 'Unlinked SMS')}</span><strong>{live ? unlinkedSms : '—'}</strong><small>{t('تحتاج ربطًا أو مراجعة', 'Need linking or review')}</small></Link>
      <Link to="/monitor" className="card mindmap-kpi success"><CheckCircle2 size={18} /><span>{t('مدفوعة اليوم', 'Paid in view')}</span><strong>{live ? paid : '—'}</strong><small>{t('تأكيدات من المصدر', 'Provider confirmations')}</small></Link>
      <Link to="/system-health" className="card mindmap-kpi"><Server size={18} /><span>{t('صحة المصادر', 'Source health')}</span><strong>{live ? `${sourcesOk}/${sourceTotal}` : '—'}</strong><small>{t(`${onlineDevices} جهاز متصل`, `${onlineDevices} devices online`)}</small></Link>
    </section>

    <section className="card mindmap-flow" aria-label={t('خريطة النظام', 'System mind map')}>
      <div className="mindmap-flow-grid">
        {nodes.map((node, index) => <div className="mindmap-step" key={node.title}>
          <article className={`mindmap-node ${node.tone}`}>
            <div className="mindmap-node-icon"><node.icon size={21} /></div>
            <div><span className="mindmap-node-kicker">{node.subtitle}</span><h3>{node.title}</h3></div>
            <ul>{node.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </article>
          {index < nodes.length - 1 && <div className="mindmap-connector" aria-hidden="true"><ArrowDown size={17} /></div>}
        </div>)}
      </div>
    </section>

    <section className="card mindmap-live-summary">
      <div className="mindmap-summary-head"><div><span className="mindmap-eyebrow"><ActivityIcon /> {t('الحالة اللحظية', 'Live state')}</span><h3>{t('من الخريطة إلى الإجراء', 'From map to action')}</h3></div><span className="cell-sub">{live?.generatedAt ? `${t('آخر فحص', 'Last checked')} ${age(live.generatedAt, t)}` : '—'}</span></div>
      <div className="mindmap-status-grid">
        <Link to="/transactions?status=PENDING"><span><Clock3 size={15} /> {t('معاملات معلقة', 'Pending transactions')}</span><strong>{pending}</strong></Link>
        <Link to="/transactions?status=PAID"><span><CheckCircle2 size={15} /> {t('مدفوعة', 'Paid')}</span><strong>{paid}</strong></Link>
        <Link to="/transactions?status=DECLINED"><span><XCircle size={15} /> {t('مرفوضة', 'Declined')}</span><strong>{declined}</strong></Link>
        <Link to="/sms"><span><MessageSquareText size={15} /> {t('كل SMS الحديثة', 'Recent SMS')}</span><strong>{live?.sms.length ?? '—'}</strong></Link>
      </div>
      <div className="mindmap-action-links"><Link to="/sms">{t('فتح Live SMS', 'Open Live SMS')} <ExternalLink size={14} /></Link><Link to="/approvals">{t('فتح طابور الموافقات', 'Open approvals')} <ExternalLink size={14} /></Link><Link to="/automation">{t('إدارة قواعد الأتمتة', 'Manage automation rules')} <ExternalLink size={14} /></Link></div>
    </section>

    <section className="mindmap-principles">
      <article className="card"><WalletCards size={18} /><div><h3>{t('حقيقة المزوّد أولاً', 'Provider truth first')}</h3><p>{t('حالة Maven أو NGPay وقراءة الحالة بعد الإجراء هي المرجع النهائي.', 'Maven or NGPay status and post-action read-back remain the final source of truth.')}</p></div></article>
      <article className="card"><MessageSquareText size={18} /><div><h3>{t('الرسالة دليل قابل للتتبع', 'SMS is traceable evidence')}</h3><p>{t('كل SMS مرتبطة بمعاملة أو تبقى ظاهرة في قائمة الانتظار للمراجعة.', 'Every SMS is linked to a transaction or stays visible in a review queue.')}</p></div></article>
      <article className="card"><Users size={18} /><div><h3>{t('القرار منسوب بوضوح', 'Every decision has an owner')}</h3><p>{t('يظهر هل القرار تلقائي، بواسطة Maven، أو بواسطة عضو من الفريق.', 'The audit trail identifies automation, Maven, or the responsible team member.')}</p></div></article>
    </section>
  </PanelShell>
}

function ActivityIcon() { return <BarChart3 size={14} /> }
