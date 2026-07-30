# SUMMARY — حالة مشروع OnTarget Panel v2 (حتى 2026-07-30)

## إيه اللي اتعمل النهارده

1. **حسم سؤال الـ schema نهائياً:** الـ API الحي `api.ontarget-egy.com` يكتب على schema **`public`** في مشروع Supabase `yvwppyoaksyhycimvgtw` (ontarget-egy). الأدلة:
   - Railway env vars الحية: `SUPABASE_URL=yvwppyoaksyhycimvgtw.supabase.co` بدون أي `SUPABASE_SCHEMA`.
   - السورس المنشور على GitHub: `createClient` بدون `db.schema` override، وبحث الكود على الـ repo كله = صفر نتائج.
   - `service_role` لا يملك USAGE على schema `ontarget` أصلاً — مستحيل يشتغل عليها.
   - schema `ontarget` تخص `ontarget-api-v3` غير المنشور (مرجع تصميم الـ Hosted Checkout المستقبلي فقط).

2. **تصحيح مصدر النشر:** الـ production ينشر من **`mzakaria-creater/ontarget-nexus` branch `main`** (Railway project `ontarget-v1-api`, service `api`) — وليس `https-ontarget-egy-com`. أي تعديل في غير nexus main لا يصل للـ production.

3. **قاعدة بيانات Panel v2 جاهزة ومتهاجرة بالفعل:** مشروع Supabase `ontarget-panel-v2` (`iwhjmhazcvctvipoasct`, eu-west-2) موجود وفيه كل جداول خطة الهجرة بالبيانات (تفاصيل في HANDBOOK). لا إعادة إنشاء ولا إعادة هجرة.

4. **تنظيف Supabase org "Goldex psp":** حذف نهائي لـ 8 مشاريع قديمة بتأكيد صريح من مينا. المتبقي 4 فقط: `ontarget-egy` (production) + `ontarget-panel-v2` (البانل الجديد) + `ontarget-psp` + `Lov`.

5. **بدء مشروع الواجهة `ont27`:** React + Vite + TypeScript، RTL + dark theme حسب توجيه UX في الـ kickoff، متصل بقاعدة panel-v2 بالـ publishable key فقط.

## تحديث 2026-07-30 (جلسة لاحقة): Auth + RBAC مبني فعلياً

بعد تأكيد مباشر عبر screenshot أن الواجهة كانت لا تزال تعرض "الأساس جاهز" بدون أي login فعلي، بُني تسجيل الدخول + RBAC من الصفر كـ Vercel Serverless Functions تحت `/api/auth/*` (التفاصيل الكاملة في [docs/AUTH.md](AUTH.md)):

- Login بكلمة مرور فقط (بحث case-insensitive عبر دالة DB جديدة `panel_get_user_for_login`)، قفل بعد 5 محاولات فاشلة، JWT مخصص (`PANEL_AUTH_JWT_SECRET` — مستقل عن أي سر Supabase) + refresh token مُدوَّر مخزَّن كـ hash فقط.
- **2FA غير مفعّل عند الدخول حالياً** — قرار منتج صريح أُخِذ أثناء البناء (راجع AUTH.md §2)، رغم أن الطلب الأصلي فرضه على أدوار `can_approve`. البنية التحتية (`panel_users_2fa`, `/api/auth/2fa-setup`, `/api/auth/2fa-enable`) موجودة وجاهزة لإعادة التفعيل.
- **فجوة غير محسومة:** `password_hash` تبيّن أنه SHA-256 خام (64 hex، بدون salt) وليس bcrypt كما ورد في مرجع نظام مختلف — التحقق الفعلي بكلمة مرور حقيقية لم يتم بعد (يحتاج صاحب المنتج، راجع AUTH.md §3 و§9).
- `role_page_permissions` مربوط بالكامل عبر `/api/auth/me` + `useAuth().can()`.

## الحالة الحالية

- ✅ التحقق (خطوة 1 من الخطة) — مكتمل وموثق
- ✅ قاعدة البيانات الجديدة + الهجرة (خطوتا 2-3) — مكتملتان من جلسة سابقة
- ✅ Auth + RBAC (خطوة 4، جزء أول) — مبني، بانتظار تأكيد دخول حقيقي من صاحب المنتج (AUTH.md §9)
- 🔄 الواجهة — التالي: Dashboard الفعلي ثم Deposits
- ⬜ Hosted Checkout (Next.js) — مؤجل حسب القرار المعماري #1

## أسئلة مفتوحة (لا تُفترض إجاباتها)

- تأكيد ميداني لتوفر Orange Cash في الأردن بنفس آلية مصر قبل بناء collector.
- تحديد قناة الإيداع في السعودية (STC Pay أو تحويل بنكي — القرار مفتوح).
- تفاصيل تكامل USDT التنفيذية (أي حساب/محفظة Binance تحديداً).
