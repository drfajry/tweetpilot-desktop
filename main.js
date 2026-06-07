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
const cron = require('node-cron');

// ── إعدادات التطبيق ──────────────────────────────
const API_KEY      = '1241epzWTO5a9JCoyGnR3Eb6L'; // ← Consumer Key
const API_SECRET   = 'XuW2J8ayMyTQyCmCkVJw7r7qMw3xoWEZirrNaqDUqGMoCXeafq'; // ← Consumer Secret
const ACCESS_TOKEN = '2051302166883606529-6FoWmSdH7pDbmuxLPQQjfEZiCy0CCx'; // ← Access Token
const ACCESS_SECRET= 'Q5uSfh3SiOPDqzFqIue18lFJnGmU0Zia6UNeCvSmfGsxo'; // ← Access Token Secret
const LICENSE_SERVER = 'https://nashir-license.onrender.com'; // ← رابط سيرفر Render
const APP_VERSION    = '1.3.1';

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
          if (response.statusCode !== 200) {
            resolve({ success: false, error: `HTTP ${response.statusCode}`, trends: [] });
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
          if (response.statusCode !== 200) { resolve({ success: false, error: `HTTP ${response.statusCode}`, trends: [] }); return; }

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

// ── النشر بـ Puppeteer ────────────────────────────
function getChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  for (const p of paths) {
    try { if (p && require('fs').existsSync(p)) return p; } catch(e){}
  }
  return null;
}

// فتح Chrome مع remote debugging
function launchChromeDebug() {
  const { spawn } = require('child_process');
  const chromePath = getChromePath();
  if (!chromePath) return false;
  const userDataDir = path.join(app.getPath('userData'), 'chrome-nashir');
  spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://x.com/home',
  ], { detached: true, stdio: 'ignore' });
  return true;
}

// CDP عبر WebSocket — بدون puppeteer
async function cdpPost(content) {
  let target;
  try {
    const res = await fetch('http://localhost:9222/json');
    const list = await res.json();
    // ابحث عن تبويب X
    target = list.find(t => t.type === 'page' && /x\.com|twitter\.com/.test(t.url));
    if (!target) {
      // افتح تبويب X جديد
      await fetch('http://localhost:9222/json/new?https://x.com/home');
      await new Promise(r => setTimeout(r, 3000));
      const res2 = await fetch('http://localhost:9222/json');
      const list2 = await res2.json();
      target = list2.find(t => t.type === 'page' && /x\.com|twitter\.com/.test(t.url));
    }
  } catch(e) {
    return { success: false, error: 'NO_CHROME' };
  }
  if (!target || !target.webSocketDebuggerUrl) {
    return { success: false, error: 'NO_TARGET' };
  }

  // اتصل عبر WebSocket بـ CDP
  return new Promise((resolve) => {
    let ws;
    try {
      const NodeWS = require('ws');
      ws = new NodeWS(target.webSocketDebuggerUrl);
    } catch(e) {
      return resolve({ success: false, error: 'NO_WS' });
    }

    let msgId = 0;
    const send = (method, params) => {
      msgId++;
      ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
      return msgId;
    };

    let timedOut = setTimeout(() => { try{ws.close();}catch(e){} resolve({ success:false, error:'انتهت المهلة' }); }, 30000);

    ws.on('open', async () => {
      send('Runtime.enable');
      send('Page.enable');
      // انتقل لصفحة الكتابة وانشر عبر JS
      const js = `
        (async () => {
          function wait(ms){return new Promise(r=>setTimeout(r,ms));}
          // افتح نافذة الكتابة
          const composeBtn = document.querySelector('a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]');
          if(composeBtn) composeBtn.click();
          await wait(2000);
          const box = document.querySelector('[data-testid="tweetTextarea_0"], div[role="textbox"]');
          if(!box) return 'NO_BOX';
          box.focus();
          document.execCommand('insertText', false, ${JSON.stringify(content)});
          await wait(1500);
          const postBtn = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
          if(!postBtn) return 'NO_BTN';
          if(postBtn.getAttribute('aria-disabled')==='true') return 'DISABLED';
          postBtn.click();
          await wait(3000);
          return 'OK';
        })()
      `;
      const id = send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            clearTimeout(timedOut);
            const result = msg.result?.result?.value;
            try { ws.close(); } catch(e){}
            if (result === 'OK') resolve({ success: true });
            else if (result === 'NO_BOX') resolve({ success: false, error: 'تعذر العثور على صندوق الكتابة' });
            else if (result === 'NO_BTN') resolve({ success: false, error: 'تعذر العثور على زر النشر' });
            else if (result === 'DISABLED') resolve({ success: false, error: 'زر النشر معطّل (تحقق من المحتوى)' });
            else resolve({ success: false, error: 'فشل غير معروف: ' + result });
          }
        } catch(e) {}
      });
    });

    ws.on('error', (e) => { clearTimeout(timedOut); resolve({ success: false, error: 'WS: ' + e.message }); });
  });
}

