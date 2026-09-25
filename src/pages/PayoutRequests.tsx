import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useAuth } from '../auth/AuthContext'
import { useLocale } from '../lib/locale'
import { useIsMobile } from '../lib/useIsMobile'
import { Smartphone, Webhook, Link2, Plus, Copy, RefreshCw } from 'lucide-react'

type RequestRow = { id:string; wallet_number:string; amount:number; device:string; merchant_name:string|null; note:string|null; status:string; requested_by:string|null; approved_by:string|null; webhook_status:number|null; webhook_error:string|null; created_at:string }
type LinkRequestRow = { id:string; payout_link_id:string; reference:string; myhfm_account:string; receiver_name:string|null; receiver_wallet:string; receiver_method:string|null; amount:number; currency:string; note:string|null; status:string; reviewed_by:string|null; reviewed_at:string|null; rejection_note:string|null; converted_payout_request_id:string|null; created_at:string; payout_links:{title:string|null; client_name:string|null}|null }
type PayoutLink = { id:string; short_code:string; title:string|null; client_name:string|null; currency:string; amount_mode:'fixed'|'open'; amount:number|null; min_amount:number|null; max_amount:number|null; active:boolean; max_uses:number|null; use_count:number; expires_at:string|null; created_at:string; status:'active'|'expired'|'exhausted'|'disabled'; stats:{pending:number; converted:number; rejected:number; total_amount:number} }
export default function PayoutRequests() {
  const { can } = useAuth(); const { t } = useLocale(); const isMobile = useIsMobile(); const [rows,setRows]=useState<RequestRow[]>([]); const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null); const [busy,setBusy]=useState<string|null>(null); const [form,setForm]=useState({wallet_number:'',amount:'',device:'ont1',note:''})
  const [tab,setTab]=useState<'manual'|'link'|'manage'>('manual')
  const [linkRows,setLinkRows]=useState<LinkRequestRow[]>([]); const [linkLoading,setLinkLoading]=useState(true); const [linkError,setLinkError]=useState<string|null>(null); const [linkBusy,setLinkBusy]=useState<string|null>(null); const [convertDevice,setConvertDevice]=useState<Record<string,string>>({})
  const [payoutLinks,setPayoutLinks]=useState<PayoutLink[]>([]); const [plLoading,setPlLoading]=useState(true); const [plError,setPlError]=useState<string|null>(null); const [plBusy,setPlBusy]=useState<string|null>(null); const [copied,setCopied]=useState<string|null>(null); const [newUrl,setNewUrl]=useState<string|null>(null)
  const [plForm,setPlForm]=useState({title:'',client_name:'',currency:'EGP',amount_mode:'open',amount:'',min_amount:'',max_amount:'',max_uses:''})
  const load=useCallback(async()=>{setLoading(true);try{const r=await api<{data:RequestRow[]}>('/api/payout-requests');setRows(r.data??[]);setError(null)}catch(e){setError(e instanceof ApiError&&e.status===403?t('لا تملك صلاحية عرض الطلبات.','You do not have permission to view requests.'):t('تعذر تحميل الطلبات.','Failed to load requests.'))}finally{setLoading(false)}},[])
  const loadLinkQueue=useCallback(async()=>{setLinkLoading(true);try{const r=await api<{data:LinkRequestRow[]}>('/api/payout-requests/link-queue');setLinkRows(r.data??[]);setLinkError(null)}catch(e){setLinkError(e instanceof ApiError&&e.status===403?t('لا تملك صلاحية عرض طلبات العملاء.','You do not have permission to view client requests.'):t('تعذر تحميل طلبات العملاء.','Failed to load client requests.'))}finally{setLinkLoading(false)}},[])
  const loadPayoutLinks=useCallback(async()=>{setPlLoading(true);try{const r=await api<{links:PayoutLink[]}>('/api/payout-links');setPayoutLinks(r.links??[]);setPlError(null)}catch(e){setPlError(e instanceof ApiError&&e.status===403?t('لا تملك صلاحية عرض روابط السحب.','You do not have permission to view payout links.'):t('تعذر تحميل روابط السحب.','Failed to load payout links.'))}finally{setPlLoading(false)}},[])
  useEffect(()=>{void load();const iv=window.setInterval(()=>void load(),8000);return()=>window.clearInterval(iv)},[load])
  useEffect(()=>{void loadLinkQueue();const iv=window.setInterval(()=>void loadLinkQueue(),8000);return()=>window.clearInterval(iv)},[loadLinkQueue])
  useEffect(()=>{void loadPayoutLinks()},[loadPayoutLinks])
  const create=async(e:React.FormEvent)=>{e.preventDefault();setBusy('create');try{await api('/api/payout-requests',{method:'POST',body:JSON.stringify({...form,amount:Number(form.amount)})});setForm({wallet_number:'',amount:'',device:'ont1',note:''});await load()}catch(e){setError(e instanceof ApiError?e.message:t('فشل إنشاء الطلب.','Failed to create request.'))}finally{setBusy(null)}}
  const decide=async(id:string,action:'approve'|'reject')=>{setBusy(id);try{await api(`/api/payout-requests/${id}/decision`,{method:'POST',body:JSON.stringify({action})});await load()}catch(e){setError(e instanceof ApiError?e.message:t('فشل تنفيذ الإجراء.','Action failed.'))}finally{setBusy(null)}}
  const rejectLinkRequest=async(id:string)=>{setLinkBusy(id);try{await api(`/api/payout-requests/link-queue/${id}/reject`,{method:'POST',body:JSON.stringify({})});await loadLinkQueue()}catch(e){setLinkError(e instanceof ApiError?e.message:t('فشل الرفض.','Reject failed.'))}finally{setLinkBusy(null)}}
  const convertLinkRequest=async(id:string)=>{const device=convertDevice[id]||'ont1';setLinkBusy(id);try{await api(`/api/payout-requests/link-queue/${id}/convert`,{method:'POST',body:JSON.stringify({device})});await loadLinkQueue();await load()}catch(e){setLinkError(e instanceof ApiError?e.message:t('فشل التحويل.','Convert failed.'))}finally{setLinkBusy(null)}}
  const createPayoutLink=async(e:React.FormEvent)=>{e.preventDefault();setPlBusy('create');setPlError(null);try{const created=await api<{payout_url?:string}>('/api/payout-links',{method:'POST',body:JSON.stringify({title:plForm.title||undefined,client_name:plForm.client_name||undefined,currency:plForm.currency,amount_mode:plForm.amount_mode,amount:plForm.amount||undefined,min_amount:plForm.min_amount||undefined,max_amount:plForm.max_amount||undefined,max_uses:plForm.max_uses||undefined})});setNewUrl(created.payout_url?`${location.origin}${created.payout_url}`:null);setPlForm({title:'',client_name:'',currency:'EGP',amount_mode:'open',amount:'',min_amount:'',max_amount:'',max_uses:''});await loadPayoutLinks()}catch(e){setPlError(e instanceof ApiError?e.message:t('تعذر إنشاء الرابط.','Failed to create link.'))}finally{setPlBusy(null)}}
  const copyPayoutLink=async(l:PayoutLink)=>{setPlBusy(l.id);try{const issued=await api<{payout_url:string}>(`/api/payout-links/${l.id}/token`,{method:'POST'});const url=`${location.origin}${issued.payout_url}`;await navigator.clipboard.writeText(url);setCopied(l.id);setTimeout(()=>setCopied(null),1500);await loadPayoutLinks()}catch{setPlError(t('تعذّر إصدار رابط آمن جديد.','Could not issue a fresh secure link.'))}finally{setPlBusy(null)}}
  const togglePayoutLink=async(l:PayoutLink)=>{setPlBusy(l.id);try{await api(`/api/payout-links/${l.id}`,{method:'PATCH',body:JSON.stringify({active:!l.active})});await loadPayoutLinks()}catch{setPlError(t('تعذر تعديل الرابط.','Failed to update link.'))}finally{setPlBusy(null)}}
  const expirePayoutLink=async(l:PayoutLink)=>{if(!window.confirm(t(`إنهاء الرابط ${l.short_code} الآن؟ لا يمكن التراجع.`,`Expire link ${l.short_code} now? This cannot be undone.`)))return;setPlBusy(l.id);try{await api(`/api/payout-links/${l.id}/expire`,{method:'POST'});await loadPayoutLinks()}catch{setPlError(t('تعذّر إنهاء الرابط.','Could not expire the link.'))}finally{setPlBusy(null)}}
  const previewPhone = form.wallet_number || '01000000000'
  const previewAmount = form.amount || '0'
  const pendingLinkCount = linkRows.filter(r=>r.status==='pending').length
  const plPreviewAmount = plForm.amount_mode==='fixed'?(plForm.amount||'0'):`${plForm.min_amount||'Any'} – ${plForm.max_amount||'Any'}`
  return <><section className="page-head"><div><h2>📤 {t('طلبات السحب اليدوية','Manual payout requests')}</h2><p className="page-sub">{t('طلب → موافقة صريحة → تنفيذ USSD على الجهاز','Request → explicit approval → USSD execution on device')}</p></div></section>
  <div className="admin-tabs">
    <button className={`pill${tab==='manual'?' active':''}`} onClick={()=>setTab('manual')}><Webhook size={14}/> {t('يدوي','Manual')}</button>
    <button className={`pill${tab==='link'?' active':''}`} onClick={()=>setTab('link')}><Link2 size={14}/> {t('طلبات العملاء','Client requests')}{pendingLinkCount>0?` (${pendingLinkCount})`:''}</button>
    <button className={`pill${tab==='manage'?' active':''}`} onClick={()=>setTab('manage')}><Plus size={14}/> {t('روابط السحب','Payout links')}</button>
  </div>
  {tab==='manage'?(<>
    {plError&&<div className="card warn">{plError}</div>}
    {can('payouts','can_create')&&<section className="payment-link-builder">
      <form className="card link-form payment-link-form" onSubmit={createPayoutLink}>
        <div className="recent-head"><div><h3><Plus size={18}/>{t('إنشاء رابط سحب جديد','Create a new payout link')}</h3><span className="cell-sub">{t('رابط عام يستخدمه عميل HFM لطلب سحب — يحتاج موافقة يدوية قبل التنفيذ','A public link an HFM client uses to request a payout — needs manual approval before execution')}</span></div></div>
        <div className="grid-3">
          <label className="field"><span>{t('العنوان','Title')}</span><input value={plForm.title} onChange={e=>setPlForm({...plForm,title:e.target.value})} placeholder="HF markets payout"/></label>
          <label className="field"><span>{t('اسم العميل/البراند','Client / brand name')}</span><input value={plForm.client_name} onChange={e=>setPlForm({...plForm,client_name:e.target.value})} placeholder="HF markets"/></label>
          <label className="field"><span>{t('العملة','Currency')}</span><select value={plForm.currency} onChange={e=>setPlForm({...plForm,currency:e.target.value})}><option value="EGP">EGP</option><option value="USD">USD</option></select></label>
          <label className="field"><span>{t('نوع المبلغ','Amount type')}</span><select value={plForm.amount_mode} onChange={e=>setPlForm({...plForm,amount_mode:e.target.value})}><option value="open">{t('مفتوح','Open')}</option><option value="fixed">{t('ثابت','Fixed')}</option></select></label>
          {plForm.amount_mode==='fixed'?(
            <label className="field"><span>{t('المبلغ','Amount')} ({plForm.currency})</span><input dir="ltr" inputMode="decimal" value={plForm.amount} onChange={e=>setPlForm({...plForm,amount:e.target.value})} required/></label>
          ):(<>
            <label className="field"><span>{t('حد أدنى','Min')} ({plForm.currency})</span><input dir="ltr" inputMode="decimal" value={plForm.min_amount} onChange={e=>setPlForm({...plForm,min_amount:e.target.value})}/></label>
            <label className="field"><span>{t('حد أقصى','Max')} ({plForm.currency})</span><input dir="ltr" inputMode="decimal" value={plForm.max_amount} onChange={e=>setPlForm({...plForm,max_amount:e.target.value})}/></label>
          </>)}
          <label className="field"><span>{t('حد الاستخدامات','Usage limit')}</span><input dir="ltr" inputMode="numeric" value={plForm.max_uses} onChange={e=>setPlForm({...plForm,max_uses:e.target.value})}/></label>
        </div>
        <button className="btn-primary" disabled={plBusy==='create'}><Plus size={16}/>{plBusy==='create'?t('جارٍ الإنشاء…','Creating…'):t('إنشاء رابط السحب','Create payout link')}</button>
        {newUrl&&<div className="card success" role="status"><strong>{t('رابط السحب الآمن جاهز','Secure payout link ready')}</strong><span className="mono">{newUrl}</span><button type="button" className="btn-ghost btn-sm" onClick={()=>void navigator.clipboard.writeText(newUrl)}><Copy size={14}/>{t('نسخ','Copy')}</button><small>{t('يحتوي على رمز 256-bit؛ احتفظ به وشاركه مع العميل فقط.','Contains a 256-bit token; keep it private and share only with the client.')}</small></div>}
      </form>
      <aside className="card payment-link-preview" aria-label="Payout link preview"><span className="page-eyebrow">Live preview</span><div className="payment-link-preview-mark"><Link2 size={26}/></div><h3>{plForm.client_name||plForm.title||t('عنوان السحب','Payout title')}</h3><strong className="mono">{plPreviewAmount} {plForm.currency}</strong><button type="button" className="btn-primary" disabled>{t('إرسال طلب السحب','Submit payout request')}</button></aside>
    </section>}
    <section className="card recent-card"><div className="recent-head"><h3>{t('روابط السحب','Payout links')} ({payoutLinks.length})</h3><button className="btn-ghost btn-sm" onClick={()=>void loadPayoutLinks()}><RefreshCw size={14}/>{t('تحديث','Refresh')}</button></div>
    {plLoading&&!payoutLinks.length?<p className="sidebar-hint">{t('جارٍ التحميل…','Loading…')}</p>:!payoutLinks.length?<p className="sidebar-hint">{t('لا توجد روابط سحب بعد.','No payout links yet.')}</p>:(
      <div className="risk-card-list">
        {payoutLinks.map(l=>(
          <div key={l.id} className={`risk-row-card${l.status==='active'?'':' row-dim'}`}>
            <div className="risk-row-card-head"><span className="mono">{l.short_code}</span><span>{l.status==='active'?t('نشط','Active'):l.status==='expired'?t('منتهٍ','Expired'):l.status==='exhausted'?t('مستنفَد','Exhausted'):t('موقوف','Disabled')}</span></div>
            <div><strong>{l.client_name||l.title||'—'}</strong></div>
            <div className="cell-sub mono" dir="ltr">{l.amount_mode==='fixed'?`${l.amount} ${l.currency}`:`${l.min_amount??'∗'} – ${l.max_amount??'∗'} ${l.currency}`}</div>
            <div className="risk-row-card-foot"><span className="mono">{t('الاستخدام','Usage')}: {l.use_count}{l.max_uses?` / ${l.max_uses}`:''}</span><span className="mono">{t('قيد المراجعة','Pending')}: {l.stats.pending}</span></div>
            <div className="risk-row-card-foot"><span className="mono">{t('محوّل','Converted')}: {l.stats.converted}</span><span className="mono">{t('مرفوض','Rejected')}: {l.stats.rejected}</span></div>
            <div className="row-actions">
              {can('payouts','can_create')&&<button className="btn-ghost" disabled={plBusy===l.id} onClick={()=>void copyPayoutLink(l)}><Copy size={14}/>{copied===l.id?t('تم النسخ','Copied'):t('نسخ','Copy')}</button>}
              {can('payouts','can_create')&&<button className="btn-ghost" disabled={plBusy===l.id} onClick={()=>void togglePayoutLink(l)}>{l.active?t('إيقاف','Disable'):t('تفعيل','Enable')}</button>}
              {can('payouts','can_create')&&l.status!=='expired'&&<button className="btn-ghost danger" disabled={plBusy===l.id} onClick={()=>void expirePayoutLink(l)}>{t('إنهاء','Expire')}</button>}
            </div>
          </div>
        ))}
      </div>
    )}
    </section>
  </>):tab==='link'?(<>
    {linkError&&<div className="card warn">{linkError}</div>}
    <section className="card recent-card"><div className="recent-head"><h3>{t('طلبات السحب من روابط العملاء','Client payout-link requests')} ({linkRows.length})</h3></div>
    {linkLoading&&!linkRows.length?<p className="sidebar-hint">{t('جارٍ التحميل…','Loading…')}</p>:!linkRows.length?<p className="sidebar-hint">{t('لا توجد طلبات بعد.','No requests yet.')}</p>:(
      <div className="risk-card-list">
        {linkRows.map(r=>(
          <div key={r.id} className="risk-row-card">
            <div className="risk-row-card-head"><span className="mono">{r.reference}</span><span className={`pay-status-badge ${r.status==='converted'?'st-paid':r.status==='rejected'?'st-declined':'st-pending'}`}>{r.status}</span></div>
            <div className="cell-sub">{r.payout_links?.client_name??r.payout_links?.title??'—'}</div>
            <div className="cell-sub mono">MYHFM {r.myhfm_account} · {r.receiver_wallet}{r.receiver_name?` · ${r.receiver_name}`:''}</div>
            <div className="risk-row-card-foot"><span className="mono">{r.amount.toFixed(2)} {r.currency}</span><span className="muted">{new Date(r.created_at).toLocaleString()}</span></div>
            {r.note&&<div className="cell-sub">{r.note}</div>}
            {r.status==='pending'&&<div className="row-actions">
              {can('payouts','can_create')&&<select className="login-input btn-sm" value={convertDevice[r.id]||'ont1'} onChange={e=>setConvertDevice({...convertDevice,[r.id]:e.target.value})}>{Array.from({length:7},(_,i)=>`ont${i+1}`).map(d=><option key={d}>{d}</option>)}</select>}
              {can('payouts','can_create')&&<button className="btn-primary btn-sm" disabled={linkBusy===r.id} onClick={()=>void convertLinkRequest(r.id)}>{t('تحويل لطلب سحب','Convert to payout')}</button>}
              {can('payouts','can_approve')&&<button className="btn-ghost danger btn-sm" disabled={linkBusy===r.id} onClick={()=>void rejectLinkRequest(r.id)}>{t('رفض','Reject')}</button>}
            </div>}
            {r.status==='converted'&&r.converted_payout_request_id&&<div className="cell-sub muted">{t('تم التحويل إلى طلب سحب','Converted to payout request')} {r.converted_payout_request_id.slice(0,8)}</div>}
            {r.status==='rejected'&&r.rejection_note&&<div className="cell-sub danger-text">{r.rejection_note}</div>}
          </div>
        ))}
      </div>
    )}
    </section>
  </>):(<>
  {error&&<div className="card warn">{error}</div>}{can('payouts','can_create')&&<section className="payout-request-layout"><form className="card payout-request-form" onSubmit={create}><h3>{t('طلب سحب جديد','New payout request')}</h3><input className="login-input" required placeholder={t('رقم المحفظة','Wallet number')} value={form.wallet_number} onChange={e=>setForm({...form,wallet_number:e.target.value})}/><input className="login-input" required type="number" min="1" placeholder={t('المبلغ EGP','Amount EGP')} value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})}/><select className="login-input" value={form.device} onChange={e=>setForm({...form,device:e.target.value})}>{Array.from({length:10},(_,i)=>`ont${i+1}`).map(d=><option key={d}>{d}</option>)}</select><input className="login-input" placeholder={t('ملاحظة','Note')} value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/><button className="btn-primary" disabled={busy==='create'}><Webhook size={16}/>{t('إنشاء طلب Webhook','Create webhook request')}</button></form><div className="card ussd-preview"><div className="recent-head"><div><h3><Smartphone size={18}/> {t('معاينة USSD على الجهاز','Device USSD preview')}</h3><span className="cell-sub">{form.device} · MacroDroid</span></div></div><div className="ussd-phone"><div className="ussd-notch"/><div className="ussd-screen"><span className="ussd-carrier">Orange Money · {form.device}</span><strong>USSD request</strong><code>#7115*1*1*{previewPhone}*{previewAmount}#</code><small>{t('يُرسل فقط بعد موافقة صريحة؛ رقم PIN يبقى في الخادم.','Sent only after explicit approval; the PIN stays server-side.')}</small></div></div></div></section>}{!can('payouts','can_create')&&<div className="card info">{t('لا تملك صلاحية إنشاء طلبات السحب.','You do not have permission to create payout requests.')}</div>}<section className="card recent-card"><div className="recent-head"><h3>{t('الطلبات','Requests')} ({rows.length})</h3></div>{loading&&!rows.length?<p className="sidebar-hint">{t('جارٍ التحميل…','Loading…')}</p>:isMobile?(
