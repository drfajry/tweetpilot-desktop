# Tweet Pilot — تطبيق سطح المكتب

## متطلبات التشغيل
- Node.js 18+
- Windows 10/11 أو macOS 12+

## التثبيت والتشغيل

```bash
npm install
npm start
```

## بناء ملف التثبيت

### Windows (.exe)
```bash
npm run build-win
```

### macOS (.dmg)
```bash
npm run build-mac
```

الملف الناتج في مجلد `dist/`

## إعداد مفاتيح X API

افتح `main.js` وضع مفاتيحك في السطرين:
```js
const CLIENT_ID     = 'ضع_CLIENT_ID_هنا';
const CLIENT_SECRET = 'ضع_CLIENT_SECRET_هنا';
```

هذه المفاتيح من developer.twitter.com → OAuth 2.0 Keys