// ── النشر عبر نافذة Electron داخلية ───────────────
// نافذة X مدمجة — المستخدم يسجل دخوله مرة، الجلسة محفوظة
let xWindow = null;

function getXSession() {
  // جلسة منفصلة دائمة لـ X
  return session.fromPartition('persist:nashir-x');
}

async function postWithPuppeteer(content) {
  return new Promise((resolve) => {
    const xSession = getXSession();
    const win = new BrowserWindow({
      width: 500, height: 700,
      show: false, // مخفية في البداية
      webPreferences: {
        partition: 'persist:nashir-x',
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { win.close(); } catch(e){}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ success: false, error: 'انتهت المهلة' }), 40000);

    win.loadURL('https://x.com/home');

    win.webContents.on('did-finish-load', async () => {
      try {
        // تحقق من تسجيل الدخول
        const isLoggedIn = await win.webContents.executeJavaScript(`
          !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
          !!document.querySelector('[data-testid="AppTabBar_Home_Link"]')
        `);

        if (!isLoggedIn) {
          // أظهر النافذة ليسجل الدخول
          clearTimeout(timer);
          win.show();
          win.webContents.send('login-needed');
          // راقب تسجيل الدخول
          const checkLogin = setInterval(async () => {
            try {
              const nowLoggedIn = await win.webContents.executeJavaScript(`
                !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
              `);
              if (nowLoggedIn) {
                clearInterval(checkLogin);
                win.hide();
                // الآن انشر
                const result = await doPost(win, content);
                finish(result);
              }
            } catch(e){}
          }, 2000);
          // مهلة تسجيل دخول دقيقتان
          setTimeout(() => { clearInterval(checkLogin); finish({ success:false, error:'LOGIN_TIMEOUT' }); }, 120000);
          return;
        }

        // مسجّل دخول — انشر مباشرة
        clearTimeout(timer);
        const result = await doPost(win, content);
        finish(result);
      } catch(e) {
        clearTimeout(timer);
        finish({ success: false, error: e.message });
      }
    });

    win.webContents.on('did-fail-load', () => {
      clearTimeout(timer);
      finish({ success: false, error: 'فشل تحميل X — تحقق من الإنترنت' });
    });
  });
}

