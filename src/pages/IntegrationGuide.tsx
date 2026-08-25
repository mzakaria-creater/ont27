import { useState } from 'react'
import PanelShell from '../components/PanelShell'
import { useLocale } from '../lib/locale'
import { Check, Copy, ExternalLink, ShieldCheck } from 'lucide-react'

const sections = [
  ['introduction', 'Introduction'], ['getting-started', 'Getting started'], ['authentication', 'Authentication'],
  ['quick-start', 'Quick start'], ['create-payment', 'Create payment'], ['checkout', 'Checkout & iframe'],
  ['webhooks', 'Webhooks'], ['status', 'Transaction status'], ['errors', 'Errors'], ['best-practices', 'Best practices'],
] as const

const createExample = `curl --request POST 'https://api.ontarget-egy.com/v1/checkout/create' \\
  --header 'Authorization: Bearer YOUR_API_KEY' \\
  --header 'Content-Type: application/json' \\
  --data '{
    "merchant_ref": "ORDER-10001",
    "amount": 500,
    "currency": "EGP",
    "callback_url": "https://merchant.example/webhooks/ontarget",
    "return_url": "https://merchant.example/payment/complete",
    "customer_phone": "01000000000"
  }'`

const webhookExample = `{
  "event": "payment.approved",
  "transaction_id": "TRX-20260825-A1B2C3D4",
  "merchant_ref": "ORDER-10001",
  "status": "approved",
  "amount": 500,
  "currency": "EGP"
}`

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false)
  return <div className="guide-code"><button onClick={() => void navigator.clipboard.writeText(children).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? 'Copied' : 'Copy'}</button><pre><code>{children}</code></pre></div>
}

export default function IntegrationGuide() {
  const { t } = useLocale()
  return <PanelShell>
    <section className="guide-hero">
      <div><span className="guide-eyebrow">ON TARGET · MERCHANT DOCUMENTATION</span><h2>API Integration Guide</h2><p>{t('مرجع عملي كامل لربط التاجر بواجهة الدفع والاستعلام وWebhooks.', 'Production integration reference for checkout, status queries, and webhooks.')}</p></div>
      <div className="guide-version"><ShieldCheck size={20}/><span>API v1</span><small>Updated August 2026</small></div>
    </section>
    <div className="guide-layout">
      <aside className="card guide-toc"><strong>Contents</strong>{sections.map(([id,label],i)=><a key={id} href={`#${id}`}><span>{String(i+1).padStart(2,'0')}</span>{label}</a>)}</aside>
      <article className="card guide-doc">
        <section id="introduction"><h3>1. Introduction</h3><p>On Target provides hosted and embedded payment checkout, server-side transaction creation, signed status notifications, and transaction status lookup.</p><div className="guide-callout success"><Check size={18}/> Use the API from your secure backend. Never expose a secret key in browser code.</div></section>
        <section id="getting-started"><h3>2. Getting started</h3><div className="guide-grid"><div><strong>API base URL</strong><code>https://api.ontarget-egy.com/v1</code></div><div><strong>Authentication</strong><code>Bearer YOUR_API_KEY</code></div><div><strong>Payload format</strong><code>application/json</code></div><div><strong>Supported currencies</strong><code>EGP · USD · EUR</code></div></div></section>
        <section id="authentication"><h3>3. Authentication</h3><p>Send the merchant API key in every protected request. Store API and secret keys only in server-side secrets.</p><Code>{`Authorization: Bearer YOUR_API_KEY\nContent-Type: application/json`}</Code></section>
        <section id="quick-start"><h3>4. Quick start</h3><ol><li>Create a checkout session from your backend.</li><li>Redirect the customer to <code>checkout_url</code> or render <code>iframe_url</code>.</li><li>Receive the webhook, validate its signature, and respond with HTTP 2xx.</li><li>Confirm final state through the transaction status endpoint.</li></ol></section>
        <section id="create-payment"><h3>5. Create payment</h3><div className="guide-endpoint"><b>POST</b><code>/checkout/create</code></div><Code>{createExample}</Code><div className="table-wrap"><table className="data-table"><thead><tr><th>Field</th><th>Required</th><th>Description</th></tr></thead><tbody>{[['merchant_ref','Yes','Unique per merchant'],['amount','Yes','Positive payment amount'],['currency','Yes','EGP, USD, or EUR'],['callback_url','Optional','HTTPS webhook endpoint'],['return_url','Optional','Customer return URL'],['customer_phone','Optional','Customer mobile number'],['description','Optional','Payment description'],['metadata','Optional','Merchant JSON metadata']].map(r=><tr key={r[0]}><td><code>{r[0]}</code></td><td>{r[1]}</td><td>{r[2]}</td></tr>)}</tbody></table></div></section>
        <section id="checkout"><h3>6. Checkout & iframe</h3><Code>{`<iframe\n  src="CHECKOUT_IFRAME_URL_FROM_API"\n  title="On Target checkout"\n  allow="payment"\n></iframe>`}</Code><div className="guide-callout warn">Only use the checkout or iframe URL returned by the API. Do not construct or reuse expired session URLs.</div></section>
        <section id="webhooks"><h3>7. Webhooks</h3><p>Events include <code>payment.created</code>, <code>payment.processing</code>, <code>payment.approved</code>, <code>payment.declined</code>, and <code>payment.expired</code>.</p><Code>{webhookExample}</Code><ul><li>Validate the signature against the raw request body.</li><li>Deduplicate events by transaction and event ID.</li><li>Return 2xx quickly, then process asynchronously.</li></ul></section>
        <section id="status"><h3>8. Transaction status</h3><div className="guide-endpoint get"><b>GET</b><code>/transaction/status?transaction_id=TRX-...</code></div><Code>{`curl 'https://api.ontarget-egy.com/v1/transaction/status?transaction_id=TRX-20260825-A1B2C3D4' \\
  --header 'Authorization: Bearer YOUR_API_KEY'`}</Code></section>
        <section id="errors"><h3>9. Error handling</h3><div className="table-wrap"><table className="data-table"><thead><tr><th>Code</th><th>Meaning</th><th>Action</th></tr></thead><tbody>{[['UNAUTHORIZED','Missing or invalid API key','Check Authorization header'],['VALIDATION_ERROR','Invalid request fields','Correct the request body'],['DUPLICATE_REFERENCE','Merchant reference already exists','Reuse the original transaction'],['NOT_FOUND','Transaction not found','Check transaction ID'],['RATE_LIMITED','Too many requests','Retry with exponential backoff']].map(r=><tr key={r[0]}>{r.map(v=><td key={v}><code>{v}</code></td>)}</tr>)}</tbody></table></div></section>
        <section id="best-practices"><h3>10. Best practices</h3><ul><li>Keep secret keys in a vault and rotate them regularly.</li><li>Use a unique merchant reference and idempotency for every order.</li><li>Store every returned transaction ID.</li><li>Never mark an order paid from the browser return URL alone.</li><li>Log request IDs without logging credentials or full sensitive payloads.</li></ul></section>
        <footer className="guide-footer"><span>On Target API v1</span><a href="https://api.ontarget-egy.com/v1/health" target="_blank" rel="noreferrer">API health <ExternalLink size={13}/></a></footer>
      </article>
    </div>
  </PanelShell>
}
