import { useMemo, useState } from "react";

import { parseYouTubeUrl } from "@syncplay/shared";

import { RoomPanel } from "./components/RoomPanel";
import { useRoomConnection } from "./hooks/useRoomConnection";

export default function App() {
  const desktopApi = window.syncplayDesktop ?? {
    platform: "unknown",
    electronVersion: "unknown"
  };
  const [videoUrl, setVideoUrl] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const {
    connectionStatus,
    room,
    participants,
    remoteCommand,
    error,
    selfId,
    displayName,
    setDisplayName,
    lastActionLabel,
    createRoom,
    joinRoom,
    leaveRoom,
    requestSync,
    sendPlay,
    sendPause,
    sendSeek
  } = useRoomConnection();

  const parsedVideo = useMemo(() => parseYouTubeUrl(videoUrl), [videoUrl]);

  function handleCreateRoom() {
    if (!parsedVideo) {
      setLocalError("Paste a valid YouTube URL to create a room.");
      return;
    }

    setLocalError(null);
    createRoom(parsedVideo.videoId);
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
      {!room && (
        <section className="hero-card">
          <div className="hero-copy">
            <p className="eyebrow">SyncPlay Desktop</p>
            <h1>Watch YouTube together, frame by frame.</h1>
            <p className="hero-text">
              Create a room, share a short code, and keep playback synced across two desktop apps.
            </p>
          </div>

          <div className="hero-side">
            <div className="hero-meta">
              <span className={`pill pill-${connectionStatus}`}>{connectionStatus}</span>
              <span className="pill pill-info">{desktopApi.platform}</span>
              <span className="pill pill-info">Electron {desktopApi.electronVersion}</span>
            </div>

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
              <p className="helper-text">This name will appear in the participant list when you create or join a room.</p>
            </div>
          </div>
        </section>
      )}

      {room ? (
        <RoomPanel
          room={room}
          participants={participants}
          selfId={selfId}
          remoteCommand={remoteCommand}
          lastActionLabel={lastActionLabel}
          onLeave={leaveRoom}
          onRequestSync={requestSync}
          onPlay={sendPlay}
          onPause={sendPause}
          onSeek={sendSeek}
        />
      ) : (
        <section className="lobby-grid">
          <article className="panel-card">
            <p className="eyebrow">Create Room</p>
            <h2>Start from a YouTube link</h2>
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
            <button className="primary-button" type="button" onClick={handleCreateRoom}>
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
            <p className="helper-text">Someone else can create the room and share the code from their app.</p>
            <button className="secondary-button" type="button" onClick={handleJoinRoom}>
              Join room
            </button>
          </article>
        </section>
      )}

      {localError || error ? (
        <section className="error-banner">
          <strong>Heads up:</strong> {localError ?? error}
        </section>
      ) : null}
    </main>
  );
}