async function doPost(win, content) {
  try {
    // افتح نافذة الكتابة واكتب وانشر
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        function wait(ms){return new Promise(r=>setTimeout(r,ms));}
        const composeBtn = document.querySelector('a[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"]');
        if(composeBtn) composeBtn.click();
        await wait(2000);
        const box = document.querySelector('[data-testid="tweetTextarea_0"], div[role="textbox"]');
        if(!box) return 'NO_BOX';
        box.focus();
        document.execCommand('insertText', false, ${JSON.stringify(content)});
        await wait(1500);
        const postBtn = document.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
        if(!postBtn) return 'NO_BTN';
        if(postBtn.getAttribute('aria-disabled')==='true') return 'DISABLED';
        postBtn.click();
        await wait(3000);
        return 'OK';
      })()
    `);

    if (result === 'OK') return { success: true };
    if (result === 'NO_BOX') return { success: false, error: 'تعذر العثور على صندوق الكتابة' };
    if (result === 'NO_BTN') return { success: false, error: 'تعذر العثور على زر النشر' };
    if (result === 'DISABLED') return { success: false, error: 'زر النشر معطّل' };
    return { success: false, error: 'فشل: ' + result };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

async function openChromeForLogin() {
  // نفتح نافذة X ليسجل الدخول
  const xSession = getXSession();
  const win = new BrowserWindow({
    width: 500, height: 700,
    webPreferences: { partition: 'persist:nashir-x', contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('https://x.com/login');
  return { success: true };
}


// ── النشر بـ Puppeteer ────────────────────────────
// ── توليد التغريدة ───────────────────────────────
ipcMain.handle('generate-tweet', (_, { trends, affiliateUrl, productDesc, tone, fixedTags, category }) => {
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
    ],
    informative: [
      `📊 تبحث عن {product}؟ أفضل خيار متاح الآن ✅\n{url}\n{trends}`,
      `💡 {product} حاصل على أعلى التقييمات — جربه 👇\n{url}\n{trends}`,
      `🔍 بحثت كثير، وهذا أفضل {product} بالسوق 📌\n{url}\n{trends}`,
      `📋 مواصفات ممتازة + ضمان: {product} ✅\n{url}\n{trends}`,
      `🧐 قبل ما تشتري {product} شوف هذا العرض\n{url}\n{trends}`,
      `📈 الجودة والسعر مجتمعين في {product}\n{url}\n{trends}`,
    ],
    funny: [
      `😂 محفظتي تكرهني بعد {product}.. بس ما أقدر أقاوم 🤷‍♂️\n{url}\n{trends}`,
      `🤣 وعدت نفسي ما أشتري.. بس {product}؟ كذبت 😅\n{url}\n{trends}`,
      `😭 حسابي يبكي بس قلبي فرحان: {product} وصل 💸\n{url}\n{trends}`,
      `🙈 لا تورّي زوجتي إني اشتريت {product} 🤫\n{url}\n{trends}`,
      `😎 صاحبي سألني من وين {product}؟ قلت سر 🔐\n{url}\n{trends}`,
      `🥹 {product} كان حلم.. اليوم صار بمتناولي 🎉\n{url}\n{trends}`,
    ],
    urgency: [
      `⏰ عاجل: {product} بهالسعر ما راح يدوم! 🚨\n{url}\n{trends}`,
      `🚨 آخر ساعات العرض على {product}! 🏃‍♂️\n{url}\n{trends}`,
      `⏳ الكمية تنفد! {product} يختفي بسرعة 😱\n{url}\n{trends}`,
      `🔴 تنبيه: السعر يرتفع قريباً على {product}\n{url}\n{trends}`,
      `⚠️ فرصة أخيرة! {product} بسعر اليوم فقط\n{url}\n{trends}`,
      `🆘 لا تتأخر! {product} مطلوب بشدة ⚡️\n{url}\n{trends}`,
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

  const product   = productDesc || 'هذا المنتج';
  const trendTags = (trends || []).map(t => t.name).join(' ');
  const fixed     = fixedTags ? '#فيصل_يختار #تخفيضات' : '';
  const allTags   = [trendTags, fixed].filter(Boolean).join(' ');

  let pool = [...(TEMPLATES_GENERAL[tone] || TEMPLATES_GENERAL.hype)];
  if (category && TEMPLATES_BY_CATEGORY[category]) {
    const catTones = TEMPLATES_BY_CATEGORY[category][tone] || TEMPLATES_BY_CATEGORY[category].hype || [];
    pool = [...pool, ...catTones];
  }

  const template = pool[Math.floor(Math.random() * pool.length)];
  let tweet = template.replace(/{product}/g, product).replace(/{url}/g, cleanUrl).replace(/{trends}/g, allTags);

  // إذا تجاوزت 280 — اختصر النص مع الإبقاء على الرابط والهاشتاقات
  if (tweet.length > 280) {
    const suffix = `\n${cleanUrl}\n${allTags}`;
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
  const stored = db.prepare('SELECT * FROM auth WHERE id=1').get();
  return stored || { username: 'مستخدم', name: 'ناشر', profile_image: '' };
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
ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('copy-to-clipboard', (_, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('puppeteer-post', async (_, { content }) => {
  if (content.length > 280) return { success: false, error: `التغريدة تتجاوز 280 حرفاً` };
  const result = await postWithPuppeteer(content);
  if (result.success) {
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(content, '', 'posted');
  }
  return result;
});

ipcMain.handle('puppeteer-login', async () => {
  return await openChromeForLogin();
});

ipcMain.handle('check-chrome', () => {
  const path = getChromePath();
  return { found: !!path, path };
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
  db.prepare("DELETE FROM scheduled_tweets WHERE status='pending'").run();
  return { success: true };
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
  if (platform === 'tiktok' || platform === 'instagram') {
    try {
      const res = await fetch(`${TRENDS_SERVER}/api/trends/${platform}`);
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
function searchDuckDuckGo(query) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}&kl=ar-ar`;

    const request = net.request({
      url,
      method: 'GET',
      session: require('electron').session.defaultSession,
    });

    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    request.setHeader('Accept-Language', 'ar-SA,ar;q=0.9,en;q=0.8');

    let data = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
      resolve({ success: false, error: 'انتهت مهلة الطلب', products: [] });
    }, 12000);

    request.on('response', (response) => {
      response.on('data', chunk => { data += chunk.toString(); });
      response.on('end', () => {
        if (timedOut) return;
        clearTimeout(timer);
        try {
          if (response.statusCode !== 200) {
            resolve({ success: false, error: `HTTP ${response.statusCode}`, products: [] });
            return;
          }

          // استخراج نتائج البحث من HTML
          const results = [];
          const titleMatches = [...data.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
          const snippetMatches = [...data.matchAll(/class="result__snippet"[^>]*>([^<]+)<\/a>/g)];

          // دالة لفك تشفير رابط DuckDuckGo
          function decodeDDGUrl(rawUrl) {
            try {
              // روابط DuckDuckGo تكون بهذا الشكل: //duckduckgo.com/l/?uddg=ENCODED_URL
              if (rawUrl.includes('duckduckgo.com/l/') && rawUrl.includes('uddg=')) {
                const uddg = rawUrl.match(/uddg=([^&]+)/)?.[1];
                if (uddg) return decodeURIComponent(uddg);
              }
              // إذا كان رابطاً عادياً أعده كما هو
              if (rawUrl.startsWith('http')) return rawUrl;
              if (rawUrl.startsWith('//')) return 'https:' + rawUrl;
              return rawUrl;
            } catch(e) { return rawUrl; }
          }

          for (let i = 0; i < Math.min(titleMatches.length, 6); i++) {
            const rawUrl = titleMatches[i][1];
            const url = decodeDDGUrl(rawUrl); // ← فك تشفير الرابط
            const title = titleMatches[i][2].trim();
            const snippet = snippetMatches[i] ? snippetMatches[i][1].trim() : '';

            const priceMatch = snippet.match(/(?:SAR|ريال|SR|﷼|\$|USD)\s*[\d,\.]+|[\d,\.]+\s*(?:SAR|ريال|SR)/i);
            const price = priceMatch ? priceMatch[0] : '';

            if (title && url && url.startsWith('http')) {
              results.push({
                name: title.substring(0, 60),
                brand: '',
                price,
                url,
                snippet: snippet.substring(0, 100),
              });
            }
          }

          if (results.length === 0) {
            resolve({ success: false, error: 'لم تُعثر على نتائج', products: [] });
            return;
          }

          resolve({ success: true, products: results });
        } catch(e) {
          resolve({ success: false, error: e.message, products: [] });
        }
      });
    });

    request.on('error', (e) => {
      if (!timedOut) { clearTimeout(timer); resolve({ success: false, error: e.message, products: [] }); }
    });

    request.end();
  });
}

