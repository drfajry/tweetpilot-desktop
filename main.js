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

// سكرابينج ترندات YouTube من youtube.trends24.in
function fetchYoutubeTrends(region) {
  return new Promise((resolve) => {
    const { net } = require('electron');
    const PATHS = { sa: 'SA', ae: 'AE', eg: 'EG', world: 'US' };
    const geo = PATHS[region] || 'SA';
    const url = `https://youtube.trends24.in/?geo=${geo}`;
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
          const matches = [...data.matchAll(/href="https:\/\/www\.youtube\.com\/watch[^"]*"[^>]*title="([^"]{5,80})"/g)];
          const titles = [...data.matchAll(/class="[^"]*title[^"]*"[^>]*>([^<]{5,80})<\//gi)]
            .map(m => m[1].trim());
          const all = [...new Set([
            ...matches.map(m => m[1].trim()),
            ...titles
          ])].filter(t => t.length > 4).slice(0, 12);
          if (all.length === 0) { resolve({ success: false, error: 'لم يتم العثور على ترندات', trends: [] }); return; }
          const trends = all.map(t => ({
            name: '#' + t.replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, '').trim().split(/\s+/).slice(0, 3).join('_'),
            tweet_volume: null,
            title: t,
          }));
          resolve({ success: true, trends });
        } catch(e) { resolve({ success: false, error: e.message, trends: [] }); }
      });
    });
    request.on('error', (e) => { if (!timedOut) { clearTimeout(timer); resolve({ success: false, error: e.message, trends: [] }); } });
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
ipcMain.handle('check-update', async () => {
  await checkForUpdates(false);
  return { version: APP_VERSION };
});

