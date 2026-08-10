import { useCallback, useEffect, useState } from 'react'
import PanelShell from '../components/PanelShell'
import { api, ApiError } from '../lib/api'
import { depositTime, money } from '../lib/deposits'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'

interface Config {
  id: boolean; enabled: boolean; asset: string; network: string
  min_sweep_amount: number; max_daily_sweep_amount: number
  treasury_wallet_address: string | null; config_key: string; updated_at: string | null
}
interface Balance {
  account_id: string; total_balance: number | null; available_balance: number | null
  usdt_value: number | null; btc_value: number | null; top_assets: unknown; measured_at: string | null
}
interface Data { config: Config | null; configured: boolean; balances: Balance[] }

export default function Binance() {
  const { t } = useLocale(); const { can } = useAuth()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null)
  const [form, setForm] = useState({ treasury_wallet_address: '', asset: 'USDT', network: 'TRX', min_sweep_amount: '', max_daily_sweep_amount: '' })
  const canEdit = can('binance_p2p', 'can_edit') || can('treasury', 'can_edit')

  const load = useCallback(async () => {
    try {
      const d = await api<Data>('/api/binance'); setData(d); setErr(null)
      if (d.config) setForm({
        treasury_wallet_address: d.config.treasury_wallet_address ?? '',
        asset: d.config.asset, network: d.config.network,
        min_sweep_amount: String(d.config.min_sweep_amount ?? ''),
        max_daily_sweep_amount: String(d.config.max_daily_sweep_amount ?? ''),
      })
    } catch (e) { setErr(e instanceof ApiError && e.status === 403 ? t('لا تملك صلاحية الخزينة.', 'No treasury permission.') : t('تعذر التحميل.', 'Unable to load.')) }
  }, [t])
  useEffect(() => { void load() }, [load])

  const save = async (e: React.FormEvent, enabled?: boolean) => {
    e.preventDefault(); setMsg(null)
    try {
      const body: Record<string, unknown> = {
        treasury_wallet_address: form.treasury_wallet_address.trim() || null,
        asset: form.asset, network: form.network,
        min_sweep_amount: Number(form.min_sweep_amount) || 0,
        max_daily_sweep_amount: Number(form.max_daily_sweep_amount) || 0,
      }
      if (enabled !== undefined) body.enabled = enabled
      await api('/api/binance/config', { method: 'PUT', body: JSON.stringify(body) })
      setMsg(t('تم الحفظ.', 'Saved.')); await load()
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 400 ? t('تحقق من البيانات — لا يمكن التفعيل بدون عنوان محفظة.', 'Check inputs — cannot enable without a wallet address.') : t('تعذر الحفظ.', 'Unable to save.'))
    }
  }

  const cfg = data?.config
  return <PanelShell>
    <section className="page-head"><h2>🪙 {t('خزينة USDT (Binance)', 'USDT Treasury (Binance)')}</h2><p className="page-sub">{t('إعداد محفظة الخزينة وحدود التجميع. لا تُعرض أرصدة إلا بعد المزامنة الفعلية.', 'Configure the treasury wallet and sweep limits. Balances appear only after a real sync.')}</p></section>
    {err && <div className="card warn">{err}</div>}
    {msg && <div className="card">{msg}</div>}
    {!data && !err && <p className="sidebar-hint">{t('جار التحميل…', 'Loading…')}</p>}

    {data && (<>
      {!data.configured && <div className="card warn">⚙️ {t('لم تُهيَّأ الخزينة بعد — أدخل عنوان محفظة الخزينة أدناه للبدء.', 'Treasury not configured yet — enter a treasury wallet address below to start.')}</div>}

      <section className="card recent-card">
        <div className="recent-head"><h3>{t('الإعداد', 'Configuration')}</h3>
          <span className={`pay-status-badge ${cfg?.enabled ? 'st-paid' : 'st-dim'}`}>{cfg?.enabled ? t('مفعّلة', 'Enabled') : t('موقوفة', 'Disabled')}</span>
        </div>
        <form onSubmit={(e) => save(e)}>
          <div className="binance-grid">
            <label className="filter-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>{t('عنوان محفظة الخزينة', 'Treasury wallet address')}
              <input className="login-input" value={form.treasury_wallet_address} disabled={!canEdit} onChange={(e) => setForm({ ...form, treasury_wallet_address: e.target.value })} placeholder="TRX / EVM address" aria-label={t('عنوان محفظة الخزينة', 'Treasury wallet address')} /></label>
            <label className="filter-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>{t('العملة', 'Asset')}
              <input className="login-input" value={form.asset} disabled={!canEdit} onChange={(e) => setForm({ ...form, asset: e.target.value })} aria-label={t('العملة', 'Asset')} /></label>
            <label className="filter-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>{t('الشبكة', 'Network')}
              <input className="login-input" value={form.network} disabled={!canEdit} onChange={(e) => setForm({ ...form, network: e.target.value })} aria-label={t('الشبكة', 'Network')} /></label>
            <label className="filter-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>{t('أدنى مبلغ تجميع', 'Min sweep amount')}
              <input className="login-input" type="number" min={0} step="any" value={form.min_sweep_amount} disabled={!canEdit} onChange={(e) => setForm({ ...form, min_sweep_amount: e.target.value })} aria-label={t('أدنى مبلغ تجميع', 'Min sweep amount')} /></label>
            <label className="filter-field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>{t('أقصى تجميع يومي', 'Max daily sweep')}
              <input className="login-input" type="number" min={0} step="any" value={form.max_daily_sweep_amount} disabled={!canEdit} onChange={(e) => setForm({ ...form, max_daily_sweep_amount: e.target.value })} aria-label={t('أقصى تجميع يومي', 'Max daily sweep')} /></label>
          </div>
          {canEdit && <div className="control-row" style={{ marginTop: 12 }}>
            <button className="btn-primary btn-sm" type="submit">{t('حفظ', 'Save')}</button>
            {cfg?.enabled
              ? <button className="btn-ghost btn-sm" type="button" onClick={(e) => save(e, false)}>{t('إيقاف التجميع', 'Disable sweeping')}</button>
              : <button className="btn-ghost btn-sm" type="button" onClick={(e) => save(e, true)} disabled={!form.treasury_wallet_address.trim()}>{t('تفعيل التجميع', 'Enable sweeping')}</button>}
          </div>}
          {cfg?.updated_at && <p className="page-sub">{t('آخر تحديث', 'Last updated')}: <span className="mono">{depositTime({ first_seen_at: cfg.updated_at })}</span></p>}
        </form>
      </section>

      <section className="card recent-card">
        <div className="recent-head"><h3>{t('الأرصدة', 'Balances')}</h3></div>
        {data.balances.length === 0
          ? <p className="sidebar-hint">{t('لا توجد أرصدة مُزامَنة بعد. تظهر هنا بمجرد أول مزامنة فعلية من Binance.', 'No balances synced yet. They appear here after the first real Binance sync.')}</p>
          : <div className="table-wrap"><table className="data-table">
              <thead><tr><th>{t('الحساب', 'Account')}</th><th>{t('الإجمالي', 'Total')}</th><th>{t('المتاح', 'Available')}</th><th>USDT</th><th>{t('آخر قياس', 'Measured')}</th></tr></thead>
              <tbody>{data.balances.map((b) => <tr key={b.account_id}><td className="mono">{b.account_id.slice(0, 8)}</td><td className="mono">{money(b.total_balance, 'USDT')}</td><td className="mono">{money(b.available_balance, 'USDT')}</td><td className="mono">{money(b.usdt_value, 'USDT')}</td><td className="mono">{b.measured_at ? depositTime({ first_seen_at: b.measured_at }) : '—'}</td></tr>)}</tbody>
            </table></div>}
      </section>
    </>)}
  </PanelShell>
}
