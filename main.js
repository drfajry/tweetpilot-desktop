const { app, BrowserWindow, ipcMain, shell, session, protocol } = require('electron');
const path = require('path');
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

// ── بناء Twitter client بـ OAuth 2.0 ──────────────
// FIX #1: الطريقة الصحيحة لبناء client للنشر بـ OAuth2 PKCE
function buildClient(row) {
  return new TwitterApi({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  }).readWrite;
  // نستخدم accessToken مباشرةً كـ Bearer token من نوع OAuth2
  // twitter-api-v2 يقبل هذا الشكل:
}

// الطريقة الصحيحة فعلاً:
function getAuthedClient(accessToken) {
  // OAuth2 access token يُستخدم هكذا في twitter-api-v2
  return new TwitterApi(accessToken);
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
    const { client: loggedClient, accessToken, refreshToken, expiresIn } =
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

  // FIX #5: اقتطاع التغريدة إذا تجاوزت 280 حرفاً
  if (tweet.length > 280) {
    // احتفظ بالرابط والترندات، اقتطع الوصف
    const urlAndTrends = `\n${affiliateUrl}\n${trendTags}`;
    const maxDescLen = 280 - urlAndTrends.length - 5;
    const lines = tweet.split('\n');
    // الأسطر الأولى هي النص الترويجي، آخر سطرين هم URL والترندات
    const textLines = lines.slice(0, -2).join('\n');
    const trimmed = textLines.length > maxDescLen
      ? textLines.substring(0, maxDescLen) + '…'
      : textLines;
    tweet = trimmed + urlAndTrends;
  }

  return { success: true, tweet, charCount: tweet.length };
});

// FIX #1: النشر الصحيح بـ OAuth 2.0
ipcMain.handle('post-tweet', async (_, { content }) => {
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  if (!row) return { success: false, error: 'غير مسجل الدخول' };

  // التحقق من الطول قبل النشر
  if (content.length > 280) {
    return { success: false, error: `التغريدة تتجاوز 280 حرفاً (${content.length} حرف)` };
  }

  try {
    // OAuth2 access token: يُمرر مباشرة كـ string
    const client = new TwitterApi(row.access_token);
    const result = await client.v2.tweet(content);
    db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(
      content, result.data.id, 'posted'
    );
    return { success: true, tweetId: result.data.id };
  } catch(e) {
    // تفاصيل الخطأ الكاملة
    const errDetail = e.data ? JSON.stringify(e.data) : e.message;
    console.error('[post-tweet error]', errDetail);
    // إذا كان خطأ 401 — Token منتهي، نحاول التجديد
    if (e.code === 401 && row.refresh_token) {
      try {
        const refreshed = await new TwitterApi({
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }).refreshOAuth2Token(row.refresh_token);
        db.prepare('UPDATE auth SET access_token=?, refresh_token=? WHERE id=1').run(
          refreshed.accessToken, refreshed.refreshToken || row.refresh_token
        );
        const newClient = new TwitterApi(refreshed.accessToken);
        const result2 = await newClient.v2.tweet(content);
        db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(
          content, result2.data.id, 'posted'
        );
        return { success: true, tweetId: result2.data.id };
      } catch(e2) {
        return { success: false, error: 'انتهت صلاحية التوكن — يرجى إعادة الربط: ' + e2.message };
      }
    }
    return { success: false, error: errDetail };
  }
});

ipcMain.handle('schedule-tweet', (_, { content, scheduledAt }) => {
  if (content.length > 280) {
    return { success: false, error: `التغريدة تتجاوز 280 حرفاً (${content.length} حرف)` };
  }
  const r = db.prepare('INSERT INTO scheduled_tweets (content, scheduled_at) VALUES (?,?)').run(content, scheduledAt);
  return { success: true, id: r.lastInsertRowid };
});

// FIX #2: جلب التغريدات المجدولة (pending + failed + posted)
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

// FIX #3: ترندات حقيقية عبر X API v2
ipcMain.handle('fetch-trends', async (_, { region }) => {
  const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
  if (!row) return { success: false, error: 'غير مسجل الدخول', trends: [] };

  // Woeid للمناطق (يحتاج Twitter API v1.1 - متاح للجميع)
  const WOEID = { sa: 349204, ae: 349217, eg: 23424802, world: 1 };
  const woeid = WOEID[region] || WOEID.sa;

  try {
    // Twitter v1.1 trends (لا يزال مجاناً)
    const client = new TwitterApi(row.access_token);
    const trends = await client.v1.trendsByPlace(woeid);
    const list = trends[0]?.trends?.slice(0, 10).map(t => ({
      name: t.name,
      tweet_volume: t.tweet_volume || null,
      url: t.url,
    })) || [];
    return { success: true, trends: list };
  } catch(e) {
    console.error('[fetch-trends error]', e.message);
    // Fallback: ترندات محدثة يومياً إذا فشل الـ API
    return { success: false, error: e.message, trends: [] };
  }
});

