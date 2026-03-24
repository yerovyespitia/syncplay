import { useState } from "react";

import type { LocalFileMediaSource, RoomState, TransferState, YoutubeMediaSource } from "@syncplay/shared";

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
  peerSignal: PeerSignal | null;
  lastActionLabel: string;
  onLeave: () => void;
  onRequestSync: () => void;
  onPlay: (currentTime: number) => void;
  onPause: (currentTime: number) => void;
  onSeek: (currentTime: number) => void;
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
  peerSignal,
  lastActionLabel,
  onLeave,
  onRequestSync,
  onPlay,
  onPause,
  onSeek,
  onPeerOffer,
  onPeerAnswer,
  onPeerIceCandidate,
  onTransferState
}: RoomPanelProps) {
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
              <span className={`room-code-icon ${copied ? "room-code-icon--copied" : ""}`}>{copied ? "OK" : "CP"}</span>
            </button>
          </div>
          <p className="helper-text">
            Source: {room.mediaSource.type === "youtube" ? "YouTube" : `${room.mediaSource.fileName} (local file)`}
          </p>
        </div>
        <div className="room-actions">
          <button className="action-button action-button--sync" onClick={onRequestSync} type="button">
            Resync
          </button>
          <button className="action-button action-button--leave" onClick={onLeave} type="button">
            Leave room
          </button>
        </div>
      </div>

      <div className="room-grid">
        <div className="player-card">
          {room.mediaSource.type === "youtube" ? (
            <YouTubeRoomPlayer
              room={room as RoomState & { mediaSource: YoutubeMediaSource }}
              selfId={selfId}
              remoteCommand={remoteCommand}
              onPlay={onPlay}
              onPause={onPause}
            />
          ) : (
            <LocalFileRoomPlayer
              room={room as RoomState & { mediaSource: LocalFileMediaSource }}
              selfId={selfId}
              localFile={localFile}
              remoteCommand={remoteCommand}
              peerSignal={peerSignal}
              onPlay={onPlay}
              onPause={onPause}
              onSeek={onSeek}
              onRequestSync={onRequestSync}
              onPeerOffer={onPeerOffer}
              onPeerAnswer={onPeerAnswer}
              onPeerIceCandidate={onPeerIceCandidate}
              onTransferState={onTransferState}
            />
          )}

          <div className="player-status">
            <span>{room.playbackState === "playing" ? "Playing" : "Paused"}</span>
            <span>{lastActionLabel}</span>
          </div>
        </div>

        <aside className="sidebar-card">
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
        </aside>
      </div>
    </section>
  );
}
