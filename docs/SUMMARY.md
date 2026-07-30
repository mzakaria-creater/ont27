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

## الحالة الحالية

- ✅ التحقق (خطوة 1 من الخطة) — مكتمل وموثق
- ✅ قاعدة البيانات الجديدة + الهجرة (خطوتا 2-3) — مكتملتان من جلسة سابقة
- 🔄 الواجهة (خطوة 4) — scaffold جاهز؛ التالي: Auth + RBAC ثم Dashboard ثم Deposits
- ⬜ Hosted Checkout (Next.js) — مؤجل حسب القرار المعماري #1

## أسئلة مفتوحة (لا تُفترض إجاباتها)

- تأكيد ميداني لتوفر Orange Cash في الأردن بنفس آلية مصر قبل بناء collector.
- تحديد قناة الإيداع في السعودية (STC Pay أو تحويل بنكي — القرار مفتوح).
- تفاصيل تكامل USDT التنفيذية (أي حساب/محفظة Binance تحديداً).
