// Local, reproducible BitTorrent swarm for streaming benchmarks: an HTTP
// tracker plus seeders with different upload caps (like real peers of uneven
// speed). Prints the magnet link and keeps seeding until killed.
//
// Usage: node scripts/bench-torrent/swarm.mjs <video-file> [--seeders=1500,1000,500] [--tracker-port=8711]
//          [--piece-kib=256] [--churn-ms=0] [--magnet-out=path]
//   --seeders     upload cap per seeder in KiB/s (comma separated)
//   --churn-ms    if > 0, the fastest seeder leaves and rejoins every N ms
import fs from "node:fs/promises";
import path from "node:path";

import { loadTorrentDeps } from "./deps.mjs";

const [filePath, ...flagArgs] = process.argv.slice(2);
const flags = Object.fromEntries(
  flagArgs.map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
if (!filePath) {
  console.error("Usage: node scripts/bench-torrent/swarm.mjs <video-file> [--seeders=1500,1000,500]");
  process.exit(1);
}

const { WebTorrent, createTorrent, TrackerServer } = await loadTorrentDeps();
const trackerPort = Number(flags["tracker-port"] ?? 8711);
const seederLimitsKiB = (flags.seeders ?? "1500,1000,500").split(",").map(Number);
const pieceLength = Number(flags["piece-kib"] ?? 256) * 1024;
const churnMs = Number(flags["churn-ms"] ?? 0);
const announce = [`http://127.0.0.1:${trackerPort}/announce`];

const tracker = new TrackerServer({ udp: false, ws: false, http: true, stats: false });
await new Promise((resolve, reject) => {
  tracker.once("error", reject);
  tracker.listen(trackerPort, "127.0.0.1", resolve);
});

const torrentBuffer = await new Promise((resolve, reject) =>
  createTorrent(filePath, { pieceLength, announce, name: path.basename(filePath), createdBy: "syncplay-bench" }, (error, buffer) =>
    error ? reject(error) : resolve(buffer)
  )
);

// Each seeder is its own client so it gets its own upload cap and connections.
// DHT/LSD are off so the only way to find them is the local tracker.
function startSeeder(limitKiB) {
  const client = new WebTorrent({ dht: false, lsd: false, utp: false, uploadLimit: limitKiB * 1024 });
  return new Promise((resolve) => {
    client.add(torrentBuffer, { path: path.dirname(filePath), announce, skipVerify: true }, (torrent) => resolve({ client, torrent, limitKiB }));
  });
}

const seeders = [];
for (const limit of seederLimitsKiB) seeders.push(await startSeeder(limit));
const magnetUri = seeders[0].torrent.magnetURI;
if (flags["magnet-out"]) await fs.writeFile(flags["magnet-out"], magnetUri);
console.log(`MAGNET ${magnetUri}`);
console.log(`seeding ${path.basename(filePath)} with ${seederLimitsKiB.join("/")} KiB/s seeders on tracker :${trackerPort}`);

if (churnMs > 0) {
  // The fastest seeder disconnects and comes back, like a peer with a flaky link.
  setInterval(async () => {
    const index = seederLimitsKiB.indexOf(Math.max(...seederLimitsKiB));
    const seeder = seeders[index];
    await new Promise((resolve) => seeder.client.destroy(resolve));
    console.log(`churn: seeder ${index} left`);
    setTimeout(async () => {
      seeders[index] = await startSeeder(seederLimitsKiB[index]);
      console.log(`churn: seeder ${index} rejoined`);
    }, churnMs / 2);
  }, churnMs);
}

setInterval(() => {
  const uploaded = seeders.map((seeder) => `${(seeder.torrent.uploaded / 1048576).toFixed(0)}MiB/${seeder.torrent.numPeers}p`);
  console.log(`stats uploaded=${uploaded.join(" ")}`);
}, 10_000).unref();

const shutdown = async () => {
  await Promise.all(seeders.map((seeder) => new Promise((resolve) => seeder.client.destroy(resolve))));
  tracker.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
