// ═══════════════════════════════════════════════════════════
//  أداة تشخيص صور المتاجر — ناشر
//  الغرض: نرى المعطى الحقيقي بدل التخمين.
//  التشغيل: ضع هذا الملف بجانب main.js ثم اكتب في CMD:
//     npx electron diagnose.js
//  انتظر، ثم انسخ كل ما يُطبع في النافذة السوداء وأرسله.
// ═══════════════════════════════════════════════════════════

const { app, BrowserWindow } = require('electron');

const TESTS = [
  { store: 'amazon',     url: 'https://www.amazon.sa/s?k=' + encodeURIComponent('سماعة بلوتوث') },
  { store: 'noon',       url: 'https://www.noon.com/saudi-ar/search/?q=' + encodeURIComponent('سماعة بلوتوث') },
  { store: 'aliexpress', url: 'https://ar.aliexpress.com/wholesale?SearchText=' + encodeURIComponent('سماعة بلوتوث') + '&g=y' },
];

const EXTRACTORS = {
  amazon: `
    (() => {
      const out = [];
      const cards = document.querySelectorAll('div[data-asin][data-component-type="s-search-result"]');
      for (const c of cards) {
        const img = c.querySelector('img.s-image');
        if (!img) continue;
        out.push({ src: img.src, srcset: (img.getAttribute('srcset')||'').slice(0,120) });
        if (out.length >= 2) break;
      }
      return out;
    })()
  `,
  noon: `
    (() => {
      const out = [];
      const links = document.querySelectorAll('a[href*="/p/"]');
      for (const a of links) {
        const img = a.querySelector('img');
        out.push({
          href: a.href.slice(0,70),
          aria: a.getAttribute('aria-label'),
          title: a.getAttribute('title'),
          imgSrc: img ? (img.src||'').slice(0,90) : 'NO_IMG',
          imgDataSrc: img ? (img.getAttribute('data-src')||'') : '',
          imgAlt: img ? img.alt : ''
        });
        if (out.length >= 2) break;
      }
      return out;
    })()
  `,
  aliexpress: `
    (() => {
      const out = [];
      const links = document.querySelectorAll('a[href*="/item/"]');
      for (const a of links) {
        const img = a.querySelector('img');
        out.push({
          href: a.href.slice(0,60),
          imgSrc: img ? (img.src||'').slice(0,90) : 'NO_IMG',
          imgSrcset: img ? (img.getAttribute('srcset')||'').slice(0,90) : '',
          imgAlt: img ? (img.alt||'').slice(0,40) : ''
        });
        if (out.length >= 2) break;
      }
      return out;
    })()
  `,
};

function probe(store, url) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { partition: 'persist:nashir-shop' } });
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    let done = false;
    const finish = (data) => { if (done) return; done = true; try { win.destroy(); } catch(e){} resolve(data); };
    setTimeout(() => finish({ store, error: 'TIMEOUT' }), 35000);

    let tries = 0;
    const tryRead = async () => {
      if (done) return;
      try {
        await win.webContents.executeJavaScript('window.scrollTo(0, 1200); true;').catch(()=>{});
        const items = await win.webContents.executeJavaScript(EXTRACTORS[store]);
        if (items && items.length) {
          // اختبر تحميل أول صورة فعلياً من داخل الصفحة
          const firstImg = items[0].src || items[0].imgSrc || items[0].imgDataSrc || '';
          let imgTest = 'NO_URL';
          if (firstImg && firstImg.startsWith('http')) {
            imgTest = await win.webContents.executeJavaScript(`
              (async () => {
                try {
                  const r = await fetch(${JSON.stringify(firstImg)}, { referrerPolicy:'no-referrer' });
                  const b = await r.blob();
                  let canDecode = false;
                  try { const bm = await createImageBitmap(b); canDecode = !!bm; } catch(e) { canDecode = false; }
                  return { status: r.status, type: b.type, size: b.size, canDecode };
                } catch(e) { return { fetchError: String(e).slice(0,80) }; }
              })()
            `).catch(e => ({ jsError: String(e).slice(0,80) }));
          }
          return finish({ store, items, firstImg: firstImg.slice(0,90), imgTest });
        }
      } catch(e) {}
      if (++tries < 12) setTimeout(tryRead, 2500);
      else finish({ store, error: 'NO_ITEMS_FOUND' });
    };
    win.webContents.on('did-finish-load', () => setTimeout(tryRead, 3000));
    win.webContents.on('did-stop-loading', () => setTimeout(() => { if(!done) tryRead(); }, 4000));
    win.loadURL(url);
  });
}

app.whenReady().then(async () => {
  console.log('\n\n══════════ بدء التشخيص — انتظر حتى يكتمل ══════════\n');
  for (const t of TESTS) {
    console.log(`\n>>> ${t.store} ...`);
    const r = await probe(t.store, t.url);
    console.log(JSON.stringify(r, null, 2));
  }
  console.log('\n══════════ انتهى — انسخ كل ما فوق وأرسله ══════════\n');
  app.quit();
});
