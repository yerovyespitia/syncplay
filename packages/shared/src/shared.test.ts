import { describe, expect, test } from "bun:test";

import type { MediaSource } from "./index";

import { normalizeRoomId, parseYouTubeUrl } from "./index";

describe("parseYouTubeUrl", () => {
  test("supports watch urls", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      videoId: "dQw4w9WgXcQ"
    });
  });

  test("supports short urls", () => {
    expect(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      videoId: "dQw4w9WgXcQ"
    });
  });

  test("rejects non-youtube urls", () => {
    expect(parseYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});

describe("room helpers", () => {
  test("normalizes room ids", () => {
    expect(normalizeRoomId(" ab-12z ")).toBe("AB12Z");
  });
});

describe("media sources", () => {
  test("supports youtube source shape", () => {
    const source: MediaSource = {
      type: "youtube",
      videoId: "abc123"
    };

    expect(source.type).toBe("youtube");
  });

  test("supports local file source shape", () => {
    const source: MediaSource = {
      type: "local_file",
      mediaId: "media-1",
      fileName: "movie.mp4",
      fileSize: 2048,
      mimeType: "video/mp4"
    };

    expect(source.type).toBe("local_file");
  });
});
