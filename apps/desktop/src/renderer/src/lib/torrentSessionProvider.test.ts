/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { buildTorrentMediaFiles, isChromiumMagnetBrowser, mergeTorrentTrackers } from "./torrentSessionProvider";

describe("torrentSessionProvider helpers", () => {
  test("detects Chromium desktop browsers as supported", () => {
    expect(
      isChromiumMagnetBrowser(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
      )
    ).toBe(true);
    expect(
      isChromiumMagnetBrowser(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/135.0.0.0 Safari/537.36"
      )
    ).toBe(true);
  });

  test("rejects unsupported browsers for web magnet support", () => {
    expect(
      isChromiumMagnetBrowser(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
      )
    ).toBe(false);
    expect(
      isChromiumMagnetBrowser(
        "Mozilla/5.0 (X11; Linux x86_64; rv:136.0) Gecko/20100101 Firefox/136.0"
      )
    ).toBe(false);
  });

  test("merges default and magnet-provided trackers without duplicates", () => {
    const trackers = mergeTorrentTrackers(
      "magnet:?xt=urn:btih:abcdef&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&tr=wss%3A%2F%2Fexample.com%2Fannounce"
    );

    expect(trackers).toContain("wss://tracker.openwebtorrent.com");
    expect(trackers).toContain("wss://example.com/announce");
    expect(trackers.filter((tracker) => tracker === "wss://tracker.openwebtorrent.com")).toHaveLength(1);
  });

  test("keeps only playable video files when building torrent metadata", () => {
    const files = buildTorrentMediaFiles({
      files: [
        { name: "movie.mkv", path: "movie.mkv", length: 1024 },
        { name: "poster.jpg", path: "poster.jpg", length: 128 },
        { name: "clip.mp4", path: "clip.mp4", length: 512 }
      ]
    });

    expect(files).toEqual([
      {
        index: 0,
        name: "movie.mkv",
        path: "movie.mkv",
        size: 1024,
        mimeType: "video/x-matroska"
      },
      {
        index: 2,
        name: "clip.mp4",
        path: "clip.mp4",
        size: 512,
        mimeType: "video/mp4"
      }
    ]);
  });
});
