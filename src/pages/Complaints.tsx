import { useCallback, useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'

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

const STATUS_META: Record<string, { label: string; cls: string }> = {
  open: { label: 'مفتوحة', cls: 'st-pending' },
  pending: { label: 'مفتوحة', cls: 'st-pending' },
  approved: { label: 'مقبولة', cls: 'st-paid' },
  resolved: { label: 'محلولة', cls: 'st-paid' },
  declined: { label: 'مرفوضة', cls: 'st-declined' },
  closed: { label: 'مغلقة', cls: 'st-dim' },
}

export default function Complaints() {
  const [rows, setRows] = useState<ComplaintRow[] | null>(null)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<ComplaintRow | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [investigation, setInvestigation] = useState<unknown | null>(null)

  const load = useCallback(async () => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : ''
    try {
      const res = await api<{ rows: ComplaintRow[]; total: number }>(`/api/complaints${qs}`)
      setRows(res.rows)
      setTotal(res.total)
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الشكاوى.' : 'تعذّر تحميل الشكاوى.')
    }
  }, [status])

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
      setInvestigation({ error: 'فشل الفحص' })
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
      setErr('فشل تنفيذ القرار — أعد المحاولة.')
    } finally {
      setBusy(false)
    }
  }

  const meta = (s: string | null) => (s ? STATUS_META[s.toLowerCase()] ?? { label: s, cls: 'st-dim' } : { label: '—', cls: 'st-dim' })

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🛎️ الشكاوى</h2>
        <p className="page-sub">شكاوى العملاء من غرفة التحكم · {total.toLocaleString('en-US')} شكوى</p>
      </section>

      <div className="filter-bar">
        <div className="chip-row">
          <button className={`chip${status === '' ? ' chip-active' : ''}`} onClick={() => setStatus('')}>الكل</button>
          {['open', 'approved', 'declined', 'closed'].map((s) => (
            <button key={s} className={`chip${status === s ? ' chip-active' : ''}`} onClick={() => setStatus(status === s ? '' : s)}>
              {meta(s).label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="card warn">{err}</div>}

      <section className="card recent-card">
        {!rows && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}
        {rows && rows.length === 0 && <p>لا توجد شكاوى.</p>}
        {rows && rows.length > 0 && (
          <div className="table-wrap">
            <table className="data-table clickable">
              <thead>
                <tr><th>#</th><th>tx</th><th>الهاتف</th><th>المبلغ</th><th>الشكوى</th><th>النتيجة</th><th>الحالة</th><th>الوقت</th></tr>
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
                      <td><span className={`pay-status-badge ${m.cls}`}>{m.label}</span></td>
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
              <h3>شكوى #{selected.id}</h3>
              <button className="btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
            </div>
            <dl className="detail-grid">
              <dt>tx</dt><dd className="mono">{selected.tx_id ?? '—'}</dd>
              <dt>الهاتف</dt><dd className="mono">{selected.customer_phone ?? '—'}</dd>
              <dt>المبلغ</dt><dd className="mono">{money(selected.amount, 'EGP')}</dd>
              <dt>الشكوى</dt><dd>{selected.note ?? '—'}</dd>
              <dt>نتيجة الفحص</dt><dd>{selected.finding ?? '—'}</dd>
              <dt>أُنشئت</dt><dd className="mono">{depositTime({ first_seen_at: selected.created_at })}</dd>
              {selected.resolved_at && <><dt>حُلّت</dt><dd className="mono">{depositTime({ first_seen_at: selected.resolved_at })}</dd></>}
            </dl>

            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => void investigate()}>
              🔍 فحص ومطابقة
            </button>
            {investigation != null && (
              <pre className="sms-body">{JSON.stringify(investigation, null, 1).slice(0, 1200)}</pre>
            )}

            <div className="section-label">القرار</div>
            <input
              className="login-input"
              placeholder="ملاحظة إدارية (اختياري)…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="drawer-actions">
              <button className="btn-primary" disabled={busy || !selected.tx_id} onClick={() => void decide('approve')}>
                ✅ قبول (PAID)
              </button>
              <button className="btn-ghost danger" disabled={busy || !selected.tx_id} onClick={() => void decide('decline')}>
                ❌ رفض
              </button>
              <button className="btn-ghost" disabled={busy || !selected.tx_id} onClick={() => void decide('close')}>
                🔒 إغلاق
              </button>
            </div>
          </aside>
        </div>
      )}
    </PanelShell>
  )
}
