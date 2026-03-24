import { useMemo, useRef, useState } from "react";

import type { DesktopApi, PickedLocalFile } from "@syncplay/shared";
import { parseYouTubeUrl } from "@syncplay/shared";

import { RoomPanel } from "./components/RoomPanel";
import { useRoomConnection } from "./hooks/useRoomConnection";

type SourceOption = "youtube" | "local_file";

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
  const normalized = candidate.toLowerCase();

  if (normalized.includes("mac")) {
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
  const hasDesktopBridge = Boolean(window.syncplayDesktop);
  const platformLabel = desktopApi.platform || detectPlatformLabel();
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
    setDisplayName,
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
          <section className="hero-card">
            <div className="hero-copy">
              <p className="eyebrow">SyncPlay Desktop</p>
              <h1>Watch together from YouTube or a local file.</h1>
              <p className="hero-text">
                Keep playback in sync with room codes, and choose whether the session starts from a YouTube link or a
                host-shared local video file.
              </p>
            </div>

            <div className="hero-side">
              <div className="hero-meta">
                <span className={`pill pill-${connectionStatus}`}>{connectionStatus}</span>
                <span className="pill pill-info">{platformLabel}</span>
                <span className="pill pill-info">Electron {electronVersionLabel}</span>
              </div>

              {hasDesktopBridge ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    void desktopApi.openDesktopWindow();
                  }}
                >
                  Open desktop window
                </button>
              ) : null}

              <div className="alias-card">
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
                <p className="helper-text">This name appears in the participant list when you join a room.</p>
              </div>
            </div>
          </section>

          <section className="lobby-grid">
            <article className="panel-card">
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
            </article>

            <article className="panel-card">
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
            </article>
          </section>
        </>
      ) : (
        <RoomPanel
          room={room}
          localFile={selectedBrowserFile}
          selfId={selfId}
          remoteCommand={remoteCommand}
          peerSignal={peerSignal}
          lastActionLabel={lastActionLabel}
          onLeave={leaveRoom}
          onRequestSync={requestSync}
          onPlay={sendPlay}
          onPause={sendPause}
          onSeek={sendSeek}
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

      {!hasDesktopBridge ? (
        <section className="error-banner">
          <strong>Desktop bridge missing:</strong> this window cannot use local-file rooms correctly. Open the app from
          Electron, or use the in-app desktop-window button from a working desktop window.
        </section>
      ) : null}
    </main>
  );
}
