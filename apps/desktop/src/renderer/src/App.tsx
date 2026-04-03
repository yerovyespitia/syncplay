import { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopApi, PickedLocalFile, TorrentSessionSummary } from "@syncplay/shared";
import { parseYouTubeUrl } from "@syncplay/shared";

import appleDarkIcon from "./assets/apple-dark.svg";
import electronIcon from "./assets/electron.svg";
import linuxIcon from "./assets/linux.svg";
import windowsIcon from "./assets/windows.svg";
import { RoomPanel } from "./components/RoomPanel";
import { SyncPlayLogo } from "./components/SyncPlayLogo";
import { useRoomConnection } from "./hooks/useRoomConnection";
import {
  createTorrentSessionProvider,
  type SelectedTorrentFileSource,
  type WebTorrentSelectedFile
} from "./lib/torrentSessionProvider";

type SourceOption = "youtube" | "local_file" | "torrent_magnet";

function createFallbackTorrentSession(magnetUri: string, message: string): TorrentSessionSummary {
  return {
    sessionId: "",
    magnetUri,
    infoHash: "",
    displayName: "Unavailable",
    phase: "failed",
    files: [],
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    peerCount: 0,
    message
  };
}

function formatPlatformLabel(value: string) {
  const normalized = value.toLowerCase();

  if (normalized.includes("mac") || normalized.includes("darwin")) {
    return "macOS";
  }

  if (normalized.includes("win")) {
    return "Windows";
  }

  if (normalized.includes("linux")) {
    return "Linux";
  }

  return "Web";
}

function detectPlatformLabel() {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };
  const candidate =
    navigatorWithUserAgentData.userAgentData?.platform ||
    navigator.platform ||
    (typeof navigator.userAgent === "string" ? navigator.userAgent : "");

  return formatPlatformLabel(candidate);
}

function detectElectronVersion() {
  const match = navigator.userAgent.match(/Electron\/([\d.]+)/);
  return match?.[1] ?? "Web";
}

function detectSafariBrowser() {
  const userAgent = navigator.userAgent;
  const vendor = navigator.vendor;
  const isAppleVendor = /Apple/i.test(vendor);
  const isSafariEngine = /Safari/i.test(userAgent);
  const isExcludedBrowser = /Chrome|Chromium|CriOS|FxiOS|Firefox|EdgiOS|Edg|OPiOS|OPR|Android/i.test(userAgent);

  return isAppleVendor && isSafariEngine && !isExcludedBrowser;
}

function formatConnectionLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function PlatformIcon({ platformLabel }: { platformLabel: string }) {
  const normalized = platformLabel.toLowerCase();
  let iconSrc: string | null = null;

  if (normalized === "macos") {
    iconSrc = appleDarkIcon;
  } else if (normalized === "windows") {
    iconSrc = windowsIcon;
  } else if (normalized === "linux") {
    iconSrc = linuxIcon;
  }

  if (!iconSrc) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.93 9h-3.18a15.6 15.6 0 0 0-1.16-5.01A8.03 8.03 0 0 1 18.93 11Zm-6.18-6.93c.89 1.13 1.64 3.02 1.96 5.43h-5.42c.32-2.41 1.07-4.3 1.96-5.43.24-.03.5-.07.75-.07s.51.04.75.07ZM9.41 5.99A15.6 15.6 0 0 0 8.25 11H5.07a8.03 8.03 0 0 1 4.34-5.01ZM4.57 13h3.68c.09 1.83.48 3.57 1.16 5.01A8.03 8.03 0 0 1 4.57 13Zm6.72 6.93c-.89-1.13-1.64-3.02-1.96-5.43h5.42c-.32 2.41-1.07 4.3-1.96 5.43-.24.03-.5.07-.75.07s-.51-.04-.75-.07Zm3.3-1.92A15.6 15.6 0 0 0 15.75 13h3.18a8.03 8.03 0 0 1-4.34 5.01Z"
        />
      </svg>
    );
  }

  return <img src={iconSrc} alt="" aria-hidden="true" />;
}

