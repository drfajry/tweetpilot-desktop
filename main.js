const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { TwitterApi } = require('twitter-api-v2');
const Database = require('better-sqlite3');
const cron = require('node-cron');

// ── إعدادات التطبيق ──────────────────────────────
const CLIENT_ID     = 'YmtJWUhrNjF6VDJ1UDBla3JWWnI6MTpjaQ'; // ← يضعها المطور
const CLIENT_SECRET = 'Xx-99PBIoht5pl4auTBBX1Zor6VsIQ-EZ8OwCDehJrjACE6xck'; // ← يضعها المطور
const CALLBACK_PORT = 42069;
const CALLBACK_URL  = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const SCOPES        = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

// ── قاعدة البيانات ────────────────────────────────
const DB_PATH = path.join(app.getPath('userData'), 'tweetpilot.db');
let db;

function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      id INTEGER PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      username TEXT,
      name TEXT,
      profile_image TEXT,
      expires_at INTEGER
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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ── النوافذ ───────────────────────────────────────
let mainWindow;
let authWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'Tweet Pilot',
    backgroundColor: '#070b14',
  });

  mainWindow.loadFile('renderer/index.html');
  mainWindow.setMenuBarVisibility(false);
}

// ── OAuth 2.0 PKCE ────────────────────────────────
let oauthState = null;
let oauthCodeVerifier = null;
let oauthServer = null;

