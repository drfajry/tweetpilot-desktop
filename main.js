const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

// تسجيل أي خطأ لتشخيص مشاكل الإقلاع
function logError(msg) {
  try {
    const logFile = path.join(app.getPath('userData'), 'error-log.txt');
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch(e) {}
}
process.on('uncaughtException', (err) => {
  logError('UNCAUGHT: ' + (err.stack || err.message));
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox('خطأ في ناشر', (err.message || 'خطأ غير معروف'));
  } catch(e) {}
});

const https = require('https');
const { TwitterApi } = require('twitter-api-v2');
const Database = require('./db');

// ── إعدادات التطبيق ──────────────────────────────
const API_KEY      = '1241epzWTO5a9JCoyGnR3Eb6L'; // ← Consumer Key
const API_SECRET   = 'XuW2J8ayMyTQyCmCkVJw7r7qMw3xoWEZirrNaqDUqGMoCXeafq'; // ← Consumer Secret
const ACCESS_TOKEN = '2051302166883606529-6FoWmSdH7pDbmuxLPQQjfEZiCy0CCx'; // ← Access Token
const ACCESS_SECRET= 'Q5uSfh3SiOPDqzFqIue18lFJnGmU0Zia6UNeCvSmfGsxo'; // ← Access Token Secret
const LICENSE_SERVER = 'https://nashir-license.onrender.com'; // ← رابط سيرفر Render
const APP_VERSION    = '1.6.3';

// ── النوافذ ───────────────────────────────────────
let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 780, minWidth: 900, minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'ناشر',
    backgroundColor: '#070b14',
    icon: path.join(__dirname, 'renderer', 'icon.ico'),
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
} // ← غيّر هذا عند كل إصدار جديد

// ── التحقق من التحديثات بـ electron-updater ──────
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false; // لا يحمّل إلا عند ضغط المستخدم
  autoUpdater.autoInstallOnAppQuit = true;
} catch(e) {
  console.log('electron-updater غير متاح:', e.message);
}

function setupAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', {
      current: APP_VERSION,
      latest: info.version,
    });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-not-available', { version: APP_VERSION });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', {
      percent: Math.round(progress.percent),
      speed: Math.round(progress.bytesPerSecond / 1024),
    });
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update-downloaded', {});
  });

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update-error', { error: err.message });
  });
}

async function checkForUpdates(silent = false) {
  if (!autoUpdater) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch(e) {
    if (!silent) mainWindow?.webContents.send('update-error', { error: e.message });
  }
}


// ── التحقق من الترخيص ────────────────────────────
async function verifyLicense(code) {
  const deviceId = require('os').hostname() + '-' + require('os').platform();
  // إعادة المحاولة — السيرفر المجاني قد يكون نائماً ويحتاج وقت ليستيقظ
  const attempts = [40000, 40000]; // محاولتان، 40 ثانية لكل واحدة
  for (let i = 0; i < attempts.length; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), attempts[i]);
      const response = await fetch(`${LICENSE_SERVER}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, device_id: deviceId }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return await response.json();
    } catch(e) {
      // لو فشلت المحاولة الأولى، جرّب مرة أخرى (السيرفر استيقظ الآن)
      if (i === attempts.length - 1) {
        if (e.name === 'AbortError') return { valid: false, error: 'انتهت مهلة الاتصال' };
        return { valid: false, error: 'تعذر الاتصال بالسيرفر: ' + e.message };
      }
    }
  }
}

async function checkStoredLicense() {
  const stored = db.prepare('SELECT * FROM auth WHERE id=2').get();
  if (!stored || !stored.username) return { valid: false, reason: 'no_license' };

  const code = stored.username;
  const result = await verifyLicense(code);

  // التحقق نجح → افتح
  if (result && result.valid === true) {
    return { valid: true };
  }

  // مفعّل على جهاز آخر — رسالة خاصة (لا نطلب كوداً جديداً، بل نوضّح)
  if (result && result.valid === false && result.error?.includes('جهاز آخر')) {
    db.prepare('DELETE FROM auth WHERE id=2').run();
    return { valid: false, reason: 'other_device', error: result.error };
  }

  // السيرفر صرّح بوضوح أن الكود ملغى أو منتهي أو خاطئ
  const serverRejected = result && result.valid === false &&
    (result.error?.includes('إلغاء') || result.error?.includes('انتهت صلاحية') ||
     result.error?.includes('غير صحيح'));

  if (serverRejected) {
    db.prepare('DELETE FROM auth WHERE id=2').run();
    return { valid: false, reason: 'invalid', error: result.error };
  }

  // أي شيء آخر (فشل اتصال، مهلة، سيرفر نائم) → لا نحذف، نطلب اتصال فقط
  return { valid: false, reason: 'no_connection' };
}

// ── قاعدة البيانات ────────────────────────────────
const DB_PATH = path.join(app.getPath('userData'), 'nashir.db');
let db;

function initDB() {
  db = new Database(DB_PATH);
}

// ── بناء Twitter client بـ OAuth 1.0a ─────────────
function getClient() {
  return new TwitterApi({
    appKey: API_KEY,
    appSecret: API_SECRET,
    accessToken: ACCESS_TOKEN,
    accessSecret: ACCESS_SECRET,
  });
}

// ── جلب Google Trends RSS ─────────────────────────
// سكرابينج ترندات X الحقيقية من trends24.in
function fetchTrends24(region) {
  return new Promise((resolve) => {
    const { net, session } = require('electron');

    const PATHS = {
      sa: 'saudi-arabia',
      ae: 'united-arab-emirates',
      eg: 'egypt',
      world: '',
    };
    const regionPath = PATHS[region] !== undefined ? PATHS[region] : PATHS.sa;
    const url = regionPath ? `https://trends24.in/${regionPath}/` : `https://trends24.in/`;

    const request = net.request({
      url,
      method: 'GET',
      session: require('electron').session.defaultSession,
    });

    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    request.setHeader('Accept-Language', 'ar-SA,ar;q=0.9,en;q=0.8');
    request.setHeader('Referer', 'https://trends24.in/');

    let data = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
      resolve({ success: false, error: 'انتهت مهلة الطلب', trends: [] });
    }, 12000);

    request.on('response', (response) => {
      response.on('data', chunk => { data += chunk.toString(); });
      response.on('end', () => {
        if (timedOut) return;
        clearTimeout(timer);
        try {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            resolve({ success: false, error: `تعذر جلب الترندات (${response.statusCode})`, trends: [] });
            return;
          }

          // استخراج الترندات من روابط twitter search
          // النمط: <a href="https://twitter.com/search?q=...">النص</a>
          const matches = [...data.matchAll(/href="https:\/\/twitter\.com\/search\?q=([^"]+)"[^>]*>([^<]+)<\/a>/g)];

          if (matches.length === 0) {
            resolve({ success: false, error: 'لم يتم العثور على ترندات', trends: [] });
            return;
          }

          // أخذ أول 15 ترند وإزالة المكررات
          const seen = new Set();
          const trends = [];
          for (const m of matches) {
            const name = m[2].trim();
            if (!name || seen.has(name) || trends.length >= 15) continue;
            seen.add(name);
            // إضافة # إذا لم يكن موجوداً
            const tag = name.startsWith('#') ? name : '#' + name.replace(/\s+/g, '_');
            trends.push({ name: tag, tweet_volume: null });
          }

          resolve({ success: true, trends });
        } catch(e) {
          resolve({ success: false, error: e.message, trends: [] });
        }
      });
    });

    request.on('error', (e) => {
      if (!timedOut) { clearTimeout(timer); resolve({ success: false, error: e.message, trends: [] }); }
    });

    request.end();
  });
}

