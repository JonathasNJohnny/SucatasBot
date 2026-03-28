const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const {
  AUTH_CACHE_FILE,
  ensureAuthCacheDir,
  loadCachedConfig,
  hasClientCredentialsInCache,
} = require("./services/auth-cache.service");
const { createSetupWindow } = require("./windows/setup-window");

// importa seu servidor (será recarregado após configurar)
let serverModule = null;

function loadServer() {
  if (serverModule) {
    delete require.cache[require.resolve("../server")];
  }
  serverModule = require("../server");
}

function createPreloadFile() {
  const preloadContent = `
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  saveConfig: (data) => ipcRenderer.invoke('save-config', data),
});
  `;

  const preloadPath = path.join(__dirname, "preload.js");
  if (!fs.existsSync(preloadPath)) {
    fs.writeFileSync(preloadPath, preloadContent, "utf8");
  }
}

function createWindowsAfterSetup() {
  // janela de controle
  const twitchControl = new BrowserWindow({
    width: 900,
    height: 700,
    icon: path.join(__dirname, "..", "..", "icon.png"),
  });

  twitchControl.setTitle("Lizah Gacha");
  twitchControl.loadURL("http://localhost:49382/twitchControl.html");
}

app.whenReady().then(() => {
  createPreloadFile();
  const preloadPath = path.join(__dirname, "preload.js");

  const hasClientCredentials = hasClientCredentialsInCache();

  const setupEnvHandler = () => {
    ipcMain.handle("save-config", async (event, data) => {
      if (!data || !data.clientId || !data.clientSecret) {
        return { success: false, message: "Dados inválidos" };
      }

      try {
        ensureAuthCacheDir();
        const cached = loadCachedConfig();
        fs.writeFileSync(
          AUTH_CACHE_FILE,
          JSON.stringify(
            {
              ...cached,
              clientId: String(data.clientId || "").trim(),
              clientSecret: String(data.clientSecret || "").trim(),
              credentialsUpdatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          "utf8",
        );
        loadServer();
        setTimeout(createWindowsAfterSetup, 1000);
        return { success: true };
      } catch (err) {
        console.error("Erro ao salvar cache:", err);
        return { success: false, message: err.message };
      }
    });
  };

  if (!hasClientCredentials) {
    createSetupWindow(preloadPath);
    setupEnvHandler();
  } else {
    // Credenciais já existem no cache
    loadServer();
    setTimeout(createWindowsAfterSetup, 1000);
  }
});
