import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const localFiles = new Map<string, string>();
const tempMediaCaches = new Map<string, string>();

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 1040,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required"
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

function inferMimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".ogg":
    case ".ogv":
      return "video/ogg";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.syncplay.desktop");

  ipcMain.handle("syncplay:open-desktop-window", async () => {
    createWindow();
  });

  ipcMain.handle("syncplay:pick-local-file", async () => {
    const activeWindow = BrowserWindow.getFocusedWindow();
    const dialogOptions: OpenDialogOptions = {
      properties: ["openFile"],
      filters: [
        {
          name: "Video files",
          extensions: ["mp4", "webm", "ogg", "ogv", "mov"]
        }
      ]
    };
    const result = activeWindow ? await dialog.showOpenDialog(activeWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const stats = await fs.stat(filePath);
    const fileId = crypto.randomUUID();
    localFiles.set(fileId, filePath);

    return {
      type: "local_file",
      mediaId: crypto.randomUUID(),
      fileId,
      fileName: path.basename(filePath),
      fileSize: stats.size,
      mimeType: inferMimeType(filePath)
    };
  });

  ipcMain.handle("syncplay:read-local-file", async (_, fileId: string) => {
    const filePath = localFiles.get(fileId);

    if (!filePath) {
      throw new Error("Local file handle not found.");
    }

    return new Uint8Array(await fs.readFile(filePath));
  });

  ipcMain.handle("syncplay:read-local-file-chunk", async (_, fileId: string, offset: number, length: number) => {
    const filePath = localFiles.get(fileId);

    if (!filePath) {
      throw new Error("Local file handle not found.");
    }

    const handle = await fs.open(filePath, "r");

    try {
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  });

  ipcMain.handle("syncplay:create-temp-media-cache", async (_, mediaId: string) => {
    const cacheId = crypto.randomUUID();
    const tempDir = path.join(os.tmpdir(), "syncplay-media-cache");
    await fs.mkdir(tempDir, { recursive: true });
    const cachePath = path.join(tempDir, `${mediaId}-${cacheId}.bin`);
    await fs.writeFile(cachePath, new Uint8Array());
    tempMediaCaches.set(cacheId, cachePath);
    return cacheId;
  });

  ipcMain.handle("syncplay:write-temp-media-chunk", async (_, cacheId: string, offset: number, bytes: Uint8Array) => {
    const cachePath = tempMediaCaches.get(cacheId);

    if (!cachePath) {
      throw new Error("Temporary media cache not found.");
    }

    const handle = await fs.open(cachePath, "r+");

    try {
      const buffer = Buffer.from(bytes);
      await handle.write(buffer, 0, buffer.length, offset);
    } finally {
      await handle.close();
    }
  });

  ipcMain.handle("syncplay:remove-temp-media-cache", async (_, cacheId: string) => {
    const cachePath = tempMediaCaches.get(cacheId);

    if (!cachePath) {
      return;
    }

    tempMediaCaches.delete(cacheId);
    await fs.rm(cachePath, { force: true });
  });

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
