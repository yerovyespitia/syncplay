// Checks that quitting the app after a torrent session exits cleanly.
// Starts `electron-vite dev` in <app-dir>, resolves a magnet from the window
// (creating the WebTorrent session, incl. wss:// trackers), waits, asks Electron
// to quit gracefully over CDP and reports whether the process aborted.
//
// Usage: node scripts/bench-torrent/quit-check.mjs <app-dir> <magnet> [wait-seconds]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectToTarget, waitForTargets, waitForTestHook } from "../perf-shared.mjs";

const [appDir, magnet, waitArg = "12"] = process.argv.slice(2);
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CDP_PORT = 9333;
let output = "";
const app = spawn(path.join(repoDir, "apps/desktop/node_modules/.bin/electron-vite"), ["dev"], {
  cwd: path.join(appDir, "apps/desktop"),
  env: { ...process.env, SYNCPLAY_CDP_PORT: String(CDP_PORT) },
  stdio: ["ignore", "pipe", "pipe"]
});
for (const stream of [app.stdout, app.stderr]) stream.on("data", (data) => (output += data));
const exited = new Promise((resolve) => app.on("exit", resolve));

// The CDP endpoint only exists once Electron is up.
for (let attempt = 0; attempt < 360; attempt += 1) {
  if (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((response) => response.ok).catch(() => false)) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
// A dev-server reload (e.g. Vite re-optimizing deps) destroys the page's
// execution context; reconnect and retry instead of failing the check.
let summary = null;
for (let attempt = 1; attempt <= 5 && !summary; attempt += 1) {
  try {
    const [target] = await waitForTargets(CDP_PORT, 1, 180_000);
    const page = await connectToTarget(target);
    await waitForTestHook(page, "app test hook");
    summary = await page.evaluate(`window.syncplayDesktop.resolveMagnetLink(${JSON.stringify(magnet)}, {})`);
  } catch (error) {
    if (!/context was destroyed|connection closed|Cannot find context/i.test(String(error))) throw error;
    console.log(`retrying after page reload (attempt ${attempt}): ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await new Promise((resolve) => setTimeout(resolve, Number(waitArg) * 1000));
// Quit like the OS/user does: SIGTERM to the Electron process runs Electron's
// graceful shutdown (before-quit, then Node environment teardown).
const { execSync } = await import("node:child_process");
const electronPid = Number(execSync(`lsof -t -iTCP:${CDP_PORT} -sTCP:LISTEN`).toString().trim().split("\n")[0]);
const reportsBefore = new Set(execSync("ls ~/Library/Logs/DiagnosticReports").toString().split("\n"));
process.kill(electronPid, "SIGTERM");
const timeout = setTimeout(() => app.kill("SIGKILL"), 20_000);
await exited;
clearTimeout(timeout);
await new Promise((resolve) => setTimeout(resolve, 4000)); // let ReportCrash write the report
const newCrashReports = execSync("ls ~/Library/Logs/DiagnosticReports")
  .toString()
  .split("\n")
  .filter((name) => name.startsWith("Electron") && name.endsWith(".ips") && !reportsBefore.has(name));
const aborted = /SIGABRT/.test(output) || newCrashReports.length > 0;
console.log(JSON.stringify({ files: summary?.files?.length ?? 0, aborted, newCrashReports }));
process.exit(0);
