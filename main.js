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
const APP_VERSION    = '2.3.6';

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
let isInstallingUpdate = false; // أثناء التثبيت: نمنع app.quit المبكر كي يُكمل المثبّت ويعيد التشغيل
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false; // لا يحمّل إلا عند ضغط المستخدم
  autoUpdater.autoInstallOnAppQuit = true;
} catch(e) {
  console.log('electron-updater غير متاح:', e.message);
}

function setupAutoUpdater() {
  if (!autoUpdater) return;

  // سجّل كل خطوات الفحص لمعرفة أي نسخة يراها electron-updater على GitHub
  try { autoUpdater.on('checking-for-update', () => console.log('[updater] checking... installed:', APP_VERSION)); } catch(e){}

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] UPDATE AVAILABLE on GitHub:', info && info.version, '| installed:', APP_VERSION);
    mainWindow?.webContents.send('update-available', {
      current: APP_VERSION,
      latest: info.version,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    // info.version = أحدث نسخة وجدها على GitHub (من latest.yml). قارنها بالمثبّتة لتشخيص السبب.
    console.log('[updater] NOT AVAILABLE. latest on GitHub (latest.yml):', info && info.version, '| installed:', APP_VERSION);
    mainWindow?.webContents.send('update-not-available', { version: APP_VERSION, serverLatest: info && info.version });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', {
      percent: Math.round(progress.percent),
      speed: Math.round(progress.bytesPerSecond / 1024),
    });
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[updater] update downloaded — ready to install');
    mainWindow?.webContents.send('update-downloaded', {});
  });

  autoUpdater.on('error', (err) => {
    // خطأ شائع: 404 على latest.yml (لم يُرفع مع الـ Release) أو الـ Release غير منشور (draft)
    console.log('[updater] ERROR:', err && err.message);
    mainWindow?.webContents.send('update-error', { error: err.message });
  });
}

// معلومات الاشتراك المحفوظة محلياً (الخطة + تاريخ انتهاء التحديثات + هل التحديثات فعّالة)
function readSubInfo() {
  try {
    const f = require('path').join(app.getPath('userData'), '.subinfo');
    if (require('fs').existsSync(f)) return JSON.parse(require('fs').readFileSync(f, 'utf8'));
  } catch(e) {}
  return {};
}
// هل يُسمح بالتحديثات الآن؟ تتوقف بعد سنة التفعيل (مدى الحياة) أو مع انتهاء الاشتراك (سنوي).
function updatesAllowed() {
  const sub = readSubInfo();
  if (sub.updates_active === false) return false;
  // تحقق إضافي من التاريخ محلياً (احتياط لو تعذّر الاتصال بالخادم)
  if (sub.updates_until) { try { if (new Date(sub.updates_until) < new Date()) return false; } catch(e) {} }
  return true;
}

