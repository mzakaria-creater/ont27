# HANDBOOK — دليل تشغيل OnTarget Panel v2 (`ont27`)

مرجع تشغيلي للمشروع. كل ما هنا مؤكد بفحص مباشر بتاريخ 2026-07-30 — لو شكيت في معلومة، تحقق من المصدر الحي وحدّث الملف.

## 1) خريطة الـ Stack (المؤكدة)

| المكوّن | القيمة | التحقق |
|---|---|---|
| Gateway API الحي | `api.ontarget-egy.com` + `checkout.ontarget-egy.com` | Railway project **`ontarget-v1-api`** service `api` env `production` |
| مصدر النشر | GitHub **`mzakaria-creater/ontarget-nexus`** branch **`main`** (auto-deploy) | `railway status --json` → `activeDeployments.meta` |
| Supabase production | **`yvwppyoaksyhycimvgtw`** (ontarget-egy، eu-west-2) — schema **`public`** | Railway env vars الحية + السورس |
| Supabase Panel v2 | **`iwhjmhazcvctvipoasct`** (ontarget-panel-v2، eu-west-2) | متهاجرة بالكامل (القسم 3) |
| الواجهة الجديدة | مجلد `~/Desktop/ont27` → GitHub repo `ont27` → Vercel | هذا المشروع |
| الدومينات | `ontarget-egy.com` (رئيسي)، `d.ontarget-egy.com` (dashboard) | DNS |

⚠️ **مصايد معروفة:**
- على Railway توجد مشاريع كثيرة متشابهة الأسماء (`ontarget-api-v3`, `ontarget-api` ×2, `ontarget-sandbox-api`...) — الحي الوحيد هو `ontarget-v1-api`.
- مجلد `~/Desktop/https-ontarget-egy-com` كوده قريب من المنشور لكنه **ليس** مصدر النشر.
- مجلد `~/Desktop/ontarget-nexus-main` نسخة محلية **متباعدة قليلاً** عن GitHub main — الحقيقة عند GitHub.
- `ontarget-api-v3` (schema `ontarget`) غير منشور — مرجع تصميم Hosted Checkout فقط.

## 2) التشغيل المحلي

```bash
cd ~/Desktop/ont27
npm install
npm run dev        # → http://localhost:5173
```

الـ `.env` (غير مرفوع على git):
```
VITE_SUPABASE_URL=https://iwhjmhazcvctvipoasct.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

## 3) قاعدة بيانات Panel v2 — الحالة المهاجَرة

جداول موجودة فعلاً في `iwhjmhazcvctvipoasct` schema `public` (كلها RLS enabled):

- **العمليات:** `maven_transactions` (~13.9k)، `maven_payout_transactions` (13)، `browser_jobs` (فارغ عمداً — الأرشيف القديم خارج القاعدة)، `transaction_actions`
- **التجار:** `master_merchants` (NGPay + PayFuture)، `merchants` (11)، `merchants_hierarchy` (7)، `merchant_api_keys`
- **الأتمتة:** `automation_settings` (Kill Switches)، `automation_rules_scoped` (3)، `maven_runtime_config` (37 — **أسرار، لا logs ولا commits**)
- **SMS matching:** `inbound_sms`، `sms_balance_chains`، `sms_maven_matches`
- **CRM + Risk:** `crm_clients`، `crm_client_names`، `client_transactions`، `api_risk_blacklist` (4,854)
- **الأجهزة:** `device_status`، `wallet_device_map` (ont1–ont6)، `wallet_device_history`
- **Auth/RBAC:** `panel_users` (5)، `app_roles` (21 — بعد توحيد الأزواج المتطابقة)، `role_page_permissions` (525)، `role_migration_map`، `panel_users_2fa`، `panel_refresh_tokens`
- **الجديد كلياً:** `local_deposit_channels` (4)، `exchange_rate_sources` (9)، `exchange_rates`، `checkout_sessions` (نظيف)، `audit_log`، `idempotency_keys`، `binance_treasury_config`، `binance_account_balances`

## 4) القواعد المعمارية غير القابلة للكسر

1. **Provider-agnostic دائماً:** لا `if merchant === 'ngpay'` بدون فرع عام. NGPay وPayFuture صفوف بيانات في `master_merchants`، ليست أسماء مثبتة في الكود.
2. **التسمية:** "Maven" اسم vendor داخلي — لا يظهر في أي UI أو رسالة. OnTarget هو الاسم العام.
3. **كل provider له طابور/معالج منفصل** — لا طابور عام بفلترة لاحقة (درس `claim_browser_jobs` القديم).
4. **أي إجراء على معاملة يحدد الـ endpoint ديناميكياً** حسب `master_merchant` مع خطأ صريح للمجهول (درس `Monitor.jsx` القديم).
5. **الأمان:** لا Bearer مشترك؛ JWT مخصص فوق `panel_users` في httpOnly cookie؛ Idempotency-Key على كل POST مغيّر للحالة؛ RLS فعلي؛ 2FA إلزامي لأي دور `can_approve`؛ `audit_log` يميّز `auto_trigger` عن `manual_panel` دائماً.
6. **Frontend لا يحمل غير publishable key** — أي وصول بيانات يمر عبر طبقة API بالـ JWT المخصص.
7. **ألوان الحالة محجوزة حصرياً:** PENDING كهرماني / PAID أخضر / DECLINED أحمر — لا تُستخدم لأي غرض آخر.
8. **أعمدة الجداول:** `ontarget_ref` والمبلغ والحالة أول 3 أعمدة دائماً (sticky).
9. **مؤشر الحداثة إلزامي:** "آخر تحديث منذ X ثانية" + حالة الاتصال في كل شاشة تعتمد بيانات حية.

## 5) ترتيب بناء الصفحات (لا قفز)

Auth + RBAC → Dashboard → **Deposits (الأولوية التشغيلية القصوى)** → Payouts → Merchants/Wallets/CRM → Automation Settings (Kill Switch) → Device Monitor → Telegram/Binance → AI Assistant.

بعد كل صفحة: اختبار فعلي ضد قاعدة panel-v2 (لا mock)، والتأكد أن أي approve/decline يوجَّه حسب `master_merchant` قبل الانتقال.

## 6) أوامر تشخيص سريعة

```bash
# مصدر النشر الحي على Railway
railway link -p ontarget-v1-api -e production && railway status --json

# env vars الحية
railway variables --kv

# أي مشروع Supabase؟ (الـ ground truth)
grep SUPABASE_URL <repo>/.env
```

## 7) نشر الواجهة

- Push إلى `main` في repo `ont27` → Vercel ينشر تلقائياً بعد ربط الـ repo.
- يدوياً: `vercel --prod` من مجلد المشروع.
