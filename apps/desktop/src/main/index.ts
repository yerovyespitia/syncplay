import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell, type OpenDialogOptions } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PickedLocalFile, TorrentMediaFile, TorrentSessionSummary } from "@syncplay/shared";
import type * as WebTorrentNamespace from "webtorrent";

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const localFiles = new Map<string, LocalMediaHandle>();
const isDevMode = !app.isPackaged || Boolean(rendererUrl);
const TEMP_MEDIA_WAIT_TIMEOUT_MS = 120_000;
const SYNCPLAY_MEDIA_SCHEME = "syncplay-media";
const STREAM_CHUNK_SIZE = 1024 * 1024;
const TORRENT_RESOLVE_TIMEOUT_MS = 90_000;
const TORRENT_DOWNLOAD_ROOT = path.join(os.tmpdir(), "syncplay-torrents");
const DEFAULT_TORRENT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.files.fm:7073/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
];

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

interface LocalMediaHandle {
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  readRange: (startByte: number, endByte: number) => Promise<Uint8Array>;
}

interface MediaCacheSession {
  mediaId: string;
  fileName: string;
  filePath: string;
  localFileId: string;
  mimeType: string;
  fileSize: number;
  availableRanges: ByteRange[];
  waiters: TempMediaWaiter[];
}

interface TorrentSession {
  sessionId: string;
  mediaId: string;
  magnetUri: string;
  infoHash: string;
  downloadPath: string;
  torrent: WebTorrentNamespace.Torrent;
  files: TorrentMediaFile[];
  selectedFileIndex?: number;
  selectedFileId?: string;
  failureMessage?: string;
}

const tempMediaCaches = new Map<string, MediaCacheSession>();
const torrentSessions = new Map<string, TorrentSession>();
let mediaServerBaseUrlPromise: Promise<string> | null = null;
let torrentClient: WebTorrentNamespace.Instance | null = null;
let webTorrentModulePromise: Promise<any> | null = null;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function resolveWindowIconPath() {
  return process.platform === "win32"
    ? path.resolve(__dirname, "../../resources/icon.ico")
    : path.resolve(__dirname, "../../resources/icon.png");
}

function resolveMacAppIconPath() {
  return path.resolve(__dirname, "../../resources/icon.png");
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 1040,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0a0a0b",
    icon: resolveWindowIconPath(),
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
    case ".m4v":
      return "video/x-m4v";
    case ".mkv":
      return "video/x-matroska";
    case ".avi":
      return "video/x-msvideo";
    case ".ts":
      return "video/mp2t";
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

function createFileHandle(filePath: string, fileSize: number, mimeType = inferMimeType(filePath)): LocalMediaHandle {
  return {
    fileName: path.basename(filePath),
    fileSize,
    mimeType,
    fileUrl: pathToFileURL(filePath).toString(),
    readRange: (startByte: number, endByte: number) => readMediaRange(filePath, startByte, endByte)
  };
}

async function readTorrentFileRange(file: WebTorrentNamespace.TorrentFile, startByte: number, endByte: number) {
  if (endByte <= startByte) {
    return new Uint8Array();
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = file.createReadStream({
      start: startByte,
      end: endByte - 1
    });

    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    stream.on("error", reject);
  });
}

async function loadWebTorrentModule(): Promise<any> {
  if (!webTorrentModulePromise) {
    webTorrentModulePromise = import("webtorrent");
  }

  return webTorrentModulePromise;
}

