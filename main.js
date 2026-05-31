const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const { TwitterApi } = require('twitter-api-v2');
const Database = require('better-sqlite3');
const cron = require('node-cron');

// ── إعدادات التطبيق ──────────────────────────────
const API_KEY      = 'r9IxQhVn7x4K4z5lzza0jT9Fg'; // ← ضع Consumer Key هنا
const API_SECRET   = 'fTamGEdYi9AGXtRwDPE8Gsf73lUfyDszlpgEXCBnvLqeSRuJcW'; // ← ضع Consumer Secret هنا
const CLIENT_ID    = 'YmtJWUhrNjF6VDJ1UDBla3JWWnI6MTpjaQ'; // ← ضع OAuth 2.0 Client ID هنا
const CLIENT_SECRET= 'lqmot8CEQTiHH6bS-aJ3_aMO1EFCTu4zNZkejTQtwAwFGXu_pT'; // ← ضع OAuth 2.0 Client Secret هنا
const CALLBACK_URL = 'nashir://auth/callback';
const SCOPES       = ['tweet.read','tweet.write','users.read','offline.access'];

// ── قاعدة البيانات ───────────────────────────────
const DB_PATH = path.join(app.getPath('userData'), 'nashir.db');
let db;

function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      id INTEGER PRIMARY KEY,
      access_token TEXT,
      access_secret TEXT,
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

// ── النافذة الرئيسية ─────────────────────────────
let mainWindow;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 650,
    title: 'ناشر',
    backgroundColor: '#070b14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
}

// ── OAuth 2.0 PKCE ───────────────────────────────
let oauthCodeVerifier = null;
let oauthState = null;

async function startOAuth() {
  const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(CALLBACK_URL, { scope: SCOPES });
  oauthCodeVerifier = codeVerifier;
  oauthState = state;
  shell.openExternal(url);
  return { success: true };
}

async function handleCallback(callbackUrl) {
  try {
    const parsed = new URL(callbackUrl);
    const code  = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    if (!code || state !== oauthState) throw new Error('رابط غير صحيح');

    const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const { client: loggedClient, accessToken, refreshToken } =
      await client.loginWithOAuth2({ code, codeVerifier: oauthCodeVerifier, redirectUri: CALLBACK_URL });

    const me = await loggedClient.v2.me({ 'user.fields': ['profile_image_url', 'name'] });

    db.prepare(`INSERT OR REPLACE INTO auth (id, access_token, access_secret, username, name, profile_image)
      VALUES (1, ?, ?, ?, ?, ?)`).run(
      accessToken, refreshToken || '',
      me.data.username, me.data.name,
      me.data.profile_image_url || ''
    );

    mainWindow?.webContents.send('auth-success', {
      username: me.data.username,
      profile_image: me.data.profile_image_url || '',
    });
  } catch(e) {
    mainWindow?.webContents.send('auth-error', e.message);
  }
}

// ── IPC Handlers ─────────────────────────────────
ipcMain.handle('get-auth', () => {
  return db.prepare('SELECT * FROM auth WHERE id=1').get() || null;
});

ipcMain.handle('start-oauth', () => startOAuth());

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
      `😂 محفظتي تكرهني بعد ما شفت سعر {product}\nبس مش قادر أقاومه 🤷\n{url}\n{trends}`,
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

ipcMain.handle('schedule-tweet', (_, { content, scheduledAt }) => {
  const r = db.prepare('INSERT INTO scheduled_tweets (content, scheduled_at) VALUES (?,?)').run(content, scheduledAt);
  return { success: true, id: r.lastInsertRowid };
});

ipcMain.handle('get-scheduled', () => {
  return db.prepare('SELECT * FROM scheduled_tweets WHERE status="pending" ORDER BY scheduled_at ASC').all();
});

ipcMain.handle('delete-scheduled', (_, id) => {
  db.prepare('DELETE FROM scheduled_tweets WHERE id=?').run(id);
  return { success: true };
});

ipcMain.handle('get-history', () => {
  return db.prepare('SELECT * FROM tweet_history ORDER BY posted_at DESC LIMIT 50').all();
});

ipcMain.handle('fetch-bestsellers', (_, source) => {
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

// ── تسجيل البروتوكول nashir:// ───────────────────
app.setAsDefaultProtocolClient('nashir');

app.on('second-instance', (event, commandLine) => {
  const url = commandLine.find(arg => arg.startsWith('nashir://'));
  if (url) handleCallback(url);
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleCallback(url);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// ── تشغيل التطبيق ────────────────────────────────
app.whenReady().then(() => {
  initDB();
  createMainWindow();

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

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
