const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  saveConfig: (data) => ipcRenderer.invoke("save-config", data),
  getClipShortcuts: () => ipcRenderer.invoke("get-clip-shortcuts"),
  saveClipShortcuts: (shortcuts) =>
    ipcRenderer.invoke("save-clip-shortcuts", shortcuts),
  setClipShortcutsEnabled: (enabled) =>
    ipcRenderer.invoke("set-clip-shortcuts-enabled", enabled),
});
