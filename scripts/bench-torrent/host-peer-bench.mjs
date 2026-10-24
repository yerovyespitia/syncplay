// Does connecting the guest straight to the host speed up its start? A "host"
// client joins the swarm first and streams the beginning (as the room host
// does); then a fresh "guest" client joins, with or without the host's address.
// Measures the guest's time to its first byte and to the first 4 MiB in order.
//
// Usage: node scripts/bench-torrent/host-peer-bench.mjs <magnet> --variant=base|with-host [--host-head-start-s=20]
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
const variant = flags.variant ?? "base";
const headStartMs = Number(flags["host-head-start-s"] ?? 20) * 1000;
const MIB = 1024 * 1024;
const { WebTorrent } = await loadTorrentDeps();
const announce = new URL(magnet).searchParams.getAll("tr");
setTimeout(() => {
  console.log(JSON.stringify({ variant, error: "time limit" }));
  process.exit(2);
}, 180_000).unref();

async function join(label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `host-peer-${label}-`));
  // LSD off: on one machine it would connect host and guest by itself, which
  // real participants on different networks never get.
  const client = new WebTorrent({ utp: false, lsd: false });
  const torrent = client.add(magnet, { announce, path: dir, destroyStoreOnDestroy: true });
  await new Promise((resolve) => torrent.once("ready", resolve));
  const file = torrent.files.reduce((largest, candidate) => (candidate.length > largest.length ? candidate : largest));
  for (const candidate of torrent.files) candidate.deselect();
  file.select();
  return { client, torrent, file, dir };
}

function readFirstBytes(file, bytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const stream = file.createReadStream({ start: 0, end: bytes - 1 });
    stream.on("data", (chunk) => (received += chunk.length));
    stream.on("end", () => resolve(received));
    stream.on("error", reject);
  });
}

// The host streams from the start, like a host that pressed play.
const host = await join("host");
void readFirstBytes(host.file, 64 * MIB).catch(() => undefined);
await new Promise((resolve) => setTimeout(resolve, headStartMs));
const hostHasMiB = Math.round(host.torrent.downloaded / MIB);

const guestStart = performance.now();
const guest = await join("guest");
const metadataMs = Math.round(performance.now() - guestStart);
if (variant === "with-host") guest.torrent.addPeer(`127.0.0.1:${host.client.torrentPort}`);

let firstByteMs = null;
const firstByteWatch = setInterval(() => {
  if (firstByteMs === null && guest.torrent.downloaded > 0) firstByteMs = Math.round(performance.now() - guestStart);
}, 20);
await readFirstBytes(guest.file, 4 * MIB);
const first4MiBMs = Math.round(performance.now() - guestStart);
clearInterval(firstByteWatch);
const fromHostMiB = guest.torrent.wires
  .filter((wire) => wire.remotePort === host.client.torrentPort)
  .reduce((sum, wire) => sum + wire.downloaded, 0) / MIB;

console.log(
  JSON.stringify({
    variant,
    hostHadMiB: hostHasMiB,
    metadataMs,
    firstByteMs: firstByteMs ?? first4MiBMs,
    first4MiBMs,
    fromHostMiB: Math.round(fromHostMiB * 10) / 10,
    guestPeers: guest.torrent.numPeers
  })
);
for (const { client, dir } of [guest, host]) {
  await new Promise((resolve) => client.destroy(resolve));
  await fs.rm(dir, { recursive: true, force: true });
}
process.exit(0);
