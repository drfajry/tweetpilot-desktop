const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // License
  verifyLicense:    (code)   => ipcRenderer.invoke('verify-license', code),
  checkLicense:     ()       => ipcRenderer.invoke('check-license'),
  // Auth
  getAuth:          ()       => ipcRenderer.invoke('get-auth'),
  startOAuth:       ()       => ipcRenderer.invoke('start-oauth'),
  logout:           ()       => ipcRenderer.invoke('logout'),
  onAuthSuccess:    (cb)     => ipcRenderer.on('auth-success', (_, data) => cb(data)),
  onAuthError:      (cb)     => ipcRenderer.on('auth-error',   (_, err)  => cb(err)),
  // Tweet
  generateTweet:    (data)   => ipcRenderer.invoke('generate-tweet', data),
  postTweet:        (data)   => ipcRenderer.invoke('post-tweet', data),
  scheduleTweet:    (data)   => ipcRenderer.invoke('schedule-tweet', data),
  getScheduled:     ()       => ipcRenderer.invoke('get-scheduled'),
  deleteScheduled:  (id)     => ipcRenderer.invoke('delete-scheduled', id),
  getHistory:       ()       => ipcRenderer.invoke('get-history'),
  fetchBestsellers: (data)   => ipcRenderer.invoke('fetch-bestsellers', data),
  fetchTrends:      (data)   => ipcRenderer.invoke('fetch-trends', data),
  onScheduledPosted:(cb)     => ipcRenderer.on('scheduled-posted', (_, data) => cb(data)),
  onScheduledFailed:(cb)     => ipcRenderer.on('scheduled-failed', (_, data) => cb(data)),
});
