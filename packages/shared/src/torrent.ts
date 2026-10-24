// Peer hints let a guest connect straight to the room host's torrent client,
// which already has the pieces near the start and unchokes immediately, instead
// of waiting 10+ s for public peers to unchoke a newcomer.

export const MAX_TORRENT_PEER_HINTS = 8;

export function parseTorrentPeerHint(hint: unknown): { host: string; port: number } | null {
  if (typeof hint !== "string") {
    return null;
  }

  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(hint.trim());

  if (!match) {
    return null;
  }

  const octets = match[1].split(".").map(Number);
  const port = Number(match[2]);

  if (octets.some((octet) => octet > 255) || port < 1 || port > 65535) {
    return null;
  }

  return { host: octets.join("."), port };
}

export function isPrivateOrLoopbackIPv4(host: string) {
  const [a, b] = host.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Keeps only well-formed LAN/loopback `ip:port` hints sent by the host and adds
 * the host's address as seen by the server (its public IP) on the same port.
 */
export function sanitizeTorrentPeerHints(hints: unknown, observedHostAddress?: string): string[] {
  const parsed = (Array.isArray(hints) ? hints : [])
    .map(parseTorrentPeerHint)
    .filter((hint): hint is { host: string; port: number } => hint !== null && isPrivateOrLoopbackIPv4(hint.host));
  const port = parsed[0]?.port;
  const observedHost = observedHostAddress?.replace(/^::ffff:/, "");
  const observed = port !== undefined ? parseTorrentPeerHint(`${observedHost}:${port}`) : null;
  const all = [...(observed ? [observed] : []), ...parsed].map((hint) => `${hint.host}:${hint.port}`);
  return [...new Set(all)].slice(0, MAX_TORRENT_PEER_HINTS);
}