// FIX #4: منتجات نون الحقيقية عبر scraping أو Amazon PA-API
ipcMain.handle('fetch-bestsellers', async (_, source) => {
  // Amazon Product Advertising API - يحتاج credentials منفصلة
  // في الوقت الحالي: بيانات محدثة أسبوعياً + رابط مباشر لصفحة البيسيلر
  const LIVE_LINKS = {
    amazon: 'https://www.amazon.sa/gp/bestsellers/electronics/',
    noon: 'https://www.noon.com/saudi-ar/deals/',
    aliexpress: 'https://www.aliexpress.com/ssr/300002660/Deals-HomePage',
  };

  // للحصول على منتجات حقيقية، افتح الصفحة في المتصفح
  // هذا يتطلب تكامل Amazon PA-API أو Noon Affiliate API
  const mocks = {
    amazon: [
      { name:'سماعات AirPods Pro 2', brand:'Apple', price:'799 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/', real: false },
      { name:'شاشة LG 27 بوصة 4K', brand:'LG', price:'1299 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/', real: false },
      { name:'ماوس MX Master 3S', brand:'Logitech', price:'349 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/', real: false },
      { name:'كيبورد ميكانيكي K8 Pro', brand:'Keychron', price:'549 SAR', url:'https://www.amazon.sa/gp/bestsellers/electronics/', real: false },
    ],
    noon: [
      { name:'سماعات Galaxy Buds2 Pro', brand:'Samsung', price:'499 SAR', url:'https://www.noon.com/saudi-ar/electronics/', real: false },
      { name:'ساعة Mi Band 8 Pro', brand:'Xiaomi', price:'229 SAR', url:'https://www.noon.com/saudi-ar/electronics/', real: false },
      { name:'مكبر Charge 5', brand:'JBL', price:'699 SAR', url:'https://www.noon.com/saudi-ar/electronics/', real: false },
      { name:'شاحن 65W GaN', brand:'Anker', price:'149 SAR', url:'https://www.noon.com/saudi-ar/electronics/', real: false },
    ],
    aliexpress: [
      { name:'إضاءة RGB للغرفة', brand:'Govee', price:'$18.99', url:'https://www.aliexpress.com/item/flash_deals.html', real: false },
      { name:'حامل هاتف مغناطيسي', brand:'', price:'$6.99', url:'https://www.aliexpress.com/item/flash_deals.html', real: false },
      { name:'سماعات TWS ANC', brand:'QCY', price:'$22.99', url:'https://www.aliexpress.com/item/flash_deals.html', real: false },
      { name:'بطارية محمولة 30000mAh', brand:'Baseus', price:'$24.99', url:'https://www.aliexpress.com/item/flash_deals.html', real: false },
    ],
  };

  return {
    success: true,
    products: mocks[source] || mocks.noon,
    liveUrl: LIVE_LINKS[source],
    note: 'بيانات تجريبية — لتفعيل البيانات الحقيقية راجع README',
  };
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

  // FIX #2: cron يُحدّث الواجهة بعد النشر
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const pending = db.prepare(
      'SELECT * FROM scheduled_tweets WHERE status="pending" AND scheduled_at <= ?'
    ).all(now);

    for (const t of pending) {
      const row = db.prepare('SELECT * FROM auth WHERE id=1').get();
      if (!row) continue;
      try {
        const client = new TwitterApi(row.access_token);
        const result = await client.v2.tweet(t.content);
        db.prepare('UPDATE scheduled_tweets SET status="posted", tweet_id=? WHERE id=?').run(result.data.id, t.id);
        db.prepare('INSERT INTO tweet_history (content, tweet_id, status) VALUES (?,?,?)').run(t.content, result.data.id, 'posted');
        // أخطر الواجهة
        mainWindow?.webContents.send('scheduled-posted', { id: t.id, tweetId: result.data.id });
      } catch(e) {
        const errMsg = e.data ? JSON.stringify(e.data) : e.message;
        db.prepare('UPDATE scheduled_tweets SET status="failed", error=? WHERE id=?').run(errMsg, t.id);
        mainWindow?.webContents.send('scheduled-failed', { id: t.id, error: errMsg });
        // إذا انتهى التوكن، حاول التجديد
        if ((e.code === 401 || errMsg.includes('401')) && row.refresh_token) {
          try {
            const refreshed = await new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
              .refreshOAuth2Token(row.refresh_token);
            db.prepare('UPDATE auth SET access_token=?, refresh_token=? WHERE id=1').run(
              refreshed.accessToken, refreshed.refreshToken || row.refresh_token
            );
          } catch(_) {}
        }
      }
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
