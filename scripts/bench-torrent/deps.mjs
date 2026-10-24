// Resolves the torrent libraries installed for the desktop app so the bench
// scripts use exactly the same WebTorrent build as the product. These packages
// are ESM-only and nested in bun's store, so they are located by directory.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const desktopRequire = createRequire(path.join(repoDir, "apps/desktop/package.json"));
const webtorrentDir = path.dirname(realpathSync(desktopRequire.resolve("webtorrent")));
const siblingDir = (fromDir, name) => realpathSync(path.join(fromDir, "..", name));
const discoveryDir = siblingDir(webtorrentDir, "torrent-discovery");

const importFile = (dir, file) => import(pathToFileURL(path.join(dir, file)).href);
const importPackage = async (dir) => {
  const pkg = (await import(pathToFileURL(path.join(dir, "package.json")).href, { with: { type: "json" } })).default;
  const entry = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."]?.import ?? pkg.exports?.["."] ?? pkg.main ?? "index.js";
  return importFile(dir, typeof entry === "string" ? entry : entry.default);
};

export async function loadTorrentDeps() {
  const [webtorrent, createTorrent, parseTorrent, trackerServer] = await Promise.all([
    importPackage(webtorrentDir),
    importPackage(siblingDir(webtorrentDir, "create-torrent")),
    importPackage(siblingDir(webtorrentDir, "parse-torrent")),
    importFile(siblingDir(discoveryDir, "bittorrent-tracker"), "server.js")
  ]);
  return {
    WebTorrent: webtorrent.default,
    createTorrent: createTorrent.default,
    parseTorrent: parseTorrent.default,
    TrackerServer: trackerServer.default ?? trackerServer.Server
  };
}
