const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // License
  verifyLicense:    (code)   => ipcRenderer.invoke('verify-license', code),
  checkLicense:     ()       => ipcRenderer.invoke('check-license'),
  // Updates
  checkUpdate:      ()       => ipcRenderer.invoke('check-update'),
  getVersion:       ()       => ipcRenderer.invoke('get-version'),
  openReleases:     ()       => ipcRenderer.invoke('open-releases'),
  openExternal:     (url)    => ipcRenderer.invoke('open-external', url),
  copyToClipboard:  (text)   => ipcRenderer.invoke('copy-to-clipboard', text),
  onUpdateAvailable:(cb)     => ipcRenderer.on('update-available',     (_, d) => cb(d)),
  onUpdateNotAvail: (cb)     => ipcRenderer.on('update-not-available', (_, d) => cb(d)),
  // Auth
  getAuth:          ()       => ipcRenderer.invoke('get-auth'),
  startOAuth:       ()       => ipcRenderer.invoke('start-oauth'),
  logout:           ()       => ipcRenderer.invoke('logout'),
  onAuthSuccess:    (cb)     => ipcRenderer.on('auth-success', (_, data) => cb(data)),
  onAuthError:      (cb)     => ipcRenderer.on('auth-error',   (_, err)  => cb(err)),
  // Puppeteer
  puppeteerPost:    (data)   => ipcRenderer.invoke('puppeteer-post', data),
  puppeteerLogin:   ()       => ipcRenderer.invoke('puppeteer-login'),
  checkChrome:      ()       => ipcRenderer.invoke('check-chrome'),
  // Tweet
  generateTweet:    (data)   => ipcRenderer.invoke('generate-tweet', data),
  postTweet:        (data)   => ipcRenderer.invoke('post-tweet', data),
  scheduleTweet:    (data)   => ipcRenderer.invoke('schedule-tweet', data),
  smartSchedule:    (data)   => ipcRenderer.invoke('smart-schedule', data),
  getScheduled:     ()       => ipcRenderer.invoke('get-scheduled'),
  deleteScheduled:  (id)     => ipcRenderer.invoke('delete-scheduled', id),
  deleteAllScheduled: ()     => ipcRenderer.invoke('delete-all-scheduled'),
  getHistory:       ()       => ipcRenderer.invoke('get-history'),
  fetchBestsellers: (data)   => ipcRenderer.invoke('fetch-bestsellers', data),
  fetchProductImage:(url)    => ipcRenderer.invoke('fetch-product-image', url),
  fetchTrends:      (data)   => ipcRenderer.invoke('fetch-trends', data),
  onScheduledPosted:(cb)     => ipcRenderer.on('scheduled-posted', (_, data) => cb(data)),
  onScheduledFailed:(cb)     => ipcRenderer.on('scheduled-failed', (_, data) => cb(data)),
});