// سكرابينج ترندات YouTube من youtube.trends24.in/saudi-arabia
function fetchYoutubeTrends(region) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const PATHS = { sa: 'saudi-arabia', ae: 'united-arab-emirates', eg: 'egypt', world: '' };
    const regionPath = PATHS[region] || 'saudi-arabia';
    const url = `https://youtube.trends24.in/${regionPath}`;

    const request = net.request({ url, method: 'GET', session: require('electron').session.defaultSession });
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    request.setHeader('Accept', 'text/html,application/xhtml+xml');

    let data = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; request.abort(); resolve({ success: false, error: 'انتهت مهلة الطلب', trends: [] }); }, 12000);

    request.on('response', (response) => {
      response.on('data', chunk => { data += chunk.toString(); });
      response.on('end', () => {
        if (timedOut) return;
        clearTimeout(timer);
        try {
          if (response.statusCode < 200 || response.statusCode >= 300) { resolve({ success: false, error: `تعذر جلب الترندات (${response.statusCode})`, trends: [] }); return; }

          // استخراج عناوين الفيديوهات من روابط يوتيوب
          const videoMatches = [...data.matchAll(/href="https:\/\/youtube\.com\/watch\?v=[^"]+">\s*([^<]{3,80})<\/a>/g)];
          // استخراج من alt النصوص والعناوين
          const altMatches = [...data.matchAll(/alt="([^"]{5,80})"/g)];
          const titleMatches = [...data.matchAll(/>([\u0600-\u06FF][^<]{3,60})</g)];

          const seen = new Set();
          const trends = [];

          const addTrend = (title) => {
            title = title.trim().replace(/\s+/g, ' ');
            if (!title || seen.has(title) || trends.length >= 12 || title.length < 4) return;
            seen.add(title);
            trends.push({
              name: '#' + title.replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, '').trim().split(/\s+/).slice(0,4).join('_'),
              title,
              tweet_volume: null,
            });
          };

          videoMatches.forEach(m => addTrend(m[1]));
          altMatches.forEach(m => addTrend(m[1]));
          if (trends.length < 5) titleMatches.forEach(m => addTrend(m[1]));

          if (trends.length === 0) { resolve({ success: false, error: 'لم يتم العثور على ترندات', trends: [] }); return; }
          resolve({ success: true, trends });
        } catch(e) { resolve({ success: false, error: e.message, trends: [] }); }
      });
    });
    request.on('error', (e) => { if (!timedOut) { clearTimeout(timer); resolve({ success: false, error: e.message, trends: [] }); } });
    request.end();
  });
}

// ── النشر عبر نافذة إكس مرئية (المستخدم يضغط زر النشر بنفسه) ──
// تفتح نافذة إكس على صفحة الكتابة، والتغريدة والصور جاهزة — المستخدم يضغط "نشر" فقط.

function getXSession() {
  return session.fromPartition('persist:nashir-x');
}

// تنزيل صورة من رابط http وتحويلها إلى data URL (لتفادي مشاكل CORS داخل صفحة إكس)
function downloadImageAsDataUrl(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 3) return resolve(null);
    try {
      const mod = url.startsWith('http://') ? require('http') : https;
      const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          return resolve(downloadImageAsDataUrl(r.headers.location, redirects + 1));
        }
        if (r.statusCode < 200 || r.statusCode >= 300) { r.resume(); return resolve(null); }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0 || buf.length > 5 * 1024 * 1024) return resolve(null);
          const type = r.headers['content-type'] || 'image/jpeg';
          resolve(`data:${type};base64,${buf.toString('base64')}`);
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    } catch(e) { resolve(null); }
  });
}


// تأمين نوافذ إكس وبناء الثقة: عنوان يُظهر النطاق الرسمي + حصر التصفح في x.com
function hardenXWindow(win) {
  const X_DOMAINS = /^https:\/\/([a-z0-9-]+\.)?(x\.com|twitter\.com|twimg\.com)\//i;
  const applyTitle = () => {
    try {
      const host = new URL(win.webContents.getURL()).host || 'x.com';
      win.setTitle(`🔒 ${host} — موقع إكس الرسمي (ناشر لا يرى كلمة مرورك)`);
    } catch(e) {}
  };
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); applyTitle(); });
  win.webContents.on('did-navigate', applyTitle);
  win.webContents.on('did-navigate-in-page', applyTitle);
  // حماية: لا تسمح بمغادرة نطاقات إكس داخل هذه النافذة
  win.webContents.on('will-navigate', (e, url) => { if (!X_DOMAINS.test(url)) e.preventDefault(); });
  // إكس يسجّل beforeunload (تأكيد حفظ المسودة) فيعطّل زر الإغلاق بصمت — نسمح بالإغلاق دائماً
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (X_DOMAINS.test(url)) return { action: 'allow' };
    return { action: 'deny' };
  });
  applyTitle();
}

