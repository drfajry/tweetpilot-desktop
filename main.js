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
const CALLBACK_URL  = 'https://example.com/callback';
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
    title: 'ناشر',
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

  // فتح المتصفح
  shell.openExternal(url);
  
  // نافذة للإدخال اليدوي للكود
  authWindow = new BrowserWindow({
    width: 500, height: 400,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    title: 'ربط حساب X',
    backgroundColor: '#070b14',
    parent: mainWindow,
    modal: true,
  });

  authWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8">
    <style>
      body{font-family:sans-serif;background:#070b14;color:#e8eaf0;padding:30px;direction:rtl}
      h2{color:#1d9bf0;margin-bottom:16px;font-size:18px}
      p{color:#888;font-size:13px;line-height:1.7;margin-bottom:20px}
      input{width:100%;padding:12px;background:#111827;border:1px solid #1d9bf033;border-radius:8px;color:#fff;font-size:13px;margin-bottom:14px;box-sizing:border-box}
      button{width:100%;padding:12px;background:linear-gradient(135deg,#1d9bf0,#0d6efd);border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:700;cursor:pointer}
      .hint{font-size:11px;color:#555;margin-top:10px;text-align:center}
    </style></head><body>
    <h2>🔗 ربط حساب X</h2>
    <p>بعد تسجيل الدخول في المتصفح، انسخ الرابط الكامل من شريط العنوان والصقه هنا:</p>
    <input id="url" placeholder="https://example.com/callback?code=...&state=..." />
    <button onclick="submit()">تأكيد الربط</button>
    <div class="hint">مثال: https://example.com/callback?code=ABC123&state=XYZ</div>
    <script>
      function submit() {
        const url = document.getElementById('url').value.trim();
        if (!url) { alert('الصق الرابط أولاً'); return; }
        const btn = document.querySelector('button');
        btn.textContent = '⏳ جاري الربط...';
        btn.disabled = true;
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'http://localhost:42070/auth?url=' + encodeURIComponent(url), true);
        xhr.timeout = 15000;
        xhr.onload = function() { btn.textContent = '✅ تم!'; };
        xhr.onerror = function() { btn.textContent = 'خطأ - حاول مجدداً'; btn.disabled = false; };
        xhr.send();
      }
    </script>
    </body></html>
  `));
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

// ── Auth Code Receiver ───────────────────────────
const authReceiver = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://localhost:42070');
  const callbackUrl = urlObj.searchParams.get('url');
  res.end('ok');
  
  if (!callbackUrl) return;
  
  try {
    const parsed = new URL(callbackUrl);
    const code  = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    
    if (!code || state !== oauthState) {
      mainWindow?.webContents.send('auth-error', 'رابط غير صحيح');
      return;
    }

    const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const { client: loggedClient, accessToken, refreshToken, expiresIn } =
      await client.loginWithOAuth2({ code, codeVerifier: oauthCodeVerifier, redirectUri: CALLBACK_URL });

    const me = await loggedClient.v2.me({ 'user.fields': ['profile_image_url', 'name'] });

    db.prepare(`INSERT OR REPLACE INTO auth (id, access_token, refresh_token, username, name, profile_image, expires_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)`).run(
      accessToken, refreshToken||'', me.data.username, me.data.name,
      me.data.profile_image_url||'', Date.now()+((expiresIn||7200)*1000)
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
authReceiver.listen(42070, '127.0.0.1');

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