async function checkForUpdates(silent = false) {
  if (!autoUpdater) return;
  // احترم فترة التحديثات: مدى الحياة تتوقف تحديثاته بعد سنة (يبقى البرنامج يعمل)
  if (!updatesAllowed()) {
    console.log('[updater] updates period ended — skipping check (app keeps working)');
    mainWindow?.webContents.send('updates-ended', readSubInfo());
    return;
  }
  try {
    let feed = '';
    try { feed = JSON.stringify(autoUpdater.getFeedURL && autoUpdater.getFeedURL() || autoUpdater.updateConfigPath || ''); } catch(e){}
    console.log('[updater] checkForUpdates start | installed:', APP_VERSION, '| feed:', feed);
    const r = await autoUpdater.checkForUpdates();
    console.log('[updater] checkForUpdates result:', r && r.updateInfo ? ('server version ' + r.updateInfo.version) : 'no info');
  } catch(e) {
    console.log('[updater] checkForUpdates threw:', e && e.message);
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
async function downloadImageAsDataUrl(url, redirects = 0) {
  if (redirects > 3) return null;
  // نظّف روابط نون المشوّهة: أزل بادئة الهاش + | (%7C) قبل pzsku
  try {
    if (/nooncdn\.com/i.test(url) && /%7C|\|/i.test(url)) {
      const pIdx = url.search(/%7C|\|/i);
      if (pIdx >= 0) { const after = url.slice(pIdx).replace(/^(%7C|\|)/i, ''); url = 'https://f.nooncdn.com/p/' + after; }
    }
  } catch(e) {}

  // مُحيل مناسب لكل CDN
  let referer = '';
  try {
    const u = new URL(url);
    if (/nooncdn\.com/i.test(u.host)) referer = 'https://www.noon.com/';
    else if (/aliexpress-media\.com|alicdn\.com/i.test(u.host)) referer = 'https://www.aliexpress.com/';
    else if (/media-amazon\.com|ssl-images-amazon\.com/i.test(u.host)) referer = 'https://www.amazon.sa/';
    else referer = u.origin + '/';
  } catch(e) {}
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5',
    'Accept-Language': 'ar-SA,ar;q=0.9,en;q=0.8',
  };
  if (referer) { headers['Referer'] = referer; headers['Origin'] = referer.replace(/\/$/, ''); }

  console.log('[IMG_FETCH_START]', url);
  try {
    // net.fetch يستخدم شبكة Chromium نفسها (نفس الكوكيز/الجلسة) — أقرب لطلب متصفح حقيقي
    const { net, session } = require('electron');
    let resp;
    try {
      const sess = session.fromPartition('persist:nashir-shop');
      resp = await net.fetch(url, { headers, useSessionCookies: true, session: sess });
    } catch(e1) {
      // fallback: net.fetch بالجلسة الافتراضية، ثم fetch العادي
      try { resp = await net.fetch(url, { headers, useSessionCookies: true }); }
      catch(e2) { resp = await fetch(url, { headers, redirect: 'follow' }); }
    }

    console.log('[IMG_FETCH_STATUS]', JSON.stringify({
      status: resp.status, ok: resp.ok, redirected: resp.redirected,
      finalUrl: (resp.url || '').slice(0, 120),
      contentType: resp.headers.get('content-type'),
      contentLength: resp.headers.get('content-length')
    }));

    if (!resp.ok) { console.log('[IMG_FETCH_FAILED]', resp.status); return null; }

    const arrayBuffer = await resp.arrayBuffer();
    console.log('[IMG_ARRAYBUFFER]', arrayBuffer.byteLength);
    const buffer = Buffer.from(arrayBuffer);
    console.log('[IMG_BUFFER]', buffer.length);

    if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) { console.log('[IMG_FETCH_FAILED] size', buffer.length); return null; }
    const type = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!/image\//i.test(type)) { console.log('[IMG_FETCH_FAILED] not-image', type); return null; }
    // AVIF/WEBP مقبولة الآن — ستُحوّل لـ JPEG في مرحلة التطبيع قبل الرفع
    return `data:${type};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('[IMG_FETCH_EXCEPTION]', String(err && err.message || err).slice(0, 180));
    return null;
  }
}


// يحوّل أي buffer صورة (بما فيها AVIF/WEBP التي لا يقبلها إكس) إلى JPEG.
// أولاً nativeImage (سريع)، فإن فشل (مثل AVIF) يفكّها عبر canvas في نافذة Chromium مخفية.
async function decodeToJpeg(buffer, mime) {
  // (1) nativeImage — يكفي لـ JPEG/PNG وأحياناً WEBP
  try {
    const { nativeImage } = require('electron');
    const ni = nativeImage.createFromBuffer(buffer);
    if (ni && !ni.isEmpty()) {
      let out = ni;
      const sz = ni.getSize();
      if (sz.width > 1600 || sz.height > 1600) out = ni.resize({ width: Math.min(1600, sz.width || 1600), quality: 'best' });
      const jpg = out.toJPEG(92);
      if (jpg && jpg.length > 1500) { console.log('[IMG_CONVERT] via nativeImage ->', jpg.length); return jpg; }
    }
  } catch(e) {}
  // (2) canvas في Chromium — يفك AVIF/WEBP أصلاً (data: URL لا يلوّث canvas)
  return await new Promise((resolve) => {
    let win = null, done = false;
    const fin = (v) => { if (done) return; done = true; try { if (win && !win.isDestroyed()) win.destroy(); } catch(e){} resolve(v); };
    try {
      const dataUrl = `data:${mime || 'image/avif'};base64,${buffer.toString('base64')}`;
      win = new BrowserWindow({ show: false, width: 1700, height: 1700, webPreferences: { partition: 'persist:nashir-shop' } });
      setTimeout(() => fin(null), 15000);
      win.webContents.once('dom-ready', async () => {
        try {
          const out = await win.webContents.executeJavaScript(`
            (async () => {
              try {
                const img = new Image();
                const ok = await new Promise((res) => {
                  img.onload = () => res(true);
                  img.onerror = () => res(false);
                  img.src = ${JSON.stringify(dataUrl)};
                  setTimeout(() => res(img.complete && img.naturalWidth > 0), 9000);
                });
                if (!ok || !img.naturalWidth) return null;
                let w = img.naturalWidth, h = img.naturalHeight;
                const MAX = 1600;
                if (w > MAX || h > MAX) { const r = Math.min(MAX/w, MAX/h); w = Math.round(w*r); h = Math.round(h*r); }
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                return c.toDataURL('image/jpeg', 0.92); // data: URL لا يُلوّث canvas
              } catch(e) { return null; }
            })()
          `);
          if (out && out.startsWith('data:image/jpeg')) {
            const b = Buffer.from(out.split(',')[1], 'base64');
            console.log('[IMG_CONVERT] via canvas ->', b.length);
            fin(b.length > 1500 ? b : null);
          } else { console.log('[IMG_CONVERT] canvas failed'); fin(null); }
        } catch(e) { console.log('[IMG_CONVERT] exception', String(e).slice(0,80)); fin(null); }
      });
      win.loadURL('data:text/html;charset=utf-8,<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"></body></html>');
    } catch(e) { fin(null); }
  });
}


// جلب الصورة عبر نافذة المتصفح والتقاطها (يتجاوز حجب fetch وقيد CORS)
function fetchImageViaBrowser(url) {
  return new Promise((resolve) => {
    let win = null;
    let done = false;
    let dbg = null;
    let attached = false;
    let htmlPath = '';
    const finish = (v) => { if (done) return; done = true;
      try { if (attached && dbg) dbg.detach(); } catch(e){}
      try { if (win && !win.isDestroyed()) win.destroy(); } catch(e){} win = null;
      try { if (htmlPath) require('fs').unlinkSync(htmlPath); } catch(e){}
      resolve(v); };
    const run = async () => {
      if (done || !win || win.isDestroyed()) return;
      try {
        // اعرض الصورة في <img> بلا crossOrigin (يتجاوز حاجة CORS التي يفتقدها nooncdn)،
        // ثم التقطها عبر CDP screenshot — يتجاوز fetch المحجوب و canvas taint معاً.
        const prep = await win.webContents.executeJavaScript(`
          (async () => {
            try {
              const img = document.createElement('img');
              img.referrerPolicy = 'no-referrer';
              img.style.cssText = 'position:fixed;top:0;left:0;background:#fff;display:block;';
              document.body.appendChild(img);
              const ok = await new Promise((res) => {
                img.onload = () => res(img.naturalWidth > 10);
                img.onerror = () => res(false);
                img.src = ${JSON.stringify(url)};
                setTimeout(() => res(img.complete && img.naturalWidth > 10), 10000);
              });
              if (!ok) return { ok:false };
              // اعرضها بحجمها الحقيقي (بحد أقصى 1200) لتُلتقط بجودة عالية
              const big = Math.min(1200, Math.max(img.naturalWidth, img.naturalHeight));
              const ratio = big / Math.max(img.naturalWidth, img.naturalHeight);
              const w = Math.max(1, Math.round(img.naturalWidth * ratio));
              const h = Math.max(1, Math.round(img.naturalHeight * ratio));
              img.style.width = w + 'px'; img.style.height = h + 'px';
              await new Promise(r => setTimeout(r, 150));
              return { ok:true, w: w, h: h };
            } catch(e) { return { ok:false, err: String(e).slice(0,80) }; }
          })()
        `);
        if (!prep || !prep.ok) return finish(null);

        dbg = win.webContents.debugger;
        try { dbg.attach('1.3'); attached = true; } catch(e) { if (/already attached/i.test(String(e))) attached = true; else return finish(null); }
        await dbg.sendCommand('Page.enable').catch(()=>{});
        const shot = await dbg.sendCommand('Page.captureScreenshot', {
          format: 'jpeg', quality: 92,
          clip: { x: 0, y: 0, width: prep.w, height: prep.h, scale: 2 },
          captureBeyondViewport: true,
        });
        if (shot && shot.data && shot.data.length > 1000) finish('data:image/jpeg;base64,' + shot.data);
        else finish(null);
      } catch(e) { finish(null); }
    };
    try {
      // صفحة file:// مؤقتة — نفس سياق المعاينة الذي يعرض صور نون بنجاح (لا opaque origin مثل data:)
      const osx = require('os'), pathh = require('path'), fsh = require('fs');
      htmlPath = pathh.join(osx.tmpdir(), 'nashir-shot-' + Date.now() + '-' + Math.random().toString(36).slice(2,7) + '.html');
      fsh.writeFileSync(htmlPath, '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff"></body></html>');
      win = new BrowserWindow({ show: false, width: 1400, height: 1400, webPreferences: { partition: 'persist:nashir-shop' } });
      try { win.webContents.session.on('will-download', (e) => e.preventDefault()); } catch(e) {}
      setTimeout(() => finish(null), 18000);
      win.webContents.once('dom-ready', () => setTimeout(run, 200));
      win.loadFile(htmlPath);
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

// ── التقاط صور نون عبر CDP ──
// نفتح صفحة كل منتج في نافذة تصوير معزولة (كراش رندرها لا يُسقط التطبيق ولا يمسّ نافذة البحث)،
// وننتظر الصورة الرئيسية الأصلية (complete && naturalWidth>500 && naturalHeight>500) ثم نصوّرها.
// كل عملية محميّة بمهلة صارمة + مهلة كلية، ومعالجة كراش الرندر — فلا تعليق ولا إسقاط للتطبيق،
// وتصل النتائج دائماً (بصور المنتج، أو بالصورة الأصلية المصغّرة عند التعذّر).
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ]);
}

async function captureNoonImages(parentWin, products) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const fsx = require('fs'); const pathx = require('path'); const urlx = require('url');

  // مجلد ملفات صور نون المؤقتة: نحفظ كل لقطة كملف ونمرّر مساره (file://) بدل data URI الثقيل عبر IPC.
  const noonImgDir = pathx.join(require('os').tmpdir(), 'nashir-noon-imgs');
  try {
    // نظّف ملفات الدفعة السابقة كي لا تتراكم
    if (fsx.existsSync(noonImgDir)) { for (const f of fsx.readdirSync(noonImgDir)) { try { fsx.unlinkSync(pathx.join(noonImgDir, f)); } catch(e){} } }
    else fsx.mkdirSync(noonImgDir, { recursive: true });
  } catch(e) {}
  const saveShot = (b64) => {
    try {
      const buf = Buffer.from(b64, 'base64');
      if (!buf || buf.length < 2000) return '';
      const fp = pathx.join(noonImgDir, `noon_${Date.now()}_${Math.random().toString(36).slice(2,8)}.jpg`);
      fsx.writeFileSync(fp, buf);
      return urlx.pathToFileURL(fp).href; // file://...
    } catch(e) { return ''; }
  };
  const saveBuf = (buf) => {
    try {
      if (!buf || buf.length < 2000) return '';
      const fp = pathx.join(noonImgDir, `noon_${Date.now()}_${Math.random().toString(36).slice(2,8)}.jpg`);
      fsx.writeFileSync(fp, buf);
      return urlx.pathToFileURL(fp).href;
    } catch(e) { return ''; }
  };

  // نافذة تصوير معزولة مستقلة عن نافذة البحث (نفس جلسة نون). لا نلمس parentWin إطلاقاً.
  let capWin = null;
  try {
    capWin = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { partition: 'persist:nashir-shop', backgroundThrottling: false } });
  } catch(e) { return products; }

  let crashed = false;
  try {
    capWin.webContents.on('render-process-gone', () => { crashed = true; });
    capWin.webContents.on('unresponsive', () => { crashed = true; });
  } catch(e){}

  const dbg = capWin.webContents.debugger;
  let attached = false;
  const captureLog = [];
  const DEADLINE = Date.now() + 100000; // مهلة كلية صارمة

  const loadAndWait = (url, timeout) => new Promise((resolve) => {
    let done = false;
    const fin = (ok) => { if (done) return; done = true;
      try { capWin.webContents.removeListener('dom-ready', onReady); } catch(e){}
      try { capWin.webContents.removeListener('did-stop-loading', onReady); } catch(e){}
      try { capWin.webContents.removeListener('did-finish-load', onReady); } catch(e){}
      try { capWin.webContents.removeListener('did-fail-load', onFail); } catch(e){}
      resolve(ok); };
    // صفحات نون SPA لا تُطلق did-finish-load (اتصالات مستمرة) — نعتمد dom-ready (يأتي بسرعة)
    const onReady = () => fin(true);
    const onFail = (e, code) => { if (code === -3) return; fin(false); };
    try { capWin.webContents.on('dom-ready', onReady); } catch(e){}
    try { capWin.webContents.on('did-stop-loading', onReady); } catch(e){}
    try { capWin.webContents.on('did-finish-load', onReady); } catch(e){}
    try { capWin.webContents.on('did-fail-load', onFail); } catch(e){}
    setTimeout(() => fin(false), timeout);
    try { capWin.loadURL(url); } catch(e) { fin(false); }
  });

  const alive = () => capWin && !capWin.isDestroyed() && capWin.webContents && !capWin.webContents.isDestroyed() && !capWin.webContents.isCrashed() && !crashed;

  try {
    try { dbg.attach('1.3'); attached = true; } catch(e) { if (/already attached/i.test(String(e))) attached = true; else attached = false; }
    if (attached) await withTimeout(dbg.sendCommand('Page.enable'), 4000, null);

    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const entry = { url: p.url, stage: 'product_page' };
      if (Date.now() > DEADLINE) { entry.skipped = 'deadline'; captureLog.push(entry); continue; }
      if (!p.url) { products[i].image = ''; continue; }
      if (!alive()) { entry.skipped = 'win_gone'; products[i].image = ''; captureLog.push(entry); continue; }

      try {
        // (1) افتح صفحة المنتج — ننتظر dom-ready (يأتي بسرعة) بمهلة 12s
        const loaded = await loadAndWait(p.url, 12000);
        entry.loaded = loaded;
        await sleep(1500);
        if (!alive()) { entry.crashed = true; products[i].image = ''; captureLog.push(entry); continue; }

        // (2)+(3) انتظر الصورة الرئيسية الأصلية — محمي بمهلة 9s
        const prep = await withTimeout(capWin.webContents.executeJavaScript(`
          (async () => {
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            try {
              let best = null, lastLog = null;
              for (let t = 0; t < 12; t++) {
                const imgs = Array.from(document.images || []);
                let cand = null;
                for (const im of imgs) {
                  if (im.complete !== true) continue;
                  if (!(im.naturalWidth > 500 && im.naturalHeight > 500)) continue;
                  const r = im.getBoundingClientRect();
                  if (!(r.width > 0 && r.height > 0)) continue;
                  if (!cand || im.naturalWidth > cand.naturalWidth) cand = im;
                }
                lastLog = cand
                  ? { attempt: t+1, naturalWidth: cand.naturalWidth, naturalHeight: cand.naturalHeight, clientWidth: cand.clientWidth, clientHeight: cand.clientHeight, complete: cand.complete, currentSrc: (cand.currentSrc||'').slice(0,150) }
                  : { attempt: t+1, found: false };
                if (cand) { best = cand; break; }
                await sleep(450);
              }
              if (!best) return { ok:false, reason:'no_main_image', log: lastLog };
              best.scrollIntoView({ block:'center', inline:'center' });
              const box = Math.min(900, Math.max(best.naturalWidth, best.naturalHeight));
              best.dataset.nashirPrev = best.getAttribute('style') || '';
              best.style.position='fixed'; best.style.top='0px'; best.style.left='0px';
              best.style.width=box+'px'; best.style.height=box+'px';
              best.style.maxWidth='none'; best.style.maxHeight='none';
              best.style.objectFit='contain'; best.style.background='#fff'; best.style.zIndex='2147483647';
              best.id = '__nashir_main_img__';
              await sleep(160);
              return { ok:true, box: box, log: lastLog };
            } catch(e) { return { ok:false, reason:'js_err', log:{ err:String(e).slice(0,120) } }; }
          })()
        `), 9000, { ok:false, reason:'timeout' });

        Object.assign(entry, (prep && prep.log) || {}, { ok: !!(prep && prep.ok), reason: prep && prep.reason });

        if (prep && prep.ok && prep.box && alive()) {
          // التقط الصورة كملف: capturePage أولاً (أوثق للنوافذ المخفية)، ثم CDP احتياطاً
          let buf = null; let capMethod = '';
          const side = Math.min(Math.ceil(prep.box), 1000); // ضمن أبعاد النافذة
          console.log('[capture] START', JSON.stringify({ url: (p.url||'').slice(0,80), box: prep.box, side }));
          // (1) محاولة capturePage
          try {
            const nimg = await capWin.webContents.capturePage({ x: 0, y: 0, width: side, height: side });
            const empty = !nimg || nimg.isEmpty();
            const sz = (nimg && !empty) ? nimg.getSize() : null;
            console.log('[capture] capturePage', JSON.stringify({ empty, size: sz }));
            if (!empty) {
              const b = nimg.toJPEG(92);
              console.log('[capture] capturePage->jpeg length:', b ? b.length : 0);
              if (b && b.length > 2000) { buf = b; capMethod = 'capturePage'; }
            }
          } catch(e) { entry.capErr = String(e).slice(0, 80); console.log('[capture] capturePage ERROR:', entry.capErr); }
          // (2) احتياط CDP Page.captureScreenshot
          if (!buf && attached && alive()) {
            console.log('[capture] CDP captureScreenshot called');
            const shot = await withTimeout(dbg.sendCommand('Page.captureScreenshot', {
              format: 'jpeg', quality: 92,
              clip: { x: 0, y: 0, width: prep.box, height: prep.box, scale: 2 },
              captureBeyondViewport: true,
            }), 8000, null);
            console.log('[capture] CDP result', JSON.stringify({ hasData: !!(shot && shot.data), dataLength: (shot && shot.data) ? shot.data.length : 0 }));
            if (shot && shot.data && shot.data.length > 2000) { buf = Buffer.from(shot.data, 'base64'); capMethod = 'cdp'; }
          }
          // (3)+(4)+(5) حفظ الملف وحجمه
          if (buf) {
            const saved = { url: saveBuf(buf) };
            let fileSize = 0; try { if (saved.url) fileSize = require('fs').statSync(require('url').fileURLToPath(saved.url)).size; } catch(e){}
            console.log('[capture] saveBuf', JSON.stringify({ method: capMethod, bufLength: buf.length, fileUrl: saved.url || '(empty)', fileSize }));
            if (saved.url) {
              products[i].image = saved.url;
              entry.captured = 'product_page'; entry.savedFile = saved.url;
              console.log('[NOON_SAVED]', saved.url);
            } else { products[i].image = ''; entry.captured = false; } // فشل الحفظ → بلا صورة (لا رابط nooncdn)
          } else {
            console.log('[capture] NO BUFFER — both capturePage and CDP failed');
            products[i].image = ''; entry.captured = false; // بلا صورة (لا رابط nooncdn)
          }
          console.log('[capture] FINAL products[i].image =', (products[i].image || '').slice(0, 90));
        } else {
          // لا صورة ≥500 في صفحة المنتج → بلا صورة. (الـ fallback مُلغى مؤقتاً بطلب المستخدم)
          products[i].image = '';
          entry.captured = false;
          entry.reason2 = 'no_image_ge_500_no_fallback';
        }
      } catch(e) {
        products[i].image = ''; // بلا رابط nooncdn عند الاستثناء
        entry.error = String(e).slice(0, 120);
      }
      // [NOON_FINAL] حالة الصورة النهائية لكل منتج
      console.log('[NOON_FINAL]', JSON.stringify({ image: (products[i].image || '').slice(0, 90), isFile: !!(products[i].image && products[i].image.startsWith('file://')) }));
      captureLog.push(entry);
      console.log('[noon-capture]', JSON.stringify(entry));
    }

    try {
      const fs = require('fs'); const path = require('path');
      const logPath = path.join(app.getPath('userData'), 'noon-capture-log.json');
      fs.writeFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), items: captureLog }, null, 2), 'utf8');
      console.log('[noon-capture] log written:', logPath);
    } catch(e) {}

    console.log('[NOON_RETURN]', (products[0] && products[0].image) ? products[0].image.slice(0, 90) : '(none)');
    return products;
  } catch(e) {
    return products;
  } finally {
    try { if (attached && alive()) dbg.detach(); } catch(e) {}
    try { if (capWin && !capWin.isDestroyed()) capWin.destroy(); } catch(e) {} // (6) أغلق نافذة التصوير دائماً
  }
}

// خطة بديلة: ارفع دقة الرابط (thumbnail/currentSrc)، تحقق naturalWidth>300، ثم صوّر. كل عملية بمهلة صارمة.
async function captureFallbackHiRes(win, dbg, srcUrl, sleep) {
  if (!srcUrl || !srcUrl.startsWith('http')) return { ok:false, log:{ fbReason:'no_src' } };
  const prep = await withTimeout(win.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      try {
        const orig = ${JSON.stringify(srcUrl)};
        const cands = [];
        for (const s of ['1200','800','600']) {
          const u = orig.replace(/\\/(\\d{2,3})\\/_?\\//, '/' + s + '/_/');
          if (u !== orig && cands.indexOf(u) === -1) cands.push(u);
        }
        cands.push(orig);
        const old = document.getElementById('__nashir_fb__'); if (old) old.remove();
        const measure = (u) => new Promise((res) => {
          const im = new Image(); im.referrerPolicy='no-referrer';
          let d=false; const f=(r)=>{ if(d)return; d=true; res(r); };
          im.onload=()=>f(im.naturalWidth>10?{w:im.naturalWidth,h:im.naturalHeight}:null);
          im.onerror=()=>f(null);
          im.src=u; setTimeout(()=>f(im.complete&&im.naturalWidth>10?{w:im.naturalWidth,h:im.naturalHeight}:null),5000);
        });
        let chosen='', cw=0, ch=0;
        for (const u of cands) { const r=await measure(u); if(r&&r.w>cw){chosen=u;cw=r.w;ch=r.h;} if(cw>=500)break; }
        if (!chosen || cw < 300 || ch < 300) return { ok:false, log:{ fbReason:'too_small', fbWidth:cw, fbHeight:ch } };
        const box = Math.min(800, Math.max(cw, ch));
        const im2 = document.createElement('img');
        im2.id='__nashir_fb__'; im2.referrerPolicy='no-referrer';
        im2.style.cssText='position:fixed;top:0;left:0;width:'+box+'px;height:'+box+'px;object-fit:contain;background:#fff;z-index:2147483647;';
        document.body.appendChild(im2);
        const drawn = await new Promise((res)=>{ let d=false; const f=(o)=>{if(d)return;d=true;res(o);}; im2.onload=()=>f(im2.naturalWidth>10); im2.onerror=()=>f(false); im2.src=chosen; setTimeout(()=>f(im2.complete&&im2.naturalWidth>10),5000); });
        if (!drawn) { im2.remove(); return { ok:false, log:{ fbReason:'draw_failed' } }; }
        await sleep(140);
        return { ok:true, box: box, log:{ fbWidth:cw, fbHeight:ch } };
      } catch(e) { return { ok:false, log:{ fbReason:'js_err', err:String(e).slice(0,100) } }; }
    })()
  `), 9000, { ok:false, log:{ fbReason:'timeout' } });

  if (!prep || !prep.ok) { return { ok:false, log: (prep && prep.log) || {} }; }
  const shot = await withTimeout(dbg.sendCommand('Page.captureScreenshot', {
    format: 'jpeg', quality: 92,
    clip: { x: 0, y: 0, width: prep.box, height: prep.box, scale: 2 },
    captureBeyondViewport: true,
  }), 8000, null);
  await withTimeout(win.webContents.executeJavaScript(`(()=>{const o=document.getElementById('__nashir_fb__');if(o)o.remove();return 1;})()`), 2000, null);
  if (shot && shot.data && shot.data.length > 2000) return { ok:true, b64: shot.data, log: prep.log };
  return { ok:false, log: prep.log };
}
// ── إرفاق الصور عبر بروتوكول DevTools (CDP) ──
// هذه الطريقة تعمل على مستوى المتصفح لا الصفحة، فالملف يصل لإكس كأن المستخدم اختاره فعلياً
// (isTrusted=true) — يتجاوز القيد الأمني الذي يرفض حقن input.files من JS الصفحة.
async function attachImagesViaCDP(win, filePaths) {
  const L = (...a) => console.log('[x-upload]', ...a);
  if (!win || win.isDestroyed() || !filePaths || !filePaths.length) { L('abort: no window or no files'); return false; }
  const fs = require('fs'); const path = require('path');

  // (3) تحقّق من كل ملف محلي قبل الرفع: المسار، الوجود، الحجم، النوع
  const validFiles = [];
  for (const fp of filePaths) {
    let exists = false, size = 0;
    try { exists = fs.existsSync(fp); size = exists ? fs.statSync(fp).size : 0; } catch(e) {}
    const ext = (path.extname(fp) || '').replace('.', '').toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    L('file', JSON.stringify({ path: fp, existsSync: exists, fileSize: size, extension: ext, mime }));
    if (exists && size > 0) validFiles.push(fp);
    else L('file SKIPPED (missing or empty):', fp);
  }
  if (!validFiles.length) { L('abort: no valid files on disk'); return false; }

  const dbg = win.webContents.debugger;
  let attached = false;
  try {
    try { dbg.attach('1.3'); attached = true; } catch(e) {
      if (!/already attached/i.test(String(e))) { L('debugger attach failed:', String(e).slice(0,100)); throw e; }
      attached = true;
    }
    await dbg.sendCommand('DOM.enable');

    // ابحث عن حقل input[type=file] يقبل الصور (حتى ~10 ثوانٍ)
    let backendNodeId = null;
    let foundAttempt = -1;
    for (let attempt = 0; attempt < 20 && !backendNodeId; attempt++) {
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type="file"]' });
      if (nodeIds && nodeIds.length) {
        for (const nid of nodeIds) {
          try {
            const { attributes } = await dbg.sendCommand('DOM.getAttributes', { nodeId: nid });
            let accept = '';
            if (attributes) { const ai = attributes.indexOf('accept'); if (ai >= 0) accept = (attributes[ai+1]||'').toLowerCase(); }
            if (!accept || accept.includes('image') || accept.includes('*') || accept.includes('video')) { backendNodeId = nid; break; }
          } catch(e) {}
        }
        if (!backendNodeId) backendNodeId = nodeIds[0];
        foundAttempt = attempt;
      }
      if (!backendNodeId) await new Promise(r => setTimeout(r, 500));
    }

    if (!backendNodeId) { L('FAIL: input[type=file] not found after 10s'); await captureFailShot(dbg, fs, path); return false; }
    L('input[type=file] found at attempt', foundAttempt, '| nodeId', backendNodeId);

    // عدّ الصور المرفقة قبل الرفع (للمقارنة بعده)
    const beforeCount = await countXPreviews(win);
    L('attachments before upload:', beforeCount);

    // (4) UPLOAD START
    L('UPLOAD START', JSON.stringify({ files: validFiles }));
    await dbg.sendCommand('DOM.setFileInputFiles', { files: validFiles, nodeId: backendNodeId });
    // (5) UPLOAD FILE SENT
    L('UPLOAD FILE SENT');

    // (6) انتظر معالجة إكس وتحقّق: ظهور المعاينة / اختفاء مؤشر التحميل / عدد الصور > 0
    let after = { blobImages: 0, tweetPhotos: 0, loading: 0 };
    let ok = false;
    for (let i = 0; i < 12; i++) {           // حتى ~6 ثوانٍ
      await new Promise(r => setTimeout(r, 500));
      after = await countXPreviews(win);
      if ((after.tweetPhotos > 0 || after.blobImages > beforeCount.blobImages) && after.loading === 0) { ok = true; break; }
    }
    L('attachments after upload:', JSON.stringify(after));
    L('preview appeared:', (after.tweetPhotos > 0 || after.blobImages > beforeCount.blobImages));
    L('loading indicator gone:', after.loading === 0);
    L('attached count > 0:', (after.tweetPhotos > 0 || after.blobImages > 0));

    if (!ok) { L('FAIL: preview did not appear after upload'); await captureFailShot(dbg, fs, path); }
    else L('SUCCESS: image attached in X');
    return ok;
  } catch(e) {
    L('ERROR:', String(e).slice(0, 150));
    try { await captureFailShot(dbg, fs, path); } catch(e2){}
    return false;
  } finally {
    try { if (attached) dbg.detach(); } catch(e) {}
  }
}

