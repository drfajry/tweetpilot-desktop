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
const Database = require('./db');

// ── إعدادات التطبيق ──────────────────────────────
const API_KEY      = '1241epzWTO5a9JCoyGnR3Eb6L'; // ← Consumer Key
const API_SECRET   = 'XuW2J8ayMyTQyCmCkVJw7r7qMw3xoWEZirrNaqDUqGMoCXeafq'; // ← Consumer Secret
const ACCESS_TOKEN = '2051302166883606529-6FoWmSdH7pDbmuxLPQQjfEZiCy0CCx'; // ← Access Token
const ACCESS_SECRET= 'Q5uSfh3SiOPDqzFqIue18lFJnGmU0Zia6UNeCvSmfGsxo'; // ← Access Token Secret
const LICENSE_SERVER = 'https://nashir-license.onrender.com'; // ← رابط سيرفر Render
const APP_VERSION    = '2.0.0';

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
function getDeviceId() {
  // بصمة ثابتة محفوظة محلياً — تبقى ثابتة للجهاز نفسه ويصعب نقلها/تزويرها
  try {
    const fsx = require('fs');
    const pathx = require('path');
    const cryptox = require('crypto');
    const idFile = pathx.join(app.getPath('userData'), '.device');
    if (fsx.existsSync(idFile)) {
      const saved = fsx.readFileSync(idFile, 'utf8').trim();
      if (saved && saved.length >= 16) return saved;
    }
    // وليد جديد: مزيج من خصائص العتاد + عشوائية، مجزّأ (hash)
    const os = require('os');
    const nets = os.networkInterfaces();
    let mac = '';
    for (const k in nets) for (const n of nets[k]) if (n.mac && n.mac !== '00:00:00:00:00:00') { mac = n.mac; break; }
    const cpu = (os.cpus()[0] || {}).model || '';
    const seed = [os.hostname(), os.platform(), os.arch(), cpu, mac, os.totalmem(), cryptox.randomBytes(8).toString('hex')].join('|');
    const id = cryptox.createHash('sha256').update(seed).digest('hex').substring(0, 32);
    try { fsx.writeFileSync(idFile, id); } catch(e) {}
    return id;
  } catch(e) {
    // احتياط: الطريقة القديمة إن فشل كل شيء
    return require('os').hostname() + '-' + require('os').platform();
  }
}

