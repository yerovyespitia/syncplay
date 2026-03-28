import { useState } from "react";

import type { LocalFileMediaSource, RoomState, TransferState, YoutubeMediaSource } from "@syncplay/shared";

import type { DebugEntry } from "../hooks/useRoomConnection";
import { LocalFileRoomPlayer } from "./LocalFileRoomPlayer";
import { YouTubeRoomPlayer } from "./YouTubeRoomPlayer";

type RemotePlaybackCommand =
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

type PeerSignal =
  | {
      type: "peer_offer";
      roomId: string;
      sourceParticipantId: string;
      sdp: RTCSessionDescriptionInit;
      receivedAt: number;
    }
  | {
      type: "peer_answer";
      roomId: string;
      sourceParticipantId: string;
      sdp: RTCSessionDescriptionInit;
      receivedAt: number;
    }
  | {
      type: "peer_ice_candidate";
      roomId: string;
      sourceParticipantId: string;
      candidate: RTCIceCandidateInit;
      receivedAt: number;
    };

interface RoomPanelProps {
  room: RoomState;
  localFile: File | null;
  selfId: string | null;
  remoteCommand: RemotePlaybackCommand | null;
  debugEntries: DebugEntry[];
  peerSignal: PeerSignal | null;
  lastActionLabel: string;
  onLeave: () => void;
  onRequestSync: () => void;
  onPlay: (currentTime: number) => void;
  onPause: (currentTime: number) => void;
  onSeek: (currentTime: number) => void;
  onDebug: (entry: Omit<DebugEntry, "id" | "timestamp">) => void;
  onPeerOffer: (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => void;
  onPeerAnswer: (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => void;
  onPeerIceCandidate: (targetParticipantId: string, candidate: RTCIceCandidateInit) => void;
  onTransferState: (transferState: TransferState) => void;
}

export function RoomPanel({
  room,
  localFile,
  selfId,
  remoteCommand,
  debugEntries,
  peerSignal,
  lastActionLabel,
  onLeave,
  onRequestSync,
  onPlay,
  onPause,
  onSeek,
  onDebug,
  onPeerOffer,
  onPeerAnswer,
  onPeerIceCandidate,
  onTransferState
}: RoomPanelProps) {
  const [copied, setCopied] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const [showDebugLogs, setShowDebugLogs] = useState(import.meta.env.DEV);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const canToggleDebugLogs = import.meta.env.DEV;

  function handleCopyCode() {
    navigator.clipboard.writeText(room.roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleCopyLogs() {
    const logText =
      debugEntries.length === 0
        ? "No logs yet."
        : debugEntries
            .slice()
            .reverse()
            .map((entry) =>
              [entry.scope, entry.message, new Date(entry.timestamp).toLocaleTimeString(), entry.details]
                .filter(Boolean)
                .join("\n")
            )
            .join("\n\n");

    navigator.clipboard.writeText(logText).then(() => {
      setLogsCopied(true);
      setTimeout(() => setLogsCopied(false), 2000);
    });
  }

  const sourceLabel =
    room.mediaSource.type === "youtube" ? (
      <span className="source-badge" aria-label="YouTube source" title="YouTube">
        <svg className="source-badge__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            fill="currentColor"
            d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.7 31.7 0 0 0 0 12a31.7 31.7 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.7 31.7 0 0 0 24 12a31.7 31.7 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z"
          />
        </svg>
      </span>
    ) : (
      `${room.mediaSource.fileName} (local file)`
    );

  return (
    <section className="room-shell">
      <div className="room-header">
        <div>
          <p className="eyebrow">Room</p>
          <div className="room-code-row">
            <button className="room-code-button" type="button" onClick={handleCopyCode} title="Copy room code">
              <span>{room.roomId}</span>
              <span className={`room-code-icon ${copied ? "room-code-icon--copied" : ""}`}>{copied ? "OK" : "CP"}</span>
            </button>
          </div>
          <p className="helper-text">
            <strong>Source:</strong> {sourceLabel}
          </p>
        </div>
        <div className="room-actions">
          {canToggleDebugLogs ? (
            <button
              className={`action-button ${showDebugLogs ? "action-button--logs-on" : "action-button--logs-off"}`}
              onClick={() => setShowDebugLogs((current) => !current)}
              type="button"
            >
              Logs {showDebugLogs ? "on" : "off"}
            </button>
          ) : null}
          <button className="action-button action-button--sync" onClick={onRequestSync} type="button">
            Resync
          </button>
          <button className="action-button action-button--leave" onClick={onLeave} type="button">
            Leave room
          </button>
        </div>
      </div>

      <div className={`room-grid ${isTheaterMode ? "room-grid--theater" : ""}`}>
        <div className="player-card">
          {room.mediaSource.type === "youtube" ? (
            <YouTubeRoomPlayer
              room={room as RoomState & { mediaSource: YoutubeMediaSource }}
              selfId={selfId}
              remoteCommand={remoteCommand}
              onPlay={onPlay}
              onPause={onPause}
              onDebug={onDebug}
            />
          ) : (
            <LocalFileRoomPlayer
              room={room as RoomState & { mediaSource: LocalFileMediaSource }}
              selfId={selfId}
              localFile={localFile}
              isTheaterMode={isTheaterMode}
              remoteCommand={remoteCommand}
              peerSignal={peerSignal}
              onDebug={onDebug}
              onPlay={onPlay}
              onPause={onPause}
              onSeek={onSeek}
              onRequestSync={onRequestSync}
              onPeerOffer={onPeerOffer}
              onPeerAnswer={onPeerAnswer}
              onPeerIceCandidate={onPeerIceCandidate}
              onTheaterModeChange={setIsTheaterMode}
              onTransferState={onTransferState}
            />
          )}

          <div className="player-status">
            <span>{room.playbackState === "playing" ? "Playing" : "Paused"}</span>
            <span>{lastActionLabel}</span>
          </div>
        </div>

        <aside className={`sidebar-card ${isTheaterMode ? "sidebar-card--hidden" : ""}`}>
          <div>
            <p className="eyebrow">Participants</p>
            <ul className="participant-list">
              {room.participants.map((participant) => (
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
            {room.transferState ? (
              <div>
                <span className="stat-label">Transfer</span>
                <strong>
                  {room.transferState.phase} {Math.round(room.transferState.progress * 100)}%
                </strong>
              </div>
            ) : null}
          </div>

          {showDebugLogs ? (
            <div className="debug-panel">
              <div className="debug-panel-header">
                <p className="eyebrow">Logs</p>
                <button
                  className={`action-button action-button--icon ${logsCopied ? "action-button--logs-on" : "action-button--logs-off"}`}
                  onClick={handleCopyLogs}
                  type="button"
                  title={logsCopied ? "Logs copied" : "Copy logs"}
                  aria-label={logsCopied ? "Logs copied" : "Copy logs"}
                >
                  {logsCopied ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        fill="currentColor"
                        d="M9.55 18.2 4.8 13.45l1.4-1.4 3.35 3.35 8.25-8.25 1.4 1.4-9.65 9.65Z"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        fill="currentColor"
                        d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H10V7h9v14Z"
                      />
                    </svg>
                  )}
                </button>
              </div>
              <ul className="debug-list">
                {debugEntries.length === 0 ? (
                  <li className="debug-empty">No logs yet.</li>
                ) : (
                  debugEntries.slice(0, 12).map((entry) => (
                    <li key={entry.id} className="debug-item">
                      <span className={`debug-scope debug-scope--${entry.scope}`}>{entry.scope}</span>
                      <div>
                        <strong>{entry.message}</strong>
                        <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                        {entry.details ? <code>{entry.details}</code> : null}
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
