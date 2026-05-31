const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAuth:         ()       => ipcRenderer.invoke('get-auth'),
  startOAuth:      ()       => ipcRenderer.invoke('start-oauth'),
  logout:          ()       => ipcRenderer.invoke('logout'),
  onAuthSuccess:   (cb)     => ipcRenderer.on('auth-success', (_, data) => cb(data)),
  onAuthError:     (cb)     => ipcRenderer.on('auth-error',   (_, err)  => cb(err)),
  generateTweet:   (data)   => ipcRenderer.invoke('generate-tweet', data),
  postTweet:       (data)   => ipcRenderer.invoke('post-tweet', data),
  scheduleTweet:   (data)   => ipcRenderer.invoke('schedule-tweet', data),
  getScheduled:    ()       => ipcRenderer.invoke('get-scheduled'),
  deleteScheduled: (id)     => ipcRenderer.invoke('delete-scheduled', id),
  getHistory:      ()       => ipcRenderer.invoke('get-history'),
  fetchBestsellers:(source) => ipcRenderer.invoke('fetch-bestsellers', source),
});
