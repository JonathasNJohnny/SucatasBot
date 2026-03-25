const { app, BrowserWindow } = require("electron");
const path = require("path");

// importa seu servidor
require("./server.js"); // <-- seu arquivo atual

function createWindows() {
  // janela de controle
  const control = new BrowserWindow({
    width: 900,
    height: 700,
  });

  control.loadURL("http://localhost:49382/control.html");
}

app.whenReady().then(() => {
  setTimeout(createWindows, 1000); // espera servidor subir
});
