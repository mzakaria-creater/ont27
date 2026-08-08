import { useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'

// Automation — matching engine settings (read-only), scoped rules, worker jobs, treasury.

interface RuleRow { id: string; scope_type: string | null; master_merchant: string | null; merchant: string | null; payment_method: string | null; provider: string | null; enabled: boolean | null; min_amount: number | null; max_amount: number | null; action_type: string | null; priority: number | null }
interface JobRow { id: string; tx_id: number | null; amount: number | null; target_status: string | null; provider: string | null; state: string | null; mission: string | null; attempts: number | null; last_error: string | null; operator_username: string | null; created_at: string | null; completed_at: string | null }
interface BalanceRow { account_id: string | null; total_balance: number | null; available_balance: number | null; usdt_value: number | null; measured_at: string | null }
interface RateRow { currency_pair: string | null; rate: number | null; fetched_at: string | null }

const FLAG_LABELS: Record<string, string> = {
  automation_enabled: 'الأتمتة مفعّلة',
  ngpay_enabled: 'NGPay',
  // maven_enabled is the old stack's back-office worker channel; the literal
  // provider name must never surface in the UI (naming rule).
  maven_enabled: 'قناة المزوّد (back-office)',
  payfuture_enabled: 'PayFuture',
  balance_check_enabled: 'فحص الرصيد',
  above_limit_to_manual: 'فوق الحد → يدوي',
  security_rules_enabled: 'قواعد الأمان',
  wallet_switch_auto_enabled: 'تبديل المحافظ تلقائياً',
  use_crm_name_matching: 'مطابقة أسماء CRM',
  use_near_amount_matching: 'مطابقة مبلغ تقريبي',
  use_unique_amount_matching: 'مطابقة مبلغ فريد',
  use_trxid_matching: 'مطابقة رقم العملية',
  use_balance_timing_matching: 'مطابقة رصيد/توقيت',
  use_wallet_verify_ocr: 'تحقق محفظة OCR',
  use_direct_field_matching: 'مطابقة حقول مباشرة',
  use_nameonly_ocr_matching: 'مطابقة اسم OCR',
  use_account_number_matching: 'مطابقة رقم حساب',
  turbo_mode: 'وضع Turbo',
  sms_feed_circuit_breaker_enabled: 'قاطع تغذية SMS',
}

interface PayAccount {
  id: string
  label: string | null
  merchant_name: string | null
  method_name: string | null
  method_type: string | null
  priority: number | null
  status: string | null
  is_active: boolean | null
}

interface CronJob { jobid: number; jobname: string | null; schedule: string | null; active: boolean | null; last_start: string | null; last_end: string | null; last_status: string | null; last_message: string | null }

interface PayfutureRoute {
  id: string
  name: string | null
  provider: string | null
  is_active: boolean | null
  merchant_name: string | null
}

export default function Automation() {
  const [data, setData] = useState<{
    settings: Record<string, unknown> | null
    rules: RuleRow[]
    jobs: JobRow[]
    balances: BalanceRow[]
    rates: RateRow[]
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<PayAccount[] | null>(null)
  const [crons, setCrons] = useState<CronJob[] | null>(null)
  const [pf, setPf] = useState<PayfutureRoute[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [panelBusy, setPanelBusy] = useState(false)
  const [panelMsg, setPanelMsg] = useState<string | null>(null)

  const loadPanel = () => {
    api<{ accounts: PayAccount[] }>('/api/control/panel?data=all_accounts')
      .then((r) => setAccounts(r.accounts))
      .catch(() => setAccounts(null))
    api<{ routes: PayfutureRoute[] }>('/api/control/panel?data=payfuture')
      .then((r) => setPf(r.routes))
      .catch(() => setPf(null))
    api<{ jobs: CronJob[] }>('/api/control/crons')
      .then((r) => setCrons(r.jobs))
      .catch(() => setCrons(null))
  }

  useEffect(() => {
    api<NonNullable<typeof data>>('/api/automation')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الأتمتة.' : 'تعذّر تحميل بيانات الأتمتة.'))
    loadPanel()
  }, [])

  const bulkAccounts = async (isActive: boolean) => {
    if (sel.size === 0) return
    setPanelBusy(true)
    try {
      await api('/api/control/panel', {
        method: 'POST',
        body: JSON.stringify({ action: 'bulk_update_accounts', ids: [...sel], is_active: isActive, status: isActive ? 'active' : 'inactive' }),
      })
      setPanelMsg(`تم ${isActive ? 'تفعيل' : 'إيقاف'} ${sel.size} حساب ✅`)
      setSel(new Set())
      loadPanel()
    } catch {
      setPanelMsg('فشل التحديث — أعد المحاولة.')
    } finally {
      setPanelBusy(false)
    }
  }

  const runSweep = async () => {
    setPanelBusy(true)
    try {
      await api('/api/control/panel', { method: 'POST', body: JSON.stringify({ action: 'run_sweep_now' }) })
      setPanelMsg('تم بدء الفحص الفوري 🔄')
    } catch {
      setPanelMsg('فشل بدء الفحص.')
    } finally {
      setPanelBusy(false)
    }
  }

  const settings = data?.settings ?? null

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🤖 الأتمتة والتكامل</h2>
        <p className="page-sub">إعدادات محرّك المطابقة والقواعد ومهام الـ workers (عرض فقط — التعديل من نظام الأتمتة نفسه)</p>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}

      {crons && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>⏱️ صحة مهام الجدولة (النظام القديم)</h3>
            <span className="mono cell-sub">{crons.filter((j) => j.active).length} نشطة من {crons.length}</span>
          </div>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>#</th><th>المهمة</th><th>الجدولة</th><th>نشطة</th><th>آخر تشغيل</th><th>النتيجة</th><th>الرسالة</th></tr></thead>
            <tbody>{crons.map((j) => <tr key={j.jobid}>
              <td className="mono">{j.jobid}</td>
              <td className="mono">{j.jobname ?? '—'}</td>
              <td className="mono">{j.schedule ?? '—'}</td>
              <td>{j.active ? '●' : '○'}</td>
              <td className="mono">{j.last_start ? depositTime({ first_seen_at: j.last_start }) : '—'}</td>
              <td><span className={`pay-status-badge ${j.last_status === 'succeeded' ? 'st-paid' : j.last_status ? 'st-declined' : 'st-dim'}`}>{j.last_status ?? '—'}</span></td>
              <td className="cell-sub">{j.last_message ?? '—'}</td>
            </tr>)}</tbody>
          </table></div>
        </section>
      )}

      {settings && (
        <section className="card recent-card">
          <div className="recent-head">
            <h3>⚙️ إعدادات المحرّك</h3>
            <span className="mono cell-sub">
              حد تلقائي: {money(Number(settings.max_auto_amount ?? 0), 'EGP')} · عتبة: {String(settings.score_threshold ?? '—')}
            </span>
          </div>
          <div className="flag-grid">
            {Object.entries(FLAG_LABELS).map(([key, label]) => {
              const v = settings[key]
              if (v === undefined || v === null) return null
              return (
                <span key={key} className={`pay-status-badge ${v ? 'st-paid' : 'st-dim'}`}>
                  {v ? '●' : '○'} {label}
                </span>
              )
            })}
          </div>
        </section>
      )}

      {data && (
        <>
          <section className="card recent-card">
            <div className="recent-head"><h3>📐 القواعد ({data.rules.length})</h3></div>
            {data.rules.length === 0 && <p>لا توجد قواعد.</p>}
            {data.rules.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>النطاق</th><th>التاجر</th><th>الطريقة</th><th>المدى</th><th>الإجراء</th><th>الحالة</th></tr></thead>
                  <tbody>
                    {data.rules.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.scope_type ?? '—'}<div className="cell-sub">أولوية {r.priority ?? '—'}</div></td>
                        <td>{r.merchant ?? r.master_merchant ?? 'الكل'}</td>
                        <td>{r.payment_method ?? r.provider ?? 'الكل'}</td>
                        <td className="mono">{money(r.min_amount, '')} – {money(r.max_amount, '')}</td>
                        <td className="mono">{r.action_type ?? '—'}</td>
                        <td><span className={`pay-status-badge ${r.enabled ? 'st-paid' : 'st-dim'}`}>{r.enabled ? 'مفعّلة' : 'موقوفة'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card recent-card">
            <div className="recent-head"><h3>🧑‍💻 مهام المتصفح الأخيرة</h3></div>
            {data.jobs.length === 0 && <p>لا توجد مهام.</p>}
            {data.jobs.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>tx</th><th>المبلغ</th><th>المهمة</th><th>الحالة</th><th>المشغّل</th><th>الوقت</th></tr></thead>
                  <tbody>
                    {data.jobs.map((j) => (
                      <tr key={j.id}>
                        <td className="mono">{j.tx_id ?? '—'}</td>
                        <td className="mono">{money(j.amount, 'EGP')}</td>
                        <td className="mono">{j.mission ?? '—'} → {j.target_status ?? '—'}</td>
                        <td>
                          <span className={`pay-status-badge ${j.state === 'completed' ? 'st-paid' : j.state === 'failed' ? 'st-declined' : 'st-pending'}`}>
                            {j.state ?? '—'}
                          </span>
                          {j.last_error && <div className="cell-sub">{j.last_error.slice(0, 60)}</div>}
                        </td>
                        <td>{j.operator_username ?? 'آلي'}</td>
                        <td className="mono">{depositTime({ first_seen_at: j.completed_at ?? j.created_at })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {accounts && (
            <section className="card recent-card">
              <div className="recent-head">
                <h3>🏦 حسابات الدفع ({accounts.length})</h3>
                {sel.size > 0 && (
                  <div className="row-actions">
                    <span>{sel.size} محدد</span>
                    <button className="btn-primary btn-sm" disabled={panelBusy} onClick={() => void bulkAccounts(true)}>✅ تفعيل</button>
                    <button className="btn-ghost danger btn-sm" disabled={panelBusy} onClick={() => void bulkAccounts(false)}>⏸ إيقاف</button>
                  </div>
                )}
              </div>
              {panelMsg && <p className="cell-sub">{panelMsg}</p>}
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="check-col">
                        <input
                          type="checkbox"
                          checked={accounts.length > 0 && accounts.every((a) => sel.has(a.id))}
                          onChange={() => setSel(sel.size === accounts.length ? new Set() : new Set(accounts.map((a) => a.id)))}
                        />
                      </th>
                      <th>الحساب</th><th>التاجر</th><th>الطريقة</th><th>الأولوية</th><th>الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}>
                        <td className="check-col">
                          <input
                            type="checkbox"
                            checked={sel.has(a.id)}
                            onChange={() => setSel((p) => { const n = new Set(p); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n })}
                          />
                        </td>
                        <td className="mono">{a.label ?? '—'}</td>
                        <td>{a.merchant_name ?? '—'}</td>
                        <td>{a.method_name ?? a.method_type ?? '—'}</td>
                        <td className="mono">{a.priority ?? '—'}</td>
                        <td><span className={`pay-status-badge ${a.is_active ? 'st-paid' : 'st-dim'}`}>{a.is_active ? 'نشط' : 'موقوف'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {pf && (
            <section className="card recent-card">
              <div className="recent-head">
                <h3>🔌 Payfuture</h3>
                <button className="btn-ghost btn-sm" disabled={panelBusy} onClick={() => void runSweep()}>🔄 إعادة فحص الآن</button>
              </div>
              <div className="flag-grid">
                {pf.map((r) => (
                  <span key={r.id} className={`pay-status-badge ${r.is_active ? 'st-paid' : 'st-dim'}`}>
                    {r.is_active ? '●' : '○'} {r.name ?? r.merchant_name ?? '—'}
                  </span>
                ))}
              </div>
            </section>
          )}

          {(data.balances.length > 0 || data.rates.length > 0) && (
            <section className="card recent-card">
              <div className="recent-head"><h3>🏦 الخزينة (Binance) وأسعار الصرف</h3></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>الحساب / الزوج</th><th>القيمة</th><th>آخر قياس</th></tr></thead>
                  <tbody>
                    {data.balances.map((b, i) => (
                      <tr key={`b${i}`}>
                        <td className="mono">{b.account_id ?? '—'}</td>
                        <td className="mono">{money(b.available_balance, '')} / {money(b.total_balance, '')} (USDT {money(b.usdt_value, '')})</td>
                        <td className="mono">{depositTime({ first_seen_at: b.measured_at })}</td>
                      </tr>
                    ))}
                    {data.rates.map((r, i) => (
                      <tr key={`r${i}`}>
                        <td className="mono">{r.currency_pair ?? '—'}</td>
                        <td className="mono">{r.rate ?? '—'}</td>
                        <td className="mono">{depositTime({ first_seen_at: r.fetched_at })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </PanelShell>
  )
}
