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
- `ontarget-api-v3` (schema `ontarget`) **منشور على URL بتاعه** `ontarget-api-v3-production.up.railway.app` لكنه ليس اللي وراء `api.ontarget-egy.com` — مرجع تصميم Hosted Checkout (راجع 5.7).

## 2) التشغيل المحلي

```bash
cd ~/Desktop/ont27
npm install
npm run dev        # web → http://localhost:5173 + API (Hono) → http://localhost:8787
```

`npm run dev` بيشغّل الاتنين معاً (concurrently): Vite للواجهة + `tsx watch server/local.ts` للـ API، مع proxy `/api` → 8787 فالكوكيز same-origin. على Vercel نفس الـ Hono app بيتخدم من `api/[[...path]].ts` — مفيش دوال منفصلة لكل endpoint (اتوحدت بعد دمج جلسة 2026-07-31). تفاصيل الـ Auth في [docs/AUTH.md](AUTH.md).

الـ `.env` (غير مرفوع على git):
```
VITE_SUPABASE_URL=https://iwhjmhazcvctvipoasct.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
# server-side فقط (الأسماء الموحدة بعد الدمج — لا تستخدم SUPABASE_SERVICE_ROLE_KEY أو PANEL_AUTH_JWT_SECRET):
SUPABASE_URL=https://iwhjmhazcvctvipoasct.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...        # يتظبط في Vercel env قبل النشر
PANEL_JWT_SECRET=<64 hex>                # يتظبط في Vercel env قبل النشر
PANEL_2FA_ENC_KEY=<base64/hex 32 bytes>  # تشفير TOTP secrets — openssl rand -hex 32
TELEGRAM_BOT_TOKEN=...                   # اختياري — إشعار طلبات الإيداع
TELEGRAM_CHAT_ID=...
```

## 2.5) Auth + RBAC (مبني ومختبر 2026-07-30)

- **API:** Hono تحت `server/` — `/api/auth/login|refresh|logout|me`، JWT (HS256، 15 دقيقة) في cookie `ot_access` httpOnly + refresh token (30 يوم، SHA-256 في `panel_refresh_tokens`) في `ot_refresh` على path `/api/auth` مع **rotation وكشف replay** (إعادة استخدام token قديم = سحب كل الجلسات).
- **Passwords:** المخزون القديم SHA-256 غير مملّح — الترقية لـ bcrypt cost 12 تلقائية عند أول login ناجح. lockout بعد 5 محاولات فاشلة لمدة 15 دقيقة (`failed_login_count`/`locked_until`).
- **RBAC:** middleware `requirePerm(page_key, action)` من `role_page_permissions`. الواجهة بتقرأ الـ matrix من `/api/auth/me` (`can()` في `AuthContext`).
- **Audit:** كل login/logout/فشل بيتسجل في `audit_log` بـ `actor_type='manual_panel'` (الـ constraint بيسمح فقط بـ `auto_trigger|manual_panel|system`).
- **2FA:** الجداول جاهزة (`panel_users_2fa`) — الـ enrollment UI **لسه**، وإلزامي قبل فتح شاشات فيها approve.

## 2.6) صفحات الدفع العامة (مبنية ومختبرة 2026-07-30)

