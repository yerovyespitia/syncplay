// Engine-level torrent streaming benchmark, using the app's WebTorrent build.
// Compares how the media server reads the selected file:
//   chunked: 1 MiB at a time, a new createReadStream per chunk (current app)
//   stream:  one createReadStream for the whole requested range
// and whether outgoing connections try uTP first (WebTorrent default) or TCP.
//
// Usage: node scripts/bench-torrent/stream-bench.mjs <magnet> --reader=chunked|stream --utp=on|off
//          [--sustain-s=20] [--limit-s=150]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadTorrentDeps } from "./deps.mjs";

const [magnet, ...flagArgs] = process.argv.slice(2);
const flags = Object.fromEntries(
  flagArgs.map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
const reader = flags.reader ?? "chunked";
const utp = (flags.utp ?? "on") === "on";
const sustainMs = Number(flags["sustain-s"] ?? 20) * 1000;
const limitMs = Number(flags["limit-s"] ?? 150) * 1000;
const MIB = 1024 * 1024;
const APP_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.files.fm:7073/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
];

const { WebTorrent } = await loadTorrentDeps();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-bench-"));
const client = new WebTorrent(utp ? {} : { utp: false });
const start = performance.now();
const since = () => Math.round(performance.now() - start);
const announce = [...new Set([...APP_TRACKERS, ...new URL(magnet).searchParams.getAll("tr")])];
const torrent = client.add(magnet, { announce, path: dir, destroyStoreOnDestroy: true });
setTimeout(() => {
  console.log(JSON.stringify({ reader, utp, error: "time limit", atMs: since() }));
  process.exit(2);
}, limitMs).unref();

await new Promise((resolve) => torrent.once("ready", resolve));
const metadataMs = since();
const file = torrent.files.reduce((largest, candidate) => (candidate.length > largest.length ? candidate : largest));
for (const candidate of torrent.files) candidate.deselect();
file.select();

// Same as main/index.ts readTorrentFileRange.
function readRangeOnce(startByte, endByte) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const stream = file.createReadStream({ start: startByte, end: endByte - 1 });
    stream.on("data", (chunk) => (bytes += chunk.length));
    stream.on("end", () => resolve(bytes));
    stream.on("error", reject);
  });
}

// Reads [startByte, endByte) the way the media server would serve one HTTP range.
async function readRange(startByte, endByte, deadline = Infinity) {
  if (reader === "chunked") {
    let offset = startByte;
    while (offset < endByte && performance.now() < deadline) {
      offset += await readRangeOnce(offset, Math.min(endByte, offset + MIB));
    }
    return offset - startByte;
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const stream = file.createReadStream({ start: startByte, end: endByte - 1 });
    const timer = Number.isFinite(deadline) ? setTimeout(() => stream.destroy(), Math.max(0, deadline - performance.now())) : null;
    stream.on("data", (chunk) => (bytes += chunk.length));
    stream.on("close", () => {
      if (timer) clearTimeout(timer);
      resolve(bytes);
    });
    stream.on("error", reject);
  });
}

// Startup: what a <video> needs for an MP4 with the index at the end.
const startupStart = performance.now();
await Promise.all([readRange(0, 4 * MIB), readRange(file.length - MIB, file.length)]);
const startupMs = Math.round(performance.now() - startupStart);

// Sustained sequential reading right after the startup window.
const sustainStart = performance.now();
const sustainedBytes = await readRange(4 * MIB, file.length - MIB, performance.now() + sustainMs);
const sustainedMiBps = sustainedBytes / MIB / ((performance.now() - sustainStart) / 1000);

// Seek: jump to 60% of the file, where pieces were not requested yet.
const seekByte = Math.floor((file.length * 0.6) / MIB) * MIB;
const seekStart = performance.now();
await readRange(seekByte, seekByte + 4 * MIB);
const seekMs = Math.round(performance.now() - seekStart);

console.log(
  JSON.stringify({
    reader,
    utp,
    metadataMs,
    startupMs,
    sustainedMiBps: Math.round(sustainedMiBps * 100) / 100,
    seekMs,
    peers: torrent.numPeers
  })
);
await new Promise((resolve) => client.destroy(resolve));
await fs.rm(dir, { recursive: true, force: true });
process.exit(0);
