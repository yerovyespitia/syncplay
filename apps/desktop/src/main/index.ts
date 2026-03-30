import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type OpenDialogOptions } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const localFiles = new Map<string, string>();
const isDevMode = !app.isPackaged || Boolean(rendererUrl);
const TEMP_MEDIA_WAIT_TIMEOUT_MS = 120_000;
const SYNCPLAY_MEDIA_SCHEME = "syncplay-media";

protocol.registerSchemesAsPrivileged([
  {
    scheme: SYNCPLAY_MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);

interface ByteRange {
  startByte: number;
  endByte: number;
}

interface TempMediaWaiter {
  startByte: number;
  endByte: number;
  resolve: (availableEndByte: number) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface MediaCacheSession {
  mediaId: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  availableRanges: ByteRange[];
  waiters: TempMediaWaiter[];
}

const tempMediaCaches = new Map<string, MediaCacheSession>();
let mediaServerBaseUrlPromise: Promise<string> | null = null;

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
      sandbox: false,
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

function mergeRanges(ranges: ByteRange[], incomingRange: ByteRange) {
  const nextRanges = [...ranges, incomingRange].sort((left, right) => left.startByte - right.startByte);
  const merged: ByteRange[] = [];

  for (const range of nextRanges) {
    const lastRange = merged[merged.length - 1];

    if (!lastRange || range.startByte > lastRange.endByte) {
      merged.push({ ...range });
      continue;
    }

    lastRange.endByte = Math.max(lastRange.endByte, range.endByte);
  }

  return merged;
}

function getContiguousEnd(ranges: ByteRange[]) {
  let contiguousEnd = 0;

  for (const range of ranges) {
    if (range.startByte > contiguousEnd) {
      break;
    }

    contiguousEnd = Math.max(contiguousEnd, range.endByte);
  }

  return contiguousEnd;
}

function getContiguousAvailableEnd(ranges: ByteRange[], startByte: number, requestedEndByte: number) {
  for (const range of ranges) {
    if (startByte < range.startByte) {
      return startByte;
    }

    if (startByte >= range.startByte && startByte < range.endByte) {
      return Math.min(range.endByte, requestedEndByte);
    }
  }

  return startByte;
}

function parseByteRange(rangeHeader: string | null, fileSize: number) {
  if (fileSize <= 0) {
    return null;
  }

  const match = /^bytes=(\d+)-(\d*)$/i.exec((rangeHeader ?? "").trim());

  if (!match) {
    return null;
  }

  const startByte = Number(match[1]);
  const inclusiveEnd = match[2] ? Number(match[2]) : fileSize - 1;

  if (!Number.isFinite(startByte) || !Number.isFinite(inclusiveEnd) || startByte < 0 || startByte >= fileSize) {
    return null;
  }

  const endByte = Math.min(fileSize, inclusiveEnd + 1);

  if (endByte <= startByte) {
    return null;
  }

  return {
    startByte,
    endByte
  };
}

function getMediaCacheIdFromPathname(pathname: string | undefined) {
  if (!pathname) {
    return null;
  }

  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] !== "cache" || !segments[1]) {
    return null;
  }

  return decodeURIComponent(segments[1]);
}

async function readMediaRange(filePath: string, startByte: number, endByte: number) {
  const byteLength = Math.max(0, endByte - startByte);
  const handle = await fs.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, startByte);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function resolveWaiters(session: MediaCacheSession) {
  const stillWaiting: TempMediaWaiter[] = [];

  for (const waiter of session.waiters) {
    const availableEndByte = getContiguousAvailableEnd(session.availableRanges, waiter.startByte, waiter.endByte);

    if (availableEndByte > waiter.startByte) {
      clearTimeout(waiter.timeout);
      waiter.resolve(availableEndByte);
      continue;
    }

    stillWaiting.push(waiter);
  }

  session.waiters = stillWaiting;
}

function waitForRangeAvailability(session: MediaCacheSession, startByte: number, endByte: number, timeoutMs = TEMP_MEDIA_WAIT_TIMEOUT_MS) {
  const availableEndByte = getContiguousAvailableEnd(session.availableRanges, startByte, endByte);

  if (availableEndByte > startByte) {
    return Promise.resolve(availableEndByte);
  }

  return new Promise<number>((resolve, reject) => {
    const waiter: TempMediaWaiter = {
      startByte,
      endByte,
      resolve,
      reject,
      timeout: setTimeout(() => {
        session.waiters = session.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error("Timed out waiting for media range."));
      }, timeoutMs)
    };

    session.waiters.push(waiter);
  });
}

