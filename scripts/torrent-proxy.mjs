import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import WebTorrent from "../node_modules/.bun/node_modules/webtorrent/index.js";

const port = Number(process.env.SYNCPLAY_TORRENT_PROXY_PORT ?? 8788);
const TORRENT_RESOLVE_TIMEOUT_MS = 90_000;
const TORRENT_DOWNLOAD_ROOT = path.join(os.tmpdir(), "syncplay-torrent-proxy");
const DEFAULT_TORRENT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.fastcast.nz",
  "wss://tracker.files.fm:7073/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
];
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,range",
  "access-control-expose-headers": "accept-ranges,content-length,content-range,content-type"
};

const torrentClient = new WebTorrent();
const torrentSessions = new Map();

function inferMimeType(filePath) {
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

function isVideoTorrentFile(file) {
  return inferMimeType(file.name).startsWith("video/");
}

function buildTorrentFiles(torrent) {
  return torrent.files
    .map((file, index) => ({
      index,
      name: file.name,
      path: file.path,
      size: file.length,
      mimeType: inferMimeType(file.name)
    }))
    .filter((file) => file.mimeType.startsWith("video/"));
}

function resolveTorrentPhase(session) {
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

function buildTorrentSessionSummary(session) {
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

function mergeTorrentTrackers(magnetUri) {
  const magnetUrl = new URL(magnetUri);
  const trackers = new Set(DEFAULT_TORRENT_TRACKERS);

  for (const tracker of magnetUrl.searchParams.getAll("tr")) {
    if (tracker) {
      trackers.add(tracker);
    }
  }

  return Array.from(trackers);
}

async function readTorrentFileRange(file, startByte, endByte) {
  if (endByte <= startByte) {
    return new Uint8Array();
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = file.createReadStream({
      start: startByte,
      end: endByte - 1
    });

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => {
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    stream.on("error", reject);
  });
}

async function resolveTorrentMetadata(magnetUri) {
  for (const [sessionId, session] of torrentSessions.entries()) {
    if (session.magnetUri === magnetUri || session.infoHash && magnetUri.includes(session.infoHash)) {
      await destroyTorrentSession(sessionId);
    }
  }

  const sessionId = crypto.randomUUID();
  const downloadPath = path.join(TORRENT_DOWNLOAD_ROOT, sessionId);
  await fs.mkdir(downloadPath, { recursive: true });
  const torrent = torrentClient.add(magnetUri, {
    announce: mergeTorrentTrackers(magnetUri),
    path: downloadPath,
    destroyStoreOnDestroy: true
  });
  const session = {
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
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while resolving torrent metadata."));
      }, TORRENT_RESOLVE_TIMEOUT_MS);
      const handleReady = () => {
        clearTimeout(timeout);
        resolve();
      };
      const handleError = (error) => {
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

    return buildTorrentSessionSummary(session);
  } catch (error) {
    session.failureMessage = error instanceof Error ? error.message : "Torrent metadata could not be resolved.";
    return buildTorrentSessionSummary(session);
  }
}

async function selectTorrentFile(sessionId, fileIndex) {
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

  selectedFile.select();
  session.selectedFileIndex = fileIndex;
  session.mediaId = crypto.randomUUID();

  return {
    type: "torrent_magnet",
    magnetUri: session.magnetUri,
    infoHash: session.infoHash,
    mediaId: session.mediaId,
    fileName: selectedFile.name,
    fileSize: selectedFile.length,
    mimeType: inferMimeType(selectedFile.name),
    sessionId: session.sessionId,
    fileIndex
  };
}

function getTorrentSessionStatus(sessionId) {
  const session = torrentSessions.get(sessionId);
  return session ? buildTorrentSessionSummary(session) : null;
}

async function destroyTorrentSession(sessionId) {
  const session = torrentSessions.get(sessionId);

  if (!session) {
    return;
  }

  torrentSessions.delete(sessionId);

  await new Promise((resolve) => {
    session.torrent.destroy({ destroyStore: true }, () => resolve());
  });
}

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }

  const [startText, endText] = rangeHeader.slice("bytes=".length).split("-", 2);
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : fileSize - 1;

  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(requestedEnd) || requestedEnd < start) {
    return null;
  }

  const end = Math.min(requestedEnd, fileSize - 1);

  if (start >= fileSize) {
    return null;
  }

  return { start, end };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...CORS_HEADERS
  });
  response.end(JSON.stringify(payload));
}