async function openComposeWindow(content, images = []) {
  // جهّز الصور كـ data URLs
  const imgs = [];
  for (const src of (images || []).slice(0, 4)) {
    if (typeof src !== 'string') continue;
    if (src.startsWith('data:image')) imgs.push(src);
    else if (src.startsWith('http')) {
      const d = await downloadImageAsDataUrl(src);
      if (d) imgs.push(d);
    }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 720, height: 840,
      title: 'ناشر — النشر على إكس',
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:nashir-x',
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let injected = false;
    let resolved = false;
    let pollTimer = null;
    const finish = (r) => {
      if (resolved) return;
      resolved = true;
      if (pollTimer) clearInterval(pollTimer);
      resolve(r);
    };

    hardenXWindow(win);
    win.on('closed', () => finish({ success: false, error: 'CLOSED' }));
    win.loadURL('https://x.com/compose/post');

    let injecting = false; // قفل متزامن — يمنع تكرار الإدخال عند تعدد أحداث التحميل
    win.webContents.on('did-finish-load', async () => {
      if (injected || injecting || win.isDestroyed()) return;
      const url = win.webContents.getURL();
      // صفحة تسجيل دخول؟ اترك المستخدم يسجّل — سيُعاد التحميل بعدها
      if (/\/(login|i\/flow\/login|account\/access)/.test(url)) return;
      injecting = true; // ← يُقفل فوراً قبل أي عملية غير متزامنة
      try {

        const result = await win.webContents.executeJavaScript(`
          (async () => {
            function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
            // انتظر صندوق الكتابة (حتى 15 ثانية)
            let box = null;
            for (let i = 0; i < 30; i++) {
              box = document.querySelector('[data-testid="tweetTextarea_0"]');
              if (box) break;
              // لو لسنا في صفحة الكتابة، افتح نافذتها
              if (i === 6) {
                const btn = document.querySelector('a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]');
                if (btn) btn.click();
              }
              await wait(500);
            }
            if (!box) return 'NO_BOX';

            // اكتب النص — بعد تفريغ الصندوق (يمنع تكدس النسخ لو أعيد الإدخال لأي سبب)
            box.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await wait(120);
            document.execCommand('insertText', false, ${JSON.stringify(content)});
            await wait(800);

            // أرفق الصور عبر حقل الملفات المخفي
            const IMGS = ${JSON.stringify(imgs)};
            if (IMGS.length > 0) {
              try {
                const dt = new DataTransfer();
                for (let i = 0; i < IMGS.length; i++) {
                  const res = await fetch(IMGS[i]);
                  const blob = await res.blob();
                  const ext = (blob.type.split('/')[1] || 'png').split('+')[0];
                  dt.items.add(new File([blob], 'image' + (i+1) + '.' + ext, { type: blob.type || 'image/png' }));
                }
                const input = document.querySelector('input[data-testid="fileInput"]');
                if (input) {
                  input.files = dt.files;
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                }
              } catch(e) { /* الصور اختيارية — النص الأهم */ }
            }
            return 'OK';
          })()
        `);

        if (result === 'OK' || result === 'NO_BOX') {
          injected = true;
          injecting = false;
          // راقب: اختفاء الصندوق وخروج من /compose = المستخدم نشر
          pollTimer = setInterval(async () => {
            if (win.isDestroyed()) { clearInterval(pollTimer); return; }
            try {
              const sent = await win.webContents.executeJavaScript(`
                (() => {
                  const box = document.querySelector('[data-testid="tweetTextarea_0"]');
                  const onCompose = location.pathname.startsWith('/compose');
                  return (!box && !onCompose) ? 'SENT' : 'WAIT';
                })()
              `);
              if (sent === 'SENT') {
                finish({ success: true });
                setTimeout(() => { try { if (!win.isDestroyed()) win.close(); } catch(e){} }, 1200);
              }
            } catch(e) {}
          }, 1500);
        } else {
          injecting = false; // لم ننجح — اسمح بمحاولة عند التحميل القادم
        }
      } catch(e) { injecting = false; }
    });

    win.webContents.on('did-fail-load', () => {
      if (!injected) finish({ success: false, error: 'فشل تحميل إكس — تحقق من الإنترنت' });
    });
  });
}

async function openChromeForLogin() {
  // نفتح نافذة X ليسجل الدخول
  const xSession = getXSession();
  const win = new BrowserWindow({
    width: 500, height: 700,
    webPreferences: { partition: 'persist:nashir-x', contextIsolation: true, nodeIntegration: false },
  });
  hardenXWindow(win);
  win.loadURL('https://x.com/login');
  return { success: true };
}



