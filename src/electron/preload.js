
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
});
  