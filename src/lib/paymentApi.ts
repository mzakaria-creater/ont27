// Public checkout/payout API base — cut over from the Node routes
// (/api/pay/*, served by the Vercel deployment and its Railway mirror) to
// the Supabase Edge Function port (supabase/functions/payment-api/), which
// is a verified line-by-line port of the same server/pay.ts logic against
// the same panel-v2 database. Centralized here so a rollback (if something
// unexpected shows up in real traffic) is a one-line change back to
// '/api/pay', not a hunt through every call site.
export const PAYMENT_API_BASE = 'https://iwhjmhazcvctvipoasct.supabase.co/functions/v1/payment-api'
