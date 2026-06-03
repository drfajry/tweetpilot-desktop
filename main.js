const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const https = require('https');
const { TwitterApi } = require('twitter-api-v2');
const Database = require('better-sqlite3');
const cron = require('node-cron');

// ── إعدادات التطبيق ──────────────────────────────
const API_KEY      = '1241epzWTO5a9JCoyGnR3Eb6L'; // ← Consumer Key
const API_SECRET   = 'XuW2J8ayMyTQyCmCkVJw7r7qMw3xoWEZirrNaqDUqGMoCXeafq'; // ← Consumer Secret
const ACCESS_TOKEN = '2051302166883606529-6FoWmSdH7pDbmuxLPQQjfEZiCy0CCx'; // ← Access Token
const ACCESS_SECRET= 'Q5uSfh3SiOPDqzFqIue18lFJnGmU0Zia6UNeCvSmfGsxo'; // ← Access Token Secret
const LICENSE_SERVER = 'https://nashir-license.onrender.com'; // ← رابط سيرفر Render
const APP_VERSION    = '1.1.0'; // ← غيّر هذا عند كل إصدار جديد

// ── التحقق من التحديثات ───────────────────────────
async function checkForUpdates(silent = false) {
  try {
    const res = await fetch(`${LICENSE_SERVER}/api/version`);
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION) {
      // إصدار جديد متاح
      mainWindow?.webContents.send('update-available', {
        current: APP_VERSION,
        latest: data.version,
        url: data.download_url || 'https://github.com/drfajry/tweetpilot-desktop/releases/latest',
      });
    } else if (!silent) {
      mainWindow?.webContents.send('update-not-available', { version: APP_VERSION });
    }
  } catch(e) {
    console.log('[update-check] failed:', e.message);
  }
}


// ── التحقق من الترخيص ────────────────────────────
async function verifyLicense(code) {
  const deviceId = require('os').hostname() + '-' + require('os').platform();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(`${LICENSE_SERVER}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, device_id: deviceId }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return await response.json();
  } catch(e) {
    if (e.name === 'AbortError') return { valid: false, error: 'انتهت مهلة الاتصال' };
    return { valid: false, error: 'تعذر الاتصال بالسيرفر: ' + e.message };
  }
}

async function checkStoredLicense() {
  const stored = db.prepare('SELECT * FROM auth WHERE id=2').get();
  if (!stored || !stored.username) return false;
  // تحقق محلي — الكود محفوظ = مفعّل مسبقاً
  return true;
}

// ── قاعدة البيانات ────────────────────────────────
const DB_PATH = path.join(app.getPath('userData'), 'nashir.db');
let db;

function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      id INTEGER PRIMARY KEY,
      username TEXT,
      name TEXT,
      profile_image TEXT
    );
    CREATE TABLE IF NOT EXISTS tweet_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT,
      tweet_id TEXT,
      status TEXT,
      posted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS scheduled_tweets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT,
      scheduled_at DATETIME,
      status TEXT DEFAULT 'pending',
      tweet_id TEXT,
      error TEXT
    );
  `);
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
      world: 'worldwide',
    };
    const regionPath = PATHS[region] || PATHS.sa;
    const url = `https://trends24.in/${regionPath}/`;

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
  const fs = require('fs');
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) return p; } catch(e){}
  }
  return null;
}

async function launchChromeWithDebugging() {
  const { spawn } = require('child_process');
  const chromePath = getChromePath();
  if (!chromePath) return null;
  const userDataDir = path.join(app.getPath('userData'), 'chrome-nashir');
  spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://x.com',
  ], { detached: true, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 4000));
}

