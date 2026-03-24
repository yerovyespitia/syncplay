export interface ParsedYouTubeUrl {
  videoId: string;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be"
]);

export function parseYouTubeUrl(value: string): ParsedYouTubeUrl | null {
  try {
    const url = new URL(value.trim());

    if (!YOUTUBE_HOSTS.has(url.hostname)) {
      return null;
    }

    if (url.hostname === "youtu.be") {
      const videoId = url.pathname.split("/").filter(Boolean)[0];
      return videoId ? { videoId } : null;
    }

    if (url.pathname === "/watch") {
      const videoId = url.searchParams.get("v");
      return videoId ? { videoId } : null;
    }

    if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
      const [, , videoId] = url.pathname.split("/");
      return videoId ? { videoId } : null;
    }

    return null;
  } catch {
    return null;
  }
}

