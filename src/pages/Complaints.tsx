import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Search, X } from 'lucide-react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useLocale } from '../lib/locale'

// الشكاوى — tx_complaints on the old prod DB, with the control room's
// investigate / approve / decline / close actions.

interface ComplaintRow {
  id: number
  tx_id: number | null
  customer_phone: string | null
  amount: number | null
  note: string | null
  status: string | null
  finding: string | null
  created_at: string | null
  resolved_at: string | null
  admin_note: string | null
}

const STATUS_META: Record<string, { ar: string; en: string; cls: string }> = {
  open: { ar: 'مفتوحة', en: 'Open', cls: 'st-pending' },
  pending: { ar: 'مفتوحة', en: 'Open', cls: 'st-pending' },
  approved: { ar: 'مقبولة', en: 'Approved', cls: 'st-paid' },
  resolved: { ar: 'محلولة', en: 'Resolved', cls: 'st-paid' },
  declined: { ar: 'مرفوضة', en: 'Declined', cls: 'st-declined' },
  closed: { ar: 'مغلقة', en: 'Closed', cls: 'st-dim' },
}

export default function Complaints() {
  const { t } = useLocale()
  const [rows, setRows] = useState<ComplaintRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('')
  const [txSearch, setTxSearch] = useState('')
  const [txId, setTxId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<ComplaintRow | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [investigation, setInvestigation] = useState<unknown | null>(null)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    if (txId) params.set('tx_id', txId)
    const qs = params.size ? `?${params.toString()}` : ''
    try {
      const res = await api<{ rows: ComplaintRow[]; total: number }>(`/api/complaints${qs}`)
      setRows(res.rows)
      setTotal(res.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية عرض الشكاوى.', 'You do not have permission to view complaints.') : t('تعذّر تحميل الشكاوى.', 'Failed to load complaints.'))
    }
  }, [status, txId])

  useEffect(() => { void load() }, [load])

  const open = (r: ComplaintRow) => {
    setSelected(r)
    setNote(r.admin_note ?? '')
    setInvestigation(null)
  }

  const investigate = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const res = await api<{ result: unknown }>('/api/complaints/investigate', {
        method: 'POST',
        body: JSON.stringify({ tx_id: selected.tx_id, phone: selected.customer_phone, amount: selected.amount }),
      })
      setInvestigation(res.result)
    } catch {
      setInvestigation({ error: t('فشل الفحص', 'Investigation failed') })
    } finally {
      setBusy(false)
    }
  }

  const decide = async (decision: 'approve' | 'decline' | 'close') => {
    if (!selected || !selected.tx_id) return
    setBusy(true)
    try {
      await api(`/api/complaints/${selected.id}/${decision}`, {
        method: 'POST',
        body: JSON.stringify({ tx_id: selected.tx_id, note: note.trim() || null }),
      })
      setSelected(null)
      void load()
    } catch {
      setErr(t('فشل تنفيذ القرار — أعد المحاولة.', 'Failed to apply the decision — try again.'))
    } finally {
      setBusy(false)
    }
  }

  const meta = (s: string | null) => (s ? STATUS_META[s.toLowerCase()] ?? { ar: s, en: s, cls: 'st-dim' } : { ar: '—', en: '—', cls: 'st-dim' })

  const searchByTx = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTxId(txSearch.trim())
  }

  const clearTxSearch = () => {
    setTxSearch('')
    setTxId('')
  }

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🛎️ {t('الشكاوى', 'Complaints')}</h2>
        <p className="page-sub">{t('شكاوى العملاء من غرفة التحكم', 'Customer complaints from the control room')} · {total.toLocaleString('en-US')}</p>
      </section>

      <div className="filter-bar">
        <form className="complaint-tx-search" onSubmit={searchByTx} role="search">
          <label htmlFor="complaint-tx-id">{t('رقم المعاملة', 'Transaction ID')}</label>
          <div className="complaint-tx-search-control">
            <Search size={17} aria-hidden="true" />
            <input
              id="complaint-tx-id"
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder={t('ابحث برقم المعاملة…', 'Search by transaction ID…')}
              value={txSearch}
              onChange={(event) => setTxSearch(event.target.value.replace(/\D/g, ''))}
            />
            {txSearch && (
              <button type="button" className="complaint-search-clear" onClick={clearTxSearch} aria-label={t('مسح البحث', 'Clear search')}>
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          <button className="btn-primary btn-sm" type="submit" disabled={!txSearch.trim()}>
            {t('بحث', 'Search')}
          </button>
        </form>
        <div className="chip-row">
          <button className={`chip${status === '' ? ' chip-active' : ''}`} onClick={() => setStatus('')}>{t('الكل', 'All')}</button>
          {['open', 'approved', 'declined', 'closed'].map((s) => (
            <button key={s} className={`chip${status === s ? ' chip-active' : ''}`} onClick={() => setStatus(status === s ? '' : s)}>
              {t(meta(s).ar, meta(s).en)}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">{t('جارٍ التحميل…', 'Loading…')}</p>}
        {rows && rows.length === 0 && <p>{txId ? t(`لا توجد شكوى للمعاملة ${txId}.`, `No complaint found for transaction ${txId}.`) : t('لا توجد شكاوى.', 'No complaints.')}</p>}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr><th>#</th><th>tx</th><th>{t('الهاتف', 'Phone')}</th><th>{t('المبلغ', 'Amount')}</th><th>{t('الشكوى', 'Complaint')}</th><th>{t('النتيجة', 'Finding')}</th><th>{t('الحالة', 'Status')}</th><th>{t('الوقت', 'Time')}</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = meta(r.status)
                  return (
                    <tr key={r.id} onClick={() => open(r)}>
                      <td className="mono">{r.id}</td>
                      <td className="mono">{r.tx_id ?? '—'}</td>
                      <td className="mono">{r.customer_phone ?? '—'}</td>
                      <td className="mono">{money(r.amount, 'EGP')}</td>
                      <td className="sms-cell">{r.note ?? '—'}</td>
                      <td className="sms-cell">{r.finding ?? '—'}</td>
                      <td><span className={`pay-status-badge ${m.cls}`}>{t(m.ar, m.en)}</span></td>
                      <td className="mono">{depositTime({ first_seen_at: r.created_at })}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <div className="drawer-backdrop" onClick={() => !busy && setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <h3>{t('شكوى', 'Complaint')} #{selected.id}</h3>
              <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
            </div>
            <dl className="detail-grid">
              <dt>tx</dt><dd className="mono">{selected.tx_id ?? '—'}</dd>
              <dt>{t('الهاتف', 'Phone')}</dt><dd className="mono">{selected.customer_phone ?? '—'}</dd>
              <dt>{t('المبلغ', 'Amount')}</dt><dd className="mono">{money(selected.amount, 'EGP')}</dd>
              <dt>{t('الشكوى', 'Complaint')}</dt><dd>{selected.note ?? '—'}</dd>
              <dt>{t('نتيجة الفحص', 'Finding')}</dt><dd>{selected.finding ?? '—'}</dd>
              <dt>{t('أُنشئت', 'Created')}</dt><dd className="mono">{depositTime({ first_seen_at: selected.created_at })}</dd>
              {selected.resolved_at && <><dt>{t('حُلّت', 'Resolved')}</dt><dd className="mono">{depositTime({ first_seen_at: selected.resolved_at })}</dd></>}
            </dl>

            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void investigate()}>
              🔍 {t('فحص ومطابقة', 'Investigate & match')}
            </button>
            {investigation != null && (
              <pre className="sms-body">{JSON.stringify(investigation, null, 1).slice(0, 1200)}</pre>
            )}

            <div className="section-label">{t('القرار', 'Decision')}</div>
            <input
              className="login-input"
              placeholder={t('ملاحظة إدارية (اختياري)…', 'Admin note (optional)…')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="drawer-actions">
              <button className="btn-primary" disabled={busy || !selected.tx_id} onClick={() => void decide('approve')}>
                ✅ {t('قبول (PAID)', 'Approve (PAID)')}
              </button>
              <button className="btn-ghost danger" disabled={busy || !selected.tx_id} onClick={() => void decide('decline')}>
                ❌ {t('رفض', 'Decline')}
              </button>
              <button className="btn-ghost" disabled={busy || !selected.tx_id} onClick={() => void decide('close')}>
                🔒 {t('إغلاق', 'Close')}
              </button>
            </div>
          </aside>
        </div>
      )}
    </PanelShell>
  )
}
