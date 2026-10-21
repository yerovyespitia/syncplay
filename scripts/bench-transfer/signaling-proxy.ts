// Sits between the desktop app and the SyncPlay server so the *real* app can be
// benchmarked over an emulated network. HTTP and WebSocket traffic is relayed
// untouched, except ICE candidates: the guest only receives proxied host
// candidates and the host receives none, so every WebRTC packet crosses the
// user-space emulator in netem.mjs.
//
// Usage: bun scripts/bench-transfer/signaling-proxy.ts --listen=8799 --server=http://127.0.0.1:8787
//          [--rate-mbps=30] [--rtt-ms=80] [--loss=0.001] [--queue-ms=80]
// Blackouts: POST http://127.0.0.1:<listen>/__netem/blackout?ms=10000
import { lookup } from "node:dns/promises";

import { createNetem, parseCandidate } from "./netem.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);
const listenPort = Number(flags.listen ?? 8799);
const serverUrl = new URL(flags.server ?? "http://127.0.0.1:8787");
const netem = createNetem({
  rateMbps: Number(flags["rate-mbps"] ?? 0),
  rttMs: Number(flags["rtt-ms"] ?? 0),
  lossRate: Number(flags.loss ?? 0),
  maxQueueMs: Number(flags["queue-ms"] ?? 100)
});

type ClientData = { upstream: WebSocket | null; queued: string[]; isGuest: boolean };

async function rewriteForClient(raw: string, client: ClientData) {
  const message = JSON.parse(raw);
  if (message.type === "peer_offer") client.isGuest = true;
  if (message.type !== "peer_ice_candidate") return raw;
  // The host discovers the guest as a peer-reflexive candidate via the proxy.
  if (!client.isGuest) return null;
  const parsed = parseCandidate(message.payload.candidate.candidate ?? "");
  if (!parsed) return null;
  // macOS resolves Chromium's ".local" mDNS names through Bonjour.
  const address = parsed.address.endsWith(".local")
    ? await lookup(parsed.address, { family: 4 }).then((result) => result.address).catch(() => null)
    : parsed.address;
  if (address === null) return null;
  const proxyPort = await netem.proxyTo(address, parsed.port, address).catch(() => null);
  if (proxyPort === null) return null;
  message.payload.candidate = { ...message.payload.candidate, candidate: parsed.rewrite(address, proxyPort) };
  return JSON.stringify(message);
}

const server = Bun.serve<ClientData, never>({
  port: listenPort,
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/__netem/blackout") {
      netem.blackout(Number(url.searchParams.get("ms") ?? 5000));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__netem/stats") return Response.json(netem.stats());
    if (url.pathname === "/ws") {
      return srv.upgrade(request, { data: { upstream: null, queued: [], isGuest: false } })
        ? undefined
        : new Response("Upgrade failed", { status: 400 });
    }
    const target = new URL(url.pathname + url.search, serverUrl);
    return fetch(target, { method: request.method, headers: request.headers, body: request.body });
  },
  websocket: {
    open(ws) {
      const upstreamUrl = new URL("/ws", serverUrl);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      const upstream = new WebSocket(upstreamUrl);
      ws.data.upstream = upstream;
      // Preserve ordering even though candidate rewriting is asynchronous.
      let delivery = Promise.resolve();
      upstream.addEventListener("open", () => {
        for (const message of ws.data.queued.splice(0)) upstream.send(message);
      });
      upstream.addEventListener("message", (event) => {
        const raw = String(event.data);
        delivery = delivery.then(async () => {
          const rewritten = await rewriteForClient(raw, ws.data);
          if (rewritten !== null) ws.send(rewritten);
        });
      });
      upstream.addEventListener("close", () => ws.close());
    },
    message(ws, message) {
      const upstream = ws.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(String(message));
      else ws.data.queued.push(String(message));
    },
    close(ws) {
      ws.data.upstream?.close();
    }
  }
});

console.log(`signaling proxy on http://127.0.0.1:${server.port} -> ${serverUrl.href} (${JSON.stringify(flags)})`);
