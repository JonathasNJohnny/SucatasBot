const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

// Usar caminho persistente no AppData para funcionar tanto em dev quanto no build Electron
const AUTH_CACHE_DIR = path.join(
  process.env.APPDATA || path.join(process.env.HOME || "", ".config"),
  "SucatasBot",
);
const AUTH_CACHE_FILE = path.join(AUTH_CACHE_DIR, "twitch-auth.json");

// importa seu servidor (será recarregado após configurar)
let serverModule = null;

function loadServer() {
  if (serverModule) {
    delete require.cache[require.resolve("./server.js")];
  }
  serverModule = require("./server.js");
}

function ensureAuthCacheDir() {
  if (!fs.existsSync(AUTH_CACHE_DIR)) {
    fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true });
  }
}

function loadCachedConfig() {
  try {
    if (!fs.existsSync(AUTH_CACHE_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(AUTH_CACHE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function hasClientCredentialsInCache() {
  const cached = loadCachedConfig();
  return Boolean(
    String(cached.clientId || "").trim() &&
    String(cached.clientSecret || "").trim(),
  );
}

function createSetupWindow() {
  const setupWindow = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const setupHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          padding: 20px;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 12px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          width: 100%;
          max-width: 400px;
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
          font-size: 24px;
        }
        .subtitle {
          color: #666;
          font-size: 14px;
          margin-bottom: 30px;
        }
        .form-group {
          margin-bottom: 20px;
        }
        label {
          display: block;
          color: #333;
          font-weight: 600;
          margin-bottom: 8px;
          font-size: 13px;
        }
        input {
          width: 100%;
          padding: 12px;
          border: 1px solid #ddd;
          border-radius: 6px;
          font-size: 14px;
          transition: border-color 0.2s;
        }
        input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        button {
          width: 100%;
          padding: 12px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 6px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.2s;
          margin-top: 10px;
        }
        button:hover {
          background: #5568d3;
        }
        button:active {
          transform: scale(0.98);
        }
        .error {
          color: #e74c3c;
          font-size: 13px;
          margin-top: 8px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>⚙️ Configuração Inicial</h1>
        <p class="subtitle">NÃO MOSTRE ISSO PARA NINGUÉM</p>
        
        <form id="setupForm">
          <div class="form-group">
            <label for="clientId">Client ID:</label>
            <input 
              type="text" 
              id="clientId" 
              placeholder="Digite seu Client ID"
              required
            />
          </div>

          <div class="form-group">
            <label for="clientSecret">Client Secret:</label>
            <input 
              type="password" 
              id="clientSecret" 
              placeholder="Digite seu Client Secret"
              required
            />
          </div>

          <button type="submit">Salvar Configuração</button>
          <div id="error" class="error"></div>
        </form>
      </div>

      <script>
        const form = document.getElementById('setupForm');
        const errorDiv = document.getElementById('error');

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          
          const clientId = document.getElementById('clientId').value.trim();
          const clientSecret = document.getElementById('clientSecret').value.trim();

          if (!clientId || !clientSecret) {
            errorDiv.textContent = 'Preencha todos os campos!';
            return;
          }

          window.electron.saveConfig({
            clientId,
            clientSecret,
          }).then(() => {
            window.close();
          }).catch((err) => {
            errorDiv.textContent = 'Erro ao salvar: ' + err;
          });
        });
      </script>
    </body>
    </html>
  `;

  setupWindow.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(setupHtml),
  );
  return setupWindow;
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
    icon: path.join(__dirname, "icon.png"),
  });

  twitchControl.setTitle("Lizah Gacha");
  twitchControl.loadURL("http://localhost:49382/twitchControl.html");
}

app.whenReady().then(() => {
  createPreloadFile();

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
    createSetupWindow();
    setupEnvHandler();
  } else {
    // Credenciais já existem no cache
    loadServer();
    setTimeout(createWindowsAfterSetup, 1000);
  }
});