// يعدّ عناصر الصور المرفقة ومؤشرات التحميل في صفحة تأليف إكس
async function countXPreviews(win) {
  try {
    return await win.webContents.executeJavaScript(`
      (() => ({
        blobImages: document.querySelectorAll('img[src^="blob:"]').length,
        tweetPhotos: document.querySelectorAll('[data-testid="tweetPhoto"], [data-testid="attachments"] img, [aria-label*="Media"] img, [data-testid="media"] img').length,
        loading: document.querySelectorAll('[role="progressbar"], [aria-valuenow]').length
      }))()
    `).catch(() => ({ blobImages: 0, tweetPhotos: 0, loading: 0 }));
  } catch(e) { return { blobImages: 0, tweetPhotos: 0, loading: 0 }; }
}

// (7) لقطة لصفحة الناشر عند فشل ظهور الصورة — تُحفظ في مجلد بيانات التطبيق
async function captureFailShot(dbg, fs, path) {
  try {
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    if (shot && shot.data) {
      const fp = path.join(app.getPath('userData'), 'x-upload-fail.jpg');
      fs.writeFileSync(fp, Buffer.from(shot.data, 'base64'));
      console.log('[x-upload] saved failure screenshot:', fp);
    }
  } catch(e) { console.log('[x-upload] could not capture failure screenshot:', String(e).slice(0,80)); }
}


