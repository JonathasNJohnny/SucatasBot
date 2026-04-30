const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  dialog,
  shell,
  globalShortcut,
} = require("electron");
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

// importa seu servidor (será recarregado após configurar)
let serverModule = null;
let mainWindow = null;
let tray = null;
let updateWindow = null;
let isQuitting = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const CLIP_SHORTCUTS_FILE = "clip-shortcuts.json";
const DEFAULT_CLIP_SHORTCUTS = {
  clip30: "Control+Alt+1",
  clip60: "Control+Alt+2",
};
let currentClipShortcuts = { ...DEFAULT_CLIP_SHORTCUTS };
let registeredClipAccelerators = [];
let clipShortcutsEnabled = true;

function normalizeShortcutToken(token) {
  const raw = String(token || "").trim();
  if (!raw) {
    return "";
  }

  if (raw === "¹") {
    return "1";
  }
  if (raw === "²") {
    return "2";
  }
  if (raw === "³") {
    return "3";
  }

  const lower = raw.toLowerCase();
  if (lower === "ctrl" || lower === "control") {
    return "Control";
  }
  if (lower === "alt" || lower === "option") {
    return "Alt";
  }
  if (lower === "shift") {
    return "Shift";
  }
  if (
    lower === "meta" ||
    lower === "win" ||
    lower === "windows" ||
    lower === "super"
  ) {
    return "Super";
  }
  if (lower === "cmd" || lower === "command") {
    return "Command";
  }
  if (lower === "cmdorctrl" || lower === "commandorcontrol") {
    return "CommandOrControl";
  }
  if (raw.length === 1) {
    return raw.toUpperCase();
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

function normalizeAccelerator(value, fallback) {
  const raw = String(value || "").trim();
  const fallbackRaw = String(fallback || "").trim();
  const source = raw || fallbackRaw;

  const tokens = source
    .split("+")
    .map((token) => normalizeShortcutToken(token))
    .filter(Boolean);

  if (!tokens.length) {
    return fallbackRaw;
  }

  const key = tokens[tokens.length - 1];
  const modifiers = tokens.slice(0, -1);
  const orderedModifiers = [
    "Control",
    "Alt",
    "Shift",
    "Super",
    "Command",
    "CommandOrControl",
  ].filter((modifier) => modifiers.includes(modifier));

  return orderedModifiers.length ? `${orderedModifiers.join("+")}+${key}` : key;
}

function resolveClipShortcuts(shortcuts) {
  const resolved = {
    clip30: normalizeAccelerator(
      shortcuts?.clip30,
      DEFAULT_CLIP_SHORTCUTS.clip30,
    ),
    clip60: normalizeAccelerator(
      shortcuts?.clip60,
      DEFAULT_CLIP_SHORTCUTS.clip60,
    ),
  };

  if (resolved.clip30 === resolved.clip60) {
    throw new Error("Os atalhos de 30s e 60s precisam ser diferentes.");
  }

  return resolved;
}

function getClipShortcutsFilePath() {
  return path.join(app.getPath("userData"), CLIP_SHORTCUTS_FILE);
}

function loadClipShortcutsFromDisk() {
  const shortcutsPath = getClipShortcutsFilePath();
  if (!fs.existsSync(shortcutsPath)) {
    return { ...DEFAULT_CLIP_SHORTCUTS };
  }

  try {
    const raw = fs.readFileSync(shortcutsPath, "utf8");
    const parsed = JSON.parse(raw);
    return resolveClipShortcuts(parsed);
  } catch (err) {
    console.error("Falha ao carregar atalhos de clipe:", err);
    return { ...DEFAULT_CLIP_SHORTCUTS };
  }
}

function saveClipShortcutsToDisk(shortcuts) {
  const shortcutsPath = getClipShortcutsFilePath();
  fs.writeFileSync(shortcutsPath, JSON.stringify(shortcuts, null, 2), "utf8");
}

function unregisterClipShortcuts() {
  for (const accelerator of registeredClipAccelerators) {
    globalShortcut.unregister(accelerator);
  }
  registeredClipAccelerators = [];
}

async function triggerClipFromShortcut(duration) {
  const payload = {
    duration,
    title: `Clipe ${duration}s`,
  };

  try {
    const response = await fetch("http://localhost:49382/api/twitch/clip", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok === false) {
      const reason = result?.message || `HTTP ${response.status}`;
      console.error(`Falha ao criar clipe via atalho (${duration}s):`, reason);
    }
  } catch (err) {
    console.error(`Erro ao acionar clipe via atalho (${duration}s):`, err);
  }
}

function registerClipShortcuts(shortcuts) {
  unregisterClipShortcuts();

  const failed = [];
  const registrations = [
    { accelerator: shortcuts.clip30, duration: 30 },
    { accelerator: shortcuts.clip60, duration: 60 },
  ];

  for (const entry of registrations) {
    const registered = globalShortcut.register(entry.accelerator, () => {
      if (!clipShortcutsEnabled) {
        return;
      }
      void triggerClipFromShortcut(entry.duration);
    });

    if (registered) {
      registeredClipAccelerators.push(entry.accelerator);
    } else {
      failed.push(entry.accelerator);
    }
  }

  return { failed };
}

function applyClipShortcuts(shortcuts, options = {}) {
  const persist = Boolean(options.persist);
  const resolved = resolveClipShortcuts(shortcuts);
  const registration = registerClipShortcuts(resolved);
  currentClipShortcuts = resolved;

  if (persist) {
    saveClipShortcutsToDisk(resolved);
  }

  return {
    shortcuts: resolved,
    failed: registration.failed,
  };
}

function setClipShortcutsEnabled(value) {
  clipShortcutsEnabled = Boolean(value);
  return {
    ok: true,
    enabled: clipShortcutsEnabled,
  };
}

function setupClipShortcutsIpcHandlers() {
  ipcMain.handle("get-clip-shortcuts", async () => {
    return {
      ok: true,
      shortcuts: currentClipShortcuts,
    };
  });

  ipcMain.handle("save-clip-shortcuts", async (event, shortcuts) => {
    try {
      const result = applyClipShortcuts(shortcuts, { persist: true });
      return {
        ok: true,
        shortcuts: result.shortcuts,
        failed: result.failed,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Falha ao salvar atalhos",
        shortcuts: currentClipShortcuts,
      };
    }
  });

  ipcMain.handle("set-clip-shortcuts-enabled", async (event, enabled) => {
    return setClipShortcutsEnabled(enabled);
  });
}

function initializeClipShortcuts() {
  const diskShortcuts = loadClipShortcutsFromDisk();
  const result = applyClipShortcuts(diskShortcuts, { persist: false });

  if (result.failed.length) {
    console.warn("Atalhos globais nao registrados:", result.failed.join(", "));
  }
}

// ===== PORTABLE VERSION MANAGEMENT =====
function isPortableVersion() {
  // Detecta se é versão portable verificando o caminho de execução
  // Se está em Program Files ou AppData\Local\Programs, é instalado (NSIS)
  const exePath = app.getPath("exe").toLowerCase();
  const programFiles = process.env.ProgramFiles?.toLowerCase() || "";
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.toLowerCase() || "";
  const appData = path
    .join(process.env.APPDATA || "", "Local", "Programs")
    .toLowerCase();

  return (
    !exePath.startsWith(programFiles) &&
    !exePath.startsWith(programFilesX86) &&
    !exePath.startsWith(appData)
  );
}

function getPortableVersionsDir() {
  return path.join(app.getPath("userData"), "portable-versions");
}

function ensurePortableVersionsDir() {
  const portableDir = getPortableVersionsDir();
  if (!fs.existsSync(portableDir)) {
    fs.mkdirSync(portableDir, { recursive: true });
  }
}

function getLatestPortableVersion() {
  try {
    ensurePortableVersionsDir();
    const portableDir = getPortableVersionsDir();
    const files = fs.readdirSync(portableDir);

    const portableFiles = files
      .filter((f) => f.endsWith(".exe"))
      .map((f) => {
        const match = f.match(/Sucatas-Bot-Portable-(\d+\.\d+\.\d+)\.exe/);
        if (!match) return null;
        return {
          file: f,
          version: match[1],
          parsed: parseTagVersion(match[1]),
          path: path.join(portableDir, f),
        };
      })
      .filter((f) => f && f.parsed);

    if (!portableFiles.length) {
      return null;
    }

    portableFiles.sort((a, b) => {
      if (a.parsed.major !== b.parsed.major) {
        return b.parsed.major - a.parsed.major;
      }

      if (a.parsed.minor !== b.parsed.minor) {
        return b.parsed.minor - a.parsed.minor;
      }

      return b.parsed.patch - a.parsed.patch;
    });

    return portableFiles[0];
  } catch (err) {
    console.error("Erro ao procurar versoes portables:", err);
    return null;
  }
}

function getDownloadUrl(version, isPortable) {
  const artifactName = isPortable
    ? `Sucatas-Bot-Portable-${version}.exe`
    : `Sucatas-Bot-Setup-${version}.exe`;

  return `https://github.com/JonathasNJohnny/SucatasBot/releases/download/v${version}/${artifactName}`;
}

function launchPortableVersion(portableExePath) {
  try {
    const { spawn } = require("child_process");
    spawn(portableExePath, [], {
      detached: true,
      stdio: "ignore",
    }).unref();

    // Fecha a versão atual
    isQuitting = true;
    app.quit();
  } catch (err) {
    console.error("Erro ao iniciar versao portable:", err);
  }
}

async function downloadPortableVersion(version) {
  // Download customizado para versão portable
  const downloadUrl = getDownloadUrl(version, true);
  const portableDir = getPortableVersionsDir();
  const fileName = `Sucatas-Bot-Portable-${version}.exe`;
  const filePath = path.join(portableDir, fileName);
  const tempFilePath = `${filePath}.download`;

  try {
    const https = require("https");

    const cleanupPortableVersions = (keepFilePath) => {
      try {
        ensurePortableVersionsDir();
        const portableDir = getPortableVersionsDir();
        const files = fs.readdirSync(portableDir);

        for (const fileName of files) {
          if (!fileName.endsWith(".exe")) {
            continue;
          }

          const currentFilePath = path.join(portableDir, fileName);
          if (currentFilePath === keepFilePath) {
            continue;
          }

          try {
            fs.unlinkSync(currentFilePath);
          } catch (err) {
            console.warn(
              "Nao foi possivel remover portable antiga:",
              currentFilePath,
              err,
            );
          }
        }
      } catch (err) {
        console.warn("Nao foi possivel limpar portables antigas:", err);
      }
    };

    const downloadFile = (url, redirectCount = 0) => {
      return new Promise((resolve, reject) => {
        https
          .get(url, (response) => {
            const statusCode = response.statusCode || 0;

            if (
              [301, 302, 303, 307, 308].includes(statusCode) &&
              response.headers.location
            ) {
              if (redirectCount >= 5) {
                response.resume();
                reject(new Error("Muitos redirecionamentos no download."));
                return;
              }

              const redirectedUrl = new URL(
                response.headers.location,
                url,
              ).toString();
              response.resume();
              resolve(downloadFile(redirectedUrl, redirectCount + 1));
              return;
            }

            if (statusCode !== 200) {
              response.resume();
              reject(
                new Error(`HTTP ${statusCode}: ${response.statusMessage}`),
              );
              return;
            }

            const totalSize = Number(response.headers["content-length"] || 0);
            let downloadedSize = 0;
            const fileStream = fs.createWriteStream(tempFilePath);

            response.on("data", (chunk) => {
              downloadedSize += chunk.length;
              if (totalSize > 0) {
                const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
                setUpdateWindowState({
                  title: `Atualizando para ${version}`,
                  detail: "Baixando atualizacao. Nao feche o app.",
                  progress: `${percent}%`,
                });
              }
            });

            fileStream.on("error", (err) => {
              response.destroy();
              reject(err);
            });

            response.pipe(fileStream);

            fileStream.on("finish", () => {
              fileStream.close((closeErr) => {
                if (closeErr) {
                  reject(closeErr);
                  return;
                }

                resolve(tempFilePath);
              });
            });
          })
          .on("error", reject);
      });
    };

    const downloadedTempFile = await downloadFile(downloadUrl);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    fs.renameSync(downloadedTempFile, filePath);
    cleanupPortableVersions(filePath);
    return filePath;
  } catch (error) {
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {
      // Ignora falha na limpeza do arquivo temporário.
    }

    console.error("Erro ao baixar versao portable:", error);
    throw error;
  }
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

async function checkForUpdatesBeforeStart(forceDownload = false) {
  // Atualizacao automatica funciona em app empacotado com release publicado.
  if (!app.isPackaged) {
    return false;
  }

  const isPortable = isPortableVersion();

  if (!isPortable) {
    // Para versão instalada, usar electron-updater padrão
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.stageUpdates = true;

    let nextVersion = null;

    try {
      const currentVersion = app.getVersion();
      const updateCheckResult = await autoUpdater.checkForUpdates();
      const nextVersionRaw = updateCheckResult?.updateInfo?.version;
      const nextVersionParsed = parseTagVersion(nextVersionRaw);

      if (!nextVersionParsed) {
        return false;
      }

      nextVersion = nextVersionParsed.normalized;

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
      const downloadedFiles = await autoUpdater.downloadUpdate();
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
          "Nao foi possivel atualizar agora. Abrindo o download manual...",
        progress: "",
      });

      setTimeout(() => {
        closeUpdateWindow();
      }, 1800);

      if (nextVersion) {
        const downloadUrl = getDownloadUrl(nextVersion, false);
        await shell.openExternal(downloadUrl);
      }

      return false;
    }
  } else {
    // Para versão portable, usar lógica customizada
    let nextVersion = null;

    try {
      const currentVersion = app.getVersion();

      // Verificar atualizações via GitHub
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.allowPrerelease = false;
      autoUpdater.stageUpdates = true;

      const updateCheckResult = await autoUpdater.checkForUpdates();
      const nextVersionRaw = updateCheckResult?.updateInfo?.version;
      const nextVersionParsed = parseTagVersion(nextVersionRaw);

      if (!nextVersionParsed) {
        return false;
      }

      nextVersion = nextVersionParsed.normalized;

      // Atualiza apenas se a proxima tag/version for superior a atual.
      if (!isRemoteVersionGreater(currentVersion, nextVersion)) {
        return false;
      }

      // Na primeira execução, força o download obrigatoriamente
      if (forceDownload) {
        createUpdateWindow();
        setUpdateWindowState({
          title: `Atualizando para ${nextVersion}`,
          detail: "Preparando download da versao completa...",
        });

        const portableExePath = await downloadPortableVersion(nextVersion);
        markFirstRunDone();

        setUpdateWindowState({
          title: "Atualizacao pronta",
          detail: "Iniciando a nova versao...",
          progress: "100%",
        });

        setTimeout(() => {
          launchPortableVersion(portableExePath);
        }, 500);

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
        detail: "Deseja atualizar agora? A versao sera baixada e iniciada.",
      });

      if (response !== 0) {
        return false;
      }

      createUpdateWindow();
      setUpdateWindowState({
        title: `Atualizando para ${nextVersion}`,
        detail: "Baixando atualizacao. Nao feche o app.",
      });

      const portableExePath = await downloadPortableVersion(nextVersion);

      setUpdateWindowState({
        title: "Atualizacao pronta",
        detail: "Iniciando a nova versao...",
        progress: "100%",
      });

      setTimeout(() => {
        launchPortableVersion(portableExePath);
      }, 500);

      return true;
    } catch (error) {
      console.error("Falha ao verificar/baixar atualizacao (portable):", error);
      autoUpdater.removeAllListeners("download-progress");

      setUpdateWindowState({
        title: "Falha na atualizacao",
        detail:
          "Nao foi possivel atualizar agora. Abrindo o download manual...",
        progress: "",
      });

      setTimeout(() => {
        closeUpdateWindow();
      }, 1800);

      if (nextVersion) {
        const downloadUrl = getDownloadUrl(nextVersion, true);
        await shell.openExternal(downloadUrl);
      }

      return false;
    }
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
  getClipShortcuts: () => ipcRenderer.invoke('get-clip-shortcuts'),
  saveClipShortcuts: (shortcuts) => ipcRenderer.invoke('save-clip-shortcuts', shortcuts),
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
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
    // Para versão portable, verificar se há uma versão mais nova armazenada
    if (isPortableVersion()) {
      const currentVersion = app.getVersion();
      const latestPortable = getLatestPortableVersion();

      if (
        latestPortable &&
        isRemoteVersionGreater(currentVersion, latestPortable.version)
      ) {
        // Inicia a versão mais nova e fecha a atual
        launchPortableVersion(latestPortable.path);
        return;
      }
    }

    checkForUpdatesBeforeStart(isFirstRun()).then((isInstallingUpdate) => {
      if (isInstallingUpdate) {
        return;
      }

      createPreloadFile();
      const preloadPath = path.join(__dirname, "preload.js");
      setupClipShortcutsIpcHandlers();
      initializeClipShortcuts();

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
    unregisterClipShortcuts();
    globalShortcut.unregisterAll();
  });

  // teste new version

  app.on("activate", () => {
    restoreExistingWindow();
  });
}
