// Electron side of the local-file transfer benchmark. Run through
// scripts/bench-transfer/run.mjs, which starts one "host" and one "guest"
// process so each side has its own main and renderer, like two real users,
// and relays their signaling.
//
// The pipeline replays the path a chunk takes in LocalFileRoomPlayer:
//   host IPC file read -> RTCDataChannel -> guest IPC write into the temp cache
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const scriptIndex = process.argv.findIndex((arg) => path.resolve(arg) === __filename);
const [role, portArg, filePath, optionsJson = "{}"] = process.argv.slice(scriptIndex + 1);
if (!["host", "guest"].includes(role) || !portArg || !filePath) {
  console.error("Usage: electron main.cjs <host|guest> <port> <file> [options-json]");
  process.exit(1);
}
const options = JSON.parse(optionsJson);
const reportPath = options.reportPath;

app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
app.setPath("userData", path.join(os.tmpdir(), `syncplay-bench-${role}`));

// --- Same helpers as apps/desktop/src/main/index.ts -------------------------
function mergeRanges(ranges, incomingRange) {
  const nextRanges = [...ranges, incomingRange].sort((left, right) => left.startByte - right.startByte);
  const merged = [];
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

async function readMediaRange(sourcePath, startByte, endByte) {
  const byteLength = Math.max(0, endByte - startByte);
  const handle = await fs.open(sourcePath, "r");
  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, startByte);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const caches = new Map();

ipcMain.handle("bench:file-info", async () => ({ fileSize: (await fs.stat(filePath)).size }));
ipcMain.handle("bench:read-chunk", (_, offset, length) => readMediaRange(filePath, offset, offset + Math.max(0, length)));

ipcMain.handle("bench:create-cache", async (_, label) => {
  const cacheId = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cachePath = path.join(os.tmpdir(), "syncplay-bench-cache", `${cacheId}.bin`);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, new Uint8Array());
  caches.set(cacheId, { filePath: cachePath, availableRanges: [] });
  return cacheId;
});

// Legacy (HEAD): open/write/close per chunk, then a second IPC to mark the range.
ipcMain.handle("bench:legacy-write", async (_, cacheId, offset, bytes) => {
  const session = caches.get(cacheId);
  const handle = await fs.open(session.filePath, "r+");
  try {
    const buffer = Buffer.from(bytes);
    await handle.write(buffer, 0, buffer.length, offset);
  } finally {
    await handle.close();
  }
});
ipcMain.handle("bench:legacy-mark", async (_, cacheId, startByte, endByte) => {
  const session = caches.get(cacheId);
  session.availableRanges = mergeRanges(session.availableRanges, { startByte, endByte });
});

// Current: persistent handle, zero-copy Buffer view, range marked in the same call.
ipcMain.handle("bench:current-write", async (_, cacheId, offset, bytes) => {
  const session = caches.get(cacheId);
  session.writeHandle ??= fs.open(session.filePath, "r+");
  const handle = await session.writeHandle;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await handle.write(buffer, 0, buffer.length, offset);
  session.availableRanges = mergeRanges(session.availableRanges, { startByte: offset, endByte: offset + buffer.length });
});

// Compares the first `compareBytes` of the cache with the source (whole file
// when omitted), then deletes the cache. Skips the comparison when compare=false.
ipcMain.handle("bench:verify-and-remove", async (_, cacheId, compare = true, compareBytes) => {
  const session = caches.get(cacheId);
  caches.delete(cacheId);
  await (await session.writeHandle)?.close();
  let identical = null;
  if (compare) {
    const [source, copy] = await Promise.all([fs.readFile(filePath), fs.readFile(session.filePath)]);
    const length = compareBytes ?? source.length;
    identical = copy.length >= length && source.subarray(0, length).equals(copy.subarray(0, length));
  }
  await fs.rm(session.filePath, { force: true });
  return { identical, ranges: session.availableRanges.length };
});

// Total CPU seconds used by every process of this Electron instance.
ipcMain.handle("bench:cpu-seconds", () =>
  app.getAppMetrics().reduce((total, metric) => total + (metric.cpu.cumulativeCPUUsage ?? 0), 0)
);

ipcMain.handle("bench:done", async (_, report) => {
  if (reportPath) {
    await fs.mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report.summary, null, 2));
  app.exit(0);
});
ipcMain.on("bench:exit", () => app.exit(0));
ipcMain.on("bench:log", (_, message) => console.log(`[${role}] ${message}`));

// --- Signaling between the two processes: newline-delimited JSON over TCP ---
function wireSignaling(socket, window) {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    buffered += data;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) window.webContents.send("bench:signal", JSON.parse(line));
    }
  });
  socket.on("close", () => app.exit(0));
  ipcMain.on("bench:signal-out", (_, message) => socket.write(`${JSON.stringify(message)}\n`));
}

function connectWithRetry(port) {
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => resolve(socket));
      socket.once("error", () => setTimeout(attempt, 200));
    };
    attempt();
  });
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  // Both processes connect to the hub in run.mjs, which relays signaling and
  // routes WebRTC traffic through the network emulator.
  const socketPromise = connectWithRetry(Number(portArg));
  await window.loadFile(path.join(__dirname, "index.html"), {
    query: { role, ...Object.fromEntries(Object.entries(options).map(([key, value]) => [key, String(value)])) }
  });
  const socket = await socketPromise;
  socket.write(`${JSON.stringify({ type: "hello", role })}\n`);
  wireSignaling(socket, window);
  window.webContents.send("bench:signal", { type: "signaling-ready" });
});