// ── توليد التغريدة ───────────────────────────────
const recentTemplates = []; // آخر القوالب المستخدمة — لتقليل التكرار
ipcMain.handle('generate-tweet', (_, { trends, affiliateUrl, productDesc, tone, customTags, category }) => {
  // فك ترميز الرابط إذا كان مشفّراً
  let cleanUrl = affiliateUrl || '';
  try {
    if (cleanUrl.includes('%')) {
      const decoded = decodeURIComponent(cleanUrl);
      if (decoded.length < cleanUrl.length) cleanUrl = decoded;
    }
    // تقصير روابط أمازون: الإبقاء على dp/CODE فقط
    const amazonMatch = cleanUrl.match(/(https?:\/\/[^\/]*amazon\.[a-z.]+)\/.*?\/(dp\/[A-Z0-9]+)/i)
      || cleanUrl.match(/(https?:\/\/[^\/]*amazon\.[a-z.]+)\/(dp\/[A-Z0-9]+)/i);
    if (amazonMatch) cleanUrl = `${amazonMatch[1]}/${amazonMatch[2]}`;
    // تقصير روابط نون: إزالة المعاملات بعد ?
    if (/noon\.com/i.test(cleanUrl)) cleanUrl = cleanUrl.split('?')[0];
  } catch(e) {}

  const TEMPLATES_GENERAL = {
    hype: [
      `🔥 لا تفوتك! {product} بسعر خيالي 👇\n{url}\n{trends}`,
      `⚡️ عرض ناري على {product}! وقت الشراء الآن 🛒\n{url}\n{trends}`,
      `🚀 تبحث عن {product}؟ هذا رابطك الذهبي 💥\n{url}\n{trends}`,
      `🎯 {product} بسعر ما يتكرر! اطلب الحين ⬇️\n{url}\n{trends}`,
      `💎 كنز اليوم: {product} بأقل سعر 🔥\n{url}\n{trends}`,
      `🛍️ {product} صار متوفر بسعر يجنّن! 😍\n{url}\n{trends}`,
      `🔝 الأكثر طلباً: {product} — احجز نسختك الآن\n{url}\n{trends}`,
      `✨ خطفت العين! {product} بعرض محدود ⏳\n{url}\n{trends}`,
      `😍 شفت {product}؟ السعر الحين فرصة حقيقية 👇\n{url}\n{trends}`,
      `💥 وأخيراً نزل العرض على {product}! لا تطوّف 🛒\n{url}\n{trends}`,
      `🌟 من أفضل ما جرّبت: {product} — والسعر مفاجأة\n{url}\n{trends}`,
      `🛒 سلة اليوم تبدأ بـ {product} 🔥 السعر بالرابط\n{url}\n{trends}`,
      `📦 وصلني {product} وصراحة فوق التوقع 👌\n{url}\n{trends}`,
      `🤩 {product} اللي الكل يسأل عنه — تفضّل الرابط\n{url}\n{trends}`,
      `🎁 تبي هدية تفرح؟ {product} خيار مضمون 💝\n{url}\n{trends}`,
      `🏆 جودة تستاهل: {product} بسعر اليوم 👇\n{url}\n{trends}`,
      `💫 اكتشاف الأسبوع: {product} — لا يفوتك\n{url}\n{trends}`,
      `🔥 ترند المتاجر الحين: {product} 🛍️\n{url}\n{trends}`,
      `✅ بحثك انتهى هنا: {product} بأفضل قيمة\n{url}\n{trends}`,
      `👀 الكل يتكلم عن {product}.. وأنا فهمت السبب\n{url}\n{trends}`,
    ],
    informative: [
      `📊 تبحث عن {product}؟ أفضل خيار متاح الآن ✅\n{url}\n{trends}`,
      `💡 {product} حاصل على أعلى التقييمات — جربه 👇\n{url}\n{trends}`,
      `🔍 بحثت كثير، وهذا أفضل {product} بالسوق 📌\n{url}\n{trends}`,
      `📋 مواصفات ممتازة + ضمان: {product} ✅\n{url}\n{trends}`,
      `🧐 قبل ما تشتري {product} شوف هذا العرض\n{url}\n{trends}`,
      `📈 الجودة والسعر مجتمعين في {product}\n{url}\n{trends}`,
      `✅ مقارنة سريعة: {product} يتفوّق بالسعر والجودة\n{url}\n{trends}`,
      `📌 معلومة للمهتمين: {product} متوفر الآن بسعر مناسب\n{url}\n{trends}`,
      `🧾 تقييمات حقيقية عالية لـ {product} — راجعها بنفسك\n{url}\n{trends}`,
      `⭐ {product}: اختيار عملي يوفّر عليك البحث\n{url}\n{trends}`,
      `🔎 جمعت لك الزبدة: {product} هو الأنسب حالياً\n{url}\n{trends}`,
      `📖 قرأت التقييمات كاملة — {product} يستحق التجربة\n{url}\n{trends}`,
      `🧠 نصيحة مجرّب: ابدأ بـ {product} ولا تشتت نفسك\n{url}\n{trends}`,
      `📐 مواصفات {product} مدروسة وسعره منطقي 👇\n{url}\n{trends}`,
    ],
    funny: [
      `😂 محفظتي تكرهني بعد {product}.. بس ما أقدر أقاوم 🤷‍♂️\n{url}\n{trends}`,
      `🤣 وعدت نفسي ما أشتري.. بس {product}؟ كذبت 😅\n{url}\n{trends}`,
      `😭 حسابي يبكي بس قلبي فرحان: {product} وصل 💸\n{url}\n{trends}`,
      `🙈 لا تورّي زوجتي إني اشتريت {product} 🤫\n{url}\n{trends}`,
      `😎 صاحبي سألني من وين {product}؟ قلت سر 🔐\n{url}\n{trends}`,
      `🥹 {product} كان حلم.. اليوم صار بمتناولي 🎉\n{url}\n{trends}`,
      `😅 قلت بس أتفرّج.. طلع {product} في السلة، كيف؟ 🤷\n{url}\n{trends}`,
      `🤭 راتبي: لا. أنا: بس {product} يستاهل 💸\n{url}\n{trends}`,
      `😂 آخر مرة أقول آخر مرة.. {product} وصل 📦\n{url}\n{trends}`,
      `🙃 النوم سلطان بس {product} وزير المالية 😴\n{url}\n{trends}`,
      `🤣 سألوني وش سر السعادة؟ قلت {product} والرابط 👇\n{url}\n{trends}`,
      `😆 وعدت محفظتي أرتاح.. بس {product} نزل عرضه 🫠\n{url}\n{trends}`,
      `🤫 بيني وبينكم: {product} أحسن قرار اتخذته هالشهر\n{url}\n{trends}`,
      `😜 قالوا التسوق إدمان.. قلت لا، {product} ضرورة 🛒\n{url}\n{trends}`,
    ],
    urgency: [
      `⏰ عاجل: {product} بهالسعر ما راح يدوم! 🚨\n{url}\n{trends}`,
      `🚨 آخر ساعات العرض على {product}! 🏃‍♂️\n{url}\n{trends}`,
      `⏳ الكمية تنفد! {product} يختفي بسرعة 😱\n{url}\n{trends}`,
      `🔴 تنبيه: السعر يرتفع قريباً على {product}\n{url}\n{trends}`,
      `⚠️ فرصة أخيرة! {product} بسعر اليوم فقط\n{url}\n{trends}`,
      `🆘 لا تتأخر! {product} مطلوب بشدة ⚡️\n{url}\n{trends}`,
      `🏃 العداد يمشي! عرض {product} ينتهي قريباً\n{url}\n{trends}`,
      `📉 السعر الحالي لـ {product} ما راح يتكرر — تأكدت بنفسي\n{url}\n{trends}`,
      `🔔 تذكير أخير: عرض {product} على وشك الانتهاء\n{url}\n{trends}`,
      `💨 {product} ينفد بسرعة! أمّن نسختك الحين\n{url}\n{trends}`,
      `🚦 إشارة خضراء: {product} متوفر الآن — لا تنتظر الحمراء\n{url}\n{trends}`,
      `⌛ ساعات قليلة وينتهي خصم {product} ⚡\n{url}\n{trends}`,
      `📢 إعلان سريع: {product} رجع للمخزون بكمية محدودة\n{url}\n{trends}`,
      `🎯 اللحظة المناسبة وصلت: {product} بأقل سعر له\n{url}\n{trends}`,
    ],
  };

  const TEMPLATES_BY_CATEGORY = {
    electronics: {
      hype: [`📱 {product} وصل بسعر يكسر السوق 🔥\n{url}\n{trends}`, `💻 عرض التقنية: {product} بأقل سعر 🎯\n{url}\n{trends}`, `🎮 {product} حلم كل تقني — بسعر مغري ⚡\n{url}\n{trends}`],
      informative: [`🔋 {product}: مواصفات قوية + ضمان ✅\n{url}\n{trends}`, `⚙️ {product} جهاز موثوق ما يخيّب 👇\n{url}\n{trends}`],
      funny: [`🤓 أنا وتقنيتي اتفقنا: {product} لازم 😂\n{url}\n{trends}`],
      urgency: [`⚡ فلاش ديل على {product}! ⏰\n{url}\n{trends}`],
    },
    fashion: {
      hype: [`👗 ستايل راقي: {product} 😍\n{url}\n{trends}`, `✨ أناقة حقيقية مع {product} 🛍️\n{url}\n{trends}`, `👜 {product} يكمّل إطلالتك بأناقة 💃\n{url}\n{trends}`],
      informative: [`👔 {product}: جودة + راحة + سعر مناسب 💯\n{url}\n{trends}`],
      funny: [`😂 يلبسون {product} ويسألون من وين؟ السر بالرابط 👇\n{url}\n{trends}`],
      urgency: [`🔥 المقاسات تنفد! {product} ⏳\n{url}\n{trends}`],
    },
    food: {
      hype: [`🍔 {product}: لذيذ + توصيل سريع 😋\n{url}\n{trends}`, `🍕 جوعان؟ {product} ما يُرفض 🔥\n{url}\n{trends}`, `🥤 {product} نكهة ما تننسى 😍\n{url}\n{trends}`],
      informative: [`🥗 تبحث عن صحي ولذيذ؟ {product} الحل ✅\n{url}\n{trends}`],
      funny: [`😂 دايتي انتهى بسبب {product} 😅\n{url}\n{trends}`],
      urgency: [`⏰ عرض اليوم فقط على {product}! 🚨\n{url}\n{trends}`],
    },
    beauty: {
      hype: [`💄 سر الجمال: {product} ✨\n{url}\n{trends}`, `🌸 جربته وما ندمت: {product} 💕\n{url}\n{trends}`, `💅 {product} يفرق في روتينك اليومي 🌷\n{url}\n{trends}`],
      informative: [`💆 {product}: مكونات طبيعية لكل البشرة ✅\n{url}\n{trends}`],
      funny: [`😂 بعد {product} صرت أنا وسيم 🤭\n{url}\n{trends}`],
      urgency: [`⏳ كمية محدودة من {product}! 💨\n{url}\n{trends}`],
    },
    home: {
      hype: [`🏠 بيتك يستاهل الأحسن: {product} 😍\n{url}\n{trends}`, `✨ {product} يحوّل بيتك لتحفة 🏡\n{url}\n{trends}`, `🛋️ لمسة جمال لبيتك مع {product} 🌟\n{url}\n{trends}`],
      informative: [`🛋️ {product}: جودة + عملية + سعر ذكي 💯\n{url}\n{trends}`],
      funny: [`😂 قالت لا تشتري شيء.. بس {product}؟ معذور 🤷‍♂️\n{url}\n{trends}`],
      urgency: [`🚨 عرض محدود على {product}! 📦\n{url}\n{trends}`],
    },
  };

  // قوالب التغريد العام (بدون رابط منتج) — {topic} اختياري
  const TEMPLATES_FREE = {
    hype: [
      `🔥 {topic} موضوع يستاهل النقاش — وش رأيكم؟\n{trends}`,
      `✨ من جد {topic} غيّر نظرتي للأمور\n{trends}`,
      `🚀 يومك يبدأ بطاقة لما تهتم بـ {topic} 💪\n{trends}`,
      `💫 جرّبت أتعمق في {topic} مؤخراً.. تجربة تستحق\n{trends}`,
      `🔥 صباح الإنجاز! اليوم نبدأ بقوة 💪\n{trends}`,
      `✨ أجمل ما في يومك أنك تقرر كيف يكون 🌟\n{trends}`,
      `⚡ الفرص ما تنتظر أحد — خذ خطوتك اليوم\n{trends}`,
    ],
    informative: [
      `📌 معلومة عن {topic} قد تفيدك اليوم 👇\n{trends}`,
      `🧠 كل ما تعلمت أكثر عن {topic}، اكتشفت كم كنت أجهل\n{trends}`,
      `📖 خلاصة تجربتي مع {topic}: الاستمرارية أهم من الكمال\n{trends}`,
      `💡 هل تعلم؟ أغلب النجاحات تبدأ بخطوة صغيرة ثابتة\n{trends}`,
      `📊 نصيحة اليوم: ركّز على شيء واحد وأتقنه\n{trends}`,
      `🧭 القاعدة الذهبية: ما يُقاس يتحسّن\n{trends}`,
    ],
    funny: [
      `😂 أنا و{topic}: قصة حب من طرف واحد\n{trends}`,
      `🤣 حاولت أفهم {topic}.. {topic} رفض يتفاهم\n{trends}`,
      `😅 خططت ليومي بدقة.. اليوم كان له رأي ثاني\n{trends}`,
      `🤭 القهوة: الموظف الوحيد اللي ما يخذلني صباحاً ☕\n{trends}`,
      `😆 النوم مبكراً خطة عظيمة.. أنفذها كل ليلة الساعة 2 🌙\n{trends}`,
      `😂 مزاجي اليوم: طموح براتب آخر الشهر\n{trends}`,
    ],
    urgency: [
      `⏰ تذكير: {topic} ما راح ينجز نفسه — ابدأ الحين\n{trends}`,
      `🚨 سؤال مهم قبل نهاية اليوم: وش أنجزت من أهدافك؟\n{trends}`,
      `⚡ باقي ساعات على نهاية الأسبوع.. لحق على هدف واحد\n{trends}`,
      `⏳ الوقت يمشي سواء بدأت أو لا — الفرق أنت من يصنعه\n{trends}`,
      `🔔 لا تأجل لبكرة قراراً تقدر تأخذه اليوم\n{trends}`,
    ],
  };

  const product   = productDesc || 'هذا المنتج';
  const trendTags = (trends || []).map(t => t.name).join(' ');
  const fixed     = (customTags || '').trim();
  const allTags   = [trendTags, fixed].filter(Boolean).join(' ');

  const isMarketing = !!cleanUrl; // وجود رابط = وضع التسويق، غيابه = تغريد عام
  let pool;
  if (isMarketing) {
    pool = [...(TEMPLATES_GENERAL[tone] || TEMPLATES_GENERAL.hype)];
    if (category && TEMPLATES_BY_CATEGORY[category]) {
      const catTones = TEMPLATES_BY_CATEGORY[category][tone] || TEMPLATES_BY_CATEGORY[category].hype || [];
      pool = [...pool, ...catTones];
    }
  } else {
    pool = [...(TEMPLATES_FREE[tone] || TEMPLATES_FREE.hype)];
    // بدون موضوع؟ استبعد قوالب {topic}
    if (!productDesc) pool = pool.filter(t => !t.includes('{topic}'));
  }

  // منع التكرار: استبعد القوالب المستخدمة مؤخراً
  let candidates = pool.filter(t => !recentTemplates.includes(t));
  if (candidates.length === 0) { recentTemplates.length = 0; candidates = pool; }
  const template = candidates[Math.floor(Math.random() * candidates.length)];
  recentTemplates.push(template);
  if (recentTemplates.length > 12) recentTemplates.shift();
  let tweet = template
    .replace(/{product}/g, product)
    .replace(/{topic}/g, productDesc || '')
    .replace(/{url}/g, cleanUrl)
    .replace(/{trends}/g, allTags)
    .replace(/\n{2,}/g, '\n').trim();

  // إذا تجاوزت 280 — اختصر النص مع الإبقاء على الرابط والهاشتاقات
  if (tweet.length > 280) {
    const suffix = (cleanUrl ? `\n${cleanUrl}` : '') + (allTags ? `\n${allTags}` : '');
    const maxText = 280 - suffix.length - 4;
    const textPart = template.split('\n')[0].replace(/{product}/g, product);
    const trimmedText = textPart.length > maxText ? textPart.substring(0, Math.max(0, maxText)) + '…' : textPart;
    tweet = trimmedText + suffix;
  }

  return { success: true, tweet, charCount: tweet.length };
});

