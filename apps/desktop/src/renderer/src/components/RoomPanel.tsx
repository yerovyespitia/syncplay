import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ChatMessage,
  HostedFileMediaSource,
  PickedLocalFile,
  RoomState,
  SubtitleTrack,
  TransferState,
  YoutubeMediaSource
} from "@syncplay/shared";

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
  localFile: PickedLocalFile | File | null;
  selfId: string | null;
  remoteCommand: RemotePlaybackCommand | null;
  debugEntries: DebugEntry[];
  peerSignal: PeerSignal | null;
  lastActionLabel: string;
  onLeave: () => void;
  onRequestSync: () => void;
  onSendChatMessage: (text: string) => void;
  onPlay: (currentTime: number) => void;
  onPause: (currentTime: number) => void;
  onSeek: (currentTime: number) => void;
  onDebug: (entry: Omit<DebugEntry, "id" | "timestamp">) => void;
  onPeerOffer: (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => void;
  onPeerAnswer: (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => void;
  onPeerIceCandidate: (targetParticipantId: string, candidate: RTCIceCandidateInit) => void;
  onTransferState: (transferState: TransferState) => void;
  onSubtitleTrackChange: (subtitleTrack: SubtitleTrack) => void;
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8.7 7.3a1 1 0 0 1 0 1.4L5.41 12l3.3 3.3a1 1 0 1 1-1.42 1.4l-4-4a1 1 0 0 1 0-1.4l4-4a1 1 0 0 1 1.41 0Zm6.6 0a1 1 0 0 1 1.41 0l4 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 1 1-1.41-1.4l3.29-3.3-3.3-3.3a1 1 0 0 1 0-1.4Z"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 4a8 8 0 0 1 7.75 6h-1.68a1 1 0 1 0 0 2H22a1 1 0 0 0 1-1V7.07a1 1 0 1 0-2 0v1.18A10 10 0 1 0 22 12a1 1 0 1 0-2 0 8 8 0 1 1-8-8Z"
      />
    </svg>
  );
}

function LeaveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M10 4a1 1 0 0 1 0 2H6v12h4a1 1 0 1 1 0 2H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5Zm5.3 3.3a1 1 0 0 1 1.4 0l3.99 4a1 1 0 0 1 0 1.4l-4 4a1 1 0 1 1-1.4-1.4l2.3-2.3H9a1 1 0 1 1 0-2h8.59l-2.3-2.3a1 1 0 0 1 0-1.4Z"
      />
    </svg>
  );
}


function formatChatTimestamp(value: number) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function getChatMessageClassName(message: ChatMessage, selfId: string | null) {
  const classNames = ["chat-message"];

  if (message.kind === "system") {
    classNames.push("chat-message--system");
  } else if (message.senderParticipantId === selfId) {
    classNames.push("chat-message--own");
  } else {
    classNames.push("chat-message--remote");
  }

  return classNames.join(" ");
}

