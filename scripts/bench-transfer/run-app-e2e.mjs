// End-to-end benchmark of the real desktop app over an emulated network.
// Starts the SyncPlay server, the signaling proxy (netem), and `electron-vite
// dev` from <app-dir>, then runs scripts/perf-local-file.mjs against it.
//
// Usage: node scripts/bench-transfer/run-app-e2e.mjs <app-dir> <media-file> <iterations> <report.json> [netem flags...]
//   e.g. ... /tmp/syncplay-bench/new bench.mp4 3 reports/e2e-new.json --rate-mbps=30 --rtt-ms=80 --queue-ms=80
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "../..");
const [appDir, mediaFile, iterations = "3", reportPath, ...netemFlags] = process.argv.slice(2);
if (!appDir || !mediaFile || !reportPath) {
  console.error("Usage: node run-app-e2e.mjs <app-dir> <media-file> <iterations> <report.json> [netem flags...]");
  process.exit(1);
}

const SERVER_PORT = 8787;
const PROXY_PORT = 8799;
const CDP_PORT = 9333;
const children = [];

function start(label, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(child);
  const prefix = `[${label}]`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (data) => {
      if (process.env.E2E_VERBOSE) process.stdout.write(data.replace(/^/gm, `${prefix} `));
    });
  }
  return child;
}

async function waitFor(label, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function stopAll() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

try {
  // Each app version runs against its own server code.
  start("server", "bun", ["apps/server/src/index.ts"], { cwd: appDir, env: { ...process.env, PORT: String(SERVER_PORT) }, detached: true });
  await waitFor("server", async () => (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).ok);

  start("proxy", "bun", [path.join(scriptDir, "signaling-proxy.ts"), `--listen=${PROXY_PORT}`, `--server=http://127.0.0.1:${SERVER_PORT}`, ...netemFlags], {
    detached: true
  });
  await waitFor("proxy", async () => (await fetch(`http://127.0.0.1:${PROXY_PORT}/__netem/stats`)).ok);

  start("app", path.join(repoDir, "apps/desktop/node_modules/.bin/electron-vite"), ["dev"], {
    cwd: path.join(appDir, "apps/desktop"),
    env: {
      ...process.env,
      VITE_SYNCPLAY_SERVER_URL: `http://127.0.0.1:${PROXY_PORT}`,
      SYNCPLAY_CDP_PORT: String(CDP_PORT)
    },
    detached: true
  });
  await waitFor("app CDP", async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).ok, 180_000);

  // E2E_SCRIPT swaps the harness (e.g. probe-guest.mjs) while keeping the stack.
  const harness = process.env.E2E_SCRIPT ?? path.join(repoDir, "scripts/perf-local-file.mjs");
  const perf = spawn("node", [harness, String(CDP_PORT), mediaFile, iterations, reportPath], {
    cwd: repoDir,
    stdio: "inherit"
  });
  const code = await new Promise((resolve) => perf.on("exit", resolve));
  const stats = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/__netem/stats`)).json();
  console.log(`netem stats: ${JSON.stringify(stats)}`);
  process.exitCode = code ?? 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  stopAll();
}
