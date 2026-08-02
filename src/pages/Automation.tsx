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
  maven_enabled: 'Maven',
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

export default function Automation() {
  const [data, setData] = useState<{
    settings: Record<string, unknown> | null
    rules: RuleRow[]
    jobs: JobRow[]
    balances: BalanceRow[]
    rates: RateRow[]
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api<NonNullable<typeof data>>('/api/automation')
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError && e.status === 403 ? 'لا تملك صلاحية عرض الأتمتة.' : 'تعذّر تحميل بيانات الأتمتة.'))
  }, [])

  const settings = data?.settings ?? null

  return (
    <PanelShell>
      <section className="page-head">
        <h2>🤖 الأتمتة والتكامل</h2>
        <p className="page-sub">إعدادات محرّك المطابقة والقواعد ومهام الـ workers (عرض فقط — التعديل من نظام الأتمتة نفسه)</p>
      </section>

      {err && <div className="card warn">{err}</div>}
      {!data && !err && <p className="sidebar-hint">جارٍ التحميل…</p>}

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
