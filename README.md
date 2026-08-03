# Company OS — معاينة من الجوال

هذه النسخة مخصصة لمشروع **Company OS** على فرع `company-os`، وتم الحفاظ على المشروع الأصلي في فرع `main` دون تعديل.

## التشغيل من الجوال عبر GitHub Codespaces

1. افتح هذا المستودع على فرع `company-os`.
2. اضغط **Code** ثم **Codespaces**.
3. اضغط **Create codespace on company-os**.
4. انتظر حتى يكتمل الإعداد التلقائي؛ سيُعاد تكوين المشروع، وتُثبت الحزم، وتُجهز قاعدة البيانات.
5. عند ظهور المنفذ `3000` اضغط **Open in Browser**. إذا لم يظهر تلقائيًا، افتح تبويب **Ports** واضغط رمز الكرة الأرضية بجانب `3000`.

## بيانات الدخول التجريبية

```text
البريد: admin@demo.local
كلمة المرور: Admin@12345
```

## عند تعطل الإعداد التلقائي

نفّذ داخل Terminal:

```bash
bash .devcontainer/setup-company-os.sh
bash .devcontainer/start-company-os.sh
```

وسجل التشغيل موجود في:

```text
company-os-dev.log
```

## ملاحظات

- ملف `.env` السري لم يُرفع؛ يُنشأ تلقائيًا من `.env.example` داخل Codespaces.
- قاعدة البيانات الحالية SQLite ومناسبة للمعاينة والتطوير المحلي.
- للنشر الدائم لاحقًا يفضّل تحويل قاعدة البيانات إلى PostgreSQL.
- ملفات المشروع الأصلية محفوظة داخل `company-os-archive` ويعيد Codespaces تكوينها تلقائيًا داخل `company-os-app`.