ipcMain.handle('fetch-bestsellers', async (_, { source, query }) => {
  const SITE = {
    amazon:     'site:amazon.sa',
    noon:       'site:noon.com/saudi-ar',
    aliexpress: 'site:aliexpress.com',
  };
  const site = SITE[source] || SITE.amazon;
  const searchQuery = `${site} ${query}`;
  const result = await searchDuckDuckGo(searchQuery);
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


const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

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

  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const pending = db.prepare(
      'SELECT * FROM scheduled_tweets WHERE status="pending" AND scheduled_at <= ?'
    ).all(now);

    for (const t of pending) {
      try {
        const client = getClient();
        const result = await client.v2.tweet(t.content);
        const tweetId = result.data?.id;
        db.prepare('UPDATE scheduled_tweets SET status="posted", tweet_id=? WHERE id=?').run(tweetId, t.id);
        db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(t.content, tweetId || '', 'posted');
        mainWindow?.webContents.send('scheduled-posted', { id: t.id, tweetId });
      } catch(e) {
        const errMsg = e.data?.detail || e.message;
        db.prepare('UPDATE scheduled_tweets SET status="failed", error=? WHERE id=?').run(errMsg, t.id);
        mainWindow?.webContents.send('scheduled-failed', { id: t.id, error: errMsg });
      }
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