- **`/payment-checkout`** (عام، `?code=` اختياري): موبايل + مبلغ → session في `checkout_sessions` (15 دقيقة) مع **allocation ديناميكي** (`server/allocate.ts`): قناة active من `local_deposit_channels` حسب العملة → أجهزتها → المحافظ من `wallet_device_map` (أونلاين حسب `device_status`، الأقل تحميلاً pending أولاً). بيعرض رقم المحفظة + QR بنفسجي + نسخ/تحميل/فتح تطبيق (لو `config.deeplink_template` موجود في القناة). إشعار Telegram اختياري env-driven.
- **`/payment-status?id=`** (عام): polling كل 5 ثوانٍ، timeline، بيقف تلقائياً عند حالة نهائية. statuses: `pending → processing → approved|declined` + `expired` (مشتقة من `expires_at`).
- **`/merchant-link-generator`** (محمي بـ RBAC صفحة `checkout-builder` — حالياً super_admin فقط create/edit و merchant_admin view): جدول `payment_links` جديد (fixed/open، min/max، expiry، max_uses، short_code من alphabet بدون حروف ملتبسة) + عدّاد ذري عبر function `use_payment_link` (service_role فقط). إحصائيات لكل رابط من جلساته.
- **Webhook للتاجر:** `server/notify.ts` بيبعت على `merchants.callback_url` بتوقيع HMAC-SHA256 (`X-OnTarget-Signature` بـ `callback_secret`) — **من غير retry queue بعد** (يتبني مع صفحة الإيداعات).
- ⚠️ الـ providers per-wallet من `wallet_device_map.provider` (فيه vodafone-cash فعلاً تحت قناة Orange Cash Egypt) — العرض ديناميكي، ممنوع تثبيت اسم مزوّد في الكود.

## 3) قاعدة بيانات Panel v2 — الحالة المهاجَرة

جداول موجودة فعلاً في `iwhjmhazcvctvipoasct` schema `public` (كلها RLS enabled):

- **العمليات:** `maven_transactions` (~13.9k)، `maven_payout_transactions` (13)، `browser_jobs` (فارغ عمداً — الأرشيف القديم خارج القاعدة)، `transaction_actions`
- **التجار:** `master_merchants` (NGPay + PayFuture)، `merchants` (11)، `merchants_hierarchy` (7)، `merchant_api_keys`
- **الأتمتة:** `automation_settings` (Kill Switches)، `automation_rules_scoped` (3)، `maven_runtime_config` (37 — **أسرار، لا logs ولا commits**)
- **SMS matching:** `inbound_sms`، `sms_balance_chains`، `sms_maven_matches`
- **CRM + Risk:** `crm_clients`، `crm_client_names`، `client_transactions`، `api_risk_blacklist` (79 — صفّ واحد لكل رقم؛ كانت 5,168 صفاً مكرّراً قبل تنظيف 2026-08-21)
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

✅ Auth + RBAC (2026-07-30 — تفاصيل كاملة في [docs/AUTH.md](AUTH.md), بما فيها قرار تعطيل 2FA وفجوة تشفير كلمة المرور غير المحسومة بعد) → **Dashboard (التالي)** → **Deposits (الأولوية التشغيلية القصوى)** → Payouts → Merchants/Wallets/CRM → Automation Settings (Kill Switch) → Device Monitor → Telegram/Binance → AI Assistant.

بعد كل صفحة: اختبار فعلي ضد قاعدة panel-v2 (لا mock)، والتأكد أن أي approve/decline يوجَّه حسب `master_merchant` قبل الانتقال.

## 5.5) مرجع الـ Hosted Checkout

