// Minimal user-space network emulator for WebRTC benchmarks. Each remote ICE
// candidate is replaced by a UDP proxy port; packets crossing it are shaped
// with a bandwidth cap (drop-tail queue), one-way delay, random loss, and
// optional blackouts. No root privileges required.
import dgram from "node:dgram";

export function createNetem({ rateMbps = 0, rttMs = 0, lossRate = 0, maxQueueMs = 300, seed = 1 } = {}) {
  const bytesPerMs = rateMbps > 0 ? (rateMbps * 1_000_000) / 8 / 1000 : Infinity;
  const oneWayDelayMs = rttMs / 2;
  const sockets = [];
  let blackoutUntil = 0;
  const stats = { forwarded: 0, droppedLoss: 0, droppedQueue: 0, droppedBlackout: 0 };

  // Deterministic PRNG (mulberry32) so loss patterns are identical across variants.
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Packets leave each link strictly in arrival order. Scheduling one
  // setTimeout per packet would reorder them (timers truncate fractional ms),
  // which SCTP reads as loss and answers by shrinking its congestion window.
  function createLink() {
    let nextDepartureAt = 0;
    const queue = [];
    let timer = null;

    const drain = () => {
      timer = null;
      const now = performance.now();
      while (queue.length > 0 && queue[0].dueAt <= now + 0.5) {
        const { packet, send } = queue.shift();
        send(packet);
      }
      if (queue.length > 0) timer = setTimeout(drain, Math.max(0, queue[0].dueAt - performance.now()));
    };

    return (packet, send) => {
      const now = performance.now();
      if (now < blackoutUntil) {
        stats.droppedBlackout += 1;
        return;
      }
      if (lossRate > 0 && random() < lossRate) {
        stats.droppedLoss += 1;
        return;
      }
      const departureStart = Math.max(now, nextDepartureAt);
      if (departureStart - now > maxQueueMs) {
        stats.droppedQueue += 1;
        return;
      }
      nextDepartureAt = departureStart + packet.length / bytesPerMs;
      stats.forwarded += 1;
      queue.push({ packet, send, dueAt: nextDepartureAt + oneWayDelayMs });
      if (timer === null) timer = setTimeout(drain, Math.max(0, queue[0].dueAt - now));
    };
  }

  // Shared links so every proxied candidate competes for the same bandwidth,
  // like a single home connection.
  const toTarget = createLink();
  const toClient = createLink();

  // Returns a local port that forwards to targetAddress:targetPort.
  async function proxyTo(targetAddress, targetPort, bindAddress) {
    // Large kernel buffers so the proxy itself never drops bursts.
    const socket = dgram.createSocket({ type: "udp4", recvBufferSize: 4 * 1024 * 1024, sendBufferSize: 4 * 1024 * 1024 });
    sockets.push(socket);
    let clientAddress = null;
    socket.on("message", (packet, remote) => {
      if (remote.address === targetAddress && remote.port === targetPort) {
        if (clientAddress) toClient(packet, (data) => socket.send(data, clientAddress.port, clientAddress.address));
        return;
      }
      clientAddress = { address: remote.address, port: remote.port };
      toTarget(packet, (data) => socket.send(data, targetPort, targetAddress));
    });
    await new Promise((resolve) => socket.bind(0, bindAddress, resolve));
    return socket.address().port;
  }

  return {
    proxyTo,
    blackout(durationMs) {
      blackoutUntil = performance.now() + durationMs;
    },
    stats: () => ({ ...stats }),
    close() {
      for (const socket of sockets) socket.close();
    }
  };
}

// Rewrites "candidate:<foundation> <component> udp <priority> <ip> <port> typ ..."
// to point at a proxy. Returns null for candidates the benchmark cannot proxy.
export function parseCandidate(candidate) {
  const parts = candidate.split(" ");
  // Only local "host" candidates can be proxied (we can bind their address).
  if (parts.length < 8 || parts[2].toLowerCase() !== "udp" || parts[6] !== "typ" || parts[7] !== "host") return null;
  // IPv4 literals, or Chromium's mDNS-obfuscated host names (resolved by the caller).
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(parts[4]) && !parts[4].endsWith(".local")) return null;
  return {
    address: parts[4],
    port: Number(parts[5]),
    rewrite: (address, port) => [...parts.slice(0, 4), address, String(port), ...parts.slice(6)].join(" ")
  };
}