async function getTorrentClient() {
  if (torrentClient) {
    return torrentClient;
  }

  try {
    const webTorrentModule = await loadWebTorrentModule();
    const WebTorrentCtor = (webTorrentModule?.default ?? webTorrentModule) as WebTorrentNamespace.WebTorrent;
    torrentClient = new WebTorrentCtor();
    return torrentClient;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Torrent playback is unavailable on this machine: ${message}`);
  }
}

function isVideoTorrentFile(file: WebTorrentNamespace.TorrentFile) {
  return inferMimeType(file.name).startsWith("video/");
}

function buildTorrentFiles(torrent: WebTorrentNamespace.Torrent): TorrentMediaFile[] {
  return torrent.files
    .map((file: WebTorrentNamespace.TorrentFile, index: number) => ({
      index,
      name: file.name,
      path: file.path,
      size: file.length,
      mimeType: inferMimeType(file.name)
    }))
    .filter((file: TorrentMediaFile) => file.mimeType.startsWith("video/"));
}

function resolveTorrentPhase(session: TorrentSession): TorrentSessionSummary["phase"] {
  if (session.failureMessage) {
    return "failed";
  }

  if (!session.files.length) {
    return "resolving_metadata";
  }

  if (session.selectedFileIndex === undefined) {
    return "selecting_file";
  }

  return session.torrent.progress >= 1 ? "ready" : "downloading";
}

function buildTorrentSessionSummary(session: TorrentSession): TorrentSessionSummary {
  const selectedFile = session.files.find((file) => file.index === session.selectedFileIndex);
  const totalBytes = selectedFile?.size ?? session.torrent.length ?? 0;
  const downloadedBytes = Math.min(session.torrent.downloaded ?? 0, totalBytes || (session.torrent.downloaded ?? 0));

  return {
    sessionId: session.sessionId,
    magnetUri: session.magnetUri,
    infoHash: session.infoHash,
    displayName: session.torrent.name || session.infoHash,
    phase: resolveTorrentPhase(session),
    files: session.files,
    selectedFileIndex: session.selectedFileIndex,
    progress: totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 0,
    downloadedBytes,
    totalBytes,
    downloadSpeed: session.torrent.downloadSpeed ?? 0,
    uploadSpeed: session.torrent.uploadSpeed ?? 0,
    peerCount: session.torrent.numPeers ?? 0,
    message: session.failureMessage
  };
}

function mergeTorrentTrackers(magnetUri: string) {
  const magnetUrl = new URL(magnetUri);
  const trackers = new Set(DEFAULT_TORRENT_TRACKERS);

  for (const tracker of magnetUrl.searchParams.getAll("tr")) {
    if (tracker) {
      trackers.add(tracker);
    }
  }

  return Array.from(trackers);
}

async function resolveTorrentMetadata(magnetUri: string) {
  const sessionId = crypto.randomUUID();
  const downloadPath = path.join(TORRENT_DOWNLOAD_ROOT, sessionId);
  await fs.mkdir(downloadPath, { recursive: true });
  const torrentClient = await getTorrentClient();
  const torrent = torrentClient.add(magnetUri, {
    announce: mergeTorrentTrackers(magnetUri),
    path: downloadPath,
    destroyStoreOnDestroy: true
  });
  const session: TorrentSession = {
    sessionId,
    mediaId: crypto.randomUUID(),
    magnetUri,
    infoHash: "",
    downloadPath,
    torrent,
    files: []
  };
  torrentSessions.set(sessionId, session);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while resolving torrent metadata."));
      }, TORRENT_RESOLVE_TIMEOUT_MS);
      const handleReady = () => {
        clearTimeout(timeout);
        resolve();
      };
      const handleError = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };

      if (torrent.ready) {
        handleReady();
        return;
      }

      torrent.once("ready", handleReady);
      torrent.once("error", handleError);
    });

    session.infoHash = torrent.infoHash;
    session.files = buildTorrentFiles(torrent);
    for (const file of torrent.files) {
      file.deselect();
    }

    if (session.files.length === 0) {
      session.failureMessage = "No video files found in torrent.";
    }

    return session;
  } catch (error) {
    session.failureMessage = error instanceof Error ? error.message : "Torrent metadata could not be resolved.";
    return session;
  }
}

async function destroyTorrentSession(sessionId: string) {
  const session = torrentSessions.get(sessionId);

  if (!session) {
    return;
  }

  torrentSessions.delete(sessionId);

  if (session.selectedFileId) {
    localFiles.delete(session.selectedFileId);
  }

  await new Promise<void>((resolve) => {
    session.torrent.destroy({ destroyStore: true }, () => resolve());
  });
}

async function createPickedLocalFile(filePath: string): Promise<PickedLocalFile> {
  const stats = await fs.stat(filePath);

  if (!stats.isFile()) {
    throw new Error("Selected path is not a file.");
  }

  const fileId = crypto.randomUUID();
  localFiles.set(fileId, createFileHandle(filePath, stats.size));
  const mediaServerBaseUrl = await startMediaServer();
  const encodedFileName = encodeURIComponent(path.basename(filePath));

  return {
    type: "local_file",
    mediaId: crypto.randomUUID(),
    fileId,
    fileUrl: pathToFileURL(filePath).toString(),
    streamUrl: `${mediaServerBaseUrl}/local/${encodeURIComponent(fileId)}/${encodedFileName}`,
    fileName: path.basename(filePath),
    fileSize: stats.size,
    mimeType: inferMimeType(filePath)
  };
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

function getLocalFileIdFromPathname(pathname: string | undefined) {
  if (!pathname) {
    return null;
  }

  const segments = pathname.split("/").filter(Boolean);

  if (segments[0] !== "local" || !segments[1]) {
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

async function streamStaticMediaBytes(
  response: ServerResponse,
  handle: LocalMediaHandle,
  startByte: number,
  endByte: number
) {
  let offset = startByte;

  while (offset < endByte) {
    const bytes = await handle.readRange(offset, Math.min(endByte, offset + STREAM_CHUNK_SIZE));

    if (bytes.byteLength === 0) {
      throw new Error("Media stream read returned zero bytes.");
    }

    const shouldContinue = response.write(bytes);
    offset += bytes.byteLength;

    if (!shouldContinue) {
      await new Promise<void>((resolve) => {
        response.once("drain", resolve);
      });
    }
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
      const chunkEndByte = Math.min(availableEndByte, offset + STREAM_CHUNK_SIZE);
      const bytes = await readMediaRange(session.filePath, offset, chunkEndByte);

      if (bytes.byteLength === 0) {
        throw new Error("Media stream read returned zero bytes.");
      }

      const shouldContinue = response.write(bytes);
      offset = chunkEndByte;

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
    const localFileId = getLocalFileIdFromPathname(requestUrl?.pathname);

    if (!localFileId) {
      writeErrorResponse(response, 404, "Media cache not found.");
      return;
    }

    const handle = localFiles.get(localFileId);

    if (!handle) {
      writeErrorResponse(response, 404, "Local file not found.");
      return;
    }

    const method = (request.method ?? "GET").toUpperCase();

    if (method !== "GET" && method !== "HEAD") {
      writeErrorResponse(response, 405, "Method not allowed.");
      return;
    }

    const rangeHeader = typeof request.headers.range === "string" ? request.headers.range : null;

    if (!rangeHeader) {
      writeMediaHeaders(
        response,
        {
          mediaId: "",
          fileName: handle.fileName,
          filePath: "",
          localFileId,
          mimeType: handle.mimeType,
          fileSize: handle.fileSize,
          availableRanges: [],
          waiters: []
        },
        200,
        handle.fileSize
      );

      if (method === "HEAD") {
        response.end();
        return;
      }

      await streamStaticMediaBytes(response, handle, 0, handle.fileSize);
      response.end();
      return;
    }

    const requestedRange = parseByteRange(rangeHeader, handle.fileSize);

    if (!requestedRange) {
      writeErrorResponse(response, 416, "Invalid byte range.");
      return;
    }

    const contentLength = Math.max(0, requestedRange.endByte - requestedRange.startByte);
    const inclusiveEndByte = requestedRange.endByte - 1;
    writeMediaHeaders(
      response,
      {
        mediaId: "",
        fileName: handle.fileName,
        filePath: "",
        localFileId,
        mimeType: handle.mimeType,
        fileSize: handle.fileSize,
        availableRanges: [],
        waiters: []
      },
      206,
      contentLength,
      `bytes ${requestedRange.startByte}-${inclusiveEndByte}/${handle.fileSize}`
    );

    if (method === "HEAD") {
      response.end();
      return;
    }

    await streamStaticMediaBytes(response, handle, requestedRange.startByte, requestedRange.endByte);
    response.end();
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
              const chunkEndByte = Math.min(availableEndByte, offset + STREAM_CHUNK_SIZE);
              const bytes = await readMediaRange(session.filePath, offset, chunkEndByte);

              if (bytes.byteLength === 0) {
                throw new Error("Media stream read returned zero bytes.");
              }

              controller.enqueue(new Uint8Array(bytes));
              offset = chunkEndByte;
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
            const chunkEndByte = Math.min(availableEndByte, offset + STREAM_CHUNK_SIZE);
            const bytes = await readMediaRange(session.filePath, offset, chunkEndByte);

            if (bytes.byteLength === 0) {
              throw new Error("Media stream read returned zero bytes.");
            }

            controller.enqueue(new Uint8Array(bytes));
            offset = chunkEndByte;
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
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(resolveMacAppIconPath()));
  }
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

    return createPickedLocalFile(result.filePaths[0]);
  });

  ipcMain.handle("syncplay:pick-local-file-by-path", async (_, filePath: string) => {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      return null;
    }

    return createPickedLocalFile(filePath.trim());
  });

  ipcMain.handle("syncplay:resolve-magnet-link", async (_, magnetUri: string) => {
    if (typeof magnetUri !== "string" || !magnetUri.trim().startsWith("magnet:?")) {
      throw new Error("Enter a valid magnet link.");
    }

    const session = await resolveTorrentMetadata(magnetUri.trim());
    return buildTorrentSessionSummary(session);
  });

  ipcMain.handle("syncplay:select-torrent-file", async (_, sessionId: string, fileIndex: number) => {
    const session = torrentSessions.get(sessionId);

    if (!session) {
      throw new Error("Torrent session not found.");
    }

    const selectedFile = session.torrent.files[fileIndex];

    if (!selectedFile || !isVideoTorrentFile(selectedFile)) {
      throw new Error("Selected torrent file is not a playable video.");
    }

    for (const file of session.torrent.files) {
      file.deselect();
    }

    if (session.selectedFileId) {
      localFiles.delete(session.selectedFileId);
    }

    selectedFile.select();
    session.selectedFileIndex = fileIndex;
    session.selectedFileId = crypto.randomUUID();
    session.mediaId = crypto.randomUUID();

    const mediaServerBaseUrl = await startMediaServer();
    const encodedFileName = encodeURIComponent(selectedFile.name);
    const streamUrl = `${mediaServerBaseUrl}/local/${encodeURIComponent(session.selectedFileId)}/${encodedFileName}`;
    localFiles.set(session.selectedFileId, {
      fileName: selectedFile.name,
      fileSize: selectedFile.length,
      mimeType: inferMimeType(selectedFile.name),
      fileUrl: streamUrl,
      readRange: (startByte: number, endByte: number) => readTorrentFileRange(selectedFile, startByte, endByte)
    });

    return {
      type: "torrent_magnet",
      magnetUri: session.magnetUri,
      infoHash: session.infoHash,
      mediaId: session.mediaId,
      fileId: session.selectedFileId,
      fileUrl: streamUrl,
      streamUrl,
      fileName: selectedFile.name,
      fileSize: selectedFile.length,
      mimeType: inferMimeType(selectedFile.name)
    } satisfies PickedLocalFile;
  });

  ipcMain.handle("syncplay:get-torrent-session-status", async (_, sessionId: string) => {
    const session = torrentSessions.get(sessionId);
    return session ? buildTorrentSessionSummary(session) : null;
  });

  ipcMain.handle("syncplay:dispose-torrent-session", async (_, sessionId: string) => {
    await destroyTorrentSession(sessionId);
  });

  ipcMain.handle("syncplay:read-local-file", async (_, fileId: string) => {
    const fileHandle = localFiles.get(fileId);

    if (!fileHandle) {
      throw new Error("Local file handle not found.");
    }

    const chunks: Uint8Array[] = [];
    let offset = 0;

    while (offset < fileHandle.fileSize) {
      const chunk = await fileHandle.readRange(offset, Math.min(fileHandle.fileSize, offset + STREAM_CHUNK_SIZE));

      if (chunk.byteLength === 0) {
        break;
      }

      chunks.push(chunk);
      offset += chunk.byteLength;
    }

    return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  });

  ipcMain.handle("syncplay:read-local-file-chunk", async (_, fileId: string, offset: number, length: number) => {
    const fileHandle = localFiles.get(fileId);

    if (!fileHandle) {
      throw new Error("Local file handle not found.");
    }

    return fileHandle.readRange(offset, offset + Math.max(0, length));
  });

  ipcMain.handle(
    "syncplay:create-temp-media-cache",
    async (_, mediaId: string, metadata: { fileSize: number; mimeType: string; fileName: string }) => {
      const cacheId = crypto.randomUUID();
      const localFileId = crypto.randomUUID();
      const tempDir = path.join(os.tmpdir(), "syncplay-media-cache");
      await fs.mkdir(tempDir, { recursive: true });
      const cachePath = path.join(tempDir, `${mediaId}-${cacheId}.bin`);
      await fs.writeFile(cachePath, new Uint8Array());
      const mediaServerBaseUrl = await startMediaServer();
      const encodedFileName = encodeURIComponent(metadata.fileName || `${mediaId}.bin`);
      const httpUrl = `${mediaServerBaseUrl}/cache/${encodeURIComponent(cacheId)}/${encodedFileName}`;
      const localHttpUrl = `${mediaServerBaseUrl}/local/${encodeURIComponent(localFileId)}/${encodedFileName}`;
      const fileUrl = pathToFileURL(cachePath).toString();
      const protocolUrl = `${SYNCPLAY_MEDIA_SCHEME}://cache/${encodeURIComponent(cacheId)}/${encodedFileName}`;
      localFiles.set(localFileId, createFileHandle(cachePath, metadata.fileSize, metadata.mimeType));

      tempMediaCaches.set(cacheId, {
        mediaId,
        fileName: metadata.fileName,
        filePath: cachePath,
        localFileId,
        mimeType: metadata.mimeType,
        fileSize: metadata.fileSize,
        availableRanges: [],
        waiters: []
      });

      return {
        cacheId,
        mediaUrl: protocolUrl,
        fileUrl,
        httpUrl,
        localHttpUrl
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

    localFiles.delete(session.localFileId);
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

app.on("before-quit", () => {
  for (const sessionId of Array.from(torrentSessions.keys())) {
    void destroyTorrentSession(sessionId);
  }

  if (torrentClient) {
    torrentClient.destroy();
    torrentClient = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