- `reference/checkout.html` — نسخة طبق الأصل من صفحة الـ checkout الحية (بتكلم `pay.ontarget-egy.com/api/v1/transaction/...`): AR/EN، 4 طرق دفع (manual / QR / USSD / redirect)، countdown للـ expiry، dynamic fields من الـ API، رفع إثبات دفع ثم تحويل لـ `waiting.html`. **دي مرجع الـ UX والـ flow** لما نبني الـ checkout الجديد (Next.js، مؤجل حسب القرار #1) مع schema `ontarget` في `ontarget-api-v3`.
- `reference/checkout-branded.html` — نفس الصفحة بهوية OnTarget الجديدة (bullseye logo + purple/blue بدل الذهبي/البرتقالي؛ الذهبي اتساب للـ timer/تحذير الانتهاء فقط كدلالة).
- ملاحظات للبناء الجديد: الصفحة الحالية بتحمّل مكتبة QR من CDN خارجي (jsdelivr) — في النسخة الجديدة تتعمل bundle محلياً؛ والـ submit بيبعت FormData مفتوح من غير session token إضافي — الـ checkout الجديد لازم يقفل ده بالـ `checkout_sessions` + سعر الصرف المقفول (`exchange_rate_locked_at/value/expires_at`).

## 5.6) مرجع الـ Depositor Portal (المحصّلين المحليين)

- `reference/depositor-portal.html` — بورتال الـ Local Depositors كما استُلم: login خاص (`POST /v1/depositors/login`)، Dashboard بعمولات (total/pending/paid)، My Transactions (`/v1/depositors/transactions`)، My Accounts (13 method: InstaPay/Vodafone/Orange/Etisalat/Fawry/Meeza/Bank/Visa-MC/USDT/Wise/Revolut/PayPal/Binance Pay عبر `POST /v1/depositors/accounts`)، My Merchants (نسب عمولة % + flat + cap + daily limit)، Documents (رفع proof/invoice/agreement عبر `/v1/documents/:txid/upload` → Supabase Storage + Google Drive).
- `reference/depositor-portal-branded.html` — نفسه بهوية bullseye + purple/blue.
- **فجوة مكشوفة:** الـ API base في الملف `http://localhost:3000` — يعني backend الـ depositors تحت التطوير ومش منشور، وجداوله (depositors، depositor_accounts، depositor_merchant_assignments، transaction_documents أو مكافئاتها) **غير موجودة في panel-v2 DB** حالياً. ده بيترجم مفهوم `local_deposit_channels` لواجهة فعلية — لما نوصل لمرحلة بنائه: نصمم الجداول في panel-v2 + طبقة API بنفس قواعد الأمان (JWT مخصص، RLS، idempotency)، ونحوّل الـ portal لصفحات داخل البانل أو تطبيق منفصل حسب قرار المنتج.

## 5.7) مرجع API Reference v3 — ولغز schema `ontarget` محسوم

- `reference/api-reference-v3.html` (+ `-branded.html`) — التوثيق الرسمي الكامل لـ `ontarget-api-v3` (v3.0، يونيو 2026): auth بثلاث طرق (Merchant JWT 30d/90d rotation + `X-API-Key: ot_live_...` + `X-Admin-Secret`)، checkout/payout بروابط 256-bit tokens، payment submission عام بـ rate limits، webhooks بتوقيع HMAC-SHA256 (`X-OnTarget-Signature` بمفتاح `ot_secret_...`)، admin CRUD، جداول أخطاء وenv vars كاملة.
- **حسم اللغز المعماري:** جداول v3 في schema `ontarget` (8 جداول RLS)، لكن **كل الـ DB access عبر SECURITY DEFINER RPCs عايشة في `public`** بـ `search_path = ontarget, public` و`Content-Profile: public` — فغياب USAGE للـ service_role على `ontarget` مش بيمنعه، وده تفسير تطابق الـ OpenAPI spec مع أسماء الجداول. مفيش تناقض مع كون الـ API الحي (`api.ontarget-egy.com`) شغال على `public` مباشرة.
- **Blueprint جاهز للـ checkout الجديد** (نقتبسه بدل الاختراع): token URL 64-hex يتخزن SHA-256 فقط؛ single-use على 3 طبقات (frontend/API 409/RPC atomic RAISE)؛ جلسة 15 دقيقة auto-expire؛ statuses: `pending → processing → approved|declined` + `expired`؛ API keys بصيغة `ot_live_` تتخزن SHA-256+salt وتظهر مرة واحدة؛ passwords bcrypt cost 12؛ rate limits (10/5min للـ submit، 30/min للـ public fetch، 100/15min عام)؛ webhook HMAC مع ملاحظة إن **مفيش retry تلقائي حالياً** — نضيف retry queue في البناء الجديد.

## 5.8) مرجع الـ Admin Dashboard (أهم مرجع — ده اللي بنعيد بناءه)

`reference/admin-dashboard.html` (+ `-branded.html`) — لوحة تحكم الأدمن الحالية بـ **19 تبويب**، وهي الأقرب لوصف البانل الجديد. التبويبات: Monitor (live)، Merchants، Transactions، Approvals (بـ badge عدّاد)، Settlements، Wallets & Payment Accounts، Payment Methods، Analytics، SMS Logs، Checkout Builder، Merchant View، API Docs، Auth & Tokens، Request Builder، Admin Profile، Operators & Depositors، Support Tickets، Merchant Hierarchy (شجرة)، Role Permissions (matrix).

**بتتكلم مع Supabase مباشرة** عبر PostgREST RPCs (`POST /rest/v1/rpc/<fn>` بـ header `Content-Profile: public`) — مش عبر Gateway API. الـ RPCs المستخدمة:
`admin_get_merchants` / `admin_get_sandbox_merchants` (توأمة live/sandbox عبر `_mEnv`)، `admin_get_transactions`، `admin_update_tx_status`، `admin_get_settlement_requests` / `admin_update_settlement`، `admin_get_support_tickets` / `admin_update_ticket`، `admin_get_wallet_pools`، `admin_list/add/update/toggle/delete_payment_method`، `api_admin_hierarchy_tree`، `api_admin_fee_allocations`، `get_checkout_wallets`. وبعض العمليات عبر Gateway بـ `X-Admin-Secret`: `/v1/admin/transaction/:id/proof`، `/v1/admin/transaction/:id/approve-payout`، `/v1/admin/transaction/:id/calculate-fees`، `/v1/admin/merchant/:mid/hierarchy`.

> 🔴 **دروس أمان من الملف ده — لا تتكرر في البانل الجديد (تعزيز مباشر لقسم الأمان في الـ kickoff):**
> 1. الملف فيه **`ADMIN_KEY` (admin secret) و`SB_ANON` مكتوبين hardcoded في الـ HTML** — أي حد يفتح view-source يشوفهم. البانل الجديد: مفيش أسرار في الـ frontend إطلاقاً؛ الأدمن سيكرت يعيش في طبقة API server-side بس.
> 2. الفرونت بينادي RPCs بالـ **anon key مباشرة** — يعني الأمان كله معتمد على منطق جوّه الـ RPC؛ لو RPC واحدة ناقصة check بتتكشف. الجديد: RLS فعلي + JWT مخصص لكل طلب، مش anon مفتوح.
> 3. **الـ admin secret ده مكشوف دلوقتي في ملف على الديسكتوب** (`a16126…`) — يُعتبر compromised ويتغيّر في env بتاعة `ontarget-v1-api` قبل أي إطلاق. [[project-ontarget-supabase]]
> 4. في الملف health-check string بيقول "Connected · awzzlmdq…" — ده project ID **غلط** (مشروع تاني)، بينما الـ RPCs الحقيقية بتضرب `yvwppyoaksyhycimvgtw`. لا تتبع الـ string ده.

**قيمته:** خريطة كاملة للصفحات والـ RPCs المطلوبة — نعيد بناء كل تبويب فوق panel-v2 DB بطبقة API آمنة بدل RPCs مفتوحة بالـ anon. وترتيب البناء في القسم 5 مشتق من التبويبات دي (Deposits = Approvals + Transactions أولوية قصوى).

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

- **Vercel project:** `ont27` على team `p2ps-projects-6352ad93` — production: **https://ont27.vercel.app**
- **الحالة الحالية:** النشر تم بـ direct upload (أول deployment 2026-07-30). الـ repo **غير مربوط** بعد بالـ Vercel project — لتفعيل النشر التلقائي مع كل push: Vercel Dashboard → ont27 → Settings → Git → Connect `mzakaria-creater/ont27`.
- البيئة: `VITE_SUPABASE_URL` و`VITE_SUPABASE_PUBLISHABLE_KEY` مدمجتان build-time (publishable key عام بطبيعته — الأسرار الحقيقية لا تدخل الواجهة أبداً).
- **إضافة 2026-07-30 (Auth):** لازم تُضاف على Vercel (Settings → Environment Variables، ليس `.env` محلي فقط) قبل أي دخول فعلي: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PANEL_AUTH_JWT_SECRET`, `PANEL_2FA_ENC_KEY` — كلها خادمية فقط (بدون `VITE_`). التفاصيل والتحذيرات في [docs/AUTH.md](AUTH.md).
