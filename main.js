const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
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
  // OAuth 1.0a: المفاتيح ثابتة، نجلب بيانات المستخدم مباشرة
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  if (row) return row;
  // إذا ما في بيانات محفوظة، نجلبها من API
  try {
    const client = getClient();
    const me = await client.v2.me({ 'user.fields': ['profile_image_url', 'name'] });
    db.prepare(`INSERT OR REPLACE INTO auth (id, username, name, profile_image)
      VALUES (1, ?, ?, ?)`).run(
      me.data.username,
      me.data.name,
      me.data.profile_image_url || ''
    );
    return db.prepare('SELECT * FROM auth WHERE id=1').get();
  } catch(e) {
    console.error('[get-auth]', e.message);
    return null;
  }
});

// OAuth 1.0a: لا حاجة لـ OAuth flow — المفاتيح ثابتة في الكود
ipcMain.handle('start-oauth', async () => {
  try {
    const client = getClient();
    const me = await client.v2.me({ 'user.fields': ['profile_image_url', 'name'] });
    db.prepare(`INSERT OR REPLACE INTO auth (id, username, name, profile_image)
      VALUES (1, ?, ?, ?)`).run(
      me.data.username,
      me.data.name,
      me.data.profile_image_url || ''
    );
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

// ── النشر بـ OAuth 1.0a ───────────────────────────
ipcMain.handle('post-tweet', async (_, { content }) => {
  if (content.length > 280) return { success: false, error: `التغريدة تتجاوز 280 حرفاً (${content.length})` };
  try {
    const client = getClient();
    const result = await client.v2.tweet(content);
    const tweetId = result.data?.id;
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(
      content, tweetId || '', 'posted'
    );
    return { success: true, tweetId };
  } catch(e) {
    const detail = e.data?.detail || e.data?.title || e.message;
    const hint = e.code === 403
      ? '\n\n✋ تأكد أن App Permissions = Read+Write في X Developer Portal'
      : e.code === 429
      ? '\n\n⏰ تجاوزت حد الطلبات — انتظر قليلاً'
      : '';
    return { success: false, error: `${detail}${hint}` };
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

ipcMain.handle('fetch-trends', async (_, { region }) => {
  const WOEID = { sa: 349204, ae: 349217, eg: 23424802, world: 1 };
  const woeid = WOEID[region] || WOEID.sa;
  try {
    const client = getClient();
    const trends = await client.v1.trendsByPlace(woeid);
    const list = trends[0]?.trends?.slice(0, 10).map(t => ({
      name: t.name,
      tweet_volume: t.tweet_volume || null,
    })) || [];
    return { success: true, trends: list };
  } catch(e) {
    return { success: false, error: e.message, trends: [] };
  }
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
        db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(
          t.content, tweetId || '', 'posted'
        );
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