function ConnectionStatusIcon({ status }: { status: string }) {
  if (status === "connected") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M9.55 18.2 4.8 13.45l1.4-1.4 3.35 3.35 8.25-8.25 1.4 1.4-9.65 9.65Z"
        />
      </svg>
    );
  }

  if (status === "connecting") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M12 3a1 1 0 0 1 1 1v1.05a7 7 0 0 1 5.95 5.95H20a1 1 0 1 1 0 2h-2a1 1 0 0 1-1-1 5 5 0 1 0-1.46 3.54 1 1 0 1 1 1.42 1.42A7 7 0 1 1 12 5V4a1 1 0 0 1 1-1Z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm4.7 13.3-1.4 1.4-3.3-3.3-3.3 3.3-1.4-1.4 3.3-3.3-3.3-3.3 1.4-1.4 3.3 3.3 3.3-3.3 1.4 1.4-3.3 3.3 3.3 3.3Z"
      />
    </svg>
  );
}

const fallbackDesktopApi: DesktopApi = {
  platform: detectPlatformLabel(),
  electronVersion: detectElectronVersion(),
  openDesktopWindow: async () => undefined,
  pickLocalFile: async () => null,
  pickLocalFileByPath: async () => null,
  resolveMagnetLink: async (magnetUri: string) =>
    createFallbackTorrentSession(magnetUri, "Magnet links are only available in the desktop app."),
  selectTorrentFile: async () => {
    throw new Error("Magnet links are only available in the desktop app.");
  },
  getTorrentSessionStatus: async () => null,
  disposeTorrentSession: async () => undefined,
  readLocalFile: async () => new Uint8Array(),
  readLocalFileChunk: async () => new Uint8Array(),
  createTempMediaCache: async () => ({
    cacheId: "",
    mediaUrl: "",
    fileUrl: "",
    httpUrl: "",
    localHttpUrl: ""
  }),
  writeTempMediaChunk: async () => undefined,
  markTempMediaRangeAvailable: async () => undefined,
  waitForTempMediaRange: async () => ({
    availableEndByte: 0
  }),
  getTempMediaStatus: async () => ({
    availableRanges: [],
    contiguousBytes: 0
  }),
  removeTempMediaCache: async () => undefined
};

