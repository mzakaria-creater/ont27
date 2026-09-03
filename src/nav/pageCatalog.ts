// Maps the real `page_key` values in `role_page_permissions` (verified live
// against the DB — 2026-07-31) to a category + Arabic label for the dashboard
// nav/home grid. There is no labels/metadata table in the DB, so this mapping
// is maintained here. Add new page_keys to CATEGORIES as real pages ship —
// never invent a page_key that doesn't exist in the DB.

export interface Category {
  id: string
  label: string
  icon: string
  /** Matches HANDBOOK.md §5 build order — surfaced first on the dashboard home. */
  priority?: boolean
}

export const CATEGORIES: Category[] = [
  { id: 'deposits', label: 'الإيداعات', icon: '💰', priority: true },
  { id: 'payouts', label: 'السحوبات', icon: '📤' },
  { id: 'transactions', label: 'المعاملات', icon: '📋' },
  { id: 'approvals', label: 'الموافقات والمهام', icon: '✅' },
  { id: 'settlements', label: 'التسويات', icon: '🧾' },
  { id: 'merchants', label: 'التجار والوكلاء', icon: '🏬' },
  { id: 'wallets', label: 'المحافظ وطرق الدفع', icon: '👛' },
  { id: 'crm', label: 'CRM العملاء', icon: '👥' },
  { id: 'risk', label: 'المخاطر والامتثال', icon: '🛡️' },
  { id: 'automation', label: 'الأتمتة والتكامل', icon: '🤖' },
  { id: 'audit', label: 'سجل التدقيق', icon: '🕵️' },
  { id: 'admin', label: 'الإدارة والإعدادات', icon: '⚙️' },
  { id: 'reports', label: 'التقارير والتحليلات', icon: '📊' },
  { id: 'support', label: 'الدعم والإشعارات', icon: '🔔' },
]

/** page_key → { category, label } */
export const PAGE_CATALOG: Record<string, { category: string; label: string }> = {
  dashboard: { category: 'deposits', label: 'لوحة التحكم' }, // shown separately, not in a module card
  deposits: { category: 'deposits', label: 'الإيداعات' },
  sms_live: { category: 'deposits', label: 'SMS مباشر' },
  'deposit-queue': { category: 'deposits', label: 'طابور الإيداعات' },
  pending_deposits: { category: 'deposits', label: 'إيداعات معلّقة' },

  payouts: { category: 'payouts', label: 'السحوبات' },
  pending_payouts: { category: 'payouts', label: 'سحوبات معلّقة' },

  transactions: { category: 'transactions', label: 'كل المعاملات' },
  all_transactions: { category: 'transactions', label: 'كل المعاملات' },
  refunds: { category: 'transactions', label: 'المرتجعات' },
  reversals: { category: 'transactions', label: 'عمليات الإلغاء' },

  approvals: { category: 'approvals', label: 'الموافقات' },
  'approval-queue': { category: 'approvals', label: 'طابور الموافقات' },
  'my-queue': { category: 'approvals', label: 'طابوري' },
  'my-tasks': { category: 'approvals', label: 'مهامي' },
  assigned_to_me: { category: 'approvals', label: 'مُسندة إليّ' },

  settlements: { category: 'settlements', label: 'التسويات' },
  settlements_list: { category: 'settlements', label: 'قائمة التسويات' },
  settlement_recon: { category: 'settlements', label: 'مطابقة التسويات' },
  fees: { category: 'settlements', label: 'الرسوم' },

  merchants: { category: 'merchants', label: 'التجار' },
  merchant_detail: { category: 'merchants', label: 'تفاصيل التاجر' },
  'merchant-dashboard': { category: 'merchants', label: 'لوحة التاجر' },
  master_merchants: { category: 'merchants', label: 'التجار الرئيسيون' },
  sub_merchants: { category: 'merchants', label: 'التجار الفرعيون' },
  'sub-merchants': { category: 'merchants', label: 'التجار الفرعيون' },
  agents: { category: 'merchants', label: 'الوكلاء' },

  wallets: { category: 'wallets', label: 'المحافظ' },
  wallet_pool: { category: 'wallets', label: 'تجمّع المحافظ' },
  'wallet-pools': { category: 'wallets', label: 'تجمّع المحافظ' },
  accounts: { category: 'wallets', label: 'الحسابات' },
  payment_methods: { category: 'wallets', label: 'طرق الدفع' },

  client_crm: { category: 'crm', label: 'إدارة العملاء' },

  risk: { category: 'risk', label: 'المخاطر' },
  risk_audit: { category: 'risk', label: 'تدقيق المخاطر' },
  flagged: { category: 'risk', label: 'معاملات مُعلَّمة' },
  exceptions: { category: 'risk', label: 'الاستثناءات' },
  manual_review: { category: 'risk', label: 'مراجعة يدوية' },
  velocity: { category: 'risk', label: 'حدود السرعة' },
  compliance: { category: 'risk', label: 'الامتثال' },

  telegram_bot: { category: 'automation', label: 'بوت تيليجرام' },
  automation: { category: 'automation', label: 'مركز الأتمتة' },
  automation_rules: { category: 'automation', label: 'قواعد الأتمتة' },
  automation_templates: { category: 'automation', label: 'قوالب الأتمتة' },
  binance_p2p: { category: 'automation', label: 'Binance P2P' },
  treasury: { category: 'automation', label: 'الخزينة' },
  allocation_engine: { category: 'automation', label: 'محرّك التوزيع' },
  capacity_monitor: { category: 'automation', label: 'مراقبة السعة' },
  workspace_hub: { category: 'automation', label: 'مركز العمل' },
  launchpad: { category: 'automation', label: 'لوحة الانطلاق' },
  ai_team: { category: 'automation', label: 'فريق الذكاء الاصطناعي' },

  audit_log: { category: 'audit', label: 'سجل التدقيق' },
  'audit-logs': { category: 'audit', label: 'سجل التدقيق' },
  review: { category: 'audit', label: 'مراجعة القرارات' },

  users: { category: 'admin', label: 'المستخدمون' },
  permissions: { category: 'admin', label: 'الصلاحيات' },
  'api-keys': { category: 'admin', label: 'مفاتيح API' },
  webhooks: { category: 'admin', label: 'Webhooks' },
  developers: { category: 'admin', label: 'المطورون' },
  settings: { category: 'admin', label: 'الإعدادات' },
  'checkout-builder': { category: 'admin', label: 'منشئ صفحة الدفع' },

  reports: { category: 'reports', label: 'التقارير' },
  advanced_analysis: { category: 'reports', label: 'تحليلات متقدمة' },
  revenue_center: { category: 'reports', label: 'الإيرادات والعمولات' },

  support: { category: 'support', label: 'الدعم الفني' },
  team_tasks: { category: 'support', label: 'مهام فريق الدعم' },
  operator_handbook: { category: 'support', label: 'دليل المشغّل' },
  notifications: { category: 'support', label: 'الإشعارات' },
}

export function labelFor(pageKey: string): string {
  return PAGE_CATALOG[pageKey]?.label ?? pageKey
}

export function categoryFor(pageKey: string): string {
  return PAGE_CATALOG[pageKey]?.category ?? 'admin'
}
