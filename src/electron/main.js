const { app, BrowserWindow, Menu, Tray, ipcMain, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const {
  AUTH_CACHE_FILE,
  ensureAuthCacheDir,
  loadCachedConfig,
  hasClientCredentialsInCache,
} = require("./services/auth-cache.service");
const { createSetupWindow } = require("./windows/setup-window");

//test update

// importa seu servidor (será recarregado após configurar)
let serverModule = null;
let mainWindow = null;
let tray = null;
let updateWindow = null;
let isQuitting = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

// Detecta primeira execução
const FIRST_RUN_CHECK_FILE = path.join(
  app.getPath("userData"),
  ".first-run-done",
);
function isFirstRun() {
  return !fs.existsSync(FIRST_RUN_CHECK_FILE);
}
function markFirstRunDone() {
  fs.writeFileSync(FIRST_RUN_CHECK_FILE, "true");
}

function parseTagVersion(versionLike) {
  const raw = String(versionLike || "").trim();
  if (!raw) {
    return null;
  }

  const withoutV =
    raw.startsWith("v") || raw.startsWith("V") ? raw.slice(1) : raw;
  const match = withoutV.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    normalized: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
  };
}

function isRemoteVersionGreater(currentVersion, remoteVersion) {
  const current = parseTagVersion(currentVersion);
  const remote = parseTagVersion(remoteVersion);

  if (!current || !remote) {
    return false;
  }

  if (remote.major !== current.major) {
    return remote.major > current.major;
  }

  if (remote.minor !== current.minor) {
    return remote.minor > current.minor;
  }

  return remote.patch > current.patch;
}