async function startOAuth() {
  const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(CALLBACK_URL, {
    scope: SCOPES,
  });

  oauthState = state;
  oauthCodeVerifier = codeVerifier;

  // ── خادم محلي مؤقت لاستقبال callback ──
  oauthServer = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
    const code  = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state');

    if (!code || state !== oauthState) {
      res.writeHead(400);
      res.end('<h2>خطأ في المصادقة</h2>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
      <style>body{font-family:sans-serif;background:#070b14;color:#1d9bf0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:22px}</style>
      </head><body>✅ تم ربط الحساب بنجاح! يمكنك إغلاق هذه النافذة.</body></html>`);

    oauthServer.close();

    try {
      const { client: loggedClient, accessToken, refreshToken, expiresIn } =
        await client.loginWithOAuth2({ code, codeVerifier: oauthCodeVerifier, redirectUri: CALLBACK_URL });

      const me = await loggedClient.v2.me({ 'user.fields': ['profile_image_url', 'name'] });

      db.prepare(`INSERT OR REPLACE INTO auth (id, access_token, refresh_token, username, name, profile_image, expires_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)`).run(
        accessToken,
        refreshToken || '',
        me.data.username,
        me.data.name,
        me.data.profile_image_url || '',
        Date.now() + (expiresIn * 1000)
      );

      mainWindow?.webContents.send('auth-success', {
        username: me.data.username,
        name: me.data.name,
        profile_image: me.data.profile_image_url,
      });

      authWindow?.close();
    } catch(e) {
      mainWindow?.webContents.send('auth-error', e.message);
    }
  });

  oauthServer.listen(CALLBACK_PORT, '127.0.0.1');

  // فتح المتصفح
  shell.openExternal(url);
}

// ── IPC Handlers ──────────────────────────────────

// جلب حالة المصادقة
ipcMain.handle('get-auth', () => {
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  return row ? { username: row.username, name: row.name, profile_image: row.profile_image } : null;
});

// بدء OAuth
ipcMain.handle('start-oauth', () => startOAuth());

// تسجيل الخروج
ipcMain.handle('logout', () => {
  db.prepare('DELETE FROM auth WHERE id=1').run();
  return true;
});

// توليد التغريدة (قوالب محلية)
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
  const tweet = template
    .replace(/{product}/g, product)
    .replace(/{url}/g, affiliateUrl)
    .replace(/{trends}/g, trendTags);
  return { success: true, tweet };
});

// نشر التغريدة
ipcMain.handle('post-tweet', async (_, { content }) => {
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  if (!row) return { success: false, error: 'غير مسجل الدخول' };

  try {
    const client = new TwitterApi(row.access_token);
    const result = await client.v2.tweet(content);
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(content, result.data.id, 'posted');
    return { success: true, tweetId: result.data.id };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// جدولة تغريدة
ipcMain.handle('schedule-tweet', (_, { content, scheduledAt }) => {
  const result = db.prepare('INSERT INTO scheduled_tweets (content, scheduled_at) VALUES (?,?)').run(content, scheduledAt);
  return { success: true, id: result.lastInsertRowid };
});

// جلب المجدولات
ipcMain.handle('get-scheduled', () => {
  return db.prepare('SELECT * FROM scheduled_tweets WHERE status="pending" ORDER BY scheduled_at ASC').all();
});

// حذف مجدولة
ipcMain.handle('delete-scheduled', (_, id) => {
  db.prepare('DELETE FROM scheduled_tweets WHERE id=?').run(id);
  return { success: true };
});

// جلب السجل
ipcMain.handle('get-history', () => {
  return db.prepare('SELECT * FROM tweet_history ORDER BY posted_at DESC LIMIT 50').all();
});

// جلب أفضل المنتجات
ipcMain.handle('fetch-bestsellers', async (_, source) => {
  const https = require('https');
  function get(hostname, path) {
    return new Promise(resolve => {
      const req = https.request({ hostname, path, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.end();
    });
  }

  const mocks = {
    amazon: [
      { name:'سماعات AirPods Pro', brand:'Apple', price:'799 SAR', url:'https://www.amazon.sa/gp/bestsellers/' },
      { name:'شاحن لاسلكي سريع', brand:'Anker', price:'129 SAR', url:'https://www.amazon.sa/gp/bestsellers/' },
      { name:'ماوس لاسلكي', brand:'Logitech', price:'149 SAR', url:'https://www.amazon.sa/gp/bestsellers/' },
      { name:'كيبورد ميكانيكي', brand:'Redragon', price:'249 SAR', url:'https://www.amazon.sa/gp/bestsellers/' },
    ],
    noon: [
      { name:'سماعات بلوتوث لاسلكية', brand:'Samsung', price:'299 SAR', url:'https://www.noon.com/saudi-ar/bestsellers/' },
      { name:'ساعة ذكية رياضية', brand:'Xiaomi', price:'449 SAR', url:'https://www.noon.com/saudi-ar/bestsellers/' },
      { name:'مكبر صوت بلوتوث', brand:'JBL', price:'349 SAR', url:'https://www.noon.com/saudi-ar/bestsellers/' },
      { name:'شاحن سريع USB-C', brand:'Anker', price:'89 SAR', url:'https://www.noon.com/saudi-ar/bestsellers/' },
    ],
    aliexpress: [
      { name:'إضاءة LED للغرفة', brand:'', price:'$5.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
      { name:'حامل هاتف للسيارة', brand:'', price:'$3.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
      { name:'سماعات TWS', brand:'', price:'$8.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
      { name:'شاحن محمول 20000mAh', brand:'', price:'$12.99', url:'https://www.aliexpress.com/ssr/300002660/Deals-HomePage' },
    ],
  };

  return { success: true, products: mocks[source] || mocks.noon };
});

// ── App Events ────────────────────────────────────
app.whenReady().then(() => {
  initDB();
  createMainWindow();

  // Scheduler
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const pending = db.prepare('SELECT * FROM scheduled_tweets WHERE status="pending" AND scheduled_at <= ?').all(now);
    for (const t of pending) {
      const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
      if (!row) continue;
      try {
        const client = new TwitterApi(row.access_token);
        const result = await client.v2.tweet(t.content);
        db.prepare('UPDATE scheduled_tweets SET status="posted", tweet_id=? WHERE id=?').run(result.data.id, t.id);
        db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(t.content, result.data.id, 'posted');
      } catch(e) {
        db.prepare('UPDATE scheduled_tweets SET status="failed", error=? WHERE id=?').run(e.message, t.id);
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