ipcMain.handle('get-version', () => ({ version: APP_VERSION }));

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('copy-to-clipboard', (_, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('open-releases', () => {
  shell.openExternal('https://github.com/drfajry/tweetpilot-desktop/releases/latest');
});

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

ipcMain.handle('generate-tweet', (_, { trends, affiliateUrl, productDesc, tone, fixedTags, category }) => {

  // قوالب عامة
  const TEMPLATES_GENERAL = {
    hype: [
      `🔥 لا تفوتك هذه الفرصة! {product} بسعر خيالي لن تصدقه\nاطلبه الآن قبل نفاد الكمية 👇\n{url}\n{trends}`,
      `⚡️ عرض انفجاري على {product}!\nهذا هو الوقت المثالي للشراء 🛒\n{url}\n{trends}`,
      `🚀 من يبحث عن {product} هذا هو الرابط الذهبي\nالسعر مش هيتكرر! 💥\n{url}\n{trends}`,
      `🎯 توقف! شوف {product} بهالسعر\nفرصة ما تتكرر كل يوم ⬇️\n{url}\n{trends}`,
    ],
    informative: [
      `📊 إذا كنت تبحث عن {product} فهذا أفضل خيار متاح الآن\nجودة عالية وسعر منافس ✅\n{url}\n{trends}`,
      `💡 نصيحة لمن يريد {product}: هذا المنتج حصل على أعلى التقييمات\nجربه بنفسك 👇\n{url}\n{trends}`,
      `🔍 بحثت كثيراً وهذا أفضل {product} بالسوق الآن\nالمواصفات والسعر لا يُقارنان 📌\n{url}\n{trends}`,
    ],
    funny: [
      `😂 محفظتي تكرهني بعد ما شفت سعر {product}\nبس مش قادر أقاومه 🤷‍♂️\n{url}\n{trends}`,
      `🤣 أنا وعدت نفسي ما أشتري.. بس {product} بهالسعر؟!\nكذبت على نفسي 😅\n{url}\n{trends}`,
      `😭 حسابي البنكي يبكي بس قلبي فرحان\n{product} وصل بسعر مو طبيعي 💸\n{url}\n{trends}`,
    ],
    urgency: [
      `⏰ تنبيه عاجل: {product} بهذا السعر لن يدوم طويلاً\nاشترِ الآن قبل فوات الأوان! 🚨\n{url}\n{trends}`,
      `🚨 آخر ساعات العرض على {product}!\nلا تندم لاحقاً، القرار الآن ⚡️\n{url}\n{trends}`,
      `⏳ الكمية محدودة جداً!\n{product} يختفي بسرعة 😱 اطلبه الآن\n{url}\n{trends}`,
    ],
  };

  // قوالب حسب الفئة
  const TEMPLATES_BY_CATEGORY = {
    electronics: {
      hype: [
        `📱 أخيراً! {product} وصل بسعر يكسر السوق 🔥\nللمهتمين بالتقنية هذا رابطكم 👇\n{url}\n{trends}`,
        `💻 عروض التقنية لا تنتظر!\n{product} الآن بأقل سعر رأيته 🎯\n{url}\n{trends}`,
      ],
      informative: [
        `🔋 مراجعة سريعة: {product}\nمواصفات ممتازة + ضمان + توصيل سريع ✅\n{url}\n{trends}`,
        `⚙️ للي يدور جهاز موثوق\n{product} خيار لا يخيب — شوف التفاصيل 👇\n{url}\n{trends}`,
      ],
      funny: [
        `🤓 نفسي وتقنيتي اتفقا على شيء واحد\n{product} لازم يكون عندي 😂\n{url}\n{trends}`,
      ],
      urgency: [
        `⚡ فلاش ديل على {product}!\nالعرض ينتهي قريباً ⏰ لا تفوت\n{url}\n{trends}`,
      ],
    },
    fashion: {
      hype: [
        `👗 ستايل راقي بسعر خيالي!\n{product} وصل وما رح يصدق عليه 😍\n{url}\n{trends}`,
        `✨ أناقة فعلية!\n{product} هو اللي كنت تبحث عنه 🛍️\n{url}\n{trends}`,
      ],
      informative: [
        `👔 مش بس موضة — جودة حقيقية\n{product} مريح وعملي وبسعر مناسب 💯\n{url}\n{trends}`,
      ],
      funny: [
        `😂 لما تلبس {product} وكل الناس تسأل: من وين؟\nالسر في الرابط 👇\n{url}\n{trends}`,
      ],
      urgency: [
        `🔥 المقاسات تنفد!\n{product} من أحلى العروض هذا الموسم ⏳\n{url}\n{trends}`,
      ],
    },
    food: {
      hype: [
        `🍔 أكل لذيذ + توصيل سريع + سعر مناسب؟\n{product} عندك كل شيء 😋\n{url}\n{trends}`,
        `🍕 جوعان؟ هذا العرض على {product} ما يُرفض!\nاطلب الآن قبل ما تنتهي الكمية 🔥\n{url}\n{trends}`,
      ],
      informative: [
        `🥗 تبحث عن خيار صحي ولذيذ؟\n{product} الحل المثالي لك ✅\n{url}\n{trends}`,
      ],
      funny: [
        `😂 دايتي انتهى بس {product} ما أقدر أقاومه\nالجسم يصبر والقلب ما يصبر 😅\n{url}\n{trends}`,
      ],
      urgency: [
        `⏰ عرض اليوم فقط على {product}!\nاطلب الآن قبل ما ينتهي 🚨\n{url}\n{trends}`,
      ],
    },
    beauty: {
      hype: [
        `💄 سر الجمال الحقيقي!\n{product} غيّر نظرتي للعناية بالبشرة ✨\n{url}\n{trends}`,
        `🌸 جربته وما ندمت!\n{product} نتائج لا تصدق بسعر ممتاز 💕\n{url}\n{trends}`,
      ],
      informative: [
        `💆 عناية حقيقية بمكونات طبيعية\n{product} مناسب لكل أنواع البشرة ✅\n{url}\n{trends}`,
      ],
      funny: [
        `😂 قبل {product}: أنا والمرآة ما نتكلم\nبعده: بصراحة أنا وسيم 🤭\n{url}\n{trends}`,
      ],
      urgency: [
        `⏳ الكمية المحدودة على {product} توشك تنتهي!\nاطلبي الآن 💨\n{url}\n{trends}`,
      ],
    },
    home: {
      hype: [
        `🏠 بيتك يستاهل الأحسن!\n{product} يحوّل أي غرفة لتحفة 😍\n{url}\n{trends}`,
        `✨ ديكور راقي بسعر بسيط\n{product} الإضافة اللي بيتك ناقصها 🏡\n{url}\n{trends}`,
      ],
      informative: [
        `🛋️ جودة + عملية + سعر مناسب\n{product} اختيار ذكي لبيتك 💯\n{url}\n{trends}`,
      ],
      funny: [
        `😂 زوجتي قالت لا تشتري شيء\nبس {product} بهالسعر؟ معذور 🤷‍♂️\n{url}\n{trends}`,
      ],
      urgency: [
        `🚨 عرض محدود على {product}!\nاطلبه قبل ما ترتفع الأسعار 📦\n{url}\n{trends}`,
      ],
    },
  };

  const product   = productDesc || 'هذا المنتج المميز';
  const trendTags = trends.map(t => t.name).join(' ');
  const fixed     = fixedTags ? '#فيصل_يختار #تخفيضات' : '';
  const allTags   = [trendTags, fixed].filter(Boolean).join(' ');

  // اختر القوالب حسب الفئة أو العامة
  let pool = TEMPLATES_GENERAL[tone] || TEMPLATES_GENERAL.hype;
  if (category && TEMPLATES_BY_CATEGORY[category]) {
    const catTones = TEMPLATES_BY_CATEGORY[category][tone] || TEMPLATES_BY_CATEGORY[category].hype || [];
    pool = [...pool, ...catTones]; // دمج القوالب العامة والمخصصة
  }

  const template = pool[Math.floor(Math.random() * pool.length)];
  let tweet = template
    .replace(/{product}/g, product)
    .replace(/{url}/g, affiliateUrl)
    .replace(/{trends}/g, allTags);

  if (tweet.length > 280) {
    const suffix = `\n${affiliateUrl}\n${allTags}`;
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
