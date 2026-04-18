import type {
  DesktopApi,
  PickedLocalFile,
  ResolveMagnetOptions,
  TorrentMagnetMediaSource,
  TorrentMediaFile,
  TorrentSessionSummary
} from "@syncplay/shared";
const DEFAULT_TORRENT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.files.fm:7073/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
];

export type WebTorrentSelectedFile = TorrentMagnetMediaSource & {
  __kind: "web_torrent_selected_file";
  sessionId: string;
  fileIndex: number;
  playbackUrl: string;
  readChunk(offset: number, length: number): Promise<Uint8Array>;
  releasePlaybackUrl(): void;
};

export type SelectedTorrentFileSource = PickedLocalFile | WebTorrentSelectedFile;

export interface TorrentSessionProvider {
  kind: "desktop" | "web";
  isSupported: boolean;
  unsupportedReason?: string;
  resolveMagnetLink(magnetUri: string, options?: ResolveMagnetOptions): Promise<TorrentSessionSummary>;
  selectTorrentFile(sessionId: string, fileIndex: number): Promise<SelectedTorrentFileSource>;
  getTorrentSessionStatus(sessionId: string): Promise<TorrentSessionSummary | null>;
  disposeTorrentSession(sessionId: string): Promise<void>;
}

export function isWebTorrentSelectedFile(value: unknown): value is WebTorrentSelectedFile {
  return Boolean(
    value &&
      typeof value === "object" &&
      "__kind" in value &&
      (value as { __kind?: string }).__kind === "web_torrent_selected_file"
  );
}

export function isChromiumMagnetBrowser(userAgent = navigator.userAgent) {
  const normalized = userAgent.toLowerCase();
  const isDesktopClassBrowser = !/android|iphone|ipad|ipod/.test(normalized);
  const isChromiumFamily =
    /chrome\/|chromium\/|edg\//.test(normalized) && !/opr\/|opera|firefox|fxios/.test(normalized);

  return isDesktopClassBrowser && isChromiumFamily;
}

export function inferTorrentMimeType(filePath: string) {
  const normalized = filePath.toLowerCase();

  if (normalized.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (normalized.endsWith(".m4v")) {
    return "video/x-m4v";
  }

  if (normalized.endsWith(".mkv")) {
    return "video/x-matroska";
  }

  if (normalized.endsWith(".avi")) {
    return "video/x-msvideo";
  }

  if (normalized.endsWith(".ts")) {
    return "video/mp2t";
  }

  if (normalized.endsWith(".webm")) {
    return "video/webm";
  }

  if (normalized.endsWith(".ogg") || normalized.endsWith(".ogv")) {
    return "video/ogg";
  }

  if (normalized.endsWith(".mov")) {
    return "video/quicktime";
  }

  return "application/octet-stream";
}

export function mergeTorrentTrackers(magnetUri: string) {
  const magnetUrl = new URL(magnetUri);
  const trackers = new Set(DEFAULT_TORRENT_TRACKERS);

  for (const tracker of magnetUrl.searchParams.getAll("tr")) {
    if (tracker) {
      trackers.add(tracker);
    }
  }

  return Array.from(trackers);
}

export function buildTorrentMediaFiles(torrent: { files: Array<{ name: string; path: string; length: number }> }) {
  return torrent.files
    .map((file, index) => ({
      index,
      name: file.name,
      path: file.path,
      size: file.length,
      mimeType: inferTorrentMimeType(file.name)
    }))
    .filter((file) => file.mimeType.startsWith("video/"));
}

function createDesktopTorrentProvider(desktopApi: DesktopApi): TorrentSessionProvider {
  return {
    kind: "desktop",
    isSupported: true,
    resolveMagnetLink: (magnetUri, options) => desktopApi.resolveMagnetLink(magnetUri, options),
    selectTorrentFile: (sessionId, fileIndex) => desktopApi.selectTorrentFile(sessionId, fileIndex),
    getTorrentSessionStatus: (sessionId) => desktopApi.getTorrentSessionStatus(sessionId),
    disposeTorrentSession: (sessionId) => desktopApi.disposeTorrentSession(sessionId)
  };
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T;
  }

  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  throw new Error(body?.message ?? "Torrent request failed.");
}

function buildTorrentApiUrl(pathname: string) {
  const proxyBaseUrl = import.meta.env.VITE_SYNCPLAY_TORRENT_PROXY_URL ?? "http://127.0.0.1:8788";
  return new URL(pathname, proxyBaseUrl).toString();
}

function createWebTorrentProvider(): TorrentSessionProvider {
  return {
    kind: "web",
    isSupported: true,
    resolveMagnetLink: async (magnetUri, options) => {
      if (typeof magnetUri !== "string" || !magnetUri.trim().startsWith("magnet:?")) {
        throw new Error("Enter a valid magnet link.");
      }

      const response = await fetch(buildTorrentApiUrl("/api/torrents/resolve"), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          magnetUri: magnetUri.trim(),
          forceIsolatedTorrentSession: Boolean(options?.forceIsolatedTorrentSession)
        })
      });

      return parseApiResponse<TorrentSessionSummary>(response);
    },
    selectTorrentFile: async (sessionId, fileIndex) => {
      const response = await fetch(buildTorrentApiUrl(`/api/torrents/${encodeURIComponent(sessionId)}/select`), {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fileIndex
        })
      });
      const selectedFile = await parseApiResponse<
        TorrentMagnetMediaSource & { sessionId: string; fileIndex: number }
      >(response);
      const playbackUrl = buildTorrentApiUrl(
        `/api/torrents/${encodeURIComponent(selectedFile.sessionId)}/files/${selectedFile.fileIndex}/${encodeURIComponent(selectedFile.fileName)}`
      );

      const source: WebTorrentSelectedFile = {
        __kind: "web_torrent_selected_file",
        ...selectedFile,
        playbackUrl,
        readChunk: async (offset, length) => {
          const chunkResponse = await fetch(playbackUrl, {
            headers: {
              range: `bytes=${offset}-${offset + length - 1}`
            }
          });

          if (!chunkResponse.ok) {
            throw new Error("Could not read torrent video chunk.");
          }

          return new Uint8Array(await chunkResponse.arrayBuffer());
        },
        releasePlaybackUrl: () => undefined
      };

      return source;
    },
    getTorrentSessionStatus: async (sessionId) => {
      const response = await fetch(buildTorrentApiUrl(`/api/torrents/${encodeURIComponent(sessionId)}/status`));
      return parseApiResponse<TorrentSessionSummary | null>(response);
    },
    disposeTorrentSession: async (sessionId) => {
      await fetch(buildTorrentApiUrl(`/api/torrents/${encodeURIComponent(sessionId)}`), {
        method: "DELETE"
      });
    }
  };
}

export function createTorrentSessionProvider(desktopApi?: DesktopApi): TorrentSessionProvider {
  if (desktopApi) {
    return createDesktopTorrentProvider(desktopApi);
  }

  return createWebTorrentProvider();
}
