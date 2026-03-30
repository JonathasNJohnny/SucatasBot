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

    // Na primeira execução, força o download obrigatoriamente
    if (forceDownload) {
      await dialog.showMessageBox({
        type: "info",
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
        title: "Baixando versão completa",
        message: `Preparando a versão ${nextVersion}...`,
        detail: "Isso pode levar alguns minutos.",
      });

      await autoUpdater.downloadUpdate();
      markFirstRunDone();

      await dialog.showMessageBox({
        type: "info",
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
        title: "Setup concluído",
        message: "Versão pronta para usar.",
        detail: "O app será reiniciado agora.",
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

    await autoUpdater.downloadUpdate();

    await dialog.showMessageBox({
      type: "info",
      buttons: ["OK"],
      defaultId: 0,
      noLink: true,
      title: "Atualizacao pronta",
      message: "Atualizacao baixada com sucesso.",
      detail: "O app sera reiniciado para concluir a instalacao.",
    });

    isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
    return true;
  } catch (error) {
    console.error("Falha ao verificar/baixar atualizacao:", error);
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

  mainWindow.setTitle("Lizah Gacha");
  mainWindow.loadURL("http://localhost:49382/twitchControl.html");

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
        // Credenciais ja existem no cache
        loadServer();
        setTimeout(createWindowsAfterSetup, 1000);
      }
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("activate", () => {
    restoreExistingWindow();
  });
}
