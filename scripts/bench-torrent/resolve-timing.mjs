// Times magnet → metadata with the app's WebTorrent configuration, to find
// where resolution time goes. Usage: node scripts/bench-torrent/resolve-timing.mjs <magnet> [variant]
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadTorrentDeps } from "./deps.mjs";

const [magnet, variant = "app"] = process.argv.slice(2);
const { WebTorrent } = await loadTorrentDeps();
const APP_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.files.fm:7073/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
];
const magnetTrackers = new URL(magnet).searchParams.getAll("tr");
const announce = variant === "magnet-only" ? magnetTrackers : [...new Set([...APP_TRACKERS, ...magnetTrackers])];
const clientOptions = { app: {}, "magnet-only": {}, "no-dht": { dht: false }, "no-utp": { utp: false } }[variant];
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-"));
const start = performance.now();
const client = new WebTorrent(clientOptions);
const marks = {};
const torrent = client.add(magnet, { announce, path: dir, destroyStoreOnDestroy: true });
torrent.on("infoHash", () => (marks.infoHash ??= performance.now() - start));
torrent.on("wire", () => (marks.firstPeer ??= performance.now() - start));
torrent.on("metadata", () => (marks.metadata ??= performance.now() - start));
torrent.on("warning", (warning) => (marks.firstWarning ??= `${Math.round(performance.now() - start)}ms ${String(warning.message ?? warning).slice(0, 80)}`));
const RESOLVE_LIMIT_MS = Number(process.env.RESOLVE_LIMIT_MS ?? 120_000);
const resolved = await Promise.race([
  new Promise((resolve) => torrent.once("ready", () => resolve(true))),
  new Promise((resolve) => setTimeout(() => resolve(false), RESOLVE_LIMIT_MS))
]);
if (!resolved) marks.timedOut = RESOLVE_LIMIT_MS;
marks.ready = performance.now() - start;
console.log(JSON.stringify({ variant, ...Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v])) }));
await new Promise((resolve) => client.destroy(resolve));
await fs.rm(dir, { recursive: true, force: true });
process.exit(0);
