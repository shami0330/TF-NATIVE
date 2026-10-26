// پل امن بین صفحه و پوسته (فقط همین دو تابع در اختیار صفحه است)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tfNative', {
  op: (name, args) => ipcRenderer.invoke('tf:op', name, args),
  log: (s) => ipcRenderer.send('tf:log', String(s))
});
