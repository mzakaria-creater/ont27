import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// Mismatch detector — automates the anomaly hunt that was done by hand today.
// Read-only by design: it surfaces suspects for a human to judge, it never
// changes a transaction. Every row links to the real transaction page.

interface UndocRow {
  tx_id: number; ontarget_ref: string | null; status: string; amount: number | null
  sender_name: string | null; approved_by: string | null; modified_utc: string | null
}
interface SmsRow {
  tx_id: number; ontarget_ref: string | null; amount: number | null; tx_sender: string | null
  to_account_number: string | null; first_seen_at: string | null
  sms_id: number; sms_sender: string | null; sms_received_at: string | null
  device_name: string | null; minutes_offset: number | null
}
interface Counts { h1: number; h3: number; h24: number; newest: string | null }
type SyncGap = Record<string, { old: number | null; current: number | null }> | null
interface Data {
  undocumented: UndocRow[]; undocumentedCounts: Counts | null
  smsMismatch: SmsRow[]; syncGap: SyncGap; hours: number
}

function fmt(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts.includes('T') || ts.includes('+') ? ts : `${ts.replace(' ', 'T')}Z`)
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString()
}

export default function Mismatch() {
  const { t } = useLocale()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [hours, setHours] = useState(24)
  const [tab, setTab] = useState<'undocumented' | 'sms' | 'sync'>('undocumented')

  const load = useCallback(async () => {
    try {
      setData(await api<Data>(`/api/mismatch?hours=${hours}`))
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403
        ? t('لا تملك صلاحية عرض كشف عدم التطابق.', 'You do not have permission to view the mismatch detector.')
        : t('تعذّر تحميل الفحص.', 'Unable to run the check.'))
    }
  }, [hours, t])

  useEffect(() => { void load() }, [load])

  const counts = data?.undocumentedCounts ?? null
  const undocTotal = data?.undocumented.length ?? 0
  const smsTotal = data?.smsMismatch.length ?? 0
  const gapEntries = data?.syncGap ? Object.entries(data.syncGap) : []
  const gapCount = gapEntries.filter(([, v]) => v.old != null && v.current != null && v.old !== v.current).length

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🎯 {t('كشف عدم التطابق', 'Mismatch detector')}</h2>
        <p className="page-sub">
          {t(
            'يفحص أنماط الخلل التي اكتُشفت يدوياً: قرارات بلا أثر تدقيقي، رفض محتمل خاطئ برسالة مطابقة، وفروقات مزامنة. للعرض والتحقيق فقط — لا يغيّر أي معاملة.',
            'Checks the failure patterns found by hand: decisions with no audit trail, possible wrong declines with a matching SMS, and sync gaps. Read-only — it never changes a transaction.',
          )}
        </p>
      </section>

      {err && <div className="card warn">{err}</div>}

      <div className="stat-grid">
        <div className={`stat-card${counts && counts.h1 > 0 ? ' stat-pending' : ''}`}>
          <span className="stat-label">🚨 {t('غير موثّقة · آخر ساعة', 'Undocumented · last hour')}</span>
          <span className="stat-value" style={{ color: counts && counts.h1 > 0 ? 'var(--status-declined)' : 'var(--status-paid)' }}>
            {counts ? counts.h1 : '…'}
          </span>
          <span className="stat-sub">
            {counts ? t(`${counts.h3} خلال 3 ساعات · ${counts.h24} خلال 24 ساعة`, `${counts.h3} in 3h · ${counts.h24} in 24h`) : ''}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">📨 {t('رفض محتمل خاطئ', 'Possible wrong declines')}</span>
          <span className="stat-value" style={{ color: smsTotal > 0 ? 'var(--status-pending)' : undefined }}>{data ? smsTotal : '…'}</span>
          <span className="stat-sub">{t('رسالة بنفس المبلغ ونفس المحفظة', 'Same amount, same wallet, unconsumed')}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">🔄 {t('فروقات مزامنة', 'Sync gaps')}</span>
          <span className="stat-value" style={{ color: gapCount > 0 ? 'var(--status-pending)' : undefined }}>{data ? gapCount : '…'}</span>
          <span className="stat-sub">{t('مقارنة بالمشروع القديم', 'Compared with the old project')}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">🕒 {t('آخر حالة غير موثّقة', 'Newest undocumented')}</span>
          <span className="stat-value" style={{ fontSize: 15 }}>{counts?.newest ? fmt(counts.newest) : '—'}</span>
          <span className="stat-sub">{t('يجب أن يتوقف هذا بعد إيقاف المصدر القديم', 'Should stop advancing once the old source is off')}</span>
        </div>
      </div>

      <div className="control-row" style={{ marginBlock: 14 }}>
        <div className="filter-pills" role="tablist">
          <button role="tab" aria-selected={tab === 'undocumented'} className={`pill${tab === 'undocumented' ? ' active' : ''}`} onClick={() => setTab('undocumented')}>
            {t('غير موثّقة', 'Undocumented')} <span className="mono">{undocTotal}</span>
          </button>
          <button role="tab" aria-selected={tab === 'sms'} className={`pill${tab === 'sms' ? ' active' : ''}`} onClick={() => setTab('sms')}>
            {t('تعارض SMS', 'SMS mismatch')} <span className="mono">{smsTotal}</span>
          </button>
          <button role="tab" aria-selected={tab === 'sync'} className={`pill${tab === 'sync' ? ' active' : ''}`} onClick={() => setTab('sync')}>
            {t('فروقات المزامنة', 'Sync gaps')} <span className="mono">{gapCount}</span>
          </button>
        </div>
        <span className="control-sep" />
        <span>{t('النافذة', 'Window')}</span>
        <select className="login-input" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label={t('نافذة الفحص', 'Check window')}>
          <option value={1}>{t('ساعة', '1 hour')}</option>
          <option value={3}>{t('3 ساعات', '3 hours')}</option>
          <option value={24}>{t('24 ساعة', '24 hours')}</option>
          <option value={72}>{t('3 أيام', '3 days')}</option>
        </select>
        <button className="btn-ghost btn-sm" onClick={() => void load()}>{t('إعادة الفحص', 'Re-run')}</button>
      </div>

      {!data && !err && <p className="sidebar-hint">{t('جارٍ الفحص…', 'Running checks…')}</p>}

      {data && tab === 'undocumented' && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>🚨 {t('قرارات بلا أثر تدقيقي', 'Decisions with no audit trail')}</h3>
            <span className="cell-sub">{t('حالة تغيّرت دون صف في deposit_decision_log', 'Status changed with no deposit_decision_log row')}</span>
          </div>
          <p className="drawer-note">
            {t(
              'مصدر هذا النمط تاريخياً هو النظام القديم (maven-http-worker) الذي كان يقرر ثم تُستورد الحالة عبر المزامنة. النتائج القديمة متوقعة؛ المهم أن يبقى عدّاد "آخر ساعة" صفراً.',
              'Historically this pattern came from the old system (maven-http-worker) deciding upstream, with the status then imported by sync. Older rows are expected; what matters is that the "last hour" counter stays at zero.',
            )}
          </p>
          {data.undocumented.length === 0 && <p>{t('لا توجد قرارات غير موثّقة في هذه النافذة ✅', 'No undocumented decisions in this window ✅')}</p>}
          {data.undocumented.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('المرجع', 'Ref')}</th><th>{t('الحالة', 'Status')}</th><th>{t('المبلغ', 'Amount')}</th>
                    <th>{t('المرسِل', 'Sender')}</th><th>{t('نُفِّذ بواسطة', 'Decided by')}</th>
                    <th>{t('وقت التغيير', 'Changed at')}</th><th>{t('التصنيف', 'Flag')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {data.undocumented.map((r) => (
                    <tr key={r.tx_id}>
                      <td className="mono">{r.ontarget_ref ?? r.tx_id}<div className="cell-sub mono">{r.tx_id}</div></td>
                      <td><span className={`pay-status-badge ${r.status === 'PAID' ? 'st-paid' : 'st-declined'}`}>{r.status}</span></td>
                      <td className="mono">{money(r.amount, 'EGP')}</td>
                      <td>{r.sender_name ?? '—'}</td>
                      <td>{r.approved_by ?? <span className="cell-sub">{t('غير معروف', 'unknown')}</span>}</td>
                      <td className="mono">{fmt(r.modified_utc)}</td>
                      <td><span className="pay-status-badge st-declined">UNDOCUMENTED</span></td>
                      <td>{r.ontarget_ref && <Link className="btn-ghost btn-sm" to={`/transactions/${r.ontarget_ref}`}>{t('فتح', 'Open')}</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {data && tab === 'sms' && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>📨 {t('رفض محتمل خاطئ', 'Possible wrong declines')}</h3>
            <span className="cell-sub">{t('آخر 48 ساعة على الأقل', 'At least the last 48 hours')}</span>
          </div>
          <p className="drawer-note">
            {t(
              'معاملة مرفوضة ووصلت رسالة بنفس المبلغ تماماً وعلى نفس المحفظة المستلِمة، وما زالت الرسالة غير مستهلكة. اشتراط تطابق المحفظة مقصود: المطابقة بالمبلغ وحده أعطت 149 نتيجة في 48 ساعة (المبالغ تتكرر كثيراً) مقابل نتيجة واحدة عند اشتراط المحفظة.',
              'A declined transaction where an SMS for the exact same amount landed on the same receiving wallet and is still unconsumed. Requiring the wallet match is deliberate: amount-only matching returned 149 hits over 48h (amounts repeat constantly) versus 1 with the wallet condition.',
            )}
          </p>
          {data.smsMismatch.length === 0 && <p>{t('لا توجد حالات مطابقة ✅', 'No candidates ✅')}</p>}
          {data.smsMismatch.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t('المرجع', 'Ref')}</th><th>{t('المبلغ', 'Amount')}</th>
                    <th>{t('اسم المعاملة', 'Tx name')}</th><th>{t('اسم الرسالة', 'SMS name')}</th>
                    <th>{t('المحفظة', 'Wallet')}</th><th>{t('فارق التوقيت', 'Time offset')}</th>
                    <th>{t('التصنيف', 'Flag')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {data.smsMismatch.map((r) => {
                    const nameDiffers = !!r.tx_sender && !!r.sms_sender && r.tx_sender.trim().toLowerCase() !== r.sms_sender.trim().toLowerCase()
                    return (
                      <tr key={`${r.tx_id}-${r.sms_id}`}>
                        <td className="mono">{r.ontarget_ref ?? r.tx_id}<div className="cell-sub mono">{r.tx_id}</div></td>
                        <td className="mono">{money(r.amount, 'EGP')}</td>
                        <td>{r.tx_sender ?? '—'}</td>
                        <td>
                          {r.sms_sender ?? '—'}
                          {nameDiffers && <div className="cell-sub warn-text">{t('اسم مختلف', 'name differs')}</div>}
                        </td>
                        <td className="mono">{r.to_account_number ?? '—'}<div className="cell-sub mono">{r.device_name ?? ''}</div></td>
                        <td className="mono">{r.minutes_offset != null ? t(`${r.minutes_offset} د`, `${r.minutes_offset} min`) : '—'}</td>
                        <td><span className="pay-status-badge st-pending">SMS_MISMATCH</span></td>
                        <td>{r.ontarget_ref && <Link className="btn-ghost btn-sm" to={`/transactions/${r.ontarget_ref}`}>{t('فتح', 'Open')}</Link>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {data && tab === 'sync' && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>🔄 {t('فروقات المزامنة مع المشروع القديم', 'Sync gaps vs the old project')}</h3>
          </div>
          {!data.syncGap && <p className="sidebar-hint">{t('تعذّر الوصول إلى المشروع القديم — الفحص غير متاح الآن.', 'The old project is not reachable — this check is unavailable right now.')}</p>}
          {data.syncGap && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>{t('الجدول', 'Table')}</th><th>{t('القديم', 'Old')}</th><th>{t('الحالي', 'Current')}</th><th>{t('الفرق', 'Diff')}</th><th>{t('التصنيف', 'Flag')}</th></tr></thead>
                <tbody>
                  {gapEntries.map(([tbl, v]) => {
                    const diff = v.old != null && v.current != null ? v.old - v.current : null
                    return (
                      <tr key={tbl}>
                        <td className="mono">{tbl}</td>
                        <td className="mono">{v.old ?? '—'}</td>
                        <td className="mono">{v.current ?? '—'}</td>
                        <td className="mono">{diff == null ? '—' : diff === 0 ? '0' : diff > 0 ? `−${diff}` : `+${Math.abs(diff)}`}</td>
                        <td>
                          {diff === 0
                            ? <span className="pay-status-badge st-paid">{t('متطابق', 'In sync')}</span>
                            : <span className="pay-status-badge st-pending">SYNC_GAP</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </PanelShell>
  )
}