function createUpdateWindow() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    return updateWindow;
  }

  updateWindow = new BrowserWindow({
    width: 460,
    height: 280,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    frame: false,
    alwaysOnTop: true,
    title: "Atualizando Sucatas Bot",
    icon: path.join(__dirname, "..", "..", "icon.png"),
    webPreferences: {
      devTools: false,
    },
  });

  updateWindow.on("closed", () => {
    updateWindow = null;
  });

  updateWindow.once("ready-to-show", () => {
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.show();
      updateWindow.focus();
    }
  });

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Atualizando</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            width: 100vw;
            height: 100vh;
            display: grid;
            place-items: center;
            font-family: 'Segoe UI', Tahoma, sans-serif;
            background: radial-gradient(circle at top, #23395d 0%, #121826 55%, #0b1020 100%);
            color: #f4f7ff;
          }
          .card {
            width: min(90vw, 390px);
            padding: 28px 24px;
            border-radius: 14px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.16);
            box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(6px);
            text-align: center;
          }
          .spinner {
            width: 56px;
            height: 56px;
            margin: 0 auto 16px;
            border-radius: 50%;
            border: 5px solid rgba(255, 255, 255, 0.25);
            border-top-color: #6cc6ff;
            animation: spin 1s linear infinite;
          }
          h1 {
            margin: 0 0 8px;
            font-size: 20px;
            font-weight: 700;
          }
          p {
            margin: 0;
            color: #d6def4;
            font-size: 14px;
            line-height: 1.4;
            min-height: 40px;
          }
          .progress {
            margin-top: 14px;
            font-weight: 600;
            color: #9ad9ff;
            font-size: 13px;
            min-height: 20px;
          }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="spinner"></div>
          <h1 id="title">Preparando atualizacao...</h1>
          <p id="detail">Aguarde enquanto finalizamos tudo para voce.</p>
          <div class="progress" id="progress"></div>
        </div>
        <script>
          window.__setUpdateState = (state) => {
            const title = document.getElementById('title');
            const detail = document.getElementById('detail');
            const progress = document.getElementById('progress');

            if (state && state.title) {
              title.textContent = state.title;
            }
            if (state && state.detail) {
              detail.textContent = state.detail;
            }
            progress.textContent = state && state.progress ? state.progress : '';
          };
        </script>
      </body>
    </html>
  `;

  updateWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
  return updateWindow;
}

function setUpdateWindowState(state) {
  if (!updateWindow || updateWindow.isDestroyed()) {
    return;
  }

  const payload = JSON.stringify(state || {});
  updateWindow.webContents
    .executeJavaScript(`window.__setUpdateState(${payload});`, true)
    .catch(() => {
      // Ignora caso a janela esteja fechando durante a atualizacao.
    });
}

function closeUpdateWindow() {
  if (!updateWindow || updateWindow.isDestroyed()) {
    return;
  }

  updateWindow.close();
  updateWindow = null;
}

async function checkForUpdatesBeforeStart(forceDownload = false) {
  // Atualizacao automatica funciona em app empacotado com release publicado.
  if (!app.isPackaged) {
    return false;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.stageUpdates = true; // Economiza espaço em disco durante updates

  try {
    const currentVersion = app.getVersion();
    const updateCheckResult = await autoUpdater.checkForUpdates();
    const nextVersionRaw = updateCheckResult?.updateInfo?.version;
    const nextVersionParsed = parseTagVersion(nextVersionRaw);

    if (!nextVersionParsed) {
      return false;
    }

    const nextVersion = nextVersionParsed.normalized;

    // Atualiza apenas se a proxima tag/version for superior a atual.
    if (!isRemoteVersionGreater(currentVersion, nextVersion)) {
      return false;
    }

    const onDownloadProgress = (progressObj) => {
      const percent = Number(progressObj?.percent || 0).toFixed(1);
      setUpdateWindowState({
        title: `Atualizando para ${nextVersion}`,
        detail: "Baixando atualizacao. Nao feche o app.",
        progress: `${percent}%`,
      });
    };

    // Na primeira execução, força o download obrigatoriamente
    if (forceDownload) {
      createUpdateWindow();
      setUpdateWindowState({
        title: `Atualizando para ${nextVersion}`,
        detail: "Preparando download da versao completa...",
      });

      autoUpdater.on("download-progress", onDownloadProgress);
      await autoUpdater.downloadUpdate();
      autoUpdater.removeListener("download-progress", onDownloadProgress);
      markFirstRunDone();

      setUpdateWindowState({
        title: "Atualizacao pronta",
        detail: "Reiniciando o app para concluir a instalacao...",
        progress: "100%",
      });

      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
      return true;
    }

    // Em execuções normais, permite usuário escolher
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Sim, atualizar", "Nao, continuar"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: "Atualizacao disponivel",
      message: `Nova versao disponivel: ${nextVersion}`,
      detail: "Deseja atualizar agora antes de abrir o app?",
    });

    if (response !== 0) {
      return false;
    }

    createUpdateWindow();
    setUpdateWindowState({
      title: `Atualizando para ${nextVersion}`,
      detail: "Baixando atualizacao. Nao feche o app.",
    });

    autoUpdater.on("download-progress", onDownloadProgress);
    await autoUpdater.downloadUpdate();
    autoUpdater.removeListener("download-progress", onDownloadProgress);

    setUpdateWindowState({
      title: "Atualizacao pronta",
      detail: "Reiniciando o app para concluir a instalacao...",
      progress: "100%",
    });

    isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
    return true;
  } catch (error) {
    console.error("Falha ao verificar/baixar atualizacao:", error);
    autoUpdater.removeAllListeners("download-progress");

    setUpdateWindowState({
      title: "Falha na atualizacao",
      detail:
        "Nao foi possivel atualizar agora. Vamos abrir o app normalmente.",
      progress: "",
    });

    setTimeout(() => {
      closeUpdateWindow();
    }, 1800);

    return false;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

function restoreExistingWindow() {
  // Prioriza a janela principal (oculta na tray), mas faz fallback para
  // qualquer janela ativa caso o setup inicial esteja aberto.
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }

  const windows = BrowserWindow.getAllWindows();
  const visibleWindow = windows.find((win) => !win.isDestroyed()) || null;

  if (!visibleWindow) {
    return;
  }

  if (visibleWindow.isMinimized()) {
    visibleWindow.restore();
  }

  visibleWindow.show();
  visibleWindow.focus();
}

function createTray() {
  if (tray) {
    return;
  }

  const iconPath = path.join(__dirname, "..", "..", "icon.png");
  tray = new Tray(iconPath);
  tray.setToolTip("SucatasBot");

  tray.on("double-click", () => {
    showMainWindow();
  });

  tray.on("click", () => {
    showMainWindow();
  });

  const trayMenu = Menu.buildFromTemplate([
    {
      label: "Abrir",
      click: () => {
        showMainWindow();
      },
    },
    // {
    //   label: "Lançar Teste de Carta",
    //   click: () => {
    //     showMainWindow();
    //   },
    // },
    {
      label: "Sair",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(trayMenu);
}

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
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    icon: path.join(__dirname, "..", "..", "icon.png"),
  });

  mainWindow.setTitle("Sucatas Bot");
  mainWindow.loadURL("http://localhost:49382/controlPanel.html");

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });

  createTray();
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    restoreExistingWindow();
  });

  app.whenReady().then(() => {
    checkForUpdatesBeforeStart(isFirstRun()).then((isInstallingUpdate) => {
      if (isInstallingUpdate) {
        return;
      }

      createPreloadFile();
      const preloadPath = path.join(__dirname, "preload.js");

      const hasClientCredentials = hasClientCredentialsInCache();

      const setupEnvHandler = () => {
        ipcMain.handle("save-config", async (event, data) => {
          if (!data || !data.clientId || !data.clientSecret) {
            return { success: false, message: "Dados invalidos" };
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
            app.relaunch();
            app.exit(0);
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
        // Credenciais ja existem no cache
        loadServer();
        setTimeout(createWindowsAfterSetup, 1000);
      }
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  // teste new version

  app.on("activate", () => {
    restoreExistingWindow();
  });
}