function destroyMediaCache(cacheId: string) {
  const session = tempMediaCaches.get(cacheId);

  if (!session) {
    return null;
  }

  tempMediaCaches.delete(cacheId);

  for (const waiter of session.waiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error("Media cache removed."));
  }

  session.waiters = [];
  return session;
}

function writeErrorResponse(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(message),
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end(message);
}

function writeMediaHeaders(
  response: ServerResponse,
  session: MediaCacheSession,
  status: number,
  contentLength: number,
  contentRange?: string
) {
  response.writeHead(status, {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(contentLength),
    "Content-Type": session.mimeType,
    ...(contentRange ? { "Content-Range": contentRange } : {})
  });
}

async function streamMediaBytes(
  response: ServerResponse,
  session: MediaCacheSession,
  startByte: number,
  endByte: number,
  timeoutMs = TEMP_MEDIA_WAIT_TIMEOUT_MS
) {
  const deadline = Date.now() + timeoutMs;
  let offset = startByte;

  while (offset < endByte) {
    const availableEndByte = getContiguousAvailableEnd(session.availableRanges, offset, endByte);

    if (availableEndByte > offset) {
      const bytes = await readMediaRange(session.filePath, offset, availableEndByte);

      if (bytes.byteLength === 0) {
        throw new Error("Media stream read returned zero bytes.");
      }

      const shouldContinue = response.write(bytes);
      offset = availableEndByte;

      if (!shouldContinue) {
        await new Promise<void>((resolve) => {
          response.once("drain", resolve);
        });
      }

      continue;
    }

    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      throw new Error("Timed out waiting for media bytes.");
    }

    await waitForRangeAvailability(session, offset, endByte, remainingMs);
  }
}

async function handleMediaServerRequest(request: IncomingMessage, response: ServerResponse) {
  const requestUrl = request.url ? new URL(request.url, "http://127.0.0.1") : null;
  const cacheId = getMediaCacheIdFromPathname(requestUrl?.pathname);

  if (!cacheId) {
    writeErrorResponse(response, 404, "Media cache not found.");
    return;
  }

  const session = tempMediaCaches.get(cacheId);

  if (!session) {
    writeErrorResponse(response, 404, "Media cache not found.");
    return;
  }

  const method = (request.method ?? "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    writeErrorResponse(response, 405, "Method not allowed.");
    return;
  }

  const rangeHeader = typeof request.headers.range === "string" ? request.headers.range : null;

  if (!rangeHeader) {
    if (method === "HEAD") {
      writeMediaHeaders(response, session, 200, session.fileSize);
      response.end();
      return;
    }

    writeMediaHeaders(response, session, 200, session.fileSize);

    try {
      await streamMediaBytes(response, session, 0, session.fileSize);
      response.end();
    } catch {
      if (!response.headersSent) {
        writeErrorResponse(response, 503, "Requested media file is not available yet.");
        return;
      }

      response.destroy();
    }
    return;
  }

  const requestedRange = parseByteRange(rangeHeader, session.fileSize);

  if (!requestedRange) {
    writeErrorResponse(response, 416, "Invalid byte range.");
    return;
  }

  const contentLength = Math.max(0, requestedRange.endByte - requestedRange.startByte);
  const inclusiveEndByte = requestedRange.endByte - 1;

  if (method === "HEAD") {
    writeMediaHeaders(
      response,
      session,
      206,
      contentLength,
      `bytes ${requestedRange.startByte}-${inclusiveEndByte}/${session.fileSize}`
    );
    response.end();
    return;
  }

  writeMediaHeaders(
    response,
    session,
    206,
    contentLength,
    `bytes ${requestedRange.startByte}-${inclusiveEndByte}/${session.fileSize}`
  );

  try {
    await streamMediaBytes(response, session, requestedRange.startByte, requestedRange.endByte);
    response.end();
  } catch {
    response.destroy();
  }
}

