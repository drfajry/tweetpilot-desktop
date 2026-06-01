const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const https = require('https');
const { TwitterApi } = require('twitter-api-v2');
const Database = require('better-sqlite3');
const cron = require('node-cron');

// ── إعدادات التطبيق ──────────────────────────────
const CLIENT_ID     = ''; // ← ضع OAuth 2.0 Client ID هنا
const CLIENT_SECRET = ''; // ← ضع OAuth 2.0 Client Secret هنا
const CALLBACK_URL  = 'nashir://auth/callback';
const SCOPES        = ['tweet.read','tweet.write','users.read','offline.access'];

// ── قاعدة البيانات ────────────────────────────────
const DB_PATH = path.join(app.getPath('userData'), 'nashir.db');
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

// ── النشر المباشر عبر X API v2 ───────────────────
// الحل الصحيح: OAuth2 User Access Token يُستخدم كـ Bearer في Authorization header
// twitter-api-v2 تُعامله كـ App Bearer (app-only) عند تمريره كـ string
// لذا نستدعي X API مباشرة بـ Node https
function postToXApi(accessToken, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const options = {
      hostname: 'api.twitter.com',
      path: '/2/tweets',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'nashir-app/1.0',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, data: parsed });
          } else {
            resolve({ success: false, status: res.statusCode, data: parsed });
          }
        } catch(e) {
          resolve({ success: false, status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// تجديد الـ access token
async function refreshAccessToken(refreshToken) {
  const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const result = await client.refreshOAuth2Token(refreshToken);
  return result;
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

// ── OAuth 2.0 PKCE ────────────────────────────────
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

    const me = await loggedClient.v2.me({ 'user.fields': ['profile_image_url','name'] });

    db.prepare(`INSERT OR REPLACE INTO auth (id, access_token, refresh_token, username, name, profile_image)
      VALUES (1, ?, ?, ?, ?, ?)`).run(
      accessToken,
      refreshToken || '',
      me.data.username,
      me.data.name,
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

// ── IPC Handlers ──────────────────────────────────
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

  // اقتطاع تلقائي إذا تجاوز 280 حرفاً
  if (tweet.length > 280) {
    const suffix = `\n${affiliateUrl}\n${trendTags}`;
    const maxText = 280 - suffix.length - 4;
    const lines = tweet.split('\n').slice(0, -2);
    const text = lines.join('\n');
    tweet = (text.length > maxText ? text.substring(0, maxText) + '…' : text) + suffix;
  }

  return { success: true, tweet, charCount: tweet.length };
});

// ── النشر — الإصلاح الجذري ───────────────────────
ipcMain.handle('post-tweet', async (_, { content }) => {
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  if (!row) return { success: false, error: 'غير مسجل الدخول — يرجى ربط الحساب أولاً' };
  if (content.length > 280) return { success: false, error: `التغريدة تتجاوز 280 حرفاً (${content.length})` };

  // المحاولة الأولى بالـ access token الحالي
  let result = await postToXApi(row.access_token, content);

  // إذا كان 401 وعندنا refresh token → نجدد ثم نعيد المحاولة
  if (!result.success && result.status === 401 && row.refresh_token) {
    console.log('[post-tweet] 401 received, attempting token refresh...');
    try {
      const refreshed = await refreshAccessToken(row.refresh_token);
      db.prepare('UPDATE auth SET access_token=?, refresh_token=? WHERE id=1').run(
        refreshed.accessToken,
        refreshed.refreshToken || row.refresh_token
      );
      result = await postToXApi(refreshed.accessToken, content);
    } catch(refreshErr) {
      return {
        success: false,
        error: `انتهت صلاحية الجلسة — يرجى إعادة ربط الحساب.\n(${refreshErr.message})`,
      };
    }
  }

  if (result.success) {
    const tweetId = result.data?.data?.id;
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(
      content, tweetId || '', 'posted'
    );
    return { success: true, tweetId };
  }

  // بناء رسالة خطأ مفهومة
  const errData = result.data || {};
  const detail  = errData.detail || errData.title || JSON.stringify(errData);
  const hint = result.status === 401
    ? '\n\n✋ تأكد من:\n• صلاحية التطبيق: Read+Write في X Developer Portal\n• إعادة ربط الحساب بعد تغيير الصلاحيات'
    : result.status === 403
    ? '\n\n✋ خطأ 403: التطبيق لا يملك صلاحية الكتابة\nاذهب إلى X Developer Portal وغيّر App Permissions إلى Read+Write ثم أعد الربط'
    : result.status === 429
    ? '\n\n⏰ تم تجاوز حد الطلبات — انتظر قليلاً ثم أعد المحاولة'
    : '';

  return { success: false, error: `خطأ ${result.status}: ${detail}${hint}` };
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

// ── ترندات حقيقية ─────────────────────────────────
ipcMain.handle('fetch-trends', async (_, { region }) => {
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  if (!row) return { success: false, error: 'غير مسجل الدخول', trends: [] };

  const WOEID = { sa: 349204, ae: 349217, eg: 23424802, world: 1 };
  const woeid = WOEID[region] || WOEID.sa;

  try {
    const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    // نستخدم الـ access token مع v1 trends
    const userClient = new TwitterApi(row.access_token);
    const trends = await userClient.v1.trendsByPlace(woeid);
    const list = trends[0]?.trends?.slice(0, 10).map(t => ({
      name: t.name,
      tweet_volume: t.tweet_volume || null,
    })) || [];
    return { success: true, trends: list };
  } catch(e) {
    console.error('[fetch-trends]', e.message);
    return { success: false, error: e.message, trends: [] };
  }
});

// ── منتجات (احتياطي) ──────────────────────────────
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
if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('nashir', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('nashir');
}

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

  // Cron: نشر التغريدات المجدولة كل دقيقة
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const pending = db.prepare(
      'SELECT * FROM scheduled_tweets WHERE status="pending" AND scheduled_at <= ?'
    ).all(now);

    for (const t of pending) {
      const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
      if (!row) continue;

      let result = await postToXApi(row.access_token, t.content);

      if (!result.success && result.status === 401 && row.refresh_token) {
        try {
          const refreshed = await refreshAccessToken(row.refresh_token);
          db.prepare('UPDATE auth SET access_token=?, refresh_token=? WHERE id=1').run(
            refreshed.accessToken, refreshed.refreshToken || row.refresh_token
          );
          result = await postToXApi(refreshed.accessToken, t.content);
        } catch(e) {
          db.prepare('UPDATE scheduled_tweets SET status="failed", error=? WHERE id=?').run(
            'انتهت الجلسة: ' + e.message, t.id
          );
          mainWindow?.webContents.send('scheduled-failed', { id: t.id });
          continue;
        }
      }

      if (result.success) {
        const tweetId = result.data?.data?.id;
        db.prepare('UPDATE scheduled_tweets SET status="posted", tweet_id=? WHERE id=?').run(tweetId, t.id);
        db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(
          t.content, tweetId || '', 'posted'
        );
        mainWindow?.webContents.send('scheduled-posted', { id: t.id, tweetId });
      } else {
        const errMsg = result.data?.detail || JSON.stringify(result.data || {});
        db.prepare('UPDATE scheduled_tweets SET status="failed", error=? WHERE id=?').run(errMsg, t.id);
        mainWindow?.webContents.send('scheduled-failed', { id: t.id, error: errMsg });
      }
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