async function verifyLicense(code) {
  const deviceId = getDeviceId();
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

// مهلة السماح دون اتصال — يحفظ تاريخ آخر تحقق ناجح
const GRACE_DAYS = 7;
function graceFile() {
  try { return require('path').join(app.getPath('userData'), '.lastverify'); } catch(e) { return null; }
}
function recordVerifySuccess() {
  try { const f = graceFile(); if (f) require('fs').writeFileSync(f, String(Date.now())); } catch(e) {}
}
function daysSinceLastVerify() {
  try {
    const f = graceFile();
    if (!f || !require('fs').existsSync(f)) return Infinity;
    const t = parseInt(require('fs').readFileSync(f, 'utf8').trim());
    if (!t) return Infinity;
    return (Date.now() - t) / (24 * 60 * 60 * 1000);
  } catch(e) { return Infinity; }
}

async function checkStoredLicense() {
  const stored = db.prepare('SELECT * FROM auth WHERE id=2').get();
  if (!stored || !stored.username) return { valid: false, reason: 'no_license' };

  const code = stored.username;
  const result = await verifyLicense(code);

  // التحقق نجح → افتح + سجّل وقت النجاح لمهلة السماح
  if (result && result.valid === true) {
    recordVerifySuccess();
    // احفظ معلومات الاشتراك (الخطة وتاريخ التحديثات) لعرضها للمستخدم
    try {
      const f = require('path').join(app.getPath('userData'), '.subinfo');
      require('fs').writeFileSync(f, JSON.stringify({
        plan: result.plan || '',
        updates_until: result.updates_until || '',
        updates_active: result.updates_active !== false,
      }));
    } catch(e) {}
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

  // فشل اتصال/مهلة/سيرفر نائم → استخدم مهلة السماح بدل حجب العميل الدافع
  const days = daysSinceLastVerify();
  if (days <= GRACE_DAYS) {
    const left = Math.max(0, Math.ceil(GRACE_DAYS - days));
    return { valid: true, grace: true, graceDaysLeft: left };
  }

  // تجاوز مهلة السماح ولم نتمكن من التحقق
  return { valid: false, reason: 'no_connection' };
}

// ── قاعدة البيانات ────────────────────────────────
const DB_PATH = path.join(app.getPath('userData'), 'nashir.db');
let db;

function initDB() {
  db = new Database(DB_PATH);
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
            const raw = m[2].trim();
            // فك ترميز رابط البحث لمعرفة إن كان هاشتاقاً فعلياً (يبدأ بـ %23 = #)
            let decoded = '';
            try { decoded = decodeURIComponent(m[1]); } catch(e) { decoded = m[1]; }
            if (!raw || seen.has(raw) || trends.length >= 15) continue;
            seen.add(raw);

            const isRealHashtag = raw.startsWith('#') || decoded.trim().startsWith('#');
            if (isRealHashtag) {
              // هاشتاق حقيقي — أبقِه كما هو
              const tag = raw.startsWith('#') ? raw : '#' + raw.replace(/\s+/g, '_');
              trends.push({ name: tag, isHashtag: true, tweet_volume: null });
            } else {
              // كلمة وصلت ترند لكنها ليست هاشتاقاً — نحفظها كنص عادي (لا نختلق هاشتاقاً)
              trends.push({ name: raw, isHashtag: false, tweet_volume: null });
            }
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
      // مُحيل (Referer) مطابق لنطاق الصورة — يتجاوز حماية ربط الصور في نون/أمازون/علي إكسبريس
      let referer = '';
      try { const u = new URL(url); referer = u.origin + '/'; } catch(e) {}
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/jpeg,image/png,image/webp,image/*;q=0.8,*/*;q=0.5',
        'Accept-Language': 'ar-SA,ar;q=0.9,en;q=0.8',
      };
      if (referer) headers['Referer'] = referer;
      const req = mod.get(url, { headers }, (r) => {
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
          // تأكد أنها صورة فعلاً (لا صفحة خطأ HTML)
          if (!/image\//i.test(type)) return resolve(null);
          // إكس لا يقبل AVIF/WEBP — ارفضها هنا ليتحوّلها مسار المتصفح (canvas → PNG)
          if (/avif|webp/i.test(type)) return resolve(null);
          resolve(`data:${type};base64,${buf.toString('base64')}`);
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    } catch(e) { resolve(null); }
  });
}


// جلب الصورة وتحويلها لصيغة PNG عبر canvas (يفك AVIF/WEBP ويخرج صيغة يقبلها إكس)
function fetchImageViaBrowser(url) {
  return new Promise((resolve) => {
    let win = null;
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { if (win && !win.isDestroyed()) win.destroy(); } catch(e){} win = null; resolve(v); };
    const convert = async () => {
      if (done || !win || win.isDestroyed()) return;
      try {
        const dataUrl = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              // حمّل الصورة عبر عنصر img (يتجاوز CORS للرسم على canvas للصور العامة)
              const dataUrl = await new Promise((res) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.referrerPolicy = 'no-referrer';
                img.onload = () => {
                  try {
                    const c = document.createElement('canvas');
                    let w = img.naturalWidth, h = img.naturalHeight;
                    if (!w || !h) return res(null);
                    const MAX = 2000;
                    if (w > MAX || h > MAX) { const r = Math.min(MAX/w, MAX/h); w = Math.round(w*r); h = Math.round(h*r); }
                    c.width = w; c.height = h;
                    c.getContext('2d').drawImage(img, 0, 0, w, h);
                    res(c.toDataURL('image/png'));
                  } catch(e) { res(null); }
                };
                img.onerror = () => res(null);
                img.src = ${JSON.stringify(url)};
                setTimeout(() => res(null), 10000);
              });
              return dataUrl;
            } catch(e) { return null; }
          })()
        `);
        finish(dataUrl && dataUrl.startsWith('data:image/png') ? dataUrl : null);
      } catch(e) { finish(null); }
    };
    try {
      win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:nashir-shop' } });
      // ضمان قاطع: ألغِ أي تنزيل قد يحاول فتح نافذة حفظ
      try { win.webContents.session.on('will-download', (e) => e.preventDefault()); } catch(e) {}
      setTimeout(() => finish(null), 15000);
      win.webContents.once('dom-ready', () => setTimeout(convert, 200));
      // صفحة HTML في الذاكرة فقط — لا نحمّل أي رابط من نطاق المتجر (يمنع نافذة الحفظ)
      win.loadURL('data:text/html;charset=utf-8,<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    } catch(e) { finish(null); }
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
    if (src.startsWith('data:image')) { imgs.push(src); continue; }
    if (src.startsWith('http')) {
      // مسار موحّد: حمّل مباشرة؛ إن فشل أو كانت الصيغة غير مقبولة، حوّلها PNG عبر المتصفح
      let d = await downloadImageAsDataUrl(src);
      if (!d) d = await fetchImageViaBrowser(src);
      if (d && d.startsWith('data:image')) imgs.push(d);
    }
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 720, height: 840,
      title: 'ناشر — النشر على إكس',
      autoHideMenuBar: true,
      parent: (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined, // يُغلق تلقائياً مع التطبيق
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
            // حارس داخل الصفحة: يضمن ألا يتكرر الحقن أبداً مهما تعددت أحداث التحميل
            if (window.__nashirInjected) return 'ALREADY';
            window.__nashirInjected = true;

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

            // تركيز ثم لصق حقيقي — محرر إكس (React) لا يفعّل الهاشتاقات/الروابط إلا عبر حدث paste
            box.focus();
            await wait(300);

            const TXT = ${JSON.stringify(content)};
            let pasted = false;
            try {
              const dt = new DataTransfer();
              dt.setData('text/plain', TXT);
              const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
              box.dispatchEvent(ev);
              pasted = true;
            } catch(e) { pasted = false; }
            await wait(800);

            // احتياط: لو لم يلتقط اللصق، عُد لـ insertText (نص بلا تفعيل أفضل من لا شيء)
            const okNow = (box.textContent || '').replace(/\\s+/g,' ').includes(TXT.replace(/\\s+/g,' ').substring(0,12));
            if (!okNow) {
              box.focus();
              document.execCommand('insertText', false, TXT);
              await wait(700);
            }

            // أرفق الصور — عبر حدث paste في المحرّر (نفس الآلية التي نجحت مع النص)
            // محرر إكس يقبل لصق الصور؛ حقن input.files لا يعمل لأن إكس لا يربطه إلا بعد ضغط زر الوسائط
            const IMGS = ${JSON.stringify(imgs)};
            if (IMGS.length > 0) {
              for (let i = 0; i < IMGS.length; i++) {
                try {
                  const res = await fetch(IMGS[i]);
                  if (!res.ok) continue;
                  const blob = await res.blob();
                  if (!blob || !blob.type || !blob.type.startsWith('image/') || blob.size === 0) continue;
                  const ext = (blob.type.split('/')[1] || 'jpg').split('+')[0];
                  const file = new File([blob], 'image' + (i+1) + '.' + ext, { type: blob.type });

                  // الطريقة 1: لصق الصورة في المحرّر
                  let ok = false;
                  try {
                    box.focus();
                    const dt = new DataTransfer();
                    dt.items.add(file);
                    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
                    box.dispatchEvent(ev);
                    ok = true;
                  } catch(e) { ok = false; }
                  await wait(2500); // امنح إكس وقتاً لرفع الصورة

                  // الطريقة 2 (احتياط): حقن input الملفات إن وُجد فعلاً
                  if (!ok) {
                    const input = document.querySelector('input[type="file"][data-testid="fileInput"], input[type="file"][accept*="image"]');
                    if (input) {
                      const dt2 = new DataTransfer();
                      dt2.items.add(file);
                      input.files = dt2.files;
                      input.dispatchEvent(new Event('change', { bubbles: true }));
                      await wait(2500);
                    }
                  }
                } catch(e) {}
              }
            }
            return 'OK';
          })()
        `);

        if (result === 'OK' || result === 'ALREADY') {
          injected = true;
          injecting = false;
          // راقب النشر الفعلي — لا نغلق إلا بتأكيد حقيقي مزدوج (يمنع الإغلاق المبكر)
          let sentStreak = 0;
          let sawComposer = false; // تأكدنا أن المستخدم كان فعلاً في صفحة الكتابة
          pollTimer = setInterval(async () => {
            if (win.isDestroyed() || !win.webContents || win.webContents.isDestroyed() || win.webContents.isCrashed()) { clearInterval(pollTimer); return; }
            try {
              const state = await win.webContents.executeJavaScript(`
                (() => {
                  const p = location.pathname;
                  if (/login|flow|access/.test(p)) return 'LOGIN';
                  const box = document.querySelector('[data-testid="tweetTextarea_0"]');
                  const toast = document.querySelector('[data-testid="toast"]');
                  const onCompose = p.startsWith('/compose') || !!box;
                  // إشعار "تم الإرسال" = تأكيد قاطع للنشر
                  if (toast && /تم|sent|Your post|تغريدتك|نشر/i.test(toast.textContent||'')) return 'POSTED';
                  if (box) return 'COMPOSING';
                  return onCompose ? 'COMPOSING' : 'IDLE';
                })()
              `);

              if (state === 'COMPOSING') { sawComposer = true; sentStreak = 0; }
              else if (state === 'POSTED') {
                // تأكيد قاطع — أغلق
                finish({ success: true });
                setTimeout(() => { try { if (!win.isDestroyed()) win.close(); } catch(e){} }, 1500);
              }
              else if (state === 'IDLE' && sawComposer) {
                // اختفى الصندوق بعد أن كان موجوداً — قد يكون نشر. نطلب تأكيداً متتالياً (مرتين)
                sentStreak++;
                if (sentStreak >= 2) {
                  finish({ success: true });
                  setTimeout(() => { try { if (!win.isDestroyed()) win.close(); } catch(e){} }, 1500);
                }
              }
              else { sentStreak = 0; }
            } catch(e) {}
          }, 2000);
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
ipcMain.handle('generate-tweet', (_, { trends, affiliateUrl, productDesc, tone, customTags, category, noonCode }) => {
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
    // نون: روابطه طويلة جداً — اختصرها لمعرّف المنتج فقط (الجزء قبل /p)
    if (/noon\.com/i.test(cleanUrl)) {
      cleanUrl = cleanUrl.split('?')[0];
      // استخرج المعرّف القصير: .../المعرّف/p → noon.com/saudi-ar/المعرّف/p
      const nm = cleanUrl.match(/(https?:\/\/[^\/]*noon\.com)\/([a-z-]+)\/.*\/([A-Z0-9]+)\/p/i);
      if (nm) cleanUrl = `${nm[1]}/${nm[2]}/${nm[3]}/p`;
    }
  } catch(e) {}

  // كود خصم نون: إن كان المنتج من نون وهناك كود، نستبدل الرابط الطويل بالكود (أنظف وأقصر)
  const isNoon = /noon\.com/i.test(affiliateUrl || '');
  if (isNoon && noonCode && noonCode.trim()) {
    cleanUrl = `🛒 احصل على خصم بكود: ${noonCode.trim().toUpperCase()}\n🔗 ${cleanUrl}`;
  }

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
  // فقط الترندات التي هي هاشتاقات حقيقية تُضاف كهاشتاقات؛ الكلمات العادية (مثل البرازيل) لا تُختلق كهاشتاق
  const trendTags = (trends || [])
    .filter(t => t.isHashtag !== false && (t.name || '').startsWith('#'))
    .map(t => t.name)
    .join(' ');
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

// إعدادات المستخدم (كود خصم نون وغيره) — تُحفظ محلياً
function settingsFile() {
  try { return require('path').join(app.getPath('userData'), '.settings.json'); } catch(e) { return null; }
}
// تشخيص صور المتاجر — يفحص المتاجر الثلاثة ويعيد المعطى الحقيقي (للدعم)
ipcMain.handle('diagnose-images', async () => {
  const TESTS = [
    { store: 'amazon',     url: 'https://www.amazon.sa/s?k=' + encodeURIComponent('سماعة بلوتوث') },
    { store: 'noon',       url: 'https://www.noon.com/saudi-ar/search/?q=' + encodeURIComponent('سماعة بلوتوث') },
    { store: 'aliexpress', url: 'https://ar.aliexpress.com/wholesale?SearchText=' + encodeURIComponent('سماعة بلوتوث') + '&g=y' },
  ];
  const EXTRACT = {
    amazon: `(()=>{const o=[];for(const c of document.querySelectorAll('div[data-asin][data-component-type="s-search-result"]')){const im=c.querySelector('img.s-image');if(!im)continue;o.push({src:(im.src||'').slice(0,100),srcset:(im.getAttribute('srcset')||'').slice(0,60)});if(o.length>=2)break;}return o;})()`,
    noon: `(()=>{const o=[];for(const a of document.querySelectorAll('a[href*="/p/"]')){const im=a.querySelector('img');o.push({aria:a.getAttribute('aria-label'),title:a.getAttribute('title'),imgSrc:im?(im.src||'').slice(0,100):'NO_IMG',imgData:im?(im.getAttribute('data-src')||''):'',alt:im?(im.alt||'').slice(0,40):''});if(o.length>=2)break;}return o;})()`,
    aliexpress: `(()=>{const o=[];for(const a of document.querySelectorAll('a[href*="/item/"]')){const im=a.querySelector('img');o.push({imgSrc:im?(im.src||'').slice(0,100):'NO_IMG',imgSrcset:im?(im.getAttribute('srcset')||'').slice(0,80):'',alt:im?(im.alt||'').slice(0,40):''});if(o.length>=2)break;}return o;})()`,
  };

  function probe(store, url) {
    return new Promise((resolve) => {
      let win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { partition: 'persist:nashir-shop' } });
      win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      let done = false;
      const finish = (d) => { if (done) return; done = true; try { if(!win.isDestroyed()) win.destroy(); } catch(e){} resolve(d); };
      setTimeout(() => finish({ store, error: 'TIMEOUT' }), 35000);
      let tries = 0;
      const read = async () => {
        if (done || win.isDestroyed()) return;
        try {
          await win.webContents.executeJavaScript('window.scrollTo(0,1200);true;').catch(()=>{});
          const items = await win.webContents.executeJavaScript(EXTRACT[store]);
          if (items && items.length) {
            const firstImg = items[0].src || items[0].imgSrc || items[0].imgData || '';
            let imgTest = 'NO_URL';
            if (firstImg && firstImg.startsWith('http')) {
              imgTest = await win.webContents.executeJavaScript(`(async()=>{try{const r=await fetch(${JSON.stringify(firstImg)},{referrerPolicy:'no-referrer'});const b=await r.blob();let dec=false;try{dec=!!(await createImageBitmap(b));}catch(e){}return{status:r.status,type:b.type,size:b.size,decode:dec};}catch(e){return{err:String(e).slice(0,60)};}})()`).catch(e => ({ jsErr: String(e).slice(0,60) }));
            }
            return finish({ store, items, firstImg: firstImg.slice(0,100), imgTest });
          }
        } catch(e) {}
        if (++tries < 12) setTimeout(read, 2500); else finish({ store, error: 'NO_ITEMS' });
      };
      win.webContents.on('did-finish-load', () => setTimeout(read, 3000));
      win.webContents.on('did-stop-loading', () => setTimeout(() => { if(!done) read(); }, 4000));
      win.loadURL(url);
    });
  }

  const out = [];
  for (const t of TESTS) out.push(await probe(t.store, t.url));
  return out;
});