async function buildMediaProtocolResponse(request: Request) {
  const requestUrl = new URL(request.url);
  const cacheId = getMediaCacheIdFromPathname(requestUrl.pathname);

  if (!cacheId) {
    return new Response("Media cache not found.", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  const session = tempMediaCaches.get(cacheId);

  if (!session) {
    return new Response("Media cache not found.", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  const method = (request.method || "GET").toUpperCase();

  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  const rangeHeader = request.headers.get("range");
  const commonHeaders = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": session.mimeType
  });

  if (!rangeHeader) {
    commonHeaders.set("Content-Length", String(session.fileSize));

    if (method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: commonHeaders
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let offset = 0;

          while (offset < session.fileSize) {
            const availableEndByte = getContiguousAvailableEnd(session.availableRanges, offset, session.fileSize);

            if (availableEndByte > offset) {
              const bytes = await readMediaRange(session.filePath, offset, availableEndByte);

              if (bytes.byteLength === 0) {
                throw new Error("Media stream read returned zero bytes.");
              }

              controller.enqueue(new Uint8Array(bytes));
              offset = availableEndByte;
              continue;
            }

            const remainingMs = TEMP_MEDIA_WAIT_TIMEOUT_MS;
            await waitForRangeAvailability(session, offset, session.fileSize, remainingMs);
          }

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: commonHeaders
    });
  }

  const requestedRange = parseByteRange(rangeHeader, session.fileSize);

  if (!requestedRange) {
    return new Response("Invalid byte range.", {
      status: 416,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }

  const contentLength = Math.max(0, requestedRange.endByte - requestedRange.startByte);
  const inclusiveEndByte = requestedRange.endByte - 1;
  commonHeaders.set("Content-Length", String(contentLength));
  commonHeaders.set("Content-Range", `bytes ${requestedRange.startByte}-${inclusiveEndByte}/${session.fileSize}`);

  if (method === "HEAD") {
    return new Response(null, {
      status: 206,
      headers: commonHeaders
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let offset = requestedRange.startByte;
        const deadline = Date.now() + TEMP_MEDIA_WAIT_TIMEOUT_MS;

        while (offset < requestedRange.endByte) {
          const availableEndByte = getContiguousAvailableEnd(session.availableRanges, offset, requestedRange.endByte);

          if (availableEndByte > offset) {
            const bytes = await readMediaRange(session.filePath, offset, availableEndByte);

            if (bytes.byteLength === 0) {
              throw new Error("Media stream read returned zero bytes.");
            }

            controller.enqueue(new Uint8Array(bytes));
            offset = availableEndByte;
            continue;
          }

          const remainingMs = deadline - Date.now();

          if (remainingMs <= 0) {
            throw new Error("Timed out waiting for media bytes.");
          }

          await waitForRangeAvailability(session, offset, requestedRange.endByte, remainingMs);
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    status: 206,
    headers: commonHeaders
  });
}

function startMediaServer() {
  if (mediaServerBaseUrlPromise) {
    return mediaServerBaseUrlPromise;
  }

  mediaServerBaseUrlPromise = new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      void handleMediaServerRequest(request, response).catch((error: unknown) => {
        console.error("[syncplay:media-server] request failed", error);
        if (!response.headersSent) {
          writeErrorResponse(response, 500, "Internal media server error.");
          return;
        }

        response.destroy();
      });
    });

    server.on("error", (error) => {
      reject(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;

      if (!address) {
        reject(new Error("Media server address unavailable."));
        return;
      }

      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return mediaServerBaseUrlPromise;
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.syncplay.desktop");
  void startMediaServer();
  protocol.handle(SYNCPLAY_MEDIA_SCHEME, (request) => buildMediaProtocolResponse(request));

  ipcMain.handle("syncplay:open-desktop-window", async () => {
    if (!isDevMode) {
      return;
    }

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

  ipcMain.handle(
    "syncplay:create-temp-media-cache",
    async (_, mediaId: string, metadata: { fileSize: number; mimeType: string; fileName: string }) => {
      const cacheId = crypto.randomUUID();
      const tempDir = path.join(os.tmpdir(), "syncplay-media-cache");
      await fs.mkdir(tempDir, { recursive: true });
      const cachePath = path.join(tempDir, `${mediaId}-${cacheId}.bin`);
      await fs.writeFile(cachePath, new Uint8Array());
      const mediaServerBaseUrl = await startMediaServer();
      const encodedFileName = encodeURIComponent(metadata.fileName || `${mediaId}.bin`);
      const httpUrl = `${mediaServerBaseUrl}/cache/${encodeURIComponent(cacheId)}/${encodedFileName}`;
      const fileUrl = pathToFileURL(cachePath).toString();
      const protocolUrl = `${SYNCPLAY_MEDIA_SCHEME}://cache/${encodeURIComponent(cacheId)}/${encodedFileName}`;

      tempMediaCaches.set(cacheId, {
        mediaId,
        fileName: metadata.fileName,
        filePath: cachePath,
        mimeType: metadata.mimeType,
        fileSize: metadata.fileSize,
        availableRanges: [],
        waiters: []
      });

      return {
        cacheId,
        mediaUrl: protocolUrl,
        fileUrl,
        httpUrl
      };
    }
  );

  ipcMain.handle("syncplay:write-temp-media-chunk", async (_, cacheId: string, offset: number, bytes: Uint8Array) => {
    const session = tempMediaCaches.get(cacheId);

    if (!session) {
      throw new Error("Temporary media cache not found.");
    }

    const handle = await fs.open(session.filePath, "r+");

    try {
      const buffer = Buffer.from(bytes);
      await handle.write(buffer, 0, buffer.length, offset);
    } finally {
      await handle.close();
    }
  });

  ipcMain.handle("syncplay:mark-temp-media-range-available", async (_, cacheId: string, startByte: number, endByte: number) => {
    const session = tempMediaCaches.get(cacheId);

    if (!session) {
      throw new Error("Temporary media cache not found.");
    }

    session.availableRanges = mergeRanges(session.availableRanges, { startByte, endByte });
    resolveWaiters(session);
  });

  ipcMain.handle(
    "syncplay:wait-for-temp-media-range",
    async (_, cacheId: string, startByte: number, endByte: number, timeoutMs?: number) => {
      const session = tempMediaCaches.get(cacheId);

      if (!session) {
        throw new Error("Temporary media cache not found.");
      }

      const availableEndByte = await waitForRangeAvailability(session, startByte, endByte, timeoutMs);
      return { availableEndByte };
    }
  );

  ipcMain.handle("syncplay:get-temp-media-status", async (_, cacheId: string) => {
    const session = tempMediaCaches.get(cacheId);

    if (!session) {
      throw new Error("Temporary media cache not found.");
    }

    return {
      availableRanges: session.availableRanges,
      contiguousBytes: getContiguousEnd(session.availableRanges)
    };
  });

  ipcMain.handle("syncplay:remove-temp-media-cache", async (_, cacheId: string) => {
    const session = destroyMediaCache(cacheId);

    if (!session) {
      return;
    }

    await fs.rm(session.filePath, { force: true });
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
