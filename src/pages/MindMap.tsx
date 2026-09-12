import { ArrowDown, BarChart3, Bot, Database, GitBranch, MessageSquareText, ShieldCheck, Users, WalletCards } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { useLocale } from '../lib/locale'

const nodes = [
  { title: 'مصادر البيانات', subtitle: 'Data sources', icon: Database, tone: 'blue', items: ['Maven / NGPay transactions', 'SMS Forwarder inbox', 'Agents and operators'] },
  { title: 'المطابقة', subtitle: 'Matching engine', icon: GitBranch, tone: 'gold', items: ['Amount + wallet + time', 'Phone or sender name', 'Balance continuity'] },
  { title: 'القرار', subtitle: 'Decision layer', icon: Bot, tone: 'purple', items: ['Automation rules', 'Maven team action', 'Human review queue'] },
  { title: 'الدليل والتدقيق', subtitle: 'Evidence & audit', icon: ShieldCheck, tone: 'green', items: ['SMS proof and UTR', 'Provider read-back', 'Action history'] },
  { title: 'التشغيل والتقارير', subtitle: 'Operations & reporting', icon: BarChart3, tone: 'orange', items: ['Live monitor', 'Wallet and settlement reports', 'Telegram notifications'] },
]

export default function MindMap() {
  const { t } = useLocale()
  return <PanelShell>
    <section className="page-head mindmap-head">
      <div>
        <span className="mindmap-eyebrow"><GitBranch size={14} /> {t('خريطة التشغيل', 'Operations map')}</span>
        <h2>{t('خريطة النظام والعمليات', 'System mind map')}</h2>
        <p className="page-sub">{t('صورة واحدة توضح كيف تنتقل المعاملة من المصدر إلى المطابقة والقرار ثم التقارير.', 'One view of how a transaction moves from source to matching, decision, evidence, and reporting.')}</p>
      </div>
      <span className="mindmap-live"><span /> {t('تدفق موحّد', 'Unified flow')}</span>
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

    <section className="mindmap-principles">
      <article className="card"><WalletCards size={18} /><div><h3>{t('حقيقة المزوّد أولاً', 'Provider truth first')}</h3><p>{t('حالة Maven أو NGPay وقراءة الحالة بعد الإجراء هي المرجع النهائي.', 'Maven or NGPay status and post-action read-back remain the final source of truth.')}</p></div></article>
      <article className="card"><MessageSquareText size={18} /><div><h3>{t('الرسالة دليل قابل للتتبع', 'SMS is traceable evidence')}</h3><p>{t('كل SMS مرتبطة بمعاملة أو تبقى ظاهرة في قائمة الانتظار للمراجعة.', 'Every SMS is linked to a transaction or stays visible in a review queue.')}</p></div></article>
      <article className="card"><Users size={18} /><div><h3>{t('القرار منسوب بوضوح', 'Every decision has an owner')}</h3><p>{t('يظهر هل القرار تلقائي، بواسطة Maven، أو بواسطة عضو من الفريق.', 'The audit trail identifies automation, Maven, or the responsible team member.')}</p></div></article>
    </section>
  </PanelShell>
}
