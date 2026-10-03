import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { useLocale } from '../lib/locale'

// All Transactions → AI Gateway: an operator describes a transaction or
// error pattern in free text; server/transactionsAi.ts answers with likely
// causes and next steps grounded in this panel's real mechanics (rule
// matching, SMS linking, Maven reconciliation, known worker failures).
export default function AiGatewayPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLocale()
  const [description, setDescription] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = description.trim()
    if (!trimmed || busy) return
    setBusy(true); setErr(null); setAnswer(null)
    try {
      const result = await api<{ answer: string }>('/api/transactions-ai/diagnose', { method: 'POST', body: JSON.stringify({ description: trimmed }) })
      setAnswer(result.answer)
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 501
        ? t('ميزة الذكاء الاصطناعي غير مُفعّلة على هذا الخادم.', 'The AI feature is not configured on this server.')
        : e instanceof ApiError && e.status === 403
          ? t('لا تملك صلاحية استخدام هذه الميزة.', 'You do not have permission to use this feature.')
          : t('تعذّر الحصول على إجابة. حاول مرة أخرى.', 'Could not get an answer. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card ai-gateway-panel" role="region" aria-label="AI Gateway">
      <div className="ai-gateway-head">
        <span className="ai-gateway-title"><Sparkles size={16} aria-hidden="true" /> {t('بوابة الذكاء الاصطناعي', 'AI Gateway')}</span>
        <button type="button" className="sms-widget-icon-btn" onClick={onClose} aria-label={t('إغلاق', 'Close')} title={t('إغلاق', 'Close')}><X size={15} /></button>
      </div>
      <p className="cell-sub ai-gateway-hint">{t('صف المعاملة أو نمط الخطأ الذي تراه، وستظهر الأسباب المحتملة والخطوات التالية.', "Describe the transaction or error pattern you're seeing — likely causes and next steps show up below.")}</p>
      <textarea
        className="login-input ai-gateway-input"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit() }}
        placeholder={t('مثال: معاملة معتمدة على Maven لكنها بانتظار عندنا منذ 20 دقيقة…', "e.g. transaction shows approved on Maven but still pending on our side for 20 minutes…")}
      />
      <div className="ai-gateway-actions">
        <button type="button" className="btn-primary btn-sm" disabled={busy || !description.trim()} onClick={() => void submit()}>
          {busy ? t('جارٍ التحليل…', 'Analyzing…') : t('تحليل', 'Analyze')}
        </button>
        <span className="cell-sub">{t('Ctrl+Enter للإرسال', 'Ctrl+Enter to submit')}</span>
      </div>
      {err && <div className="card warn ai-gateway-error">{err}</div>}
      {answer && <div className="ai-gateway-answer" dir="auto">{answer}</div>}
    </section>
  )
}
