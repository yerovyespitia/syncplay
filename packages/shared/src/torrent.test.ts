import { describe, expect, test } from "bun:test";

import { MAX_TORRENT_PEER_HINTS, parseTorrentPeerHint, sanitizeTorrentPeerHints } from "./torrent";

describe("parseTorrentPeerHint", () => {
  test("accepts ipv4:port", () => {
    expect(parseTorrentPeerHint("192.168.1.20:6881")).toEqual({ host: "192.168.1.20", port: 6881 });
  });

  test("rejects malformed hosts and ports", () => {
    for (const hint of ["256.1.1.1:80", "10.0.0.1:0", "10.0.0.1:70000", "example.com:80", "10.0.0.1", 42, null]) {
      expect(parseTorrentPeerHint(hint)).toBeNull();
    }
  });
});

describe("sanitizeTorrentPeerHints", () => {
  test("keeps LAN hints and adds the observed public address on the same port", () => {
    expect(sanitizeTorrentPeerHints(["192.168.1.20:6881", "10.0.0.5:6881"], "::ffff:203.0.113.7")).toEqual([
      "203.0.113.7:6881",
      "192.168.1.20:6881",
      "10.0.0.5:6881"
    ]);
  });

  test("drops public addresses claimed by the client and junk", () => {
    expect(sanitizeTorrentPeerHints(["8.8.8.8:53", "nope", "172.20.0.2:51413"], "198.51.100.4")).toEqual([
      "198.51.100.4:51413",
      "172.20.0.2:51413"
    ]);
  });

  test("returns nothing without a valid hint and caps the list", () => {
    expect(sanitizeTorrentPeerHints(undefined, "198.51.100.4")).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) => `10.0.0.${index + 1}:6881`);
    expect(sanitizeTorrentPeerHints(many, "198.51.100.4")).toHaveLength(MAX_TORRENT_PEER_HINTS);
  });
});
