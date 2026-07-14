# Elaf Assistant

بوت واتساب لفندق إيلاف المقام يعمل عبر:

- Meta WhatsApp Cloud API
- Google Gemini API
- Google Cloud Run

## الملفات المهمة

- `index.js` — الربط بين واتساب وGemini
- `system_prompt.js` — تعليمات ومعلومات الفندق، وهو الملف الذي تعدله لاحقًا
- `.env.example` — أسماء المتغيرات المطلوبة
- `Dockerfile` — تشغيل المشروع على Cloud Run

## المتغيرات المطلوبة في Cloud Run

أضف المتغيرات التالية، ولا تضع القيم السرية داخل GitHub:

- `VERIFY_TOKEN`  
  اكتب جملة سرية من اختيارك، مثل: `elaf_verify_2026_x7`

- `WHATSAPP_TOKEN`  
  رمز الوصول الذي أنشأته في Meta. الرمز المؤقت ينتهي؛ للإنتاج استخدم رمزًا دائمًا.

- `PHONE_NUMBER_ID`  
  رقم Phone Number ID الظاهر في إعداد واتساب داخل Meta.

- `GRAPH_API_VERSION`  
  استخدم: `v25.0`

- `GEMINI_API_KEY`  
  مفتاح Gemini من Google AI Studio.

- `GEMINI_MODEL`  
  استخدم: `gemini-2.5-flash`

## رابط Webhook بعد النشر

بعد أن يعطيك Cloud Run رابط الخدمة، اجعل رابط الاستدعاء في Meta:

`https://YOUR-CLOUD-RUN-URL/webhook`

واكتب في خانة Verify Token نفس قيمة `VERIFY_TOKEN`.

بعد نجاح التحقق، اشترك في الحقل:

`messages`

## تنبيه مهم

الذاكرة الحالية للمحادثة مؤقتة داخل الخادم وقد تُمسح عند إعادة تشغيل Cloud Run. هذا مناسب للتجربة الأولى. لاحقًا يمكن إضافة قاعدة بيانات لحفظ الحجوزات والمحادثات بشكل دائم.
