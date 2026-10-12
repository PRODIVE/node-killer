const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nodeKiller', {
  ready: () => ipcRenderer.send('panel:ready'),
  onSnapshot: (callback) => ipcRenderer.on('panel:snapshot', (_event, snapshot) => callback(snapshot)),
  killGroup: (rootPid) => ipcRenderer.invoke('panel:kill-group', rootPid),
  reveal: (folder) => ipcRenderer.invoke('panel:reveal', folder),
  copy: (text) => ipcRenderer.invoke('panel:copy', text),
  openMenu: () => ipcRenderer.send('panel:menu'),
});
