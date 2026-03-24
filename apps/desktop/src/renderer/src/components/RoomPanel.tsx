import { useEffect, useMemo, useRef, useState } from "react";
import YouTube, { type YouTubeEvent } from "react-youtube";

import type { Participant, RoomState } from "@syncplay/shared";

type YoutubePlayerApi = {
  getCurrentTime(): number | Promise<number>;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
};

const PLAYER_STATE_PLAYING = 1;
const PLAYER_STATE_PAUSED = 2;

type RemoteCommand =
  | {
      kind: "sync";
      room: RoomState;
      actorId?: string;
      receivedAt: number;
    }
  | {
      kind: "event";
      room: RoomState;
      actorId: string;
      action: "player_play" | "player_pause" | "player_seek";
      receivedAt: number;
    };

interface RoomPanelProps {
  room: RoomState;
  participants: Participant[];
  selfId: string | null;
  remoteCommand: RemoteCommand | null;
  lastActionLabel: string;
  onLeave: () => void;
  onRequestSync: () => void;
  onPlay: (currentTime: number) => void;
  onPause: (currentTime: number) => void;
  onSeek: (currentTime: number) => void;
}

const DRIFT_THRESHOLD_SECONDS = 1.2;

export function RoomPanel({
  room,
  participants,
  selfId,
  remoteCommand,
  lastActionLabel,
  onLeave,
  onRequestSync,
  onPlay,
  onPause,
  onSeek
}: RoomPanelProps) {
  const playerRef = useRef<YoutubePlayerApi | null>(null);
  const suppressEventsRef = useRef(false);
  const isReadyRef = useRef(false);
  const lastAppliedEventIdRef = useRef(-1);

  const playerOptions = useMemo(() => ({
    width: "100%",
    height: "100%",
    playerVars: {
      autoplay: 0,
      rel: 0,
      modestbranding: 1
    }
  }), []);

  useEffect(() => {
    if (!remoteCommand || !playerRef.current || !isReadyRef.current) {
      return;
    }

    if (lastAppliedEventIdRef.current === remoteCommand.room.lastEventId && remoteCommand.kind === "event") {
      return;
    }

    if (remoteCommand.kind === "event" && remoteCommand.actorId === selfId) {
      lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
      return;
    }

    applyAuthoritativeState(playerRef.current, remoteCommand.room);
    lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
  }, [remoteCommand, selfId]);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      const player = playerRef.current;

      if (!player || !isReadyRef.current || room.playbackState !== "playing") {
        return;
      }

      const expectedTime = room.currentTime + (Date.now() - room.updatedAt) / 1000;
      const currentTime = await player.getCurrentTime();

      if (Math.abs(expectedTime - currentTime) > DRIFT_THRESHOLD_SECONDS) {
        applyAuthoritativeState(player, {
          ...room,
          currentTime: expectedTime
        });
      }
    }, 2500);

    return () => {
      window.clearInterval(interval);
    };
  }, [room]);

  function handleReady(event: YouTubeEvent<number>) {
    playerRef.current = event.target;
    isReadyRef.current = true;
    applyAuthoritativeState(event.target, room);
  }

  async function handleStateChange(event: YouTubeEvent<number>) {
    if (suppressEventsRef.current || !playerRef.current || !isReadyRef.current) {
      return;
    }

    const currentTime = await playerRef.current.getCurrentTime();

    if (event.data === PLAYER_STATE_PLAYING) {
      onPlay(currentTime);
      return;
    }

    if (event.data === PLAYER_STATE_PAUSED) {
      onPause(currentTime);
    }
  }

  async function handleManualSync() {
    const player = playerRef.current;

    if (!player) {
      onRequestSync();
      return;
    }

    const currentTime = await player.getCurrentTime();
    onSeek(currentTime);
    onRequestSync();
  }

  const [copied, setCopied] = useState(false);

  function handleCopyCode() {
    navigator.clipboard.writeText(room.roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <section className="room-shell">
      <div className="room-header">
        <div>
          <p className="eyebrow">Room</p>
          <div className="room-code-row">
            <button className="room-code-button" type="button" onClick={handleCopyCode} title="Copy room code">
              <span>{room.roomId}</span>
              <span className="room-code-icon">{copied ? "✓" : "⎘"}</span>
            </button>
            {copied && <span className="room-code-copied">Copied!</span>}
          </div>
        </div>
        <div className="room-actions">
          <button className="action-button action-button--sync" onClick={handleManualSync} type="button">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13.65 2.35A8 8 0 1 0 15 8h-2a6 6 0 1 1-1.1-3.5L9 7h6V1l-1.35 1.35Z" fill="currentColor"/>
            </svg>
            Resync
          </button>
          <button className="action-button action-button--leave" onClick={onLeave} type="button">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10 2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4M13 8H7m3-3 3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Leave room
          </button>
        </div>
      </div>

      <div className="room-grid">
        <div className="player-card">
          <div className="player-wrapper">
            <YouTube
              className="youtube-frame"
              iframeClassName="youtube-iframe"
              videoId={room.videoId}
              opts={playerOptions}
              onReady={handleReady}
              onStateChange={handleStateChange}
            />
          </div>
          <div className="player-status">
            <span>{room.playbackState === "playing" ? "Playing" : "Paused"}</span>
            <span>{lastActionLabel}</span>
          </div>
        </div>

        <aside className="sidebar-card">
          <div>
            <p className="eyebrow">Participants</p>
            <ul className="participant-list">
              {participants.map((participant) => (
                <li key={participant.id}>
                  <span>{participant.displayName ?? participant.id.slice(0, 6)}</span>
                  {participant.id === selfId ? <strong>You</strong> : null}
                </li>
              ))}
            </ul>
          </div>

          <div className="sync-stats">
            <div>
              <span className="stat-label">Current time</span>
              <strong>{room.currentTime.toFixed(1)}s</strong>
            </div>
            <div>
              <span className="stat-label">Events</span>
              <strong>{room.lastEventId}</strong>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );

  function applyAuthoritativeState(player: YoutubePlayerApi, authoritativeRoom: RoomState) {
    suppressEventsRef.current = true;

    void Promise.resolve(player.getCurrentTime()).then((currentTime: number) => {
      if (Math.abs(authoritativeRoom.currentTime - currentTime) > DRIFT_THRESHOLD_SECONDS || authoritativeRoom.playbackState === "paused") {
        player.seekTo(authoritativeRoom.currentTime, true);
      }

      if (authoritativeRoom.playbackState === "playing") {
        player.playVideo();
      } else {
        player.pauseVideo();
      }

      window.setTimeout(() => {
        suppressEventsRef.current = false;
      }, 150);
    });
  }
}
