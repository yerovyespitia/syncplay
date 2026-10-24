// Simulates a media element playing a torrent through the media server, to
// compare read strategies by what a viewer feels: startup, stalls, seek.
// The consumer plays at the video bitrate and, like a browser, stops reading
// once it has `ahead-s` seconds buffered.
//
//   chunked:  a new createReadStream per 1 MiB (old app)
//   stream:   one createReadStream for the whole range (prioritises everything)
//   windowN:  chained createReadStreams of N MiB (priority stays near playhead)
//
// Usage: node scripts/bench-torrent/playback-bench.mjs <magnet> --reader=window8 --bitrate-mbps=6
//          [--play-s=60] [--after-seek-s=30] [--ahead-s=30] [--limit-s=240]
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
const bytesPerSecond = (Number(flags["bitrate-mbps"] ?? 6) * 1_000_000) / 8;
const playMs = Number(flags["play-s"] ?? 60) * 1000;
const afterSeekMs = Number(flags["after-seek-s"] ?? 30) * 1000;
const aheadBytes = Number(flags["ahead-s"] ?? 30) * bytesPerSecond;
const STARTUP_BYTES = 2 * 1024 * 1024;
const MIB = 1024 * 1024;
const APP_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
];

const { WebTorrent } = await loadTorrentDeps();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "playback-bench-"));
const client = new WebTorrent({ utp: false });
const announce = [...new Set([...APP_TRACKERS, ...new URL(magnet).searchParams.getAll("tr")])];
const torrent = client.add(magnet, { announce, path: dir, destroyStoreOnDestroy: true });
setTimeout(() => {
  console.log(JSON.stringify({ reader, error: "time limit" }));
  process.exit(2);
}, Number(flags["limit-s"] ?? 240) * 1000).unref();
await new Promise((resolve) => torrent.once("ready", resolve));
const file = torrent.files.reduce((largest, candidate) => (candidate.length > largest.length ? candidate : largest));
for (const candidate of torrent.files) candidate.deselect();
file.select();

// The bytes an HTTP response for `bytes=startByte-` would deliver, per strategy.
async function* readFrom(startByte) {
  const end = file.length;
  const windowBytes = reader.startsWith("window") ? Number(reader.slice("window".length)) * MIB : reader === "chunked" ? MIB : end;
  for (let offset = startByte; offset < end; offset += windowBytes) {
    yield* file.createReadStream({ start: offset, end: Math.min(end, offset + windowBytes) - 1 });
  }
}

// Plays from startByte for durationMs of wall time. Returns startup latency and
// seconds stalled after playback began.
async function play(startByte, durationMs) {
  const iterator = readFrom(startByte)[Symbol.asyncIterator]();
  let received = 0;
  let playedBytes = 0;
  let startedAt = null;
  let stalledMs = 0;
  let pending = null;
  const begin = performance.now();
  let last = begin;

  while (performance.now() - begin < durationMs + (startedAt === null ? 60_000 : 0)) {
    // Keep reading while the buffer ahead of the playhead is below the cap.
    if (!pending && received - playedBytes < aheadBytes) {
      pending = iterator.next().then((result) => {
        if (!result.done) received += result.value.length;
        pending = null;
      });
    }
    await Promise.race([pending ?? Promise.resolve(), new Promise((resolve) => setTimeout(resolve, 50))]);
    const now = performance.now();
    if (startedAt === null && received >= STARTUP_BYTES) startedAt = now;
    if (startedAt !== null) {
      const want = playedBytes + (bytesPerSecond * (now - last)) / 1000;
      if (want <= received) playedBytes = want;
      else {
        playedBytes = received;
        stalledMs += now - last;
      }
      if (now - startedAt >= durationMs) break;
    }
    last = now;
  }
  await iterator.return?.();
  return { startupMs: startedAt === null ? null : Math.round(startedAt - begin), stalledS: Math.round(stalledMs / 100) / 10 };
}

const start = await play(0, playMs);
const seekByte = Math.floor((file.length * 0.6) / MIB) * MIB;
const seek = await play(seekByte, afterSeekMs);
console.log(
  JSON.stringify({
    reader,
    startupMs: start.startupMs,
    stalledS: start.stalledS,
    seekMs: seek.startupMs,
    stalledAfterSeekS: seek.stalledS,
    peers: torrent.numPeers
  })
);
await new Promise((resolve) => client.destroy(resolve));
await fs.rm(dir, { recursive: true, force: true });
process.exit(0);
