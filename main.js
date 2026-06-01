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

// ── Device ID ─────────────────────────────────────
function getDeviceId() {
  const { machineIdSync } = require('node-machine-id');
  try { return machineIdSync(true); } catch(e) { return require('os').hostname(); }
}

// ── التحقق من الترخيص ────────────────────────────
async function verifyLicense(code) {
  const deviceId = getDeviceId();
  try {
    const response = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ code, device_id: deviceId });
      const url = new URL(`${LICENSE_SERVER}/api/verify`);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.write(body); req.end();
    });
    return response;
  } catch(e) {
    return { valid: false, error: 'تعذر الاتصال بالسيرفر: ' + e.message };
  }
}

async function checkStoredLicense() {
  const stored = db.prepare('SELECT * FROM auth WHERE id=2').get();
  if (!stored || !stored.username) return false; // نستخدم username لتخزين الكود
  const result = await verifyLicense(stored.username);
  return result.valid;
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
  mainWindow.loadFile('renderer/index.html');
  mainWindow.setMenuBarVisibility(false);
}

// ── IPC Handlers ──────────────────────────────────
ipcMain.handle('verify-license', async (_, code) => {
  const result = await verifyLicense(code);
  if (result.valid) {
    // احفظ الكود محلياً (في جدول auth سطر id=2)
    db.prepare(`INSERT OR REPLACE INTO auth (id, username, name, profile_image) VALUES (2, ?, ?, '')`)
      .run(code, result.plan || 'active');
  }
  return result;
});

ipcMain.handle('check-license', async () => {
  const valid = await checkStoredLicense();
  return { valid };
});

ipcMain.handle('get-auth', async () => {
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  if (row) return row;
  try {
    const client = getClient();
    const me = await client.v2.me({ 'user.fields': ['profile_image_url', 'name'] });
    db.prepare(`INSERT OR REPLACE INTO auth (id, username, name, profile_image)
      VALUES (1, ?, ?, ?)`).run(me.data.username, me.data.name, me.data.profile_image_url || '');
    return db.prepare('SELECT * FROM auth WHERE id=1').get();
  } catch(e) {
    return null;
  }
});

ipcMain.handle('start-oauth', async () => {
  try {
    const client = getClient();
    const me = await client.v2.me({ 'user.fields': ['profile_image_url', 'name'] });
    db.prepare(`INSERT OR REPLACE INTO auth (id, username, name, profile_image)
      VALUES (1, ?, ?, ?)`).run(me.data.username, me.data.name, me.data.profile_image_url || '');
    mainWindow?.webContents.send('auth-success', {
      username: me.data.username,
      profile_image: me.data.profile_image_url || '',
    });
    return { success: true };
  } catch(e) {
    mainWindow?.webContents.send('auth-error', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('logout', () => {
  db.prepare('DELETE FROM auth WHERE id=1').run();
  return true;
});

ipcMain.handle('generate-tweet', (_, { trends, affiliateUrl, productDesc, tone, fixedTags }) => {
  const TEMPLATES = {
    hype: [
      `🔥 لا تفوتك هذه الفرصة! {product} بسعر خيالي لن تصدقه\nاطلبه الآن قبل نفاد الكمية 👇\n{url}\n{trends}`,
      `⚡️ عرض انفجاري على {product}!\nهذا هو الوقت المثالي للشراء 🛒\n{url}\n{trends}`,
      `🚀 من يبحث عن {product} هذا هو الرابط الذهبي\nالسعر مش هيتكرر! 💥\n{url}\n{trends}`,
    ],
    informative: [
      `📊 إذا كنت تبحث عن {product} فهذا أفضل خيار متاح الآن\nجودة عالية وسعر منافس ✅\n{url}\n{trends}`,
      `💡 نصيحة لمن يريد {product}: هذا المنتج حصل على أعلى التقييمات\nجربه بنفسك 👇\n{url}\n{trends}`,
    ],
    funny: [
      `😂 محفظتي تكرهني بعد ما شفت سعر {product}\nبس مش قادر أقاومه 🤷‍♂️\n{url}\n{trends}`,
      `🤣 أنا وعدت نفسي ما أشتري.. بس {product} بهالسعر؟!\nكذبت على نفسي 😅\n{url}\n{trends}`,
    ],
    urgency: [
      `⏰ تنبيه عاجل: {product} بهذا السعر لن يدوم طويلاً\nاشترِ الآن قبل فوات الأوان! 🚨\n{url}\n{trends}`,
      `🚨 آخر ساعات العرض على {product}!\nلا تندم لاحقاً، القرار الآن ⚡️\n{url}\n{trends}`,
    ],
  };
  const product   = productDesc || 'هذا المنتج المميز';
  const trendTags = trends.map(t => t.name).join(' ');
  const fixed     = fixedTags ? '#فيصل_يختار #تخفيضات' : '';
  const allTags   = [trendTags, fixed].filter(Boolean).join(' ');
  const list      = TEMPLATES[tone] || TEMPLATES.hype;
  const template  = list[Math.floor(Math.random() * list.length)];
  let tweet = template
    .replace(/{product}/g, product)
    .replace(/{url}/g, affiliateUrl)
    .replace(/{trends}/g, allTags);

  if (tweet.length > 280) {
    const suffix = `\n${affiliateUrl}\n${trendTags}`;
    const maxText = 280 - suffix.length - 4;
    const lines = tweet.split('\n').slice(0, -2);
    const text = lines.join('\n');
    tweet = (text.length > maxText ? text.substring(0, maxText) + '…' : text) + suffix;
  }

  return { success: true, tweet, charCount: tweet.length };
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

ipcMain.handle('get-scheduled', () => {
  return db.prepare('SELECT * FROM scheduled_tweets ORDER BY scheduled_at DESC LIMIT 50').all();
});

ipcMain.handle('delete-scheduled', (_, id) => {
  db.prepare('DELETE FROM scheduled_tweets WHERE id=?').run(id);
  return { success: true };
});

ipcMain.handle('get-history', () => {
  return db.prepare('SELECT * FROM tweet_history ORDER BY posted_at DESC LIMIT 50').all();
});

// ── FIX: ترندات حقيقية من Google Trends ──────────
ipcMain.handle('fetch-trends', async (_, { region }) => {
  const result = await fetchTrends24(region);
  return result;
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
          // كل نتيجة: <a class="result__a" href="...">العنوان</a>
          const results = [];
          const titleMatches = [...data.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
          const snippetMatches = [...data.matchAll(/class="result__snippet"[^>]*>([^<]+)<\/a>/g)];

          for (let i = 0; i < Math.min(titleMatches.length, 6); i++) {
            const url = titleMatches[i][1];
            const title = titleMatches[i][2].trim();
            const snippet = snippetMatches[i] ? snippetMatches[i][1].trim() : '';

            // استخراج السعر من الـ snippet إذا وجد
            const priceMatch = snippet.match(/(?:SAR|ريال|SR|﷼|\$|USD)\s*[\d,\.]+|[\d,\.]+\s*(?:SAR|ريال|SR)/i);
            const price = priceMatch ? priceMatch[0] : '';

            if (title && url) {
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

// ── App Events ────────────────────────────────────
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