export default function App() {
  const desktopApi = window.syncplayDesktop ?? fallbackDesktopApi;
  const isDev = import.meta.env.DEV;
  const hasDesktopBridge = Boolean(window.syncplayDesktop);
  const torrentSessionProvider = useMemo(() => createTorrentSessionProvider(window.syncplayDesktop), []);
  const platformLabel = formatPlatformLabel(desktopApi.platform || detectPlatformLabel());
  const electronVersionLabel = desktopApi.electronVersion || detectElectronVersion();
  const isSafariBrowser = useMemo(() => detectSafariBrowser(), []);
  const [sourceOption, setSourceOption] = useState<SourceOption>("youtube");
  const [videoUrl, setVideoUrl] = useState("");
  const [magnetLink, setMagnetLink] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [selectedLocalFile, setSelectedLocalFile] = useState<PickedLocalFile | WebTorrentSelectedFile | null>(null);
  const [selectedPlaybackFile, setSelectedPlaybackFile] = useState<SelectedTorrentFileSource | File | null>(null);
  const [torrentSession, setTorrentSession] = useState<TorrentSessionSummary | null>(null);
  const [isTorrentFileSelectOpen, setIsTorrentFileSelectOpen] = useState(false);
  const [isResolvingMagnet, setIsResolvingMagnet] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeTorrentSessionIdRef = useRef<string | null>(null);
  const {
    connectionStatus,
    room,
    remoteCommand,
    peerSignal,
    error,
    selfId,
    displayName,
    debugEntries,
    setDisplayName,
    pushDebugEntry,
    lastActionLabel,
    createRoom,
    joinRoom,
    leaveRoom,
    requestSync,
    sendChatMessage,
    updateTransferState,
    updateSubtitleTrack,
    sendPeerOffer,
    sendPeerAnswer,
    sendPeerIceCandidate,
    sendPlay,
    sendPause,
    sendSeek
  } = useRoomConnection();
  const shouldShowMagnetSupportWarning = sourceOption === "torrent_magnet" && !torrentSessionProvider.isSupported;
  const shouldBlockSafariMagnetFlow = sourceOption === "torrent_magnet" && isSafariBrowser;

  const parsedVideo = useMemo(() => parseYouTubeUrl(videoUrl), [videoUrl]);
  const canCreateRoom =
    sourceOption === "youtube"
      ? Boolean(parsedVideo)
      : sourceOption === "torrent_magnet"
        ? !shouldBlockSafariMagnetFlow && selectedLocalFile?.type === "torrent_magnet"
        : selectedLocalFile?.type === "local_file";
  const canJoinRoom = Boolean(roomCode.trim());

  async function disposeActiveTorrentSession() {
    const activeSessionId = activeTorrentSessionIdRef.current;

    activeTorrentSessionIdRef.current = null;
    setTorrentSession(null);

    if (!activeSessionId) {
      return;
    }

    try {
      await torrentSessionProvider.disposeTorrentSession(activeSessionId);
    } catch {
      // Best-effort cleanup for abandoned sessions.
    }
  }

  async function switchSourceOption(nextSourceOption: SourceOption) {
    if (nextSourceOption !== "torrent_magnet") {
      await disposeActiveTorrentSession();
    }

    setSourceOption(nextSourceOption);
    setSelectedLocalFile(null);
    setSelectedPlaybackFile(null);
    setLocalError(null);
  }

  useEffect(() => {
    if (!isDev) {
      return;
    }

    window.__syncplayTest = {
      getState: () => ({
        connectionStatus,
        room,
        selfId,
        sourceOption,
        roomCode,
        magnetLink,
        torrentSession,
        hasSelectedLocalFile: Boolean(selectedLocalFile),
        selectedLocalFile,
        debugEntries,
        localError,
        error,
        lastActionLabel
      }),
      selectSourceOption: (nextSourceOption: SourceOption) => {
        void switchSourceOption(nextSourceOption);
      },
      selectLocalFileByPath: async (filePath: string) => {
        const pickedFile = await desktopApi.pickLocalFileByPath(filePath);

        if (!pickedFile) {
          return null;
        }

        setSelectedLocalFile(pickedFile);
        setSelectedPlaybackFile(pickedFile);
        setLocalError(null);
        return pickedFile;
      },
      joinRoomByCode: (nextRoomCode: string) => {
        const normalizedRoomCode = nextRoomCode.trim().toUpperCase();
        setRoomCode(normalizedRoomCode);
        joinRoom(normalizedRoomCode);
      },
      createCurrentRoom: () => {
        handleCreateRoom();
      }
    };

    return () => {
      delete window.__syncplayTest;
    };
  }, [
    connectionStatus,
    error,
    isDev,
    joinRoom,
    lastActionLabel,
    localError,
    magnetLink,
    debugEntries,
    room,
    roomCode,
    selectedLocalFile,
    selfId,
    sourceOption,
    torrentSession
  ]);

  useEffect(() => {
    if (!torrentSession || !torrentSession.sessionId) {
      return;
    }

    activeTorrentSessionIdRef.current = torrentSession.sessionId;

    const intervalId = window.setInterval(() => {
      void torrentSessionProvider.getTorrentSessionStatus(torrentSession.sessionId).then((nextStatus) => {
        if (nextStatus) {
          setTorrentSession(nextStatus);
        }
      });
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [torrentSession, torrentSessionProvider]);

  useEffect(() => {
    return () => {
      void disposeActiveTorrentSession();
    };
  }, []);

  async function handlePickLocalFile() {
    await disposeActiveTorrentSession();
    if (window.syncplayDesktop) {
      const pickedFile = await desktopApi.pickLocalFile();

      if (!pickedFile) {
        return;
      }

      setSelectedLocalFile(pickedFile);
      setSelectedPlaybackFile(pickedFile);
      setLocalError(null);
      return;
    }

    fileInputRef.current?.click();
  }

  function handleLocalFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const browserFile = event.target.files?.[0];

    if (!browserFile) {
      return;
    }

    const pickedFile: PickedLocalFile = {
      type: "local_file",
      mediaId: crypto.randomUUID(),
      fileId: crypto.randomUUID(),
      fileUrl: URL.createObjectURL(browserFile),
      streamUrl: "",
      fileName: browserFile.name,
      fileSize: browserFile.size,
      mimeType: browserFile.type || "application/octet-stream"
    };

    setSelectedPlaybackFile(browserFile);
    setSelectedLocalFile(pickedFile);
    setLocalError(null);
  }

  async function handleResolveMagnet() {
    if (shouldBlockSafariMagnetFlow) {
      setLocalError("Magnet links are limited in Safari. For the full experience, we recommend using Chrome.");
      return;
    }

    if (!magnetLink.trim()) {
      setLocalError("Paste a magnet link first.");
      return;
    }

    await disposeActiveTorrentSession();
    setSelectedLocalFile(null);
    setSelectedPlaybackFile(null);
    setIsResolvingMagnet(true);

    try {
      const nextSession = await torrentSessionProvider.resolveMagnetLink(magnetLink.trim());
      setTorrentSession(nextSession);
      activeTorrentSessionIdRef.current = nextSession.sessionId || null;

      if (nextSession.phase === "failed") {
        setLocalError(nextSession.message ?? "Could not resolve magnet link.");
        return;
      }

      if (nextSession.files.length === 1) {
        const autoSelectedFile = await torrentSessionProvider.selectTorrentFile(nextSession.sessionId, nextSession.files[0].index);
        setSelectedLocalFile(autoSelectedFile);
        setSelectedPlaybackFile(autoSelectedFile);
        const latestStatus = await torrentSessionProvider.getTorrentSessionStatus(nextSession.sessionId);
        if (latestStatus) {
          setTorrentSession(latestStatus);
        }
        setLocalError(null);
        return;
      }

      setLocalError(null);
    } catch (resolveError) {
      setLocalError(resolveError instanceof Error ? resolveError.message : "Could not resolve magnet link.");
    } finally {
      setIsResolvingMagnet(false);
    }
  }

  async function handleSelectTorrentFile(fileIndex: number) {
    if (!torrentSession?.sessionId) {
      return;
    }

    try {
      const pickedFile = await torrentSessionProvider.selectTorrentFile(torrentSession.sessionId, fileIndex);
      setSelectedLocalFile(pickedFile);
      setSelectedPlaybackFile(pickedFile);
      const latestStatus = await torrentSessionProvider.getTorrentSessionStatus(torrentSession.sessionId);
      if (latestStatus) {
        setTorrentSession(latestStatus);
      }
      setLocalError(null);
    } catch (selectionError) {
      setLocalError(selectionError instanceof Error ? selectionError.message : "Could not open torrent video.");
    }
  }

  function handleCreateRoom() {
    if (sourceOption === "youtube") {
      if (!parsedVideo) {
        setLocalError("Paste a valid YouTube URL to create a room.");
        return;
      }

      createRoom({
        type: "youtube",
        videoId: parsedVideo.videoId
      });
      setLocalError(null);
      return;
    }

    if (sourceOption === "torrent_magnet") {
      if (shouldBlockSafariMagnetFlow) {
        setLocalError("Magnet-link rooms are disabled in Safari. For the full experience, we recommend using Chrome.");
        return;
      }

      if (!selectedLocalFile || selectedLocalFile.type !== "torrent_magnet") {
        setLocalError("Resolve the magnet link and choose a video file first.");
        return;
      }

      createRoom({
        type: "torrent_magnet",
        magnetUri: selectedLocalFile.magnetUri,
        infoHash: selectedLocalFile.infoHash,
        mediaId: selectedLocalFile.mediaId,
        fileName: selectedLocalFile.fileName,
        fileSize: selectedLocalFile.fileSize,
        mimeType: selectedLocalFile.mimeType
      });
      setLocalError(null);
      return;
    }

    if (!selectedLocalFile) {
      setLocalError("Choose a local video file first.");
      return;
    }

    createRoom({
      type: "local_file",
      mediaId: selectedLocalFile.mediaId,
      fileName: selectedLocalFile.fileName,
      fileSize: selectedLocalFile.fileSize,
      mimeType: selectedLocalFile.mimeType
    });
    setLocalError(null);
  }

  function handleJoinRoom() {
    if (!roomCode.trim()) {
      setLocalError("Enter a room code first.");
      return;
    }

    setLocalError(null);
    joinRoom(roomCode);
  }

  async function handleLeaveRoom() {
    leaveRoom();
    await disposeActiveTorrentSession();
    setSelectedLocalFile(null);
    setSelectedPlaybackFile(null);
  }

  function renderTorrentStatus() {
    if (!torrentSession) {
      return "Paste a magnet link, resolve metadata, then choose the video file to share.";
    }

    if (torrentSession.phase === "failed") {
      return torrentSession.message ?? "Could not resolve torrent metadata.";
    }

    if (torrentSession.phase === "selecting_file") {
      return `${torrentSession.files.length} playable video file(s) found. Choose one to create the room.`;
    }

    if (torrentSession.selectedFileIndex !== undefined) {
      return `Torrent ready. ${Math.round(torrentSession.progress * 100)}% downloaded from ${torrentSession.peerCount} peer(s).`;
    }

    return "Fetching torrent metadata.";
  }

  return (
    <main className="app-shell">
      <div className="window-drag-region" aria-hidden="true" />
      {!room ? (
        <>
          <header className="top-bar">
            <div className="top-bar-brand">
              <SyncPlayLogo className="top-bar-brand__logo" />
              <div className="top-bar-brand__copy">
                <span className="eyebrow">SyncPlay</span>
                <strong>{hasDesktopBridge ? "Desktop" : "Web"}</strong>
              </div>
            </div>
            <div className="hero-meta">
              <span className={`pill pill-${connectionStatus}`}>
                <ConnectionStatusIcon status={connectionStatus} />
                {formatConnectionLabel(connectionStatus)}
              </span>
              {isDev ? (
                <>
                  <span className="pill pill-info">
                    <PlatformIcon platformLabel={platformLabel} />
                    {platformLabel}
                  </span>
                  <span className="pill pill-info">
                    <img src={electronIcon} alt="" aria-hidden="true" />
                    {electronVersionLabel}
                  </span>
                </>
              ) : null}
              {hasDesktopBridge && isDev ? (
                <button
                  className="desktop-icon-button"
                  type="button"
                  aria-label="Open desktop window"
                  title="Open desktop window"
                  onClick={() => {
                    void desktopApi.openDesktopWindow();
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                      fill="currentColor"
                      d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v1h1.5A2.5 2.5 0 0 1 20 10v7.5A2.5 2.5 0 0 1 17.5 20h-7A2.5 2.5 0 0 1 8 17.5v-1H6.5A2.5 2.5 0 0 1 4 14V6.5Zm2.5-1a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1H8V10A2.5 2.5 0 0 1 10.5 7.5h4V6.5a1 1 0 0 0-1-1h-7Zm4 3.5a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1h-7Z"
                    />
                  </svg>
                </button>
              ) : null}
            </div>
          </header>

          <section className="hero-section">
            <div className="hero-copy">
              <h1>Watch anything together, in sync.</h1>
              <p className="hero-text">
                Share a room code and play from YouTube, a local file, or a magnet link — everyone stays in perfect sync.
              </p>
            </div>
            <div className="hero-alias">
              <label className="input-label" htmlFor="display-name">
                Your alias
              </label>
              <input
                id="display-name"
                className="text-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Guest 1234"
                maxLength={32}
              />
            </div>
          </section>

          <section className="lobby-section">
            <div className="lobby-col">
              <p className="eyebrow">Create Room</p>
              <h2>Choose your media source</h2>

              <div className="source-selector">
                <button
                  className={`source-chip ${sourceOption === "youtube" ? "source-chip--active" : ""}`}
                  onClick={() => {
                    void switchSourceOption("youtube");
                  }}
                  type="button"
                >
                  YouTube
                </button>
                <button
                  className={`source-chip ${sourceOption === "local_file" ? "source-chip--active" : ""}`}
                  onClick={() => {
                    void switchSourceOption("local_file");
                  }}
                  type="button"
                >
                  Local File
                </button>
                <button
                  className={`source-chip ${sourceOption === "torrent_magnet" ? "source-chip--active" : ""}`}
                  onClick={() => {
                    void switchSourceOption("torrent_magnet");
                  }}
                  type="button"
                >
                  Magnet Link
                </button>
              </div>

              {sourceOption === "youtube" ? (
                <>
                  <label className="input-label" htmlFor="youtube-url">
                    YouTube URL
                  </label>
                  <input
                    id="youtube-url"
                    className="text-input"
                    value={videoUrl}
                    onChange={(event) => setVideoUrl(event.target.value)}
                    placeholder="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                  />
                  <p className="helper-text">
                    {parsedVideo ? `Detected video id: ${parsedVideo.videoId}` : "Supports watch, short and embed URLs."}
                  </p>
                </>
              ) : sourceOption === "local_file" ? (
                <>
                  <label className="input-label" htmlFor="local-file">
                    Local video
                  </label>
                  <div className="local-file-picker">
                    <button id="local-file" className="secondary-button" type="button" onClick={handlePickLocalFile}>
                      Choose file
                    </button>
                    <input
                      ref={fileInputRef}
                      className="hidden-file-input"
                      type="file"
                      accept="video/mp4,video/webm,video/ogg,video/quicktime,.mp4,.webm,.ogg,.ogv,.mov"
                      onChange={handleLocalFileSelected}
                    />
                    <span className="helper-text">
                      {selectedLocalFile
                        ? `${selectedLocalFile.fileName} (${Math.round(selectedLocalFile.fileSize / 1024 / 1024)} MB)`
                        : "Select an MP4, WebM, OGG or MOV file from this computer."}
                    </span>
                  </div>
                  <p className="helper-text">
                    Local-file rooms work for 2 people. The host shares the video directly to the guest.
                  </p>
                </>
              ) : (
                <>
                  <label className="input-label" htmlFor="magnet-link">
                    Magnet link
                  </label>
                  <input
                    id="magnet-link"
                    className="text-input"
                    name="syncplay-magnet-link"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={magnetLink}
                    onChange={(event) => {
                      if (torrentSession) {
                        void disposeActiveTorrentSession();
                        setSelectedLocalFile(null);
                        setSelectedPlaybackFile(null);
                      }
                      setMagnetLink(event.target.value);
                      setLocalError(null);
                    }}
                    placeholder="magnet:?xt=urn:btih:..."
                  />
                  <div className="local-file-picker">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleResolveMagnet}
                      disabled={isResolvingMagnet || shouldBlockSafariMagnetFlow}
                    >
                      {isResolvingMagnet ? "Resolving..." : "Resolve magnet"}
                    </button>
                    <span className="helper-text">{renderTorrentStatus()}</span>
                  </div>
                  {shouldBlockSafariMagnetFlow ? (
                    <div className="browser-warning" role="note">
                      <strong>Chrome recommended.</strong> Safari has limited support for magnet links. For a full experience,
                      we recommend using Chrome.
                    </div>
                  ) : null}
                  {torrentSession && torrentSession.files.length > 1 ? (
                    <>
                      <label className="input-label" htmlFor="torrent-file">
                        Video file
                      </label>
                      <div className={`select-input-shell ${isTorrentFileSelectOpen ? "select-input-shell--open" : ""}`}>
                        <select
                          id="torrent-file"
                          className="text-input"
                          name="syncplay-torrent-file"
                          value={selectedLocalFile?.type === "torrent_magnet" ? String(torrentSession.selectedFileIndex ?? "") : ""}
                          onMouseDown={() => setIsTorrentFileSelectOpen(true)}
                          onFocus={() => setIsTorrentFileSelectOpen(true)}
                          onBlur={() => setIsTorrentFileSelectOpen(false)}
                          onKeyDown={(event) => {
                            if (
                              event.key === " " ||
                              event.key === "Enter" ||
                              event.key === "ArrowDown" ||
                              event.key === "ArrowUp"
                            ) {
                              setIsTorrentFileSelectOpen(true);
                            }

                            if (event.key === "Escape" || event.key === "Tab") {
                              setIsTorrentFileSelectOpen(false);
                            }
                          }}
                          onChange={(event) => {
                            setIsTorrentFileSelectOpen(false);
                            const nextIndex = Number(event.target.value);
                            if (Number.isFinite(nextIndex)) {
                              void handleSelectTorrentFile(nextIndex);
                            }
                          }}
                        >
                          <option value="" disabled>
                            Choose a video file
                          </option>
                          {torrentSession.files.map((file) => (
                            <option key={file.index} value={file.index}>
                              {file.name} ({Math.round(file.size / 1024 / 1024)} MB)
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  ) : null}
                  <p className="helper-text">
                    Magnet-link rooms also work for 2 people. The host downloads the torrent locally and shares the selected
                    video directly to the guest.
                  </p>
                </>
              )}

              <button className="primary-button" type="button" onClick={handleCreateRoom} disabled={!canCreateRoom}>
                Create sync room
              </button>
            </div>

            <div className="lobby-col lobby-col--join">
              <p className="eyebrow">Join Room</p>
              <h2>Enter a shared room code</h2>
              <label className="input-label" htmlFor="room-code">
                Room code
              </label>
              <input
                id="room-code"
                className="text-input text-input-code"
                name="syncplay-room-code"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                placeholder="AB12CD"
                maxLength={6}
              />
              <p className="helper-text">Use the room code whether the host chose YouTube or a local file.</p>
              <button className="secondary-button" type="button" onClick={handleJoinRoom} disabled={!canJoinRoom}>
                Join room
              </button>
            </div>
          </section>
        </>
      ) : (
        <RoomPanel
          room={room}
          localFile={selectedPlaybackFile}
          selfId={selfId}
          remoteCommand={remoteCommand}
          debugEntries={debugEntries}
          peerSignal={peerSignal}
          lastActionLabel={lastActionLabel}
          onLeave={() => {
            void handleLeaveRoom();
          }}
          onRequestSync={requestSync}
          onSendChatMessage={sendChatMessage}
          onPlay={sendPlay}
          onPause={sendPause}
          onSeek={sendSeek}
          onDebug={pushDebugEntry}
          onPeerOffer={sendPeerOffer}
          onPeerAnswer={sendPeerAnswer}
          onPeerIceCandidate={sendPeerIceCandidate}
          onTransferState={updateTransferState}
          onSubtitleTrackChange={updateSubtitleTrack}
        />
      )}

      {localError || error ? (
        <section className="error-banner">
          <strong>Heads up:</strong> {localError ?? error}
        </section>
      ) : null}

      {shouldShowMagnetSupportWarning ? (
        <section className="error-banner">
          <strong>Magnet support unavailable:</strong> {torrentSessionProvider.unsupportedReason}
        </section>
      ) : null}
    </main>
  );
}
