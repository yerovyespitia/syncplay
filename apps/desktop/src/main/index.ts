import { app, BrowserWindow, shell } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import path from "node:path";

const rendererUrl = process.env.ELECTRON_RENDERER_URL;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 1040,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.syncplay.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