async function ensurePuppeteer() {
  try {
    require('puppeteer-core');
    return true;
  } catch(e) {
    // puppeteer-core غير موجود — ثبّته تلقائياً
    const { execSync } = require('child_process');
    const appPath = path.join(app.getPath('userData'), 'node_modules');
    try {
      mainWindow?.webContents.send('puppeteer-installing', {});
      execSync(`npm install puppeteer-core@21 --prefix "${app.getPath('userData')}"`, {
        timeout: 120000,
        stdio: 'ignore',
      });
      // أضف مسار node_modules للـ require
      require('module').globalPaths.push(path.join(app.getPath('userData'), 'node_modules'));
      require('puppeteer-core');
      return true;
    } catch(e2) {
      return false;
    }
  }
}

async function connectToChrome() {
  const ok = await ensurePuppeteer();
  if (!ok) return null;
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); } catch(e) { return null; }
  try {
    await fetch('http://localhost:9222/json/version');
    return await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  } catch(e) { return null; }
}

async function postWithPuppeteer(content) {
  const ok = await ensurePuppeteer();
  if (!ok) return { success: false, error: 'تعذر تثبيت puppeteer-core — تأكد من اتصال الإنترنت' };
  let puppeteer;
  try { puppeteer = require('puppeteer-core'); } catch(e) {
    return { success: false, error: 'puppeteer-core غير مثبت' };
  }
  const chromePath = getChromePath();
  if (!chromePath) return { success: false, error: 'لم يتم العثور على Chrome' };

  let browser = await connectToChrome();
  if (!browser) {
    await launchChromeWithDebugging();
    browser = await connectToChrome();
  }
  if (!browser) return { success: false, error: 'تعذر فتح Chrome — أغلق Chrome وحاول مجدداً' };

  try {
    const page = await browser.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });

    const isLoggedIn = await page.evaluate(() =>
      !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]') ||
      !!document.querySelector('[data-testid="AppTabBar_Home_Link"]')
    );
    if (!isLoggedIn) { await page.close(); return { success: false, error: 'LOGIN_REQUIRED' }; }

    // اضغط زر التغريدة
    for (const sel of ['a[data-testid="SideNav_NewTweet_Button"]','[data-testid="FloatingActionButtons_Tweet"]','a[href="/compose/post"]']) {
      try { await page.click(sel); break; } catch(e) {}
    }
    await new Promise(r => setTimeout(r, 2000));

    // انتظر صندوق الكتابة
    let textbox = null;
    for (const sel of ['[data-testid="tweetTextarea_0"]','.public-DraftEditor-content','div[aria-label="Post text"]','div[role="textbox"]']) {
      try { await page.waitForSelector(sel, { timeout: 5000 }); textbox = sel; break; } catch(e) {}
    }
    if (!textbox) { await page.close(); return { success: false, error: 'تعذر العثور على صندوق الكتابة' }; }

    // اكتب التغريدة
    await page.click(textbox);
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    for (const char of content) await page.keyboard.type(char, { delay: 15 });
    await new Promise(r => setTimeout(r, 1000));

    // اضغط نشر
    for (const sel of ['[data-testid="tweetButton"]','[data-testid="tweetButtonInline"]']) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const disabled = await page.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true', btn);
          if (!disabled) { await btn.click(); break; }
        }
      } catch(e) {}
    }

    await new Promise(r => setTimeout(r, 3000));
    await page.close();
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

async function openChromeForLogin() {
  const chromePath = getChromePath();
  if (!chromePath) return { success: false, error: 'Chrome غير موجود' };
  await launchChromeWithDebugging();
  const browser = await connectToChrome();
  if (!browser) return { success: false, error: 'تعذر فتح Chrome' };
  const page = await browser.newPage();
  await page.goto('https://x.com/login', { waitUntil: 'networkidle2' });
  try {
    await page.waitForSelector('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 120000 });
    await page.close();
    return { success: true };
  } catch(e) {
    await page.close();
    return { success: false, error: 'انتهت المهلة' };
  }
}


// ── النشر بـ Puppeteer ────────────────────────────
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
ipcMain.handle('fetch-trends', async (_, { region, platform }) => {
  if (platform === 'youtube') {
    return await fetchYoutubeTrends(region);
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