<div className="risk-card-list">
  {rows.map(r=>(
    <div key={r.id} className="risk-row-card">
      <div className="risk-row-card-head"><span className="mono">{r.id.slice(0,8)}</span><span className={`pay-status-badge ${r.status==='completed'||r.status==='executing'?'st-paid':r.status==='failed'||r.status==='rejected'?'st-declined':'st-pending'}`}>{r.status}</span></div>
      <div className="cell-sub mono">{r.wallet_number} · {r.device}</div>
      <div className="risk-row-card-foot"><span className="mono">{r.amount.toFixed(2)} EGP</span><span className="muted">{r.requested_by??'—'}</span></div>
      {r.webhook_error&&<div className="cell-sub danger-text">{r.webhook_error}</div>}
      {r.status==='pending'&&can('payouts','can_approve')&&<div className="row-actions"><button className="btn-primary btn-sm" disabled={busy===r.id} onClick={()=>void decide(r.id,'approve')}>{t('موافقة','Approve')}</button><button className="btn-ghost danger btn-sm" disabled={busy===r.id} onClick={()=>void decide(r.id,'reject')}>{t('رفض','Reject')}</button></div>}
    </div>
  ))}
</div>
):<div className="table-wrap"><table className="data-table"><thead><tr><th>ID</th><th>{t('المحفظة','Wallet')}</th><th>{t('المبلغ','Amount')}</th><th>{t('الجهاز','Device')}</th><th>{t('الحالة','Status')}</th><th>{t('مقدم بواسطة','Requested by')}</th><th>{t('إجراء','Action')}</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td className="mono">{r.id.slice(0,8)}</td><td className="mono">{r.wallet_number}</td><td className="mono">{r.amount.toFixed(2)} EGP</td><td className="mono">{r.device}</td><td><span className={`pay-status-badge ${r.status==='completed'||r.status==='executing'?'st-paid':r.status==='failed'||r.status==='rejected'?'st-declined':'st-pending'}`}>{r.status}</span>{r.webhook_error&&<div className="cell-sub danger-text">{r.webhook_error}</div>}</td><td>{r.requested_by??'—'}</td><td>{r.status==='pending'&&can('payouts','can_approve')&&<div className="row-actions"><button className="btn-primary btn-sm" disabled={busy===r.id} onClick={()=>void decide(r.id,'approve')}>{t('موافقة','Approve')}</button><button className="btn-ghost danger btn-sm" disabled={busy===r.id} onClick={()=>void decide(r.id,'reject')}>{t('رفض','Reject')}</button></div>}</td></tr>)}</tbody></table></div>}</section>
  </>)}
  </>
}
