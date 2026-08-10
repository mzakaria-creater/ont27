import { useCallback, useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Operations archive — the browser_jobs execution log (old DB, 31k+ rows).
// Every automated/manual execution attempt: what it tried, the provider
// before/after status, and why it failed. Read-only audit surface.

interface Job {
  id: string; tx_id: number | null; amount: number | null; target_status: string | null
  provider: string | null; source: string | null; state: string | null
  attempts: number | null; max_attempts: number | null
  maven_before_status: string | null; maven_after_status: string | null
  last_error: string | null; error_code: string | null; operator_username: string | null
  created_at: string | null; completed_at: string | null; failed_at: string | null
}
interface Resp { rows: Job[]; total: number; limit: number; offset: number }
const PAGE = 30

function stateClass(s: string | null) {
  if (s === 'completed') return 'st-paid'
  if (s === 'failed') return 'st-declined'
  if (s === 'pending') return 'st-pending'
  return 'st-dim'
}

export default function OperationsArchive() {
  const { t } = useLocale()
  const [data, setData] = useState<Resp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [state, setState] = useState('')
  const [source, setSource] = useState('')
  const [txId, setTxId] = useState('')

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) })
    if (state) p.set('state', state)
    if (source) p.set('source', source)
    if (txId.trim()) p.set('tx_id', txId.trim())
    try { setData(await api<Resp>(`/api/control/browser-jobs?${p}`)); setErr(null) }
    catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('هذا الأرشيف متاح للإدارة فقط.', 'This archive is management-only.') : t('تعذر التحميل.', 'Unable to load.')) }
  }, [page, state, source, txId, t])
  useEffect(() => { void load() }, [load])

  const totalPages = data ? Math.max(Math.ceil(data.total / PAGE), 1) : 1
  const reset = (fn: () => void) => { setPage(0); fn() }

  return <PanelShell>
    <section className="page-head"><h2>🗄️ {t('أرشيف العمليات', 'Operations archive')}</h2>
      <p className="page-sub">{t('سجل تنفيذ كل قرار (تلقائي/يدوي) على المزوّد — للمراجعة والتدقيق المالي.', 'Every execution attempt (auto/manual) on the provider — for review and financial audit.')}{data && <> · {data.total.toLocaleString('en-US')}</>}</p>
    </section>

    <div className="filter-bar">
      <div className="filter-pills">
        {[['', t('كل الحالات', 'All states')], ['completed', t('مكتملة', 'Completed')], ['failed', t('فاشلة', 'Failed')], ['pending', t('معلّقة', 'Pending')]].map(([v, label]) =>
          <button key={v} className={`pill${state === v ? ' active' : ''}`} onClick={() => reset(() => setState(v))}>{label}</button>)}
      </div>
      <div className="filter-pills">
        {[['', t('كل المصادر', 'All sources')], ['auto_trigger', '🤖 ' + t('تلقائي', 'Auto')], ['manual_panel', t('يدوي', 'Manual')]].map(([v, label]) =>
          <button key={v} className={`pill${source === v ? ' active' : ''}`} onClick={() => reset(() => setSource(v))}>{label}</button>)}
      </div>
      <form className="search-row" onSubmit={(e) => { e.preventDefault(); setPage(0); void load() }}>
        <input className="login-input search-input" placeholder={t('بحث برقم المعاملة (tx_id)', 'Search tx_id')} value={txId} onChange={(e) => setTxId(e.target.value)} aria-label="tx_id" />
        <button type="submit" className="btn-primary btn-sm">{t('بحث', 'Search')}</button>
      </form>
    </div>

    {err && <div className="card warn">{err}</div>}
    <section className="card recent-card">
      {!data && !err && <p className="sidebar-hint">{t('جار التحميل…', 'Loading…')}</p>}
      {data && data.rows.length === 0 && <p>{t('لا توجد سجلات مطابقة.', 'No matching records.')}</p>}
      {data && data.rows.length > 0 && <div className="table-wrap"><table className="data-table">
        <thead><tr>
          <th>tx_id</th><th>{t('المستهدف', 'Target')}</th><th>{t('المزوّد', 'Provider')}</th><th>{t('المصدر', 'Source')}</th>
          <th>{t('الحالة', 'State')}</th><th>{t('قبل→بعد', 'Before→After')}</th><th>{t('محاولات', 'Attempts')}</th><th>{t('الخطأ', 'Error')}</th><th>{t('الوقت', 'Time')}</th>
        </tr></thead>
        <tbody>{data.rows.map((j) => <tr key={j.id}>
          <td className="mono">{j.tx_id ?? '—'}{j.amount != null && <div className="cell-sub mono">{money(j.amount, 'EGP')}</div>}</td>
          <td className="mono">{j.target_status ?? '—'}</td>
          <td>{j.provider ?? '—'}</td>
          <td>{j.source === 'auto_trigger' ? '🤖' : j.operator_username ? j.operator_username : (j.source ?? '—')}</td>
          <td><span className={`pay-status-badge ${stateClass(j.state)}`}>{j.state ?? '—'}</span></td>
          <td className="mono">{j.maven_before_status ?? '?'} → {j.maven_after_status ?? '?'}</td>
          <td className="mono">{j.attempts ?? 0}/{j.max_attempts ?? '—'}</td>
          <td className="cell-sub">{j.last_error ? <span title={j.last_error}>{(j.error_code ?? j.last_error).slice(0, 40)}</span> : '—'}</td>
          <td className="mono">{depositTime({ first_seen_at: j.completed_at ?? j.failed_at ?? j.created_at })}</td>
        </tr>)}</tbody>
      </table></div>}
      {data && totalPages > 1 && <div className="pager">
        <button className="btn-ghost btn-sm" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>→ {t('السابق', 'Prev')}</button>
        <span className="pager-info mono">{page + 1} / {totalPages}</span>
        <button className="btn-ghost btn-sm" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)}>{t('التالي', 'Next')} ←</button>
      </div>}
    </section>
  </PanelShell>
}