function isOwnChatMessage(message: ChatMessage, selfId: string | null) {
  return message.kind !== "system" && message.senderParticipantId === selfId;
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
  onSendChatMessage,
  onPlay,
  onPause,
  onSeek,
  onDebug,
  onPeerOffer,
  onPeerAnswer,
  onPeerIceCandidate,
  onTransferState,
  onSubtitleTrackChange
}: RoomPanelProps) {
  const [copied, setCopied] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [sidebarHeight, setSidebarHeight] = useState<number | null>(null);
  const [showDebugLogs, setShowDebugLogs] = useState(import.meta.env.DEV);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const playerCardRef = useRef<HTMLDivElement | null>(null);
  const chatMessageListRef = useRef<HTMLDivElement | null>(null);
  const chatMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const canToggleDebugLogs = import.meta.env.DEV;
  const shouldShowPlaybackReadiness =
    room.participants.length > 1 &&
    (room.mediaSource.type === "local_file" || room.mediaSource.type === "torrent_magnet") &&
    Boolean(room.transferState);
  const playbackReadyPercent = room.transferState
    ? room.transferState.isPlaybackReady
      ? 100
      : Math.round(room.transferState.progress * 100)
    : 0;
  const showLoadingOverlay = shouldShowPlaybackReadiness && !room.transferState?.isPlaybackReady;
  const visibleChatMessages = useMemo(() => room.chatMessages, [room.chatMessages]);

  useEffect(() => {
    const chatList = chatMessageListRef.current;

    if (!chatList) {
      return;
    }

    chatList.scrollTo({
      top: chatList.scrollHeight,
      behavior: "smooth"
    });
  }, [visibleChatMessages]);

  useEffect(() => {
    const playerCard = playerCardRef.current;

    if (!playerCard || isTheaterMode) {
      setSidebarHeight(null);
      return;
    }

    const measuredPlayerCard = playerCard;

    function syncSidebarHeight() {
      setSidebarHeight(measuredPlayerCard.getBoundingClientRect().height);
    }

    syncSidebarHeight();

    const resizeObserver = new ResizeObserver(() => {
      syncSidebarHeight();
    });

    resizeObserver.observe(measuredPlayerCard);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isTheaterMode, shouldShowPlaybackReadiness, showDebugLogs, room.mediaSource.type, visibleChatMessages.length]);

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

  function handleSendChatMessage() {
    const nextMessage = chatDraft.trim();

    if (!nextMessage) {
      return;
    }

    onSendChatMessage(nextMessage);
    setChatDraft("");
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
      `${room.mediaSource.fileName} (${room.mediaSource.type === "torrent_magnet" ? "magnet link" : "local file"})`
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
              <CodeIcon />
              Dev mode
            </button>
          ) : null}
          <button className="action-button action-button--sync" onClick={onRequestSync} type="button">
            <RefreshIcon />
            Resync
          </button>
          <button className="action-button action-button--leave" onClick={onLeave} type="button">
            <LeaveIcon />
            Leave room
          </button>
        </div>
      </div>

      <div className={`room-grid ${isTheaterMode ? "room-grid--theater" : ""}`}>
        <div ref={playerCardRef} className="player-card">
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
              room={room as RoomState & { mediaSource: HostedFileMediaSource }}
              selfId={selfId}
              localFile={localFile}
              isTheaterMode={isTheaterMode}
              showDebugInfo={showDebugLogs}
              remoteCommand={remoteCommand}
              peerSignal={peerSignal}
              showLoadingOverlay={showLoadingOverlay}
              loadingPercent={playbackReadyPercent}
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
              onSubtitleTrackChange={onSubtitleTrackChange}
            />
          )}
        </div>

        <aside
          className={`sidebar-card ${isTheaterMode ? "sidebar-card--hidden" : ""}`}
          style={!showDebugLogs && sidebarHeight ? { height: `${sidebarHeight}px`, maxHeight: `${sidebarHeight}px` } : undefined}
        >
          {showDebugLogs ? (
            <div className="sidebar-section">
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
          ) : null}

          {!showDebugLogs ? (
            <div className="chat-panel">
              <div className="chat-panel-header">
                <p className="eyebrow">Chat</p>
                <span>{visibleChatMessages.length} messages</span>
              </div>

              <div ref={chatMessageListRef} className="chat-message-list" aria-live="polite">
                {visibleChatMessages.length === 0 ? (
                  <div className="chat-empty-state">
                    Messages you send here will appear for everyone in the room.
                  </div>
                ) : (
                  visibleChatMessages.map((message: ChatMessage) => (
                    <article
                      key={message.id}
                      className={getChatMessageClassName(message, selfId)}
                    >
                      <div className="chat-message-meta">
                        <strong className="chat-message-author">
                          <span>{message.kind === "system" ? "System" : message.senderDisplayName ?? "Guest"}</span>
                          {isOwnChatMessage(message, selfId) ? <em className="chat-message-you-tag">You</em> : null}
                        </strong>
                        <span>{formatChatTimestamp(message.createdAt)}</span>
                      </div>
                      <p>{message.text}</p>
                    </article>
                  ))
                )}
                <div ref={chatMessagesEndRef} />
              </div>

              <div className="chat-composer">
                <input
                  className="chat-composer-input"
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSendChatMessage();
                    }
                  }}
                  placeholder="Message the room"
                  maxLength={280}
                />
                <button className="action-button action-button--chat" type="button" onClick={handleSendChatMessage}>
                  Send
                </button>
              </div>
            </div>
          ) : null}

          {showDebugLogs ? (
            <div className="sync-stats sidebar-section">
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
          ) : null}

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
