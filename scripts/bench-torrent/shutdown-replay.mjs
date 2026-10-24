// Replays the app's shutdown logic with real WebTorrent clients: a shared client
// (host session) and an isolated one (guest session), like main/index.ts.
// "old" = before-quit before the fix (double-destroys the shared client),
// "new" = destroy each client once and wait.
// Usage: node scripts/bench-torrent/shutdown-replay.mjs old|new
import os from "node:os";

import { loadTorrentDeps } from "./deps.mjs";
const { WebTorrent } = await loadTorrentDeps();
const variant = process.argv[2];
const rejections = [];
process.on("unhandledRejection", (error) => rejections.push(String(error?.message ?? error)));
const magnet = "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny";
let torrentClient = new WebTorrent({ utp: false, dht: false, lsd: false, tracker: false });
const isolated = new WebTorrent({ utp: false, dht: false, lsd: false, tracker: false });
const torrentSessions = new Map([
  ["host", { client: torrentClient, torrent: torrentClient.add(magnet, { path: `${os.tmpdir()}/shutdown-replay-host` }) }],
  ["guest", { client: isolated, torrent: isolated.add(magnet, { path: `${os.tmpdir()}/shutdown-replay-guest` }) }]
]);
await new Promise((r) => setTimeout(r, 500));

// Old destroyTorrentSession (main/index.ts before the fix), store handling omitted.
async function destroyTorrentSession(sessionId) {
  const session = torrentSessions.get(sessionId);
  if (!session) return;
  torrentSessions.delete(sessionId);
  await new Promise((resolve) => session.torrent.destroy({}, () => resolve()));
  const isSharedClient = Array.from(torrentSessions.values()).some((candidate) => candidate.client === session.client);
  if (!isSharedClient && session.client !== torrentClient) session.client.destroy();
}

if (variant === "old") {
  // Old before-quit: fire-and-forget session teardown, then destroy + null the shared client.
  for (const sessionId of Array.from(torrentSessions.keys())) void destroyTorrentSession(sessionId);
  if (torrentClient) { torrentClient.destroy(); torrentClient = null; }
} else {
  // New before-quit: destroy every distinct client exactly once and wait.
  const clients = new Set([torrentClient, ...Array.from(torrentSessions.values(), (s) => s.client)].filter(Boolean));
  torrentSessions.clear(); torrentClient = null;
  await Promise.all(Array.from(clients, (client) => new Promise((resolve) => client.destroy(() => resolve()))));
}
await new Promise((r) => setTimeout(r, 1500));
console.log(JSON.stringify({ variant, rejections }));
process.exit(0);
