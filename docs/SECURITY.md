# الأمان

## مطبق

- AES-256-GCM مع IV مستقل لكل قيمة.
- scrypt لكلمات المرور.
- Session tokens عشوائية ولا يخزن النص الخام، بل SHA-256.
- HttpOnly وSameSite cookies.
- CSP وX-Frame-Options وnosniff.
- التحقق من توقيع Meta `X-Hub-Signature-256`.
- Idempotency للأحداث والرسائل.
- Logs منظمة مع إخفاء الحقول الحساسة.
- عزل استعلامات المنشآت.
- تحذير وموافقة موثقة للربط غير الرسمي.

## قبل الإنتاج

- ضع التطبيق خلف HTTPS وReverse Proxy موثوق.
- فعّل `COOKIE_SECURE=true`.
- استخدم مفتاح تشفير من Secret Manager ولا تحفظه في المشروع.
- انقل SQLite إلى PostgreSQL عند تعدد النسخ.
- استبدل Rate Limiter المحلي بـRedis.
- نفذ فحص ملفات ومضاد فيروسات قبل تفعيل رفع الملفات.
- استخدم مخزن Baileys مشفرًا بدل `useMultiFileAuthState` المحلي.
- أضف 2FA للمدير والمنشآت الحساسة.
- أجرِ اختبار اختراق ومراجعة سياسات Meta قبل الإطلاق العام.