async function openComposeWindow(content, images = []) {
  // جهّز الصور: حمّلها ثم احفظها كملفات مؤقتة على القرص (CDP يحتاج مسارات ملفات)
  const imgFiles = []; // مسارات الملفات على القرص
  const tmpDir = require('path').join(require('os').tmpdir(), 'nashir-imgs');
  try { require('fs').mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
  // نظّف ملفات النشرات السابقة (لا داعي لإبقائها بعد انتهاء استخدامها)
  try {
    const fsc = require('fs'); const pc = require('path');
    for (const f of fsc.readdirSync(tmpDir)) { try { fsc.unlinkSync(pc.join(tmpDir, f)); } catch(e){} }
  } catch(e) {}
  let idx = 0;
  for (const src of (images || []).slice(0, 4)) {
    if (typeof src !== 'string') continue;
    // [PRE_PUBLISH_IMAGE] — حالة الصورة لحظة بدء النشر، قبل أي معالجة
    try {
      const isFile = src.startsWith('file://');
      const isHttp = src.startsWith('http');
      let exists = null, size = null;
      if (isFile) {
        try { const lp = require('url').fileURLToPath(src); exists = require('fs').existsSync(lp); size = exists ? require('fs').statSync(lp).size : 0; } catch(e) { exists = false; size = 0; }
      }
      console.log('[PRE_PUBLISH_IMAGE]', JSON.stringify({ image: src.slice(0, 120), isFile, isHttp, exists, size }));
    } catch(e) {}
    // (1) نوع الصورة + المصدر
    const srcType = src.startsWith('file://') ? 'LocalFile' : src.startsWith('data:image') ? 'Base64' : src.startsWith('http') ? 'URL' : (src.startsWith('blob:') ? 'Blob' : 'Unknown');
    console.log('[x-image] processing', JSON.stringify({ type: srcType, source: src.slice(0, 90) }));
    let buf = null; let bufMime = 'image/jpeg';
    if (src.startsWith('file://')) {
      // (3) ملف محلي — اطبع المسار/الوجود/الحجم/النوع، واقرأه مباشرة (لا fetch ولا إعادة تحميل)
      try {
        const lp = require('url').fileURLToPath(src);
        const exists = require('fs').existsSync(lp);
        const fsize = exists ? require('fs').statSync(lp).size : 0;
        console.log('[x-image] localFile', JSON.stringify({ path: lp, existsSync: exists, fileSize: fsize, mime: 'image/jpeg' }));
        if (!exists) { console.log('[x-image] localFile MISSING — skipping'); continue; }
        buf = require('fs').readFileSync(lp);
      } catch(e) { console.log('[x-image] localFile read error:', String(e).slice(0,80)); continue; }
    } else if (src.startsWith('data:image')) {
      const m = src.match(/^data:image\/([a-z0-9+]+);base64,(.+)$/i);
      if (!m) continue;
      // (2) Base64 — اطبع طول البيانات
      console.log('[x-image] base64', JSON.stringify({ dataLength: m[2].length, ext: m[1] }));
      bufMime = 'image/' + m[1];
      buf = Buffer.from(m[2], 'base64');
    } else if (src.startsWith('http')) {
      let httpSrc = src;
      // رفع دقة صور أمازون: أزل لاحقة المقاس المصغّر (._AC_UL320_.) للحصول على الأصل كامل الدقة
      if (/(media-amazon|images-amazon|ssl-images-amazon)\.com/i.test(httpSrc)) {
        httpSrc = httpSrc.replace(/(\/I\/[A-Za-z0-9@%+_-]+)\.[^/]+(\.(jpg|jpeg|png|webp|gif))(\?.*)?$/i, '$1$2');
      }
      // رفع دقة صور نون: استبدل مقاس CDN المصغّر (/45/_/) بمقاس كبير قبل الالتقاط
      if (/nooncdn\.com/i.test(httpSrc)) {
        httpSrc = httpSrc.replace(/\/(\d{2,3})\/_?\//, '/1200/_/');
      }
      console.log('[IMG_PATH] node fetch (hi-res):', httpSrc.slice(0, 100));
      let d = await downloadImageAsDataUrl(httpSrc);
      console.log('[IMG_PATH] node fetch result:', d ? 'OK data:image' : 'FAILED');
      if (!d) {
        console.log('[IMG_PATH] node fetch failed → trying browser session (same cookies/UA)');
        d = await fetchImageViaBrowser(httpSrc);
        console.log('[IMG_PATH] browser session result:', d ? 'OK' : 'FAILED');
      }
      if ((!d || !d.startsWith('data:image')) && httpSrc !== src) {
        console.log('[IMG_PATH] retry with original url:', src.slice(0, 100));
        d = await downloadImageAsDataUrl(src);
        if (!d) { console.log('[IMG_PATH] original via browser session'); d = await fetchImageViaBrowser(src); }
      }
      if (d && d.startsWith('data:image')) {
        const m = d.match(/^data:image\/([a-z0-9+]+);base64,(.+)$/i);
        if (m) { buf = Buffer.from(m[2], 'base64'); bufMime = 'image/' + m[1]; console.log('[IMG_BUFFER_SIZE]', buf.length, '| mime', bufMime); }
      } else {
        console.log('[IMG_PATH] ALL methods failed for this url');
      }
    }
    if (!buf || buf.length === 0) { console.log('[x-image] no buffer for', srcType, '— skipping'); continue; }
    console.log('[x-image] buffer ready', JSON.stringify({ type: srcType, bufferSize: buf.length }));
    try {
      // ── تطبيع الصورة قبل الإرفاق: إعادة ترميز JPEG نظيف بأبعاد آمنة ──
      // يحل تشوّه أمازون (إعادة ترميز من webp/مصغّر) ويضبط أبعاد صورة نون عالية الدقة.
      try {
        const { nativeImage } = require('electron');
        let ni = nativeImage.createFromBuffer(buf);
        if (!ni.isEmpty()) {
          const sz = ni.getSize();
          const MAXD = 1600;
          if (sz.width > MAXD || sz.height > MAXD) {
            ni = ni.resize({ width: Math.min(MAXD, sz.width || MAXD), quality: 'best' });
          }
          const jpeg = ni.toJPEG(90);
          if (jpeg && jpeg.length > 1200) buf = jpeg;
        } else {
          // nativeImage لم يفهم الصيغة (AVIF غالباً) → حوّلها عبر canvas في Chromium
          const jpg = await decodeToJpeg(buf, bufMime);
          if (jpg && jpg.length > 1500) buf = jpg;
          else console.log('[IMG_CONVERT] keep original (convert empty), mime=', bufMime);
        }
      } catch(e) {}
      if (buf.length > 6 * 1024 * 1024) continue;
      const fp = require('path').join(tmpDir, `img_${Date.now()}_${idx++}.jpg`);
      require('fs').writeFileSync(fp, buf);
      imgFiles.push(fp);
      try {
        const exists = require('fs').existsSync(fp);
        const fsize = exists ? require('fs').statSync(fp).size : 0;
        console.log('[x-image] saved', JSON.stringify({ imagePath: fp, existsSync: exists, fileSize: fsize, extension: 'jpg', source: src.slice(0, 60) }));
      } catch(e) {}
    } catch(e) {}
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
    win.on('closed', () => {
      finish({ success: false, error: 'CLOSED' });
      // نظّف ملفات الصور المؤقتة
      for (const fp of imgFiles) { try { require('fs').unlinkSync(fp); } catch(e) {} }
    });
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

            // الصور تُرفق عبر بروتوكول DevTools (CDP) من العملية الرئيسية — لا من هنا
            return 'OK';
          })()
        `);

        // ── إرفاق الصور عبر CDP (DOM.setFileInputFiles) — يتجاوز قيد إكس الأمني ──
        if ((result === 'OK' || result === 'ALREADY') && imgFiles.length > 0) {
          console.log('[x-image] upload started', JSON.stringify({ count: imgFiles.length, files: imgFiles }));
          let upOk = false;
          try { upOk = await attachImagesViaCDP(win, imgFiles); } catch(e) { console.log('[x-image] upload error', String(e).slice(0,120)); }
          console.log('[x-image] upload finished', JSON.stringify({ response: upOk }));
        }

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
      `🧵 خل أوفر عليك البحث: {product} أفضل خيار بسعره الحين\n{url}\n{trends}`,
      `💬 وصلني كثير سؤال عن {product} — جمعت لكم الرابط والسعر\n{url}\n{trends}`,
      `🔁 لو ترددت في {product}، هذي إشارتك تشتريه 👇\n{url}\n{trends}`,
      `📌 ثبّت الرابط لين توصلك السيولة 😅 {product} يستاهل الانتظار\n{url}\n{trends}`,
      `⭐ تقييم 5 نجوم وتجربة شخصية: {product} ما خذلني\n{url}\n{trends}`,
      `🤝 نصيحة صديق قبل لا تكون نصيحة بائع: {product} صفقة\n{url}\n{trends}`,
      `🛒 اللي يسأل عن {product} كل يوم.. ها هو الرابط مرة وحدة\n{url}\n{trends}`,
      `💯 من غير مبالغة: {product} من أفضل اللي مرّت عليّ هالسنة\n{url}\n{trends}`,
      `🔖 احفظ التغريدة: {product} بسعره الحالي ما يتكرر كثير\n{url}\n{trends}`,
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
      `😂 محفظتي قالت لا.. قلبي قال {product}.. القلب فاز 🏆\n{url}\n{trends}`,
      `🤣 دخلت أتفرّج بس.. طلعت بـ {product} 🛒 كيف؟ الله أعلم\n{url}\n{trends}`,
      `😎 صاحبي سألني من وين {product}؟ قلت سر المهنة 🔐\n{url}\n{trends}`,
      `🥹 {product} كان حلم.. اليوم صار واقع 🎉\n{url}\n{trends}`,
      `😅 قاعد أشتغل وفجأة تذكرت {product}.. الإنتاجية انتهت 📉\n{url}\n{trends}`,
      `🤭 بيني وبينكم: {product} أحسن قرار اتخذته هالشهر\n{url}\n{trends}`,
      `😆 جيت أقول آخر طلب.. ضميري ضحك علي 😂 {product} جاي\n{url}\n{trends}`,
      `🫠 {product} نزل عرضه وأنا اللي ضعيف.. خلونا نشتري\n{url}\n{trends}`,
      `😜 قالوا التسوق إدمان.. قلت لا، هذا ذكاء استهلاكي 🧠\n{url}\n{trends}`,
      `🤓 حسبتها رياضياً: {product} بهالسعر = ربح صافي 📊\n{url}\n{trends}`,
      `😏 لما تلقى {product} بسعر كذا، ما تفكر مرتين — تفكر مرة\n{url}\n{trends}`,
      `🙂 الناس تجمّع نقاط، وأنا أجمّع طلبات {product} 📦\n{url}\n{trends}`,
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

  // ── تتبّع عميق لصورة نون واحدة: من الاستخراج حتى الإرفاق (للإجابة على الأسئلة الستة) ──
  try {
    const noonResult = out.find(r => r.store === 'noon');
    const noonUrl = noonResult && noonResult.firstImg;
    const trace = { q0_extractedUrl: noonUrl || 'لم يُستخرج رابط' };
    if (noonUrl && noonUrl.startsWith('http')) {

      // ★ الاختبار الحاسم: fetch للصورة من داخل صفحة نون نفسها (الأصل noon.com) ★
      trace.IN_PAGE_FETCH = await (async () => {
        return await new Promise((resolve) => {
          let w = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { partition: 'persist:nashir-shop' } });
          w.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
          let fin = false;
          const done = (v) => { if (fin) return; fin = true; try { if(!w.isDestroyed()) w.destroy(); } catch(e){} resolve(v); };
          setTimeout(() => done({ error: 'TIMEOUT بعد فتح صفحة نون' }), 30000);
          w.webContents.on('did-finish-load', async () => {
            try {
              await new Promise(r => setTimeout(r, 2500));
              const res = await w.webContents.executeJavaScript(`
                (async () => {
                  const orig = ${JSON.stringify(noonUrl)};
                  let cleaned = orig;
                  const pIdx = cleaned.search(/%7C|\\|/i);
                  if (pIdx >= 0) {
                    const after = cleaned.slice(pIdx).replace(/^(%7C|\\|)/i, '');
                    cleaned = 'https://f.nooncdn.com/p/' + after;
                  }
                  async function testFetch(u){
                    try {
                      const r = await fetch(u);
                      const ct = r.headers.get('content-type');
                      const cl = r.headers.get('content-length');
                      let blobInfo = null;
                      try { const b = await r.blob(); blobInfo = { type: b.type, size: b.size }; } catch(e) { blobInfo = { blobErr: String(e).slice(0,60) }; }
                      return { url_tested: u.slice(0,90), status: r.status, statusText: r.statusText, responseUrl: (r.url||'').slice(0,90), redirected: r.redirected, contentType: ct, contentLength: cl, blob: blobInfo };
                    } catch(e) { return { url_tested: u.slice(0,90), fetchError: String(e).slice(0,90) }; }
                  }
                  const result = { original: await testFetch(orig) };
                  if (cleaned !== orig) result.cleaned = await testFetch(cleaned);
                  return result;
                })()
              `);
              done(res);
            } catch(e) { done({ jsError: String(e).slice(0,100) }); }
          });
          // افتح صفحة بحث نون الحقيقية (الأصل noon.com)
          w.loadURL('https://www.noon.com/saudi-ar/');
        });
      })();

      // التحميل عبر مسار النشر الفعلي (downloadImageAsDataUrl في العملية الرئيسية)
      const direct = await downloadImageAsDataUrl(noonUrl);
      if (direct) {
        const m = direct.match(/^data:([^;]+);base64,(.+)$/);
        trace.q1_directDownload = 'نجح';
        trace.q2_contentType = m ? m[1] : 'غير معروف';
        trace.q3_sizeBytes = m ? Buffer.from(m[2], 'base64').length : 0;
        trace.q5_extension = m ? (m[1].split('/')[1] || '') : '';
      } else {
        trace.q1_directDownload = 'فشل — جرّبنا المتصفح';
        const viaBrowser = await fetchImageViaBrowser(noonUrl);
        if (viaBrowser) {
          const m2 = viaBrowser.match(/^data:([^;]+);base64,(.+)$/);
          trace.q1b_browserFetch = 'نجح';
          trace.q2_contentType = m2 ? m2[1] : 'غير معروف';
          trace.q3_sizeBytes = m2 ? Buffer.from(m2[2], 'base64').length : 0;
          trace.q5_extension = m2 ? (m2[1].split('/')[1] || '') : '';
        } else {
          trace.q1b_browserFetch = 'فشل أيضاً';
        }
      }
      // هل يُفك محلياً؟ (nativeImage المدمج في Electron)
      try {
        const { nativeImage } = require('electron');
        const dataForDecode = direct || null;
        if (dataForDecode) {
          const ni = nativeImage.createFromDataURL(dataForDecode);
          const sz = ni.getSize();
          trace.q4_localDecode = (!ni.isEmpty() && sz.width > 0) ? `نجح (${sz.width}x${sz.height})` : 'فشل (صورة فارغة)';
        } else {
          trace.q4_localDecode = 'لا توجد بيانات لفكّها (التحميل الخارجي فشل)';
        }
      } catch(e) { trace.q4_localDecode = 'خطأ: ' + String(e).slice(0,50); }

      // الخلاصة بناءً على الاختبار الحاسم
      const ip = trace.IN_PAGE_FETCH || {};
      const o = ip.original || {};
      const c = ip.cleaned || null;
      if (o.status === 200 && o.blob && o.blob.size > 0) {
        trace.q6_diagnosis = '✅ الرابط الأصلي يعمل داخل صفحة نون (200) — المشكلة Origin فقط. المسار: جلب داخل صفحة نون.';
      } else if (c && c.status === 200 && c.blob && c.blob.size > 0) {
        trace.q6_diagnosis = '✅✅ الرابط الأصلي مكسور لكن المُنظّف يعمل (200)! المشكلة: الرابط فيه بادئة هاش+| تكسره. الحل: تنظيف الرابط + جلب داخل صفحة نون.';
      } else if (o.fetchError && (!c || c.fetchError)) {
        trace.q6_diagnosis = '⚠️ fetch فشل للأصلي والمنظّف داخل صفحة نون — حماية CDN أعمق من Origin.';
      } else if ((o.status && o.status !== 200) || (c && c.status && c.status !== 200)) {
        trace.q6_diagnosis = `⚠️ رجع status غير 200 (أصلي:${o.status||'-'} منظّف:${c?c.status:'-'}) — حماية CDN/توقيع رابط.`;
      } else {
        trace.q6_diagnosis = 'غير حاسم — راجع IN_PAGE_FETCH (original/cleaned)';
      }
    } else {
      trace.q6_diagnosis = 'لم يُستخرج رابط صورة من نون أصلاً';
    }
    out.push({ store: 'noon_DEEP_TRACE', trace });
  } catch(e) {
    out.push({ store: 'noon_DEEP_TRACE', error: String(e).slice(0,100) });
  }

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
  if (!autoUpdater) return;
  try {
    // ارفع علم التثبيت: يمنع window-all-closed و before-quit من إنهاء العملية قبل أن يكمل المثبّت.
    isInstallingUpdate = true;
    // حاسم: isForceRunAfter (إعادة التشغيل) يُتجاهَل في electron-updater إذا كان isSilent=false.
    // لذلك نستخدم quitAndInstall(true, true): تثبيت صامت + إعادة تشغيل فعلية بعد الانتهاء.
    setImmediate(() => {
      try { autoUpdater.quitAndInstall(true, true); }
      catch(e) { isInstallingUpdate = false; }
    });
  } catch(e) { isInstallingUpdate = false; }
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

// ════════════════ محرك البحث الذكي في ناشر ════════════════
// قاموس العلامات التجارية: كلمة عربية → مرادفات إنجليزية (الأول هو الأساسي). قابل للتوسعة.
const BRAND_MAP = {
  'جالكسي': ['Galaxy','Samsung'], 'جلاكسي': ['Galaxy','Samsung'], 'سامسونج': ['Samsung','Galaxy'], 'سامسونغ': ['Samsung','Galaxy'],
  'ايفون': ['iPhone','Apple'], 'آيفون': ['iPhone','Apple'], 'أيفون': ['iPhone','Apple'], 'ابل': ['Apple','iPhone'], 'آبل': ['Apple','iPhone'],
  'شاومي': ['Xiaomi','Redmi','Poco','Mi'], 'شياومي': ['Xiaomi','Redmi','Poco','Mi'], 'ريدمي': ['Redmi','Xiaomi'], 'بوكو': ['Poco','Xiaomi'],
  'سوني': ['Sony'], 'هواوي': ['Huawei'], 'اوبو': ['OPPO'], 'أوبو': ['OPPO'], 'فيفو': ['vivo'], 'ريلمي': ['realme'], 'ريالمي': ['realme'],
  'نوكيا': ['Nokia'], 'ايربودز': ['AirPods'], 'إيربودز': ['AirPods'], 'ماك': ['Mac','MacBook'], 'ماك بوك': ['MacBook'],
  'ايباد': ['iPad'], 'آيباد': ['iPad'], 'انكر': ['Anker'], 'أنكر': ['Anker'], 'جي بي ال': ['JBL'], 'بوز': ['Bose'],
  'لينوفو': ['Lenovo'], 'ديل': ['Dell'], 'اتش بي': ['HP'], 'ايسوس': ['Asus'], 'ال جي': ['LG'], 'ريزر': ['Razer'], 'لوجيتك': ['Logitech'],
};
// مرادفات عامة لتوحيد الكتابة (عربي/إنجليزي). قابل للتوسعة.
const SYNONYMS = {
  'ايربودز': 'AirPods', 'إيربودز': 'AirPods', 'ايفون': 'iPhone', 'آيفون': 'iPhone', 'أيفون': 'iPhone',
  'جالكسي': 'Galaxy', 'جلاكسي': 'Galaxy', 'الترا': 'Ultra', 'برو': 'Pro', 'ماكس': 'Max', 'بلس': 'Plus', 'ميني': 'Mini',
};
// كلمات عامة تُحذف قبل البحث (تشتّت النتائج)
const GENERIC_WORDS = new Set([
  'جوال','هاتف','موبايل','تليفون','تلفون','سماعة','سماعات','شاحن','كيبل','جراب','غطاء','كفر','حافظة','واقي','لاصقة',
  'منتج','أفضل','افضل','جديد','أصلي','اصلي','رسمي','ضمان','عرض','خصم','سعر','اشتري','شراء','توصيل','متجر',
  'the','best','new','original','genuine','case','cover','phone','mobile','for','with','buy','price',
]);

// خرائط مطبّعة (مفاتيح بعد التطبيع) لضمان المطابقة الصحيحة
function normText(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const _normKeys = (obj) => { const o = {}; for (const k in obj) o[normText(k)] = obj[k]; return o; };
const BRAND_MAP_N = _normKeys(BRAND_MAP);
const SYNONYMS_N = _normKeys(SYNONYMS);
const GENERIC_N = new Set([...GENERIC_WORDS].map(w => normText(w)));

// استخراج رقم الموديل (S24, A55, M55, A36, WH-1000XM5, 15 Pro Max) — أعلى أولوية في البحث
function extractModel(text) {
  const t = ' ' + String(text || '') + ' ';
  const models = [];
  const patterns = [
    /\b([A-Za-z]{1,4}-?\d{2,4}[A-Za-z]{0,3}\d{0,2})\b/g, // WH-1000XM5، A55، S24، M55
    /\b(\d{1,2}\s?(?:Pro\s?Max|Pro|Ultra|Plus|Max|Mini|SE|FE)\b)/gi, // 15 Pro Max، S24 Ultra
  ];
  for (const re of patterns) { let m; while ((m = re.exec(t))) { const v = m[1].replace(/\s+/g, ' ').trim(); if (v && !/^\d{1,2}$/.test(v)) models.push(v); } }
  return [...new Set(models)];
}

// العلامات الإنجليزية المستخرجة من استعلام عربي
function brandsFromQuery(rawQuery) {
  const words = normText(rawQuery).split(' ');
  const out = [];
  for (const w of words) { if (BRAND_MAP_N[w]) out.push(...BRAND_MAP_N[w]); }
  return [...new Set(out)];
}

// موديلات الاستعلام من النص الأصلي + المحسّن (يلتقط "١٧ برو ماكس" بعد تحويلها لـ Pro Max)
function queryModels(raw) {
  return [...new Set([...extractModel(raw), ...extractModel(improveQuery(raw))])];
}

// يحوّل الاستعلام لأفضل صيغة بحث: علامة بالإنجليزية + موديل، بلا كلمات عامة
function improveQuery(raw) {
  const original = String(raw || '').trim();
  if (!original) return original;
  const words = normText(original).split(' ').filter(Boolean);
  const brands = [], kept = [];
  for (const w of words) {
    if (BRAND_MAP_N[w]) { brands.push(BRAND_MAP_N[w][0]); continue; }
    if (SYNONYMS_N[w]) { kept.push(SYNONYMS_N[w]); continue; }
    if (GENERIC_N.has(w)) continue;
    kept.push(w);
  }
  const models = extractModel(original);
  const modelKeys = models.map(m => m.toLowerCase().replace(/\s+/g, ''));
  const keptClean = kept.filter(w => !modelKeys.includes(w.toLowerCase().replace(/\s+/g, ''))); // لا تكرّر الموديل
  const parts = [...new Set([...brands, ...models, ...keptClean])].filter(Boolean);
  const improved = parts.join(' ').trim();
  return improved.length >= 2 ? improved : original;
}

// يولّد عدة استعلامات مرتّبة بالأولوية (للبحث المتسلسل عند ضعف النتائج)
function buildQueries(raw) {
  const original = String(raw || '').trim();
  const improved = improveQuery(original);
  const models = queryModels(original);
  const brands = brandsFromQuery(original);
  const qs = [];
  if (improved) qs.push(improved);                                   // 1) المحسّن الكامل
  if (brands.length && models.length) qs.push((brands[0] + ' ' + models.join(' ')).trim()); // 2) علامة + موديل
  if (models.length) qs.push(models.join(' '));                      // 3) الموديل وحده (أولوية عالية)
  if (brands.length) qs.push(brands.slice(0, 2).join(' '));          // 4) العلامة وحدها
  if (original && normText(original) !== normText(improved)) qs.push(original); // 5) الأصلي
  return [...new Set(qs.filter(q => q && q.trim().length >= 2))].slice(0, 6);
}

// مسافة Levenshtein
function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}
// تشابه 0..1 على نص مطبّع
function similarity(a, b) {
  a = normText(a); b = normText(b);
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 0;
}

// درجة منتج (0..1): تطابق الموديل (أعلى) + العلامة + احتواء كلمات الاستعلام. مناسب للأسماء الطويلة (نون).
function scoreProduct(productName, rawQuery) {
  const pn = normText(productName);
  const pnNoSpace = pn.replace(/\s+/g, '');
  const models = queryModels(rawQuery).map(m => normText(m).replace(/\s+/g, ''));
  const brands = brandsFromQuery(rawQuery).map(b => normText(b));
  let score = 0, modelHit = false, brandHit = false;

  for (const md of models) { if (md && pnNoSpace.includes(md)) { modelHit = true; break; } }
  if (modelHit) score += 0.40;

  for (const br of brands) { if (br && pn.includes(br)) { brandHit = true; break; } }
  if (brands.length && brandHit) score += 0.25;

  const qWords = [...new Set(improveQuery(rawQuery).split(' ').map(w => normText(w).replace(/\s+/g, '')).filter(w => w.length > 1))];
  if (qWords.length) { const hit = qWords.filter(w => pnNoSpace.includes(w)).length; score += (hit / qWords.length) * 0.35; }

  // عقوبات لتفادي اختيار منتج خاطئ
  if (models.length && !modelHit) score *= 0.50;     // طُلب موديل ولم يوجد
  if (brands.length && !brandHit) score *= 0.70;     // طُلبت علامة ولم توجد
  return Math.max(0, Math.min(1, score));
}

// يرتّب ويصفّي بعتبة متدرّجة (75→60). يُرجع أفضل 5 (الأعلى أولاً)، أو [] إن لا شيء ≥60% (عند وجود موديل/علامة).
function rankFilter(products, rawQuery) {
  if (!Array.isArray(products) || !products.length) return [];
  if (!rawQuery || !String(rawQuery).trim()) return products.slice(0, 8);

  const scored = products
    .map(p => ({ ...p, _score: scoreProduct(p.name || p.title || '', rawQuery) }))
    .sort((a, b) => b._score - a._score);

  const hasSignal = queryModels(rawQuery).length > 0 || brandsFromQuery(rawQuery).length > 0;
  if (!hasSignal) return scored.slice(0, 8); // استعلام عام: ترتيب فقط بلا عتبة صارمة

  const thresholds = [0.75, 0.72, 0.70, 0.67, 0.65, 0.60];
  let kept = [];
  for (const th of thresholds) { kept = scored.filter(p => p._score >= th); if (kept.length >= 5) break; }
  if (!kept.length) return [];          // لا منتج مناسب ≥60% → غير موجود (لا اختيار خاطئ)
  return kept.slice(0, 5);              // أفضل 5، الأعلى أولاً
}


// ── بحث المنتجات داخل نافذة المتجر الحقيقية (لا كشط محركات بحث = لا حظر) ──
// نفتح صفحة بحث المتجر في نافذة خفية، ننتظر تحميل النتائج، ثم نقرأ روابط المنتجات من DOM الفعلي.
ipcMain.handle('fetch-bestsellers', async (_, { source, query }) => {
  const rawQuery = String(query || '').trim();              // الاستعلام كما كتبه المستخدم (للترتيب)
  const queries = buildQueries(rawQuery);                    // استعلامات مرتّبة بالأولوية
  query = queries[0] || rawQuery;                            // ابدأ بالاستعلام المحسّن الأفضل
  console.log('[SEARCH] raw=' + JSON.stringify(rawQuery) + ' improved=' + JSON.stringify(query) + ' queries=' + JSON.stringify(queries));
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
          // أفضل رابط nooncdn من عنصر img: currentSrc/src/data-*/srcset، ثم أي img داخل البطاقة
          const pickImg = (img, scope) => {
            const cands = [];
            if (img) {
              if (img.currentSrc) cands.push(img.currentSrc);
              if (img.src) cands.push(img.src);
              for (const at of ['data-src','data-original','data-lazy-src','data-image']) { const v = img.getAttribute && img.getAttribute(at); if (v) cands.push(v); }
              for (const ss of [img.srcset, (img.getAttribute && img.getAttribute('data-srcset'))]) {
                if (ss) for (const part of ss.split(',')) { const u = part.trim().split(/\\s+/)[0]; if (u) cands.push(u); }
              }
            }
            if (scope) {
              try {
                for (const im of scope.querySelectorAll('img')) {
                  if (im.currentSrc) cands.push(im.currentSrc);
                  if (im.src) cands.push(im.src);
                  if (im.srcset) for (const part of im.srcset.split(',')) { const u = part.trim().split(/\\s+/)[0]; if (u) cands.push(u); }
                }
                const m = (scope.innerHTML || '').match(/https?:\\/\\/[^"'\\s)]*nooncdn\\.com\\/p\\/[^"'\\s)]+/i);
                if (m) cands.push(m[0]);
              } catch(e){}
            }
            for (const c of cands) { if (/nooncdn\\.com\\/p\\//i.test(c) && !/placeholder|\\.svg/i.test(c)) return c; }
            for (const c of cands) { if (/nooncdn\\.com/i.test(c) && !/placeholder|\\.svg/i.test(c)) return c; }
            return '';
          };
          // احتياط على مستوى الصفحة: og:image / twitter:image / JSON-LD
          const pageImg = (() => {
            try {
              for (const sel of ['meta[property="og:image"]','meta[name="twitter:image"]','meta[property="twitter:image"]']) {
                const mt = document.querySelector(sel);
                if (mt && mt.content && /nooncdn/i.test(mt.content) && !/placeholder|\\.svg/i.test(mt.content)) return mt.content;
              }
              for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                const mm = (s.textContent || '').match(/https?:\\/\\/[^"'\\s)]*nooncdn\\.com\\/p\\/[^"'\\s)]+/i);
                if (mm) return mm[0];
              }
            } catch(e){}
            return '';
          })();

          const links = document.querySelectorAll('a[href*="/p/"]');
          for (const a of links) {
            const href = a.href || '';
            if (!/\\/p(\\/|$|\\?)/.test(href)) continue;
            const clean = href.split('?')[0];
            if (seen.has(clean)) continue;
            const img = a.querySelector('img');
            const card = a.closest('div[class*="productContainer"], div[class*="grid_"], li, article') || a.parentElement || a;
            // أول رابط صالح بالترتيب، ولا نُسقط المنتج إن لم نجد
            let image = pickImg(img, card) || pageImg || (img && img.src) || '';
            if (/\\/assets\\/|logo|sprite|icon/i.test(image)) image = pageImg || '';
            // العنوان
            let title = ((img && img.alt) || '').trim();
            if (!title || /^(logo|image|placeholder|loading)$/i.test(title)) {
              try {
                const t = card.querySelector('[title]:not(img), [class*="name"], [class*="Name"], [class*="title"], [class*="Title"], [data-qa*="name"]');
                if (t) title = ((t.getAttribute && t.getAttribute('title')) || t.textContent || '').trim();
                if (!title) title = (a.getAttribute('title') || a.textContent || '').trim();
              } catch(e){}
            }
            title = (title || '').replace(/\\s+/g,' ').trim().substring(0,90);
            seen.add(clean);
            out.push({ url: clean, title: title, price:'', image: image, rect: null });
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
          let clean = products
            .filter(p => p.url && !isHomepageOrNav(p.url))
            .map(p => ({
              name: (p.title || '').substring(0, 70),
              price: p.price || '',
              url: p.url,
              image: p.image || '',
              rect: p.rect || null,
              snippet: '',
              isProduct: true,
            }));

          // ترتيب ذكي بالتشابه (موديل ← علامة ← اسم) مع عتبة متدرّجة 75→60٪
          const ranked = rankFilter(clean, rawQuery);
          console.log('[SEARCH] results=' + clean.length + ' ranked=' + ranked.length + (ranked.length ? ' topScore=' + (ranked[0]._score || 0).toFixed(2) : ' (none >=60%)'));
          // عند وجود موديل/علامة ولا نتيجة ≥60٪ → غير موجود (لا نختار منتجاً خاطئاً)
          const finalProducts = ranked.map(({ _score, ...p }) => p);
          finish({ success: true, products: finalProducts, engine: 'store', notFound: finalProducts.length === 0 });
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
  // ── كتابة أسطر التشخيص في ملف على سطح المكتب لتسهيل إرسالها ──
  try {
    const dbgFile = path.join(app.getPath('desktop'), 'nashir-debug.txt');
    try { require('fs').writeFileSync(dbgFile, '=== ناشر debug ' + new Date().toISOString() + ' v' + APP_VERSION + ' ===\n'); } catch(e){}
    const origLog = console.log.bind(console);
    const writeDbg = (line) => {
      try {
        if (/^\[(PRE_PUBLISH_IMAGE|x-image|x-upload|noon-capture|capture|NOON_SAVED|NOON_FINAL|NOON_RETURN|IMG_[A-Z_]+|SEARCH|updater)\]/.test(line)) {
          require('fs').appendFileSync(dbgFile, line + '\n');
        }
      } catch(e) {}
    };
    console.log = (...args) => {
      origLog(...args);
      try { writeDbg(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch(e) {}
    };
    const origErr = console.error.bind(console);
    console.error = (...args) => {
      origErr(...args);
      try { writeDbg(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')); } catch(e) {}
    };
  } catch(e) {}

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

app.on('window-all-closed', () => {
  if (isInstallingUpdate) return; // أثناء التثبيت: لا تُغلق — دع quitAndInstall يكمل ويعيد التشغيل
  if (process.platform !== 'darwin') app.quit();
});

// عند الإغلاق: أغلق كل النوافذ الفرعية (نافذة إكس) حتى لا تبقى يتيمة
app.on('before-quit', () => {
  if (isInstallingUpdate) return; // أثناء التثبيت: دع quitAndInstall يدير الإغلاق وإعادة التشغيل
  try {
    BrowserWindow.getAllWindows().forEach(w => { try { if (!w.isDestroyed()) w.destroy(); } catch(e){} });
  } catch(e) {}
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
