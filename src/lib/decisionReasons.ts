// Arabic reasons for a manual deposit decision.
//
// Why this exists: of 2,142 manual decisions in the last 30 days, 1,904 (89%)
// were recorded with no reason at all — including 217 approvals, where money
// was released and nothing says why. The endpoint has always accepted a `note`;
// no screen in the panel ever sent one. Presets make recording a reason one
// click, so the honest path is also the fast one.
//
// Approve and decline get different lists because they are different acts: an
// approval says what convinced us the money arrived, a decline says what was
// missing. A single shared list would collapse that distinction.

export const APPROVE_REASONS = [
  'تم تأكيد وصول المبلغ من رسالة المحفظة',
  'تم التحقق من الإيصال المرفق',
  'العميل حوّل من رقم مختلف — تم التحقق منه',
  'المبلغ مختلف عن المطلوب — قُبل بعد المراجعة',
  'الرسالة وصلت متأخرة — تم ربطها يدوياً',
] as const

export const DECLINE_REASONS = [
  'لا توجد رسالة تؤكد وصول المبلغ',
  'المبلغ المُحوَّل مختلف عن المطلوب',
  'الإيصال غير صالح أو مكرر',
  'رقم محظور',
  'انتهت المهلة ولم يصل تحويل',
  'تحويل مكرر — سبق اعتماده',
] as const

export function reasonsFor(action: 'approve' | 'decline'): readonly string[] {
  return action === 'approve' ? APPROVE_REASONS : DECLINE_REASONS
}

// Long enough to exclude "ok", "تم", and a stray keypress, short enough that a
// real short reason still passes. The server enforces the same floor — a rule
// only the browser applies is not a rule.
export const MIN_REASON_LENGTH = 4

export function reasonIsValid(reason: string): boolean {
  return reason.trim().length >= MIN_REASON_LENGTH
}
