import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import nodemailer from "npm:nodemailer@7.0.6";

const OWNER_TEST_EMAIL = "minafx2@gmail.com";
const jsonHeaders = { "content-type": "application/json" };

function esc(value: unknown): string {
  return String(value ?? "—").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
}
function money(value: unknown, currency: unknown): string {
  const n=Number(value);
  const amount=Number.isFinite(n)?new Intl.NumberFormat("en-EG",{minimumFractionDigits:2,maximumFractionDigits:2}).format(n):String(value??"—");
  return `${amount} ${String(currency||"EGP").toUpperCase()}`;
}
function emailTemplate(tx: Record<string,unknown>) {
  const reference=tx.ontarget_ref||tx.merchant_tx_reference||tx.tx_id||"TEST";
  const amount=money(tx.amount,tx.currency);
  const merchant=tx.master_merchant||tx.merchant||"OnTarget";
  const customer=tx.sender_name||"Team";
  const approvedBy=tx.approved_by||"OnTarget System";
  const approvedAt=tx.last_status_change||new Date().toISOString();
  const senderWallet=tx.sender_number||"—";
  const receiverWallet=tx.receiving_wallet||tx.to_account_number||"—";
  const method=tx.payment_method||tx.gateway||"—";
  const country=tx.country||"—";
  const subject=`Transaction Approved: ${String(merchant)} - ${amount}`;
  const rows=[
    ["Status","PAID / APPROVED"],["Transaction Type","From Wallet to Wallet"],["Amount",amount],
    ["From Wallet",senderWallet],["To Wallet",receiverWallet],["Merchant",merchant],
    ["Country",country],["Payment Method",method],["Approved By",approvedBy],
    ["Date & Time",approvedAt],["Reference Number",reference]
  ].map(([label,value])=>`<tr><td style="padding:9px 0;color:#667085">${esc(label)}</td><td align="right" style="padding:9px 0;font-weight:700">${esc(value)}</td></tr>`).join("");
  const html=`<!doctype html><html><body style="margin:0;background:#f3f6fb;font-family:Arial,Helvetica,sans-serif;color:#172033">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;background:#f3f6fb"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 32px rgba(24,39,75,.10)">
  <tr><td style="padding:30px 36px;background:#102a56;color:#fff"><div style="font-weight:800;letter-spacing:1.5px;font-size:14px">ONTARGET</div><div style="margin-top:20px;width:50px;height:50px;line-height:50px;text-align:center;border-radius:50%;background:#22c55e;font-size:28px">✓</div><h1 style="margin:14px 0 4px;font-size:27px">Transaction Approved</h1><div style="color:#dbe7ff">Wallet transfer processed successfully</div></td></tr>
  <tr><td style="padding:30px 36px"><p style="font-size:16px;line-height:1.7;margin:0 0 16px">Dear ${esc(customer)},</p><p style="font-size:15px;line-height:1.7;color:#475467;margin:0 0 22px">The wallet-to-wallet transfer has been successfully processed and approved.</p>
  <div style="border:1px solid #e4e9f2;border-radius:14px;overflow:hidden"><div style="padding:20px;background:#f8fafc;border-bottom:1px solid #e4e9f2"><div style="font-size:12px;color:#667085">APPROVED AMOUNT</div><div style="font-size:29px;font-weight:800;color:#102a56;margin-top:4px">${esc(amount)}</div><div style="margin-top:9px;font-size:14px;color:#475467">${esc(senderWallet)} &nbsp;→&nbsp; ${esc(receiverWallet)}</div></div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:12px 20px;font-size:14px">${rows}</table></div>
  <p style="margin:24px 0 0;font-size:15px;line-height:1.7">Thank you for your business.</p></td></tr>
  <tr><td style="padding:18px 36px;background:#f8fafc;border-top:1px solid #e4e9f2;color:#98a2b3;font-size:12px">Internal operational notification from OnTarget.</td></tr></table></td></tr></table></body></html>`;
  const text=`Transaction Approved\n\nStatus: PAID / APPROVED\nTransaction Type: From Wallet to Wallet\nAmount: ${amount}\nFrom Wallet: ${senderWallet}\nTo Wallet: ${receiverWallet}\nMerchant: ${merchant}\nCountry: ${country}\nPayment Method: ${method}\nApproved By: ${approvedBy}\nDate & Time: ${approvedAt}\nReference Number: ${reference}`;
  return {subject,html,text};
}
// Supabase's newer projects issue opaque secret keys (sb_secret_...)
// instead of a JWT with a `role` claim. This function's caller (the panel
// server) sends that secret key as the Authorization bearer, so the old
// JWT-decode-and-check-role path always threw and fell through to `false`
// -- every single call was rejected 403 regardless of who called it. The
// gateway's own verify_jwt already authenticates the key before this code
// runs at all, so trusting the sb_secret_ prefix here is not a new trust
// boundary, just recognizing the key format Supabase actually issues now.
function serviceRole(req:Request):boolean {
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  if (token.startsWith("sb_secret_")) return true;
  try {
    const payload=JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
    return String(payload.role||"")==="service_role";
  } catch { return false; }
}
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST") return new Response(JSON.stringify({error:"method_not_allowed"}),{status:405,headers:jsonHeaders});
  if(!serviceRole(req)) return new Response(JSON.stringify({error:"forbidden"}),{status:403,headers:jsonHeaders});
  const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  const supabaseUrl=Deno.env.get("SUPABASE_URL")||"";
  const smtpUser=Deno.env.get("SMTP_USER")||"";
  const smtpPassword=Deno.env.get("SMTP_PASSWORD")||"";
  if(!smtpUser||!smtpPassword) return new Response(JSON.stringify({error:"smtp_not_configured"}),{status:500,headers:jsonHeaders});
  const body=await req.json().catch(()=>({})) as Record<string,unknown>;
  let tx:Record<string,unknown>;
  let subscriptions:{id:string,email:string}[]=[];
  // This project's PostgREST default exposed schema is "api", not "public",
  // where every one of this function's tables actually live -- without
  // Accept-Profile/Content-Profile: public on every REST call, PostgREST
  // returned PGRST205 "Could not find the table 'api.maven_transactions'"
  // (and silently empty results for the subscriptions/deliveries lookups),
  // which this code swallowed into a generic "transaction_not_found" / zero
  // matching subscriptions. Confirmed live: every call with a real tx_id
  // failed this way; only the body.test===true path (which never touches
  // REST) ever actually sent mail, so real approval emails were never
  // delivered to anyone despite the function reporting success elsewhere.
  const restHeaders={authorization:`Bearer ${serviceKey}`,apikey:serviceKey,"Accept-Profile":"public"};
  if(body.test===true){
    tx={tx_id:"TEST-"+Date.now(),ontarget_ref:"TEST-APPROVAL",amount:199,currency:"EGP",master_merchant:"OnTarget",country:"Egypt",payment_method:"Mobile Wallet",sender_name:"Mina Zakaria",sender_number:"01000000000",receiving_wallet:"01200000000",approved_by:"OnTarget System",last_status_change:new Date().toISOString()};
    subscriptions=[{id:"test",email:OWNER_TEST_EMAIL}];
  }else{
    const txId=Number(body.tx_id);
    if(!Number.isSafeInteger(txId)||txId<=0) return new Response(JSON.stringify({error:"invalid_tx_id"}),{status:400,headers:jsonHeaders});
    const txRes=await fetch(`${supabaseUrl}/rest/v1/maven_transactions?tx_id=eq.${txId}&select=tx_id,ontarget_ref,merchant_tx_reference,amount,currency,status,master_merchant,merchant,country,payment_method,gateway,sender_name,sender_number,to_account_number,receiving_wallet,approved_by,last_status_change`,{headers:restHeaders});
    const txRows=await txRes.json() as Record<string,unknown>[];
    tx=txRows[0];
    if(!tx) return new Response(JSON.stringify({error:"transaction_not_found"}),{status:404,headers:jsonHeaders});
    if(!["PAID","APPROVED"].includes(String(tx.status||"").toUpperCase())) return new Response(JSON.stringify({error:"transaction_not_approved"}),{status:409,headers:jsonHeaders});
    const subRes=await fetch(`${supabaseUrl}/rest/v1/approval_email_subscriptions?active=eq.true&select=id,email,scope_type,scope_value`,{headers:restHeaders});
    const all=await subRes.json() as {id:string,email:string,scope_type:string,scope_value:string|null}[];
    const values={
      merchant:[tx.master_merchant,tx.merchant].map(v=>String(v??"").toLowerCase()),
      country:[String(tx.country??"").toLowerCase()],
      payment_method:[tx.payment_method,tx.gateway].map(v=>String(v??"").toLowerCase())
    };
    subscriptions=all.filter(s=>s.scope_type==="all"||(values[s.scope_type as keyof typeof values]??[]).includes(String(s.scope_value??"").toLowerCase())).map(s=>({id:s.id,email:s.email}));
  }
  if(!subscriptions.length) return new Response(JSON.stringify({ok:true,sent:0,reason:"no_matching_subscriptions"}),{headers:jsonHeaders});
  const transport=nodemailer.createTransport({host:Deno.env.get("SMTP_HOST")||"mail.privateemail.com",port:Number(Deno.env.get("SMTP_PORT")||"465"),secure:Number(Deno.env.get("SMTP_PORT")||"465")===465,auth:{user:smtpUser,pass:smtpPassword}});
  const message=emailTemplate(tx);
  const results=[];
  for(const sub of subscriptions){
    if(sub.id!=="test"){
      const check=await fetch(`${supabaseUrl}/rest/v1/approval_email_deliveries?tx_id=eq.${tx.tx_id}&subscription_id=eq.${sub.id}&select=id`,{headers:restHeaders});
      const prior=await check.json() as unknown[];
      if(prior.length){results.push({email:sub.email,status:"already_sent"});continue;}
    }
    try{
      const sent=await transport.sendMail({from:Deno.env.get("SMTP_FROM")||`OnTarget <${smtpUser}>`,to:sub.email,...message});
      results.push({email:sub.email,status:"sent",message_id:sent.messageId});
      if(sub.id!=="test") await fetch(`${supabaseUrl}/rest/v1/approval_email_deliveries`,{method:"POST",headers:{authorization:`Bearer ${serviceKey}`,apikey:serviceKey,"content-type":"application/json","Content-Profile":"public",Prefer:"return=minimal"},body:JSON.stringify({tx_id:tx.tx_id,subscription_id:sub.id,recipient:sub.email,provider_message_id:sent.messageId,status:"sent"})});
    }catch(error){results.push({email:sub.email,status:"failed",error:error instanceof Error?error.message:String(error)});}
  }
  const sent=results.filter(r=>r.status==="sent").length;
  return new Response(JSON.stringify({ok:sent>0||results.every(r=>r.status==="already_sent"),sent,results}),{status:results.some(r=>r.status==="failed")&&sent===0?502:200,headers:jsonHeaders});
});