ipcMain.handle('get-settings', async () => {
  try {
    const f = settingsFile();
    if (f && require('fs').existsSync(f)) return JSON.parse(require('fs').readFileSync(f, 'utf8'));
  } catch(e) {}
  return {};
});
ipcMain.handle('set-settings', async (_, data) => {
  try {
    const f = settingsFile();
    if (!f) return { success: false };
    let cur = {};
    try { if (require('fs').existsSync(f)) cur = JSON.parse(require('fs').readFileSync(f, 'utf8')); } catch(e) {}
    const merged = { ...cur, ...(data || {}) };
    require('fs').writeFileSync(f, JSON.stringify(merged));
    return { success: true };
  } catch(e) { return { success: false }; }
});

ipcMain.handle('get-auth', async () => {
  // نعرض كود الترخيص كمعرّف للعميل (id=2 = الترخيص)
  const license = db.prepare('SELECT * FROM auth WHERE id=2').get();
  // اقرأ معلومات الاشتراك المحفوظة
  let sub = {};
  try {
    const f = require('path').join(app.getPath('userData'), '.subinfo');
    if (require('fs').existsSync(f)) sub = JSON.parse(require('fs').readFileSync(f, 'utf8'));
  } catch(e) {}
  if (license && license.username) {
    // نعرض آخر 5 أحرف من الكود للخصوصية + الخطة
    const code = license.username;
    const shortCode = code.length > 5 ? '...' + code.slice(-5) : code;
    return {
      username: shortCode,
      name: license.name === 'lifetime' ? 'اشتراك دائم' : 'مشترك',
      profile_image: '',
      fullCode: code,
      plan: sub.plan || license.name || '',
      updates_until: sub.updates_until || '',
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
  // النشر يتم عبر نافذة إكس المرئية (المستخدم يضغط نشر بنفسه)
  const result = await openComposeWindow(content, []);
  if (result.success) {
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(content, '', 'posted');
  }
  return result;
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
      date.setHours(hours, minutes, 0, 0); // التوقيت المحلي لجهاز المستخدم — toISOString يتكفل بتحويل UTC

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

ipcMain.handle('update-scheduled-time', (_, { id, scheduledAt }) => {
  db.prepare('UPDATE scheduled_tweets SET scheduled_at=? WHERE id=?').run(scheduledAt, id);
  return { success: true };
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
  if (lower.includes('noon.com')) return /\/[a-z0-9-]+\/p\/|\/p\/\d|\/[a-z0-9]{8,}\/p\b/i.test(u);
  if (lower.includes('aliexpress.')) return /\/item\/\d+/i.test(u);
  return true;
}

// صفحة رئيسية أو فئة أو بحث — ليست منتجاً
function isHomepageOrNav(u) {
  try {
    const url = new URL(u);
    const path = url.pathname.replace(/\/+$/, ''); // أزل السلاش الأخير
    // الصفحة الرئيسية: لا مسار أو مسار لغة فقط (/ar، /saudi-ar)
    if (path === '' || /^\/(ar|en|sa|saudi-ar|saudi|[a-z]{2})$/i.test(path)) return true;
    return false;
  } catch(e) { return false; }
}

function isBadPage(u) {
  if (isHomepageOrNav(u)) return true;
  return /\/s\?|\/search|\/sr\?|\/b\?|\/gp\/bestsellers|\/deal|\/browse|\/c\/|\/cat\/|\/category|\?k=|search=|\/store\/|\/stores\/|\/wholesale|\/promotion\//i.test(u);
}

function buildResults(items) {
  // items: [{url, title, snippet}]
  const strong = []; // صفحات منتجات مؤكدة
  const weak = [];   // روابط متجر أخرى (ليست رئيسية/فئة) — احتياط
  const seen = new Set();
  for (const it of items) {
    const { url, title, snippet } = it;
    if (!title || !url || !url.startsWith('http')) continue;
    if (isHomepageOrNav(url)) continue;       // لا صفحات رئيسية أبداً
    if (seen.has(url)) continue;
    seen.add(url);
    const priceMatch = (snippet || '').match(/(?:SAR|ريال|SR|﷼|\$|USD)\s*[\d,\.]+|[\d,\.]+\s*(?:SAR|ريال|SR)/i);
    const entry = {
      name: title.substring(0, 60),
      brand: '',
      price: priceMatch ? priceMatch[0] : '',
      url,
      snippet: (snippet || '').substring(0, 100),
      isProduct: isProductPage(url),
    };
    if (isProductPage(url) && !isBadPage(url)) strong.push(entry);
    else if (!isBadPage(url)) weak.push(entry);
  }
  // الأفضلية لصفحات المنتجات المؤكدة؛ وإن لم توجد، نعرض روابط المتجر الأخرى (مع تنبيه الاستبدال الظاهر للمستخدم)
  const combined = [...strong, ...weak].slice(0, 8);
  return combined;
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

  // فك روابط Bing التحويلية (bing.com/ck/a?...&u=a1<base64>) للحصول على الرابط الحقيقي
  function decodeBingUrl(raw) {
    try {
      let u = raw.replace(/&amp;/g, '&');
      if (/bing\.com\/ck\//i.test(u)) {
        const uParam = u.match(/[?&]u=([^&]+)/)?.[1];
        if (uParam) {
          let b64 = uParam.replace(/^a1/, ''); // بادئة Bing
          b64 = b64.replace(/-/g, '+').replace(/_/g, '/'); // base64url → base64
          while (b64.length % 4) b64 += '=';
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          if (decoded.startsWith('http')) return decoded;
        }
      }
      return u;
    } catch(e) { return raw; }
  }

  const items = [];
  // نتائج Bing: <li class="b_algo"> ... <h2><a href="URL">العنوان</a></h2>
  for (const m of body.matchAll(/<h2[^>]*><a[^>]+href="(http[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g)) {
    items.push({ url: decodeBingUrl(m[1]), title: stripTags(m[2]), snippet: '' });
  }
  const results = buildResults(items);
  if (results.length === 0) return { success: false, error: 'BING_EMPTY', products: [] };
  return { success: true, products: results, engine: 'bing' };
}

// ── بحث المنتجات داخل نافذة المتجر الحقيقية (لا كشط محركات بحث = لا حظر) ──
// نفتح صفحة بحث المتجر في نافذة خفية، ننتظر تحميل النتائج، ثم نقرأ روابط المنتجات من DOM الفعلي.
ipcMain.handle('fetch-bestsellers', async (_, { source, query }) => {
  const STORES = {
    amazon: {
      url: q => `https://www.amazon.sa/s?k=${encodeURIComponent(q)}&language=ar`,
      extract: `
        (() => {
          const out = [];
          const cards = document.querySelectorAll('div[data-asin][data-component-type="s-search-result"]');
          for (const c of cards) {
            const asin = c.getAttribute('data-asin');
            if (!asin) continue;
            const titleEl = c.querySelector('h2 span, h2 a span');
            const priceEl = c.querySelector('.a-price .a-offscreen');
            const imgEl = c.querySelector('img.s-image');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (!title) continue;
            out.push({ url:'https://www.amazon.sa/dp/'+asin, title:title.substring(0,80), price:priceEl?priceEl.textContent.trim():'', image: imgEl?imgEl.src:'' });
            if (out.length >= 8) break;
          }
          return out;
        })()
      `,
    },
    noon: {
      url: q => `https://www.noon.com/saudi-ar/search/?q=${encodeURIComponent(q)}`,
      extract: `
        (() => {
          const out = [];
          const seen = new Set();
          // روابط منتجات نون الحقيقية: تحوي /<معرّف>/p مع صورة منتج فعلية (لا شعار)
          const links = document.querySelectorAll('a[href*="/p/"]');
          for (const a of links) {
            const href = a.href || '';
            if (!/\\/p(\\/|$|\\?)/.test(href)) continue;
            const clean = href.split('?')[0];
            if (seen.has(clean)) continue;
            const img = a.querySelector('img');
            if (!img) continue;
            const alt = (img.alt||'').trim();
            const src = img.src||'';
            // استبعد الشعار والصور غير المنتجة
            if (!alt || /^(logo|image|placeholder|loading)$/i.test(alt)) continue;
            if (/\\/assets\\/|logo|sprite|icon/i.test(src)) continue;
            // صورة المنتج في نون من نطاق f.nooncdn.com/p أو k.nooncdn مع معرّف منتج
            if (!/nooncdn\\.com\\/p\\//i.test(src)) continue;
            seen.add(clean);
            out.push({ url: clean, title: alt.substring(0,80), price:'', image: src });
            if (out.length >= 8) break;
          }
          return out;
        })()
      `,
    },
    aliexpress: {
      url: q => `https://ar.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}&g=y`,
      extract: `
        (() => {
          const out = [];
          const seen = new Set();
          const seenImg = new Set();
          const links = document.querySelectorAll('a[href*="/item/"]');
          for (const a of links) {
            const m = a.href.match(/\\/item\\/(\\d+)\\.html/);
            if (!m) continue;
            const clean = 'https://www.aliexpress.com/item/' + m[1] + '.html';
            if (seen.has(clean)) continue;
            seen.add(clean);
            const img = a.querySelector('img');
            const title = (img && img.alt) ? img.alt.trim() : (a.textContent || '').trim();
            if (!title || title.length < 5) continue;
            let src = img ? img.src : '';
            if(src && src.startsWith('//')) src = 'https:' + src;
            if(src && seenImg.has(src)) continue;
            if(src) seenImg.add(src);
            out.push({ url:clean, title:title.substring(0,80), price:'', image: src });
            if (out.length >= 8) break;
          }
          return out;
        })()
      `,
    },
  };

  const st = STORES[source] || STORES.amazon;
  const searchUrl = st.url(query);

  return await new Promise((resolve) => {
    let win = new BrowserWindow({
      width: 1280, height: 900,
      show: false, // خفية
      webPreferences: {
        partition: 'persist:nashir-shop',
        contextIsolation: true,
        nodeIntegration: false,
        images: true,
      },
    });

    // بعض المتاجر (خصوصاً علي إكسبريس) تتصرف بشكل مختلف بدون User-Agent متصفح حقيقي
    const REAL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    win.webContents.setUserAgent(REAL_UA);
    // ضمان: لا نافذة حفظ/تنزيل أبداً في نافذة البحث الخفية
    try { win.webContents.session.on('will-download', (e) => e.preventDefault()); } catch(e) {}
    win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['Accept-Language'] = 'ar-SA,ar;q=0.9,en;q=0.8';
      callback({ requestHeaders: details.requestHeaders });
    });

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch(e) {}
      win = null;
      resolve(result);
    };

    // مهلة قصوى 40 ثانية (نون وعلي إكسبريس أبطأ)
    const hardTimeout = setTimeout(() => finish({ success: false, error: 'انتهت المهلة — حاول مجدداً', products: [] }), 50000);

    // حصر النافذة في نطاق المتجر فقط (أمان)
    win.webContents.on('will-navigate', (e, u) => {
      const ok = /amazon\.|noon\.com|aliexpress\./i.test(u);
      if (!ok) e.preventDefault();
    });

    const tryExtract = async (attempt) => {
      if (done || !win || win.isDestroyed()) return;
      try {
        // مرّر الصفحة لتحفيز تحميل المنتجات الكسولة (lazy-load)
        await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight*0.6); true;').catch(()=>{});
        const products = await win.webContents.executeJavaScript(st.extract);
        if (products && products.length > 0) {
          const withImg = products.filter(p => p.image && (p.image.startsWith('http') || p.image.startsWith('data:'))).length;
          // في المحاولات المبكرة، انتظر تحميل الصور (canvas يحتاج img.complete)؛ بعد 6 محاولات اقبل ما توفّر
          if (withImg === 0 && attempt < 6) {
            setTimeout(() => tryExtract(attempt + 1), 2200);
            return;
          }
          clearTimeout(hardTimeout);
          const clean = products
            .filter(p => p.url && !isHomepageOrNav(p.url))
            .map(p => ({
              name: (p.title || '').substring(0, 70),
              price: p.price || '',
              url: p.url,
              image: p.image || '',
              snippet: '',
              isProduct: true,
            }));
          finish({ success: true, products: clean.slice(0, 8), engine: 'store' });
          return;
        }
      } catch(e) {}
      // أعد المحاولة حتى 14 مرة (نتائج نون/علي إكسبريس تُحمّل ببطء وديناميكياً)
      if (attempt < 18) setTimeout(() => tryExtract(attempt + 1), 2200);
      else { clearTimeout(hardTimeout); finish({ success: false, error: 'لم نجد منتجات لهذا البحث — جرّب كلمة أخرى', products: [] }); }
    };

    win.webContents.on('did-finish-load', () => {
      // امنح الصفحة وقتاً لبدء تحميل النتائج الديناميكية ثم اقرأ (مع إعادات متعددة)
      setTimeout(() => tryExtract(0), 2500);
    });
    // بعض المتاجر تكمل التحميل بدون did-finish-load نظيف — جرّب أيضاً عند التوقف
    win.webContents.on('did-stop-loading', () => {
      setTimeout(() => { if (!done) tryExtract(0); }, 3000);
    });

    win.webContents.on('did-fail-load', (e, code, desc) => {
      if (code === -3) return; // إلغاء عادي
      clearTimeout(hardTimeout);
      finish({ success: false, error: 'تعذّر فتح المتجر — تحقق من الإنترنت', products: [] });
    });

    win.loadURL(searchUrl);
  });
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

// عند الإغلاق: أغلق كل النوافذ الفرعية (نافذة إكس) حتى لا تبقى يتيمة
app.on('before-quit', () => {
  try {
    BrowserWindow.getAllWindows().forEach(w => { try { if (!w.isDestroyed()) w.destroy(); } catch(e){} });
  } catch(e) {}
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