// ── معالجات الترخيص والمصادقة ────────────────────
ipcMain.handle('check-license', async () => {
  return await checkStoredLicense();
});

ipcMain.handle('verify-license', async (_, code) => {
  const result = await verifyLicense(code);
  if (result.valid) {
    // احفظ الكود + تاريخ التحقق الناجح في profile_image
    db.prepare(`INSERT OR REPLACE INTO auth (id, username, name, profile_image) VALUES (2, ?, ?, ?)`)
      .run(code, result.plan || 'active', new Date().toISOString());
  }
  return result;
});

ipcMain.handle('get-auth', async () => {
  // نعرض كود الترخيص كمعرّف للعميل (id=2 = الترخيص)
  const license = db.prepare('SELECT * FROM auth WHERE id=2').get();
  if (license && license.username) {
    // نعرض آخر 5 أحرف من الكود للخصوصية + الخطة
    const code = license.username;
    const shortCode = code.length > 5 ? '...' + code.slice(-5) : code;
    return {
      username: shortCode,
      name: license.name === 'lifetime' ? 'اشتراك دائم' : 'مشترك',
      profile_image: '',
      fullCode: code,
    };
  }
  return { username: 'مشترك', name: 'ناشر', profile_image: '' };
});

ipcMain.handle('logout', async () => {
  db.prepare('DELETE FROM auth WHERE id=2').run();
  return { success: true };
});

