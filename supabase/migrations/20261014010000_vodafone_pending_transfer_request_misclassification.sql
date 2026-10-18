-- Vodafone Cash's "جالك طلب تحويل بمبلغ X جنيه من رقم Y المسجل بإسم Z. افتح
-- تطبيق أنا فودافون علشان تقبل أو ترفض الطلب" is a PENDING incoming-transfer
-- request notice -- the money has not moved yet, the wallet owner still has
-- to accept it in the app. It was being inconsistently classified as
-- sms_category 'deposit' whenever sms-inbound/index.ts happened to resolve
-- an amount + wallet for it (device-prefix single-candidate mapping), even
-- though it carries no completed-payment wording at all.
--
-- Confirmed live on sender 01067348969: 8 occurrences across different
-- fabricated amounts (158/150/151/100/80/74 EGP) sent within hours of each
-- other, while only ONE real "تم استلام" deposit from that same sender ever
-- landed (45 EGP, a different amount) -- consistent with probing. One of the
-- fake-amount request SMS (#1014624, 74 EGP) was cited by staff
-- (ahmedmano.solly) as "SMS verified / payment evidence confirmed" to
-- manually override an automation-engine-blacklist auto-decline back to PAID
-- on tx #138501449, i.e. this misclassification already contributed to one
-- blacklisted sender's declined transaction being paid out.
--
-- Mirrors sms-inbound/index.ts's isPendingTransferRequest fix (deployed as
-- v29): these messages must stay 'unknown' -- never deposit/withdrawal,
-- never shown as financial evidence, never wallet-resolved, never eligible
-- for automation or manual-match "evidence". This only touches
-- sms_category; is_blocked/matched_transaction_id/match_status on the
-- already-reviewed rows are left untouched for the audit trail.
update inbound_sms
set sms_category = 'unknown'
where raw_sms ~ 'طلب\s*تحويل'
  and raw_sms ~ '(تقبل|ترفض)'
  and sms_category != 'unknown';
