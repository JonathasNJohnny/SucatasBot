const { BrowserWindow } = require("electron");

function createSetupWindow(preloadPath) {
  const setupWindow = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: {
      preload: preloadPath,
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
        <h1>Configuracao Inicial</h1>
        <p class="subtitle">NAO MOSTRE ISSO PARA NINGUEM</p>

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

          <button type="submit">Salvar Configuracao</button>
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

module.exports = {
  createSetupWindow,
};