ipcMain.handle('start-oauth', async () => {
  return { success: false, error: 'غير مفعّل' };
});

// ── معالجات التحديث ──────────────────────────────
ipcMain.handle('check-update', async () => {
  await checkForUpdates(false);
  return { version: APP_VERSION };
});

ipcMain.handle('download-update', async () => {
  if (!autoUpdater) return { success: false, error: 'التحديث غير متاح' };
  try { autoUpdater.downloadUpdate(); return { success: true }; }
  catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('install-update', () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

ipcMain.handle('get-version', () => ({ version: APP_VERSION }));

ipcMain.handle('open-releases', () => {
  shell.openExternal('https://github.com/drfajry/tweetpilot-desktop/releases/latest');
});

// ── معالجات مساعدة ───────────────────────────────
// إصلاح خلل Electron المعروف: بعد نافذة alert تتجمد حقول الإدخال حتى يُعاد تركيز النافذة
ipcMain.handle('refocus-window', () => {
  try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.blur(); mainWindow.focus(); } } catch(e) {}
});

ipcMain.handle('open-external', (_, url) => {
  // حماية: روابط http/https فقط — يمنع فتح file:// أو بروتوكولات تنفيذية
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
  } catch(e) {}
});

ipcMain.handle('copy-to-clipboard', (_, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('puppeteer-post', async (_, { content, images }) => {
  if (content.length > 280) return { success: false, error: `التغريدة تتجاوز 280 حرفاً` };
  const result = await openComposeWindow(content, images || []);
  if (result.success) {
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(content, '', 'posted');
  }
  return result;
});

ipcMain.handle('puppeteer-login', async () => {
  return await openChromeForLogin();
});

ipcMain.handle('check-chrome', () => {
  // لم نعد نحتاج Chrome — النشر عبر نافذة داخلية
  return { found: true };
});

ipcMain.handle('post-tweet', async (_, { content }) => {
  if (content.length > 280) return { success: false, error: `التغريدة تتجاوز 280 حرفاً (${content.length})` };
  try {
    const client = getClient();
    const result = await client.v2.tweet(content);
    const tweetId = result.data?.id;
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(content, tweetId || '', 'posted');
    return { success: true, tweetId };
  } catch(e) {
    const detail = e.data?.detail || e.data?.title || e.message;
    return { success: false, error: detail };
  }
});

ipcMain.handle('schedule-tweet', (_, { content, scheduledAt }) => {
  if (content.length > 280) return { success: false, error: `التغريدة تتجاوز 280 حرفاً (${content.length})` };
  const r = db.prepare('INSERT INTO scheduled_tweets (content, scheduled_at) VALUES (?,?)').run(content, scheduledAt);
  return { success: true, id: r.lastInsertRowid };
});

// ── الجدولة الذكية ────────────────────────────────
// أفضل أوقات النشر على X (بتوقيت السعودية UTC+3)
const SMART_TIMES = {
  1: ['20:00'],                              // مرة واحدة — المساء
  2: ['09:00', '20:00'],                     // مرتين — صباح ومساء
  3: ['09:00', '14:00', '20:00'],            // ثلاث — صباح وظهر ومساء
  4: ['08:00', '12:00', '17:00', '21:00'],   // أربع
  5: ['08:00', '11:00', '14:00', '18:00', '21:00'], // خمس
};

ipcMain.handle('smart-schedule', (_, { tweets, dailyCount, startDate }) => {
  // tweets: مصفوفة نصوص التغريدات
  // dailyCount: عدد التغريدات يومياً
  // startDate: تاريخ البداية (اليوم أو غداً)

  const times = SMART_TIMES[dailyCount] || SMART_TIMES[3];
  const results = [];
  let tweetIndex = 0;
  let dayOffset = 0;

  while (tweetIndex < tweets.length) {
    for (const time of times) {
      if (tweetIndex >= tweets.length) break;
      const [hours, minutes] = time.split(':').map(Number);

      // حساب التاريخ والوقت
      const date = new Date(startDate);
      date.setDate(date.getDate() + dayOffset);
      date.setHours(hours - 3, minutes, 0, 0); // تحويل من UTC+3 إلى UTC

      const content = tweets[tweetIndex];
      if (content.length <= 280) {
        const r = db.prepare('INSERT INTO scheduled_tweets (content, scheduled_at) VALUES (?,?)')
          .run(content, date.toISOString());
        results.push({ id: r.lastInsertRowid, scheduledAt: date.toISOString(), content });
      }
      tweetIndex++;
    }
    dayOffset++;
  }

  mainWindow?.webContents.send('scheduled-posted', {});
  return { success: true, scheduled: results };
});

ipcMain.handle('get-scheduled', () => {
  return db.prepare('SELECT * FROM scheduled_tweets ORDER BY scheduled_at ASC LIMIT 100').all();
});

ipcMain.handle('delete-scheduled', (_, id) => {
  db.prepare('DELETE FROM scheduled_tweets WHERE id=?').run(id);
  return { success: true };
});

ipcMain.handle('delete-all-scheduled', () => {
  db.prepare("DELETE FROM scheduled_tweets WHERE status='pending' OR status='failed'").run();
  return { success: true };
});

// تحديث هاشتاقات التغريدة بترندات لحظة النشر (حل الترندات القديمة في الجدولة)
async function refreshHashtags(content) {
  try {
    // 1) أزل سطر الهاشتاقات الأخير إن وجد (سطر كله هاشتاقات)
    const lines = content.split('\n');
    while (lines.length > 0) {
      const last = lines[lines.length - 1].trim();
      if (last === '' || /^(#[^\s#]+[\s]*)+$/.test(last)) lines.pop();
      else break;
    }
    let base = lines.join('\n').trimEnd();

    // 2) اجلب ترندات إكس الحالية (السعودية)
    const t = await fetchTrends24('sa');
    if (!t.success || !t.trends || t.trends.length === 0) return content; // فشل الجلب → انشر كما هي

    // 3) أضف أول 3 ترندات بما يسمح به حد 280
    const fresh = [];
    for (const tr of t.trends) {
      if (fresh.length >= 3) break;
      const tag = (tr.name || '').trim();
      if (!tag || !tag.startsWith('#')) continue;
      const candidate = base + '\n' + [...fresh, tag].join(' ');
      if (candidate.length <= 280) fresh.push(tag);
    }
    if (fresh.length === 0) return (base && base.length <= 280) ? base : content;
    return base ? (base + '\n' + fresh.join(' ')) : fresh.join(' ');
  } catch(e) { return content; }
}

// نشر منشور مجدول الآن (عبر نافذة X الداخلية) — مخطط المحتوى
ipcMain.handle('post-scheduled', async (_, { id, content }) => {
  try {
    // ✨ استبدل الهاشتاقات القديمة بترندات لحظة النشر
    const freshContent = await refreshHashtags(content);
    const result = await openComposeWindow(freshContent, []);
    if (result.success) {
      db.prepare('UPDATE scheduled_tweets SET status="posted", tweet_id=? WHERE id=?').run('', id);
      db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(freshContent, '', 'posted');
      return { success: true };
    }
    // لا نعلّمه "فشل" نهائياً — يبقى pending ليعيد المستخدم المحاولة
    return { success: false, error: result.error || 'فشل النشر' };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-history', () => {
  return db.prepare('SELECT * FROM tweet_history ORDER BY posted_at DESC LIMIT 50').all();
});

// ── FIX: ترندات حقيقية من Google Trends ──────────
const TRENDS_SERVER = 'https://nashir-trends.onrender.com';

ipcMain.handle('fetch-trends', async (_, { region, platform }) => {
  if (platform === 'youtube') {
    return await fetchYoutubeTrends(region);
  }
  if (platform === 'google') {
    try {
      const res = await fetch(`${TRENDS_SERVER}/api/trends/tiktok`); // السيرفر يخزنها تحت tiktok (Google Trends)
      const data = await res.json();
      if (data.trends && data.trends.length > 0) {
        return { success: true, trends: data.trends, updatedAt: data.updatedAt };
      }
      return { success: false, error: 'الترندات غير متاحة حالياً — حاول لاحقاً', trends: [] };
    } catch(e) {
      return { success: false, error: 'تعذر الاتصال بسيرفر الترندات', trends: [] };
    }
  }
  return await fetchTrends24(region);
});

// جلب المنتجات عبر DuckDuckGo HTML Search — بدون API key
// ── بحث المنتجات: أدوات مشتركة ───────────────────
function stripTags(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function isProductPage(u) {
  const lower = u.toLowerCase();
  if (lower.includes('amazon.')) return /\/dp\/[a-z0-9]{6,}|\/gp\/product\//i.test(u);
  if (lower.includes('noon.com')) return /\/[a-z0-9]+\/p\/|\/p\//i.test(u);
  if (lower.includes('aliexpress.')) return /\/item\/\d+/i.test(u);
  return true;
}

function isBadPage(u) {
  return /\/s\?|\/search|\/sr\?|\/b\?|\/gp\/bestsellers|\/deal|\/browse|\/c\/|\/cat\/|\?k=|search=|\/store\//i.test(u);
}

function buildResults(items) {
  // items: [{url, title, snippet}]
  const results = [];
  const seen = new Set();
  for (const it of items) {
    if (results.length >= 8) break;
    const { url, title, snippet } = it;
    if (!title || !url || !url.startsWith('http')) continue;
    if (isBadPage(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const priceMatch = (snippet || '').match(/(?:SAR|ريال|SR|﷼|\$|USD)\s*[\d,\.]+|[\d,\.]+\s*(?:SAR|ريال|SR)/i);
    results.push({
      name: title.substring(0, 60),
      brand: '',
      price: priceMatch ? priceMatch[0] : '',
      url,
      snippet: (snippet || '').substring(0, 100),
      isProduct: isProductPage(url),
    });
  }
  results.sort((a, b) => (b.isProduct ? 1 : 0) - (a.isProduct ? 1 : 0));
  return results;
}

// طلب GET بسيط عبر net (نفس نمط الدرس 5: GET بسيط بلا ترويسات كثيرة)
function simpleGet(url) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const request = net.request({ url, method: 'GET', session: require('electron').session.defaultSession });
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    request.setHeader('Accept-Language', 'ar-SA,ar;q=0.9,en;q=0.8');
    let data = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; request.abort(); resolve({ status: 0, body: '' }); }, 12000);
    request.on('response', (response) => {
      response.on('data', chunk => { data += chunk.toString(); });
      response.on('end', () => { if (!timedOut) { clearTimeout(timer); resolve({ status: response.statusCode, body: data }); } });
    });
    request.on('error', () => { if (!timedOut) { clearTimeout(timer); resolve({ status: 0, body: '' }); } });
    request.end();
  });
}

// المصدر 1: DuckDuckGo (HTML) — تحليل مرن يتحمل تغيّر شكل الصفحة
async function searchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=ar-ar`;
  const { status, body } = await simpleGet(url);

  if (status === 202 || status === 429 || status === 403) {
    return { success: false, error: 'محرك البحث مشغول مؤقتاً — انتظر ١٠ ثوانٍ وأعد المحاولة', products: [], rateLimited: true };
  }
  if (status < 200 || status >= 300) {
    return { success: false, error: `تعذر البحث (${status})`, products: [] };
  }

  function decodeDDGUrl(rawUrl) {
    try {
      let u = rawUrl.replace(/&amp;/g, '&');
      if (u.includes('uddg=')) {
        const uddg = u.match(/uddg=([^&"]+)/)?.[1];
        if (uddg) return decodeURIComponent(uddg);
      }
      if (u.startsWith('http')) return u;
      if (u.startsWith('//')) return 'https:' + u;
      return u;
    } catch(e) { return rawUrl; }
  }

  const items = [];

  // النمط 1: الكلاسيكي result__a (بأي ترتيب للسمات)
  for (const m of body.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    items.push({ url: decodeDDGUrl(m[1]), title: stripTags(m[2]) });
  }
  for (const m of body.matchAll(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    items.push({ url: decodeDDGUrl(m[1]), title: stripTags(m[2]) });
  }
  // النمط 2 (احتياطي): أي رابط uddg مهما كان الكلاس
  if (items.length === 0) {
    for (const m of body.matchAll(/<a[^>]*href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const title = stripTags(m[2]);
      if (title.length < 4) continue; // تجاهل الروابط الفارغة/الأيقونات
      items.push({ url: decodeDDGUrl(m[1]), title });
    }
  }

  // المقتطفات (اختيارية)
  const snippets = [...body.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g)].map(m => stripTags(m[1]));
  items.forEach((it, i) => { it.snippet = snippets[i] || ''; });

  const results = buildResults(items);
  if (results.length === 0) return { success: false, error: 'DDG_EMPTY', products: [] };
  return { success: true, products: results, engine: 'duckduckgo' };
}

// المصدر 2 (احتياطي): Bing
async function searchBing(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ar&cc=SA`;
  const { status, body } = await simpleGet(url);
  if (status < 200 || status >= 300) return { success: false, error: `BING_${status}`, products: [] };

  const items = [];
  // نتائج Bing: <li class="b_algo"> ... <h2><a href="URL">العنوان</a></h2>
  for (const m of body.matchAll(/<h2[^>]*><a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g)) {
    items.push({ url: m[1].replace(/&amp;/g, '&'), title: stripTags(m[2]), snippet: '' });
  }
  const results = buildResults(items);
  if (results.length === 0) return { success: false, error: 'BING_EMPTY', products: [] };
  return { success: true, products: results, engine: 'bing' };
}

let lastDDGAt = 0; // آخر طلب DDG — للتهدئة بين البحثات المتتالية

ipcMain.handle('fetch-bestsellers', async (_, { source, query }) => {
  const STORES = {
    amazon:     { site: 'site:amazon.sa',          domain: 'amazon.',     loose: 'amazon.sa' },
    noon:       { site: 'site:noon.com/saudi-ar',  domain: 'noon.com',    loose: 'noon.com' },
    aliexpress: { site: 'site:aliexpress.com',     domain: 'aliexpress.', loose: 'aliexpress' },
  };
  const st = STORES[source] || STORES.amazon;
  const strictQ = `${st.site} ${query}`;
  const looseQ  = `${st.loose} ${query}`;

  const byDomain = (r) => {
    if (!r.success) return r;
    const filtered = r.products.filter(p => p.url.toLowerCase().includes(st.domain));
    return filtered.length ? { ...r, products: filtered } : { success: false, error: 'EMPTY_AFTER_FILTER', products: [] };
  };

  // خطة البحث: نتجنب DDG إذا استُخدم قبل أقل من 8 ثوانٍ (يحظر الطلبات المتتالية)
  const ddgCooling = (Date.now() - lastDDGAt) < 8000;

  const tryDDG = async (q) => {
    lastDDGAt = Date.now();
    return byDomain(await searchDuckDuckGo(q));
  };
  const tryBing = async (q) => byDomain(await searchBing(q));

  let result;
  if (!ddgCooling) {
    result = await tryDDG(strictQ);
    if (result.rateLimited) { await new Promise(r => setTimeout(r, 4000)); result = await tryDDG(strictQ); }
    if (!result.success) result = await tryBing(strictQ);
    if (!result.success) result = await tryBing(looseQ);
    if (!result.success) result = await tryDDG(looseQ);
  } else {
    // DDG في فترة تهدئة — ابدأ بـ Bing مباشرة
    result = await tryBing(strictQ);
    if (!result.success) result = await tryBing(looseQ);
    if (!result.success) result = await tryDDG(looseQ);
  }

  if (!result.success) {
    return { success: false, error: 'لم نجد نتائج — جرّب كلمات أدق أو أعد المحاولة بعد لحظات', products: [] };
  }
  return result;
});

// ── سحب صورة المنتج من الرابط ────────────────────
ipcMain.handle('fetch-product-image', async (_, url) => {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const request = net.request({
      url,
      method: 'GET',
      session: require('electron').session.defaultSession,
    });
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    request.setHeader('Accept', 'text/html,application/xhtml+xml');
    request.setHeader('Accept-Language', 'ar-SA,ar;q=0.9,en;q=0.8');

    let data = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
      resolve({ success: false, error: 'انتهت المهلة' });
    }, 10000);

    request.on('response', (response) => {
      // نقرأ أول 50KB فقط — كافية للـ meta tags
      let size = 0;
      response.on('data', chunk => {
        if (size > 50000) return;
        data += chunk.toString();
        size += chunk.length;
      });
      response.on('end', () => {
        if (timedOut) return;
        clearTimeout(timer);
        try {
          // استخراج og:image
          let imgUrl = '';
          const ogMatch = data.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
            || data.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
          if (ogMatch) imgUrl = ogMatch[1];

          // استخراج twitter:image كبديل
          if (!imgUrl) {
            const twMatch = data.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
              || data.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
            if (twMatch) imgUrl = twMatch[1];
          }

          // استخراج عنوان الصفحة
          const titleMatch = data.match(/<title[^>]*>([^<]+)<\/title>/i);
          const pageTitle = titleMatch ? titleMatch[1].replace(/\s*[|\-–]\s*.*$/, '').trim() : '';

          if (imgUrl) {
            // تأكد أن الرابط كامل
            if (imgUrl.startsWith('//')) imgUrl = 'https:' + imgUrl;
            resolve({ success: true, imageUrl: imgUrl, pageTitle });
          } else {
            resolve({ success: false, error: 'لم يتم العثور على صورة', pageTitle });
          }
        } catch(e) {
          resolve({ success: false, error: e.message });
        }
      });
    });
    request.on('error', (e) => {
      if (!timedOut) { clearTimeout(timer); resolve({ success: false, error: e.message }); }
    });
    request.end();
  });
});


app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });

  initDB();
  createMainWindow();
  setupAutoUpdater();

  // تحقق من التحديثات عند الفتح (بعد 5 ثواني)
  setTimeout(() => checkForUpdates(true), 5000);
  // وكل 6 ساعات
  setInterval(() => checkForUpdates(true), 6 * 60 * 60 * 1000);

  // ملاحظة: أُزيل النشر التلقائي (cron) — تحوّلت الجدولة إلى "مخطط محتوى":
  // المستخدم ينشر منشورات اليوم بنفسه بضغطة زر عبر نافذة X الداخلية.
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
