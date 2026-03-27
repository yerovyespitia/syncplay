import { useMemo, useRef, useState } from "react";

import type { DesktopApi, PickedLocalFile } from "@syncplay/shared";
import { parseYouTubeUrl } from "@syncplay/shared";

import { RoomPanel } from "./components/RoomPanel";
import { SyncPlayLogo } from "./components/SyncPlayLogo";
import { useRoomConnection } from "./hooks/useRoomConnection";

type SourceOption = "youtube" | "local_file";

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

  return "web";
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
  return match?.[1] ?? "web";
}

const fallbackDesktopApi: DesktopApi = {
  platform: detectPlatformLabel(),
  electronVersion: detectElectronVersion(),
  openDesktopWindow: async () => undefined,
  pickLocalFile: async () => null,
  readLocalFile: async () => new Uint8Array(),
  readLocalFileChunk: async () => new Uint8Array(),
  createTempMediaCache: async () => "",
  writeTempMediaChunk: async () => undefined,
  removeTempMediaCache: async () => undefined
};

export default function App() {
  const desktopApi = window.syncplayDesktop ?? fallbackDesktopApi;
  const isDev = import.meta.env.DEV;
  const hasDesktopBridge = Boolean(window.syncplayDesktop);
  const platformLabel = formatPlatformLabel(desktopApi.platform || detectPlatformLabel());
  const electronVersionLabel = desktopApi.electronVersion || detectElectronVersion();
  const [sourceOption, setSourceOption] = useState<SourceOption>("youtube");
  const [videoUrl, setVideoUrl] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [selectedLocalFile, setSelectedLocalFile] = useState<PickedLocalFile | null>(null);
  const [selectedBrowserFile, setSelectedBrowserFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
    updateTransferState,
    sendPeerOffer,
    sendPeerAnswer,
    sendPeerIceCandidate,
    sendPlay,
    sendPause,
    sendSeek
  } = useRoomConnection();
  const shouldShowDesktopBridgeWarning =
    !hasDesktopBridge &&
    (sourceOption === "local_file" || (room !== null && room.mediaSource.type === "local_file"));

  const parsedVideo = useMemo(() => parseYouTubeUrl(videoUrl), [videoUrl]);
  const canCreateRoom = sourceOption === "youtube" ? Boolean(parsedVideo) : Boolean(selectedLocalFile && selectedBrowserFile);
  const canJoinRoom = Boolean(roomCode.trim());

  function handlePickLocalFile() {
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
      fileName: browserFile.name,
      fileSize: browserFile.size,
      mimeType: browserFile.type || "application/octet-stream"
    };

    setSelectedBrowserFile(browserFile);
    setSelectedLocalFile(pickedFile);
    setLocalError(null);
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
                <strong>Desktop</strong>
              </div>
            </div>
            <div className="hero-meta">
              <span className={`pill pill-${connectionStatus}`}>{connectionStatus}</span>
              <span className="pill pill-info">{platformLabel}</span>
              <span className="pill pill-info">Electron {electronVersionLabel}</span>
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
              <h1>Watch together from YouTube or a local file.</h1>
              <p className="hero-text">
                Keep playback in sync with room codes, and choose whether the session starts from a YouTube link or a
                host-shared local video file.
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
                  onClick={() => setSourceOption("youtube")}
                  type="button"
                >
                  YouTube
                </button>
                <button
                  className={`source-chip ${sourceOption === "local_file" ? "source-chip--active" : ""}`}
                  onClick={() => setSourceOption("local_file")}
                  type="button"
                >
                  Local File
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
              ) : (
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
          localFile={selectedBrowserFile}
          selfId={selfId}
          remoteCommand={remoteCommand}
          debugEntries={debugEntries}
          peerSignal={peerSignal}
          lastActionLabel={lastActionLabel}
          onLeave={leaveRoom}
          onRequestSync={requestSync}
          onPlay={sendPlay}
          onPause={sendPause}
          onSeek={sendSeek}
          onDebug={pushDebugEntry}
          onPeerOffer={sendPeerOffer}
          onPeerAnswer={sendPeerAnswer}
          onPeerIceCandidate={sendPeerIceCandidate}
          onTransferState={updateTransferState}
        />
      )}

      {localError || error ? (
        <section className="error-banner">
          <strong>Heads up:</strong> {localError ?? error}
        </section>
      ) : null}

      {shouldShowDesktopBridgeWarning ? (
        <section className="error-banner">
          <strong>Desktop bridge missing:</strong> this window cannot use local-file rooms correctly. Open the app from
          Electron, or use the in-app desktop-window button from a working desktop window.
        </section>
      ) : null}
    </main>
  );
}
