// Runs the local-file transfer benchmark with separate host and guest Electron
// processes. This script is the signaling hub between them and, when network
// options are given, routes all WebRTC traffic through a user-space emulator.
//
// Usage:
//   node scripts/bench-transfer/run.mjs <file> [--rounds=5] [--report=reports/x.json]
//     [--variants=legacy,current] [--scenario=throughput|blackout]
//     [--rate-mbps=20] [--rtt-ms=40] [--loss=0.005] [--queue-ms=100]
//     [--sustained-mib=64] [--blackout-ms=5000] [--blackout-transfer-mib=24]
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNetem, parseCandidate } from "./netem.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronBin = path.resolve(scriptDir, "../../apps/desktop/node_modules/.bin/electron");
const mainScript = path.join(scriptDir, "main.cjs");

const [filePath, ...flagArgs] = process.argv.slice(2);
const flags = Object.fromEntries(
  flagArgs.map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
if (!filePath) {
  console.error("Usage: node scripts/bench-transfer/run.mjs <file> [--flags]");
  process.exit(1);
}

const rateMbps = Number(flags["rate-mbps"] ?? 0);
const rttMs = Number(flags["rtt-ms"] ?? 0);
const lossRate = Number(flags.loss ?? 0);
const maxQueueMs = Number(flags["queue-ms"] ?? 100);
const scenario = flags.scenario ?? "throughput";
const emulateNetwork = rateMbps > 0 || rttMs > 0 || lossRate > 0 || scenario === "blackout";
const reportPath = flags.report ?? `reports/bench-transfer-${scenario}.json`;
const guestOptions = {
  reportPath,
  rounds: flags.rounds ?? "5",
  variants: flags.variants ?? "legacy,current",
  scenario,
  sustainedMiB: flags["sustained-mib"] ?? "1000000",
  blackoutMs: flags["blackout-ms"] ?? "5000",
  blackoutTransferMiB: flags["blackout-transfer-mib"] ?? "24",
  rawMiB: flags["raw-mib"] ?? "32"
};

const netem = emulateNetwork ? createNetem({ rateMbps, rttMs, lossRate, maxQueueMs }) : null;

// --- Signaling hub -------------------------------------------------------------
const sockets = {};
const pending = { host: [], guest: [] };
const send = (role, message) => {
  if (sockets[role]) sockets[role].write(`${JSON.stringify(message)}\n`);
  else pending[role].push(message);
};

async function route(fromRole, message) {
  if (message.type === "netem-blackout") {
    netem?.blackout(message.ms);
    return;
  }
  const toRole = fromRole === "host" ? "guest" : "host";
  if (netem && message.type === "candidate") {
    // The guest only ever learns proxied host candidates; the host discovers the
    // guest as a peer-reflexive candidate through the proxy. Everything else is
    // dropped so traffic cannot bypass the emulator.
    if (fromRole === "guest") return;
    const parsed = parseCandidate(message.candidate.candidate);
    if (!parsed) return;
    const proxyPort = await netem.proxyTo(parsed.address, parsed.port, parsed.address);
    message = { ...message, candidate: { ...message.candidate, candidate: parsed.rewrite(parsed.address, proxyPort) } };
  }
  send(toRole, message);
}

const server = net.createServer((socket) => {
  let role = null;
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    buffered += data;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Not one of our Electron processes (e.g. a local port probe).
        socket.destroy();
        return;
      }
      if (message.type === "hello") {
        role = message.role;
        sockets[role] = socket;
        for (const queued of pending[role].splice(0)) send(role, queued);
        continue;
      }
      void route(role, message);
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = String(server.address().port);

// --- Electron processes --------------------------------------------------------
let udpSendErrors = 0;
const quietChromium = (line) => {
  if (/UDP send of .* failed/.test(line)) udpSendErrors += 1;
  return !/stun_port|dcsctp_transport|rtc_data_channel|^\s*$/.test(line);
};
const launch = (role, extraArgs) => {
  const child = spawn(electronBin, [mainScript, role, port, filePath, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (data) => {
      for (const line of data.split("\n").filter(quietChromium)) {
        if (line.includes('"mode"') || line.includes("failed")) console.log(line);
      }
    });
  }
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
};

console.log(
  `scenario=${scenario} network=${emulateNetwork ? `${rateMbps || "∞"} Mbps, RTT ${rttMs} ms, loss ${lossRate * 100}%` : "loopback"}`
);
const hostExit = launch("host", []);
const guestExitCode = await launch("guest", [JSON.stringify(guestOptions)]);
await hostExit;
netem?.close();
server.close();

const report = JSON.parse(await readFile(reportPath, "utf8"));
if (report.summary.error) {
  console.error(report.summary.error);
  process.exit(1);
}
report.network = emulateNetwork ? { rateMbps, rttMs, lossRate, maxQueueMs, proxyStats: netem.stats() } : "loopback";
report.chromiumUdpSendErrors = udpSendErrors;
console.log(`chromium UDP send errors: ${udpSendErrors}${netem ? `, proxy ${JSON.stringify(netem.stats())}` : ""}`);
await import("node:fs/promises").then((fs) => fs.writeFile(reportPath, JSON.stringify(report, null, 2)));

const fmt = (metric, digits = 0) => (metric ? metric.median.toFixed(digits) : "n/a");
if (scenario === "raw") {
  for (const [mode, s] of Object.entries(report.summary)) console.log(`${mode.padEnd(14)} raw MiB/s ${fmt(s.rawMiBps, 1)}`);
} else if (scenario === "blackout") {
  console.log("\nmedians        completed  resume after network back (ms)  total ms  redundant MiB  peers  ICE restarts");
  for (const [mode, s] of Object.entries(report.summary)) {
    console.log(
      [
        mode.padEnd(14),
        `${s.completedRuns}/${s.runs}`.padStart(9),
        fmt(s.resumeAfterNetworkBackMs).padStart(31),
        fmt(s.totalMs).padStart(9),
        fmt(s.redundantMiB, 1).padStart(14),
        fmt(s.peersCreated).padStart(6),
        fmt(s.iceRestarts).padStart(13)
      ].join(" ")
    );
  }
} else {
  console.log("\nmedians                  connect ms  startup ms  seek ms  MiB/s  host CPU ms/MiB  guest CPU ms/MiB");
  for (const [mode, s] of Object.entries(report.summary)) {
    console.log(
      [
        mode.padEnd(24),
        fmt(s.connectMs).padStart(10),
        fmt(s.startupMs).padStart(11),
        fmt(s.seekMs).padStart(8),
        fmt(s.sustainedMiBps, 1).padStart(6),
        fmt(s.hostCpuMsPerMiB, 1).padStart(16),
        fmt(s.guestCpuMsPerMiB, 1).padStart(17)
      ].join(" ")
    );
  }
}
process.exit(guestExitCode ?? 0);