function sendEmpty(response, statusCode) {
  response.writeHead(statusCode, CORS_HEADERS);
  response.end();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : null);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);

    if (request.method === "OPTIONS") {
      sendEmpty(response, 204);
      return;
    }

    if (url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/torrents/resolve" && request.method === "POST") {
      const body = await readJsonBody(request).catch(() => null);
      const magnetUri = body?.magnetUri?.trim();

      if (!magnetUri?.startsWith("magnet:?")) {
        sendJson(response, 400, { message: "Enter a valid magnet link." });
        return;
      }

      const session = await resolveTorrentMetadata(magnetUri);
      sendJson(response, 200, session);
      return;
    }

    const selectMatch = url.pathname.match(/^\/api\/torrents\/([^/]+)\/select$/);

    if (selectMatch && request.method === "POST") {
      const body = await readJsonBody(request).catch(() => null);
      const fileIndex = body?.fileIndex;

      if (!Number.isInteger(fileIndex)) {
        sendJson(response, 400, { message: "Choose a valid torrent file." });
        return;
      }

      try {
        const selectedFile = await selectTorrentFile(selectMatch[1] ?? "", fileIndex);
        sendJson(response, 200, selectedFile);
      } catch (error) {
        sendJson(response, 400, { message: error instanceof Error ? error.message : "Could not open torrent video." });
      }
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/torrents\/([^/]+)\/status$/);

    if (statusMatch && request.method === "GET") {
      sendJson(response, 200, getTorrentSessionStatus(statusMatch[1] ?? ""));
      return;
    }

    const disposeMatch = url.pathname.match(/^\/api\/torrents\/([^/]+)$/);

    if (disposeMatch && request.method === "DELETE") {
      await destroyTorrentSession(disposeMatch[1] ?? "");
      sendEmpty(response, 204);
      return;
    }

    const fileMatch = url.pathname.match(/^\/api\/torrents\/([^/]+)\/files\/(\d+)\/[^/]+$/);

    if (fileMatch && request.method === "GET") {
      const session = torrentSessions.get(fileMatch[1] ?? "");

      if (!session) {
        sendJson(response, 404, { message: "Torrent session not found." });
        return;
      }

      const fileIndex = Number(fileMatch[2]);
      const file = session.torrent.files[fileIndex];

      if (!file || !isVideoTorrentFile(file)) {
        sendJson(response, 404, { message: "Selected torrent file is not available." });
        return;
      }

      const range = parseRangeHeader(request.headers.range ?? null, file.length);

      if (!range) {
        const bytes = await readTorrentFileRange(file, 0, file.length);
        response.writeHead(200, {
          "accept-ranges": "bytes",
          "content-length": String(bytes.byteLength),
          "content-type": inferMimeType(file.name),
          ...CORS_HEADERS
        });
        response.end(Buffer.from(bytes));
        return;
      }

      const bytes = await readTorrentFileRange(file, range.start, range.end + 1);
      response.writeHead(206, {
        "accept-ranges": "bytes",
        "content-length": String(bytes.byteLength),
        "content-range": `bytes ${range.start}-${range.end}/${file.length}`,
        "content-type": inferMimeType(file.name),
        ...CORS_HEADERS
      });
      response.end(Buffer.from(bytes));
      return;
    }

    sendJson(response, 404, { message: "Not found." });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { message: error instanceof Error ? error.message : "Internal server error." });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`SyncPlay torrent proxy running on http://127.0.0.1:${port}`);
});

async function shutdown() {
  for (const sessionId of Array.from(torrentSessions.keys())) {
    await destroyTorrentSession(sessionId);
  }

  torrentClient.destroy();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
