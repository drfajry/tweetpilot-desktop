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
// استخدام Electron net module بدل Node https
// net يرسل الطلب كمتصفح حقيقي مع session كاملة
function fetchGoogleTrends(geo) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;

    const request = net.request({
      url,
      method: 'GET',
      session: require('electron').session.defaultSession,
    });

    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    request.setHeader('Accept-Language', 'ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7');

    let data = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      request.abort();
      resolve({ success: false, error: 'انتهت مهلة الطلب', trends: [] });
    }, 10000);

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
          const titles = [...data.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
            .slice(1)
            .map(m => m[1].trim());
          const traffic = [...data.matchAll(/<ht:approx_traffic>([^<]+)<\/ht:approx_traffic>/g)]
            .map(m => m[1].trim());
          if (titles.length === 0) {
            resolve({ success: false, error: 'لم يتم العثور على ترندات في الاستجابة', trends: [] });
            return;
          }
          const trends = titles.slice(0, 10).map((name, i) => ({
            name: '#' + name.replace(/\s+/g, '_'),
            tweet_volume: traffic[i] ? parseInt(traffic[i].replace(/[^0-9]/g, '')) || null : null,
          }));
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

ipcMain.handle('generate-tweet', (_, { trends, affiliateUrl, productDesc, tone }) => {
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
  const list      = TEMPLATES[tone] || TEMPLATES.hype;
  const template  = list[Math.floor(Math.random() * list.length)];
  let tweet = template
    .replace(/{product}/g, product)
    .replace(/{url}/g, affiliateUrl)
    .replace(/{trends}/g, trendTags);

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
  // تحويل المنطقة إلى كود Google
  const GEO = { sa: 'SA', ae: 'AE', eg: 'EG', world: 'US' };
  const geo = GEO[region] || 'SA';

  const result = await fetchGoogleTrends(geo);

  if (result.success && result.trends.length > 0) {
    return { success: true, trends: result.trends, source: 'google' };
  }

  // Fallback احتياطي
  return { success: false, error: result.error, trends: [] };
});

ipcMain.handle('fetch-bestsellers', async (_, source) => {
  const mocks = {
    amazon: [
      { name:'سماعات AirPods Pro 2', brand:'Apple', price:'799 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/' },
      { name:'شاشة LG 27 بوصة 4K', brand:'LG', price:'1299 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/' },
      { name:'ماوس MX Master 3S', brand:'Logitech', price:'349 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/' },
      { name:'كيبورد Keychron K8', brand:'Keychron', price:'549 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/' },
    ],
    noon: [
      { name:'سماعات Galaxy Buds2 Pro', brand:'Samsung', price:'499 SAR', url:'https://www.noon.com/saudi-ar/electronics/' },
      { name:'ساعة Mi Band 8 Pro', brand:'Xiaomi', price:'229 SAR', url:'https://www.noon.com/saudi-ar/electronics/' },
      { name:'مكبر Charge 5', brand:'JBL', price:'699 SAR', url:'https://www.noon.com/saudi-ar/electronics/' },
      { name:'شاحن 65W GaN', brand:'Anker', price:'149 SAR', url:'https://www.noon.com/saudi-ar/electronics/' },
    ],
    aliexpress: [
      { name:'إضاءة RGB للغرفة', brand:'Govee', price:'$18.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
      { name:'حامل هاتف مغناطيسي', brand:'', price:'$6.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
      { name:'سماعات TWS ANC', brand:'QCY', price:'$22.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
      { name:'بطارية محمولة 30000mAh', brand:'Baseus', price:'$24.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
    ],
  };
  return { success: true, products: mocks[source] || mocks.noon };
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
