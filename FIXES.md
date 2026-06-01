# ناشر — ملخص الإصلاحات

## ✅ المشاكل التي تم حلها

### 1. النشر يفشل (FIX #1)
**السبب:** `new TwitterApi(accessToken)` مع OAuth2 token يعمل لكن يحتاج الـ token يكون صالحاً وغير منتهي.

**ما تم إصلاحه:**
- عرض رسالة خطأ تفصيلية بدل "فشل النشر"
- تجديد تلقائي للـ access token عبر refresh_token عند خطأ 401
- جدول DB تم تصحيحه: `access_secret` → `refresh_token`

**إذا استمر الفشل، تحقق من:**
```
X Developer Portal → Your App → Settings → User authentication settings
✅ OAuth 2.0 ON
✅ Type of App: Native App  
✅ Callback URI: nashir://auth/callback
✅ Scopes: tweet.read, tweet.write, users.read, offline.access
```

---

### 2. التغريدات المجدولة لا تظهر (FIX #2)
**ما تم إضافته:**
- صفحة "المجدولة" في التنقل العلوي
- جدول يعرض كل التغريدات (pending / posted / failed)
- عرض رسالة الخطأ إذا فشل النشر المجدول
- إشعار مباشر للواجهة عند نشر تغريدة مجدولة
- زر حذف للتغريدات المنتظرة

---

### 3. الترندات وهمية (FIX #3)
**ما تم تغييره:**
- `fetch-trends` handler يستدعي X API v1.1 (`trendsByPlace`) فعلاً
- عند نجاح API: بيانات حقيقية مع badge "حقيقية"
- عند فشل API (صلاحيات محدودة): fallback لبيانات احتياطية مع badge "احتياطية"

**متطلبات الترندات الحقيقية:**
- حساب X Developer بمستوى **Free** لا يدعم `trendsByPlace`
- يحتاج مستوى **Basic** أو أعلى ($100/شهر)
- **البديل المجاني:** استخدم RapidAPI "Twitter v2" للترندات

---

### 4. المنتجات وهمية (FIX #4)
**الوضع الحالي:** بيانات تجريبية محدثة مع روابط مباشرة للصفحات الرسمية.

**للبيانات الحقيقية:**
- **أمازون:** سجّل في Amazon Associates وفعّل Product Advertising API
  ```
  AWS_ACCESS_KEY + AWS_SECRET_KEY + ASSOCIATE_TAG
  ```
- **نون:** تواصل مع noon.com/affiliate للحصول على API access
- **علي إكسبريس:** برنامج AliExpress Affiliate API متاح مجاناً

---

### 5. تجاوز 280 حرف (FIX #5)
**ما تم إصلاحه:**
- التغريدة المولَّدة تُقتطع تلقائياً للحفاظ على URL والهاشتاق
- textarea قابل للتعديل مباشرة مع عداد حي للحروف
- زر "التالي" معطل إذا تجاوز 280 حرف
- تحقق نهائي في `postTweet()` قبل الإرسال
- تحقق في main.js كـ safety net

---

## 🔑 إعداد المفاتيح

في `main.js`:
```js
const CLIENT_ID     = 'YOUR_OAUTH2_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_OAUTH2_CLIENT_SECRET';
```

## 🗃️ ملاحظة قاعدة البيانات

إذا كان التطبيق مثبتاً مسبقاً، احذف قاعدة البيانات القديمة:
- Windows: `%APPDATA%\nashir\nashir.db`
- Mac: `~/Library/Application Support/nashir/nashir.db`
- Linux: `~/.config/nashir/nashir.db`

أو شغّل هذا في Developer Tools:
```js
// في console الـ renderer
window.api.logout()
```
