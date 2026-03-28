import { useEffect, useMemo, useRef, useState } from "react";

import type { ByteRange, LocalFileMediaSource, RangeRequestReason, RoomState, TransferState } from "@syncplay/shared";

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

interface LocalFileRoomPlayerProps {
  room: RoomState & { mediaSource: LocalFileMediaSource };
  selfId: string | null;
  localFile: File | null;
  isTheaterMode: boolean;
  remoteCommand: RemotePlaybackCommand | null;
  peerSignal: PeerSignal | null;
  onDebug?: (entry: { scope: "local"; message: string; details?: string }) => void;
  onPlay: (currentTime: number) => void;
  onPause: (currentTime: number) => void;
  onSeek: (currentTime: number) => void;
  onRequestSync: () => void;
  onPeerOffer: (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => void;
  onPeerAnswer: (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => void;
  onPeerIceCandidate: (targetParticipantId: string, candidate: RTCIceCandidateInit) => void;
  onTheaterModeChange: (isTheaterMode: boolean) => void;
  onTransferState: (transferState: TransferState) => void;
}

const CHUNK_SIZE = 128 * 1024;
const REQUEST_WINDOW_BYTES = 2 * 1024 * 1024;
const MIN_INITIAL_BUFFER_BYTES = 4 * 1024 * 1024;
const MIN_INITIAL_BUFFER_SECONDS = 12;
const LOW_BUFFER_AHEAD_SECONDS = 6;
const SEEK_RESUME_PADDING_SECONDS = 2;
const BLOB_REFRESH_STEP_BYTES = 8 * 1024 * 1024;
const SOURCE_REFRESH_AHEAD_SECONDS = 18;
const TRANSFER_PROGRESS_BUCKET = 0.02;
const BUFFERED_TIME_BUCKET_SECONDS = 5;
const DRIFT_THRESHOLD_SECONDS = 1.2;
const DATA_CHANNEL_HIGH_WATER_MARK = 4 * 1024 * 1024;
const DATA_CHANNEL_LOW_WATER_MARK = 512 * 1024;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const CONTROLS_IDLE_DELAY_MS = 3000;

type PeerControlMessage =
  | {
      type: "file-start";
      fileName: string;
      fileSize: number;
      mimeType: string;
      mediaId: string;
      duration?: number;
    }
  | {
      type: "range-request";
      startByte: number;
      endByte: number;
      reason: RangeRequestReason;
      targetTime?: number;
    }
  | {
      type: "chunk-meta";
      startByte: number;
      endByte: number;
    }
  | {
      type: "range-complete";
      startByte: number;
      endByte: number;
      reason: RangeRequestReason;
      targetTime?: number;
    }
  | {
      type: "buffer-ready";
      bufferedUntilTime?: number;
    }
  | {
      type: "seek-buffering";
      targetTime: number;
    }
  | {
      type: "file-complete";
    };

interface PendingPlaybackRestore {
  time: number;
  shouldPlay: boolean;
}

const fallbackDesktopApi = {
  createTempMediaCache: async () => "",
  writeTempMediaChunk: async () => undefined,
  removeTempMediaCache: async () => undefined
};

function formatMediaTitle(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  return withoutExtension.replace(/[_-]+/g, " ").trim() || fileName;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 6.2v11.6c0 .63.7 1.01 1.23.67l9.18-5.8a.8.8 0 0 0 0-1.34L9.23 5.53A.8.8 0 0 0 8 6.2Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M7 5.5A1.5 1.5 0 0 1 8.5 4h1A1.5 1.5 0 0 1 11 5.5v13A1.5 1.5 0 0 1 9.5 20h-1A1.5 1.5 0 0 1 7 18.5v-13Zm6 0A1.5 1.5 0 0 1 14.5 4h1A1.5 1.5 0 0 1 17 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 13 18.5v-13Z" />
    </svg>
  );
}

function VolumeHighIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 10.5A1.5 1.5 0 0 1 5.5 9H8l4.47-3.58A1 1 0 0 1 14 6.2v11.6a1 1 0 0 1-1.53.78L8 15H5.5A1.5 1.5 0 0 1 4 13.5v-3Zm13.34-2.74a.75.75 0 0 1 1.06-.05 6 6 0 0 1 0 8.58.75.75 0 1 1-1.1-1.02 4.5 4.5 0 0 0 0-6.54.75.75 0 0 1 .04-1.07Zm-2.42 1.92a.75.75 0 0 1 1.06.06 3 3 0 0 1 0 4.52.75.75 0 1 1-1.12-1 1.5 1.5 0 0 0 0-2.52.75.75 0 0 1 .06-1.06Z"
      />
    </svg>
  );
}

function VolumeMutedIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 10.5A1.5 1.5 0 0 1 5.5 9H8l4.47-3.58A1 1 0 0 1 14 6.2v11.6a1 1 0 0 1-1.53.78L8 15H5.5A1.5 1.5 0 0 1 4 13.5v-3Zm11.03-.97a.75.75 0 0 1 1.06 0L18 11.44l1.91-1.9a.75.75 0 1 1 1.06 1.06l-1.9 1.9 1.9 1.91a.75.75 0 1 1-1.06 1.06L18 13.56l-1.9 1.91a.75.75 0 1 1-1.07-1.06l1.91-1.9-1.91-1.91a.75.75 0 0 1 0-1.06Z"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M6.75 4A2.75 2.75 0 0 0 4 6.75v2.5a.75.75 0 0 0 1.5 0v-2.5c0-.69.56-1.25 1.25-1.25h2.5a.75.75 0 0 0 0-1.5h-2.5Zm8 0a.75.75 0 0 0 0 1.5h2.5c.69 0 1.25.56 1.25 1.25v2.5a.75.75 0 0 0 1.5 0v-2.5A2.75 2.75 0 0 0 17.25 4h-2.5Zm4.5 10a.75.75 0 0 0-.75.75v2.5c0 .69-.56 1.25-1.25 1.25h-2.5a.75.75 0 0 0 0 1.5h2.5A2.75 2.75 0 0 0 20 17.25v-2.5a.75.75 0 0 0-.75-.75Zm-14.5 0a.75.75 0 0 0-.75.75v2.5A2.75 2.75 0 0 0 6.75 20h2.5a.75.75 0 0 0 0-1.5h-2.5c-.69 0-1.25-.56-1.25-1.25v-2.5a.75.75 0 0 0-.75-.75Z"
      />
    </svg>
  );
}

function TheaterIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M5.75 5A2.75 2.75 0 0 0 3 7.75v8.5A2.75 2.75 0 0 0 5.75 19h12.5A2.75 2.75 0 0 0 21 16.25v-8.5A2.75 2.75 0 0 0 18.25 5H5.75Zm0 1.5h12.5c.69 0 1.25.56 1.25 1.25v1.75H4.5V7.75c0-.69.56-1.25 1.25-1.25Zm-1.25 4.5H10v6.5H5.75c-.69 0-1.25-.56-1.25-1.25V11Zm7 0h8v5.25c0 .69-.56 1.25-1.25 1.25H11.5V11Z"
      />
    </svg>
  );
}

export function LocalFileRoomPlayer({
  room,
  selfId,
  localFile,
  isTheaterMode,
  remoteCommand,
  peerSignal,
  onDebug,
  onPlay,
  onPause,
  onSeek,
  onRequestSync,
  onPeerOffer,
  onPeerAnswer,
  onPeerIceCandidate,
  onTheaterModeChange,
  onTransferState
}: LocalFileRoomPlayerProps) {
  const isHost = room.hostParticipantId === selfId;
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const suppressEventsRef = useRef(false);
  const lastAppliedEventIdRef = useRef(-1);
  const activePeerIdRef = useRef<string | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingChunkMetaRef = useRef<ByteRange | null>(null);
  const receivedChunksRef = useRef(new Map<number, Uint8Array>());
  const availableRangesRef = useRef<ByteRange[]>([]);
  const contiguousBytesRef = useRef(0);
  const requestedRangeRef = useRef<ByteRange | null>(null);
  const lastBlobSizeRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  const cacheIdRef = useRef<string | null>(null);
  const pendingSeekTimeRef = useRef<number | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const transferStartedRef = useRef(false);
  const preparingHostMediaRef = useRef(false);
  const durationRef = useRef(room.mediaSource.duration ?? 0);
  const pendingPlaybackRestoreRef = useRef<PendingPlaybackRestore | null>(null);
  const suppressDisconnectRef = useRef(false);
  const lastReportedTransferRef = useRef<TransferState | null>(null);
  const localMessageRef = useRef("Waiting for peer connection");
  const controlsHideTimeoutRef = useRef<number | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [localMessage, setLocalMessage] = useState("Waiting for peer connection");
  const [isFullscreenMode, setIsFullscreenMode] = useState(false);
  const [isPlaying, setIsPlaying] = useState(room.playbackState === "playing");
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(room.currentTime);
  const [duration, setDuration] = useState(room.mediaSource.duration ?? 0);
  const [isPointerActive, setIsPointerActive] = useState(true);
  const debugRole = isHost ? "host" : "guest";
  const desktopApi = window.syncplayDesktop ?? fallbackDesktopApi;
  const mediaTitle = useMemo(() => formatMediaTitle(room.mediaSource.fileName), [room.mediaSource.fileName]);
  const subtitleLabel = `${isHost ? "Host" : "Guest"} • Local file`;
  const safeDuration = Math.max(duration, 0);
  const progressPercent = safeDuration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;
  const volumePercent = Math.min(100, Math.max(0, (isMuted ? 0 : volume) * 100));

  function reportLocalDebug(message: string, details?: Record<string, unknown>) {
    debugLog(debugRole, message, details);
    onDebug?.({
      scope: "local",
      message,
      details: details ? JSON.stringify(details) : undefined
    });
  }

  const remoteParticipantId = useMemo(
    () => room.participants.find((participant) => participant.id !== selfId)?.id ?? null,
    [room.participants, selfId]
  );

  useEffect(() => {
    debugLog(debugRole, "desktop bridge status", {
      hasDesktopApi: Boolean(window.syncplayDesktop),
      roomId: room.roomId
    });
  }, [debugRole, room.roomId]);

  useEffect(() => {
    return () => {
      if (controlsHideTimeoutRef.current !== null) {
        window.clearTimeout(controlsHideTimeoutRef.current);
      }
      cleanupPeer();
      revokeObjectUrl();
      void clearTempCache();
    };
  }, []);

  useEffect(() => {
    const wrapper = videoRef.current?.closest(".local-player-wrapper");

    function handleFullscreenChange() {
      setIsFullscreenMode(document.fullscreenElement === wrapper);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!mediaUrl) {
      setIsPointerActive(true);
      return;
    }

    if (!isPlaying) {
      setIsPointerActive(true);
      if (controlsHideTimeoutRef.current !== null) {
        window.clearTimeout(controlsHideTimeoutRef.current);
        controlsHideTimeoutRef.current = null;
      }
      return;
    }

    scheduleControlsHide();

    return () => {
      if (controlsHideTimeoutRef.current !== null) {
        window.clearTimeout(controlsHideTimeoutRef.current);
        controlsHideTimeoutRef.current = null;
      }
    };
  }, [isPlaying, mediaUrl]);

  useEffect(() => {
    if (isHost) {
      void prepareHostMedia();

      if (remoteParticipantId && !peerRef.current) {
        void createHostPeer(remoteParticipantId);
      }

      return;
    }

    if (!cacheIdRef.current) {
      void ensureTempCache();
    }
  }, [isHost, localFile, remoteParticipantId]);

  useEffect(() => {
    if (!peerSignal || peerSignal.roomId !== room.roomId) {
      return;
    }

    void handlePeerSignal(peerSignal);
  }, [peerSignal, room.roomId]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video || !remoteCommand || !mediaUrl) {
      return;
    }

    if (remoteCommand.kind === "event" && remoteCommand.actorId === selfId) {
      lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
      return;
    }

    if (lastAppliedEventIdRef.current === remoteCommand.room.lastEventId && remoteCommand.kind === "event") {
      return;
    }

    applyAuthoritativeState(video, remoteCommand.room);
    lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
  }, [mediaUrl, remoteCommand, selfId]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const video = videoRef.current;

      if (!video || !mediaUrl || room.playbackState !== "playing") {
        return;
      }

      const expectedTime = room.currentTime + (Date.now() - room.updatedAt) / 1000;

      if (Math.abs(expectedTime - video.currentTime) > DRIFT_THRESHOLD_SECONDS) {
        applyAuthoritativeState(video, {
          ...room,
          currentTime: expectedTime
        });
      }

      if (!isHost) {
        const bufferedUntilTime = calculateBufferedUntilTime(contiguousBytesRef.current);

        if (bufferedUntilTime !== undefined && bufferedUntilTime - video.currentTime < LOW_BUFFER_AHEAD_SECONDS) {
          requestNextRange("sequential");
        }
      }
    }, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, [isHost, mediaUrl, room]);

  async function ensureTempCache() {
    if (cacheIdRef.current) {
      return cacheIdRef.current;
    }

    if (!window.syncplayDesktop) {
      debugLog(debugRole, "desktop bridge unavailable for temp cache");
    }

    cacheIdRef.current = await desktopApi.createTempMediaCache(room.mediaSource.mediaId);
    return cacheIdRef.current;
  }

  async function clearTempCache() {
    if (!cacheIdRef.current) {
      return;
    }

    const cacheId = cacheIdRef.current;
    cacheIdRef.current = null;
    await desktopApi.removeTempMediaCache(cacheId);
  }

  async function prepareHostMedia() {
    if (!localFile || mediaUrl || preparingHostMediaRef.current) {
      debugLog(debugRole, "prepareHostMedia skipped", {
        hasLocalFile: Boolean(localFile),
        hasMediaUrl: Boolean(mediaUrl),
        preparing: preparingHostMediaRef.current
      });
      return;
    }

    preparingHostMediaRef.current = true;
    debugLog(debugRole, "prepareHostMedia start", {
      fileName: localFile.name,
      fileSize: localFile.size,
      mimeType: localFile.type
    });

    try {
      const url = createObjectUrlFromFile(localFile);
      setMediaUrl(url);
      updateLocalMessage("File ready on host");
      debugLog(debugRole, "prepareHostMedia success", { url });
    } catch {
      const failedState = buildTransferState("failed", {
        message: "Could not read the selected file"
      });
      updateLocalMessage(failedState.message ?? "Could not read the selected file");
      publishTransferState(failedState, true);
      debugLog(debugRole, "prepareHostMedia failed");
    } finally {
      preparingHostMediaRef.current = false;
    }
  }

  async function createHostPeer(targetParticipantId: string) {
    reportLocalDebug("createHostPeer", { targetParticipantId });
    cleanupPeer(false);
    const peer = buildPeerConnection(targetParticipantId);
    activePeerIdRef.current = targetParticipantId;
    const dataChannel = peer.createDataChannel("syncplay-file");
    dataChannel.binaryType = "arraybuffer";
    dataChannelRef.current = dataChannel;
    attachDataChannel(targetParticipantId, dataChannel);
    peerRef.current = peer;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    onPeerOffer(targetParticipantId, offer);
    publishTransferState(
      buildTransferState("connecting_peer", {
        message: "Connecting to peer"
      })
    );
  }

  async function createGuestPeer(sourceParticipantId: string) {
    reportLocalDebug("createGuestPeer", { sourceParticipantId });
    cleanupPeer(false);
    const peer = buildPeerConnection(sourceParticipantId);
    peer.ondatachannel = (event) => {
      dataChannelRef.current = event.channel;
      attachDataChannel(sourceParticipantId, event.channel);
    };
    peerRef.current = peer;
    activePeerIdRef.current = sourceParticipantId;
    publishTransferState(
      buildTransferState("connecting_peer", {
        message: "Waiting for file transfer"
      })
    );
    return peer;
  }

  function buildPeerConnection(targetParticipantId: string) {
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    reportLocalDebug("peer connection created", { targetParticipantId });
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        reportLocalDebug("peer ice candidate", {
          targetParticipantId,
          candidateType: event.candidate.type ?? "unknown"
        });
        onPeerIceCandidate(targetParticipantId, event.candidate.toJSON());
      }
    };
    peer.onconnectionstatechange = () => {
      reportLocalDebug("peer connection state", {
        targetParticipantId,
        state: peer.connectionState
      });
      if (suppressDisconnectRef.current) {
        return;
      }

      if (peer.connectionState === "connected") {
        reconnectAttemptRef.current = 0;
        return;
      }

      if (peer.connectionState === "disconnected" || peer.connectionState === "failed") {
        handlePeerDisconnect(targetParticipantId);
      }
    };
    return peer;
  }

  function attachDataChannel(targetParticipantId: string, channel: RTCDataChannel) {
    reportLocalDebug("attachDataChannel", {
      targetParticipantId,
      label: channel.label,
      readyState: channel.readyState
    });
    channel.onopen = () => {
      reportLocalDebug("data channel open", { targetParticipantId });
      if (isHost) {
        updateLocalMessage("Connected to peer");
        return;
      }

      updateLocalMessage("Preparing playback");
      requestNextRange("initial");
    };

    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        void handleControlMessage(targetParticipantId, JSON.parse(event.data) as PeerControlMessage);
        return;
      }

      void handleBinaryChunk(event.data);
    };

    channel.onerror = () => {
      reportLocalDebug("data channel error", {
        targetParticipantId
      });
      handlePeerDisconnect(targetParticipantId);
    };

    channel.onclose = () => {
      reportLocalDebug("data channel close", {
        targetParticipantId
      });
    };
  }

  async function handlePeerSignal(signal: PeerSignal) {
    reportLocalDebug("handlePeerSignal", {
      type: signal.type,
      sourceParticipantId: signal.sourceParticipantId
    });

    try {
      if (signal.type === "peer_offer") {
        const shouldCreateNewPeer =
          !peerRef.current || (activePeerIdRef.current !== null && activePeerIdRef.current !== signal.sourceParticipantId);
        const peer = shouldCreateNewPeer ? await createGuestPeer(signal.sourceParticipantId) : peerRef.current;

        if (!peer) {
          return;
        }

        await peer.setRemoteDescription(signal.sdp);
        await flushPendingIceCandidates(peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        reportLocalDebug("peer answer created", {
          sourceParticipantId: signal.sourceParticipantId
        });
        onPeerAnswer(signal.sourceParticipantId, answer);
        return;
      }

      if (signal.type === "peer_answer") {
        if (!peerRef.current) {
          return;
        }

        await peerRef.current.setRemoteDescription(signal.sdp);
        await flushPendingIceCandidates(peerRef.current);
        reportLocalDebug("peer answer applied", {
          sourceParticipantId: signal.sourceParticipantId
        });
        return;
      }

      if (signal.type === "peer_ice_candidate") {
        if (!peerRef.current || !peerRef.current.remoteDescription) {
          pendingIceCandidatesRef.current.push(signal.candidate);
          reportLocalDebug("peer ice candidate queued", {
            sourceParticipantId: signal.sourceParticipantId
          });
          return;
        }

        await peerRef.current.addIceCandidate(signal.candidate);
        reportLocalDebug("peer ice candidate applied", {
          sourceParticipantId: signal.sourceParticipantId
        });
      }
    } catch (error) {
      const errorDetails = {
        type: signal.type,
        sourceParticipantId: signal.sourceParticipantId,
        error: formatError(error)
      };
      reportLocalDebug("peer signal failed", errorDetails);
      updateLocalMessage("Peer negotiation failed");
      publishTransferState(
        buildTransferState("failed", {
          message: "Peer negotiation failed"
        }),
        true
      );
    }
  }

  function handlePeerDisconnect(targetParticipantId: string) {
    if (suppressDisconnectRef.current) {
      return;
    }

    reconnectAttemptRef.current += 1;
    reportLocalDebug("peer disconnect", {
      targetParticipantId,
      reconnectAttempt: reconnectAttemptRef.current
    });
    const video = videoRef.current;
    video?.pause();
    updateLocalMessage("Reconnecting to host");

    publishTransferState(
      buildTransferState("connecting_peer", {
        message: "Reconnecting to host",
        reconnectAttempt: reconnectAttemptRef.current
      })
    );

    cleanupPeer(false);

    if (isHost) {
      window.setTimeout(() => {
        if (room.hostParticipantId === selfId) {
          void createHostPeer(targetParticipantId);
        }
      }, 600);
    }
  }

  async function handleControlMessage(sourceParticipantId: string, message: PeerControlMessage) {
    switch (message.type) {
      case "file-start":
        durationRef.current = message.duration ?? durationRef.current;
        updateLocalMessage("Preparing playback");
        await ensureTempCache();
        return;
      case "range-request":
        if (!isHost || !localFile || !dataChannelRef.current) {
          return;
        }

        await sendRequestedRange(dataChannelRef.current, message);
        return;
      case "chunk-meta":
        pendingChunkMetaRef.current = {
          startByte: message.startByte,
          endByte: message.endByte
        };
        return;
      case "range-complete":
        requestedRangeRef.current = null;
        if (message.reason === "seek" && typeof message.targetTime === "number") {
          pendingSeekTimeRef.current = message.targetTime;
        }
        maybePromotePlaybackReady();
        maybeRefreshMediaSource();
        maybeResumePendingSeek();
        if (shouldPrefetchMoreData()) {
          requestNextRange(pendingSeekTimeRef.current !== undefined ? "seek" : "sequential");
        }
        return;
      case "buffer-ready":
        return;
      case "seek-buffering":
        updateLocalMessage(`Buffering at ${formatTime(message.targetTime)}`);
        return;
      case "file-complete":
        publishTransferState(
          buildTransferState("ended", {
            message: "Transfer complete",
            bytesReceived: room.mediaSource.fileSize,
            bytesPersisted: room.mediaSource.fileSize
          }),
          true
        );
        maybeRefreshMediaSource(true);
        return;
    }
  }

  async function sendRequestedRange(
    channel: RTCDataChannel,
    request: Extract<PeerControlMessage, { type: "range-request" }>
  ) {
    if (!localFile) {
      return;
    }

    if (durationRef.current <= 0 && videoRef.current?.duration && Number.isFinite(videoRef.current.duration)) {
      durationRef.current = videoRef.current.duration;
    }

    channel.send(
      JSON.stringify({
        type: "file-start",
        fileName: room.mediaSource.fileName,
        fileSize: room.mediaSource.fileSize,
        mimeType: room.mediaSource.mimeType,
        mediaId: room.mediaSource.mediaId,
        duration: durationRef.current || undefined
      } satisfies PeerControlMessage)
    );

    let offset = request.startByte;
    let chunksSinceYield = 0;

    while (offset < request.endByte) {
      const length = Math.min(CHUNK_SIZE, request.endByte - offset);
      const chunk = new Uint8Array(await localFile.slice(offset, offset + length).arrayBuffer());

      if (chunk.byteLength === 0) {
        break;
      }

      const endByte = offset + chunk.byteLength;
      channel.send(
        JSON.stringify({
          type: "chunk-meta",
          startByte: offset,
          endByte
        } satisfies PeerControlMessage)
      );
      channel.send(Uint8Array.from(chunk));
      offset = endByte;
      chunksSinceYield += 1;

      if (channel.bufferedAmount > DATA_CHANNEL_HIGH_WATER_MARK) {
        await waitForChannelDrain(channel);
      } else if (chunksSinceYield >= 8) {
        chunksSinceYield = 0;
        await yieldToUi();
      }
    }

    channel.send(
      JSON.stringify({
        type: "range-complete",
        startByte: request.startByte,
        endByte: offset,
        reason: request.reason,
        targetTime: request.targetTime
      } satisfies PeerControlMessage)
    );

    if (offset >= room.mediaSource.fileSize) {
      channel.send(JSON.stringify({ type: "file-complete" } satisfies PeerControlMessage));
    }
  }

  async function handleBinaryChunk(payload: Blob | ArrayBuffer) {
    const range = pendingChunkMetaRef.current;

    if (!range) {
      return;
    }

    const chunk = payload instanceof Blob ? new Uint8Array(await payload.arrayBuffer()) : new Uint8Array(payload);
    pendingChunkMetaRef.current = null;
    receivedChunksRef.current.set(range.startByte, chunk);
    availableRangesRef.current = mergeRanges(availableRangesRef.current, {
      startByte: range.startByte,
      endByte: range.startByte + chunk.byteLength
    });
    contiguousBytesRef.current = getContiguousEnd(availableRangesRef.current);

    const cacheId = await ensureTempCache();
    if (cacheId) {
      await desktopApi.writeTempMediaChunk(cacheId, range.startByte, chunk);
    }

    publishTransferState(
      buildTransferState("buffering", {
        message: pendingSeekTimeRef.current !== undefined ? `Buffering at ${formatTime(pendingSeekTimeRef.current)}` : "Preparing playback"
      })
    );

    maybePromotePlaybackReady();
    maybeRefreshMediaSource();
    maybeResumePendingSeek();
  }

  function maybePromotePlaybackReady() {
    if (isHost) {
      return;
    }

    const video = videoRef.current;
    const playableBufferedUntil = getPlayableBufferedUntil(video);
    const hasPlayableFrame = hasCurrentPlayableData(video);
    const isReady =
      hasPlayableFrame &&
      playableBufferedUntil !== undefined &&
      playableBufferedUntil >= Math.max(MIN_INITIAL_BUFFER_SECONDS, room.currentTime + SEEK_RESUME_PADDING_SECONDS);

    if (!isReady) {
      return;
    }

    updateLocalMessage("Ready to play");
    publishTransferState(
      buildTransferState("ready", {
        bufferedUntilTime: playableBufferedUntil,
        isPlaybackReady: true,
        message: "Ready to play"
      })
    );

    if (dataChannelRef.current) {
      dataChannelRef.current.send(
        JSON.stringify({
          type: "buffer-ready",
          bufferedUntilTime: playableBufferedUntil
        } satisfies PeerControlMessage)
      );
    }
  }

  function maybeResumePendingSeek() {
    const pendingSeekTime = pendingSeekTimeRef.current;

    if (pendingSeekTime === undefined) {
      return;
    }

    const video = videoRef.current;

    if (!video) {
      return;
    }

    const bufferedUntilTime = getPlayableBufferedUntil(video);

    if (bufferedUntilTime === undefined || bufferedUntilTime < pendingSeekTime + SEEK_RESUME_PADDING_SECONDS) {
      return;
    }

    pendingSeekTimeRef.current = undefined;
    pendingPlaybackRestoreRef.current = {
      time: pendingSeekTime,
      shouldPlay: room.playbackState === "playing"
    };
    maybeRefreshMediaSource(true);
    updateLocalMessage(room.playbackState === "playing" ? "Playback resumed" : "Ready to play");
    publishTransferState(
      buildTransferState(room.playbackState === "playing" ? "streaming" : "ready", {
        bufferedUntilTime,
        isPlaybackReady: true,
        message: room.playbackState === "playing" ? "Playback resumed" : "Ready at seek position"
      })
    );
  }

  function maybeRefreshMediaSource(force = false) {
    if (isHost) {
      return;
    }

    const contiguousBytes = contiguousBytesRef.current;
    const bufferedUntilTime = calculateBufferedUntilTime(contiguousBytes);

    if (contiguousBytes === 0) {
      return;
    }

    if (!force) {
      const hasInitialBuffer =
        contiguousBytes >= MIN_INITIAL_BUFFER_BYTES ||
        (bufferedUntilTime !== undefined && bufferedUntilTime >= MIN_INITIAL_BUFFER_SECONDS);

      if (!hasInitialBuffer) {
        return;
      }
    }

    if (!force && contiguousBytes - lastBlobSizeRef.current < BLOB_REFRESH_STEP_BYTES) {
      const video = videoRef.current;
      const currentBlobBufferedUntil = getPlayableBufferedUntil(video) ?? calculateBufferedUntilTime(lastBlobSizeRef.current);

      if (
        mediaUrl &&
        pendingSeekTimeRef.current === undefined &&
        video &&
        currentBlobBufferedUntil !== undefined &&
        currentBlobBufferedUntil - video.currentTime > SOURCE_REFRESH_AHEAD_SECONDS
      ) {
        return;
      }
    }

    const video = videoRef.current;
    pendingPlaybackRestoreRef.current = {
      time: pendingSeekTimeRef.current ?? video?.currentTime ?? room.currentTime,
      shouldPlay: room.playbackState === "playing"
    };
    suppressEventsRef.current = true;

    const bytes = buildContiguousPrefix(contiguousBytes, receivedChunksRef.current);
    const url = createObjectUrl(bytes, room.mediaSource.mimeType);
    lastBlobSizeRef.current = contiguousBytes;
    setMediaUrl(url);
    updateLocalMessage(
      pendingSeekTimeRef.current !== undefined
        ? `Buffering at ${formatTime(pendingSeekTimeRef.current)}`
        : room.playbackState === "playing"
          ? "Streaming local file"
          : "Ready to play"
    );
  }

  function requestNextRange(reason: RangeRequestReason) {
    if (isHost || !dataChannelRef.current || dataChannelRef.current.readyState !== "open") {
      return;
    }

    if (requestedRangeRef.current) {
      return;
    }

    const startByte = contiguousBytesRef.current;

    if (startByte >= room.mediaSource.fileSize) {
      return;
    }

    const targetTime = pendingSeekTimeRef.current;
    const targetByte =
      targetTime !== undefined ? estimateByteOffset(targetTime, durationRef.current, room.mediaSource.fileSize) : undefined;
    const baseEnd = startByte + REQUEST_WINDOW_BYTES;
    const seekEnd = targetByte !== undefined ? targetByte + REQUEST_WINDOW_BYTES : baseEnd;
    const endByte = Math.min(room.mediaSource.fileSize, Math.max(baseEnd, seekEnd));
    const requestRange = {
      startByte,
      endByte
    };

    const effectiveTransferState = lastReportedTransferRef.current ?? room.transferState;
    const nextPhase =
      reason === "initial"
        ? "buffering"
        : effectiveTransferState?.isPlaybackReady
          ? room.playbackState === "playing"
            ? "streaming"
            : "ready"
          : effectiveTransferState?.phase ?? "buffering";
    const nextMessage =
      reason === "seek" && targetTime !== undefined
        ? `Buffering at ${formatTime(targetTime)}`
        : reason === "initial"
          ? "Preparing playback"
          : effectiveTransferState?.isPlaybackReady
            ? room.playbackState === "playing"
              ? "Streaming local file"
              : "Ready to play"
            : effectiveTransferState?.message ?? "Preparing playback";

    requestedRangeRef.current = requestRange;
    dataChannelRef.current.send(
      JSON.stringify({
        type: "range-request",
        startByte,
        endByte,
        reason,
        targetTime
      } satisfies PeerControlMessage)
    );

    publishTransferState(
      buildTransferState(nextPhase, {
        message: nextMessage,
        pendingSeekTime: targetTime,
        lastRequestedRange: requestRange
      })
    );

    if (reason === "seek" && targetTime !== undefined && dataChannelRef.current) {
      dataChannelRef.current.send(
        JSON.stringify({
          type: "seek-buffering",
          targetTime
        } satisfies PeerControlMessage)
      );
    }
  }

  function shouldPrefetchMoreData() {
    if (contiguousBytesRef.current >= room.mediaSource.fileSize) {
      return false;
    }

    if (pendingSeekTimeRef.current !== undefined) {
      return true;
    }

    const effectiveTransferState = lastReportedTransferRef.current ?? room.transferState;

    if (!effectiveTransferState?.isPlaybackReady) {
      return true;
    }

    return room.playbackState === "playing";
  }

  function handlePlay() {
    const video = videoRef.current;

    if (!video || suppressEventsRef.current || !mediaUrl) {
      debugLog(debugRole, "handlePlay ignored", {
        hasVideo: Boolean(video),
        suppressing: suppressEventsRef.current,
        hasMediaUrl: Boolean(mediaUrl)
      });
      return;
    }

    const bufferedUntilTime = isHost ? Number.POSITIVE_INFINITY : getPlayableBufferedUntil(video);

    if (bufferedUntilTime !== undefined && video.currentTime >= bufferedUntilTime - 0.25) {
      debugLog(debugRole, "handlePlay requesting more buffer", {
        currentTime: video.currentTime,
        bufferedUntilTime
      });
      video.pause();
      pendingSeekTimeRef.current = video.currentTime;
      requestNextRange("seek");
      return;
    }

    setIsPlaying(true);
    debugLog(debugRole, "handlePlay forwarding play", {
      currentTime: video.currentTime
    });
    onPlay(video.currentTime);
  }

  function handlePause() {
    const video = videoRef.current;

    if (!video || suppressEventsRef.current || !mediaUrl) {
      debugLog(debugRole, "handlePause ignored", {
        hasVideo: Boolean(video),
        suppressing: suppressEventsRef.current,
        hasMediaUrl: Boolean(mediaUrl)
      });
      return;
    }

    setIsPlaying(false);
    debugLog(debugRole, "handlePause forwarding pause", {
      currentTime: video.currentTime
    });
    onPause(video.currentTime);
  }

  function handleSeeked() {
    const video = videoRef.current;

    if (!video || suppressEventsRef.current || !mediaUrl) {
      return;
    }

    if (isHost) {
      debugLog(debugRole, "handleSeeked forwarding seek", {
        currentTime: video.currentTime
      });
      onSeek(video.currentTime);
      return;
    }

    const bufferedUntilTime = getPlayableBufferedUntil(video);

    if (bufferedUntilTime !== undefined && video.currentTime <= bufferedUntilTime - SEEK_RESUME_PADDING_SECONDS) {
      onSeek(video.currentTime);
      return;
    }

    pendingSeekTimeRef.current = video.currentTime;
    video.pause();
    onSeek(video.currentTime);
    requestNextRange("seek");
  }

  function handleLoadedMetadata() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    debugLog(debugRole, "loadedmetadata", {
      duration: video.duration,
      readyState: video.readyState,
      networkState: video.networkState,
      currentTime: video.currentTime
    });

    if (isHost && Number.isFinite(video.duration) && video.duration > 0) {
      durationRef.current = video.duration;
    }

    if (Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    }

    restorePendingPlayback(video, "loadedmetadata");
  }

  function handleTimeUpdate() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    setCurrentTime(video.currentTime);

    if (Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    }
  }

  function handleVolumeChange() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    setIsMuted(video.muted);
    setVolume(video.volume);
  }

  function scheduleControlsHide() {
    if (controlsHideTimeoutRef.current !== null) {
      window.clearTimeout(controlsHideTimeoutRef.current);
    }

    controlsHideTimeoutRef.current = window.setTimeout(() => {
      setIsPointerActive(false);
      controlsHideTimeoutRef.current = null;
    }, CONTROLS_IDLE_DELAY_MS);
  }

  function revealControls() {
    setIsPointerActive(true);

    if (!isPlaying || !mediaUrl) {
      if (controlsHideTimeoutRef.current !== null) {
        window.clearTimeout(controlsHideTimeoutRef.current);
        controlsHideTimeoutRef.current = null;
      }
      return;
    }

    scheduleControlsHide();
  }

  function togglePlayback() {
    const video = videoRef.current;

    if (!video || !mediaUrl) {
      return;
    }

    if (video.paused) {
      void video.play();
      return;
    }

    video.pause();
  }

  function handleTimelineInput(event: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const nextTime = Number(event.target.value);
    video.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function handleVolumeInput(event: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const nextVolume = Number(event.target.value);
    video.volume = nextVolume;
    video.muted = nextVolume === 0;
    setVolume(nextVolume);
    setIsMuted(video.muted);
  }

  function toggleMute() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    video.muted = !video.muted;
    setIsMuted(video.muted);
  }

  async function toggleFullscreen() {
    const wrapper = videoRef.current?.closest(".local-player-wrapper");

    if (!wrapper) {
      return;
    }

    if (document.fullscreenElement === wrapper) {
      await document.exitFullscreen();
      return;
    }

    await wrapper.requestFullscreen();
  }

  return (
    <div className={`local-player-shell ${isTheaterMode ? "local-player-shell--theater" : ""}`}>
      <div
        className={`local-player-wrapper ${isFullscreenMode ? "local-player-wrapper--fullscreen" : ""}`}
        onMouseMove={revealControls}
        onMouseEnter={revealControls}
      >
        <video
          ref={videoRef}
          className="local-video"
          playsInline
          src={mediaUrl ?? undefined}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={() => {
            const video = videoRef.current;
            debugLog(debugRole, "loadeddata", {
              readyState: video?.readyState,
              currentTime: video?.currentTime
            });
            if (video) {
              maybePromotePlaybackReady();
              maybeResumePendingSeek();
              restorePendingPlayback(video, "loadeddata");
            }
          }}
          onCanPlay={() => {
            const video = videoRef.current;
            debugLog(debugRole, "canplay", {
              readyState: video?.readyState,
              currentTime: video?.currentTime
            });
            if (video) {
              maybePromotePlaybackReady();
              maybeResumePendingSeek();
              restorePendingPlayback(video, "canplay");
            }
          }}
          onError={() => {
            const video = videoRef.current;
            debugLog(debugRole, "video error", {
              mediaErrorCode: video?.error?.code,
              mediaErrorMessage: video?.error?.message ?? null,
              networkState: video?.networkState,
              readyState: video?.readyState,
              currentSrc: video?.currentSrc ?? null
            });
          }}
          onPlay={handlePlay}
          onPause={handlePause}
          onSeeked={handleSeeked}
          onTimeUpdate={handleTimeUpdate}
          onVolumeChange={handleVolumeChange}
          onDoubleClick={() => {
            void toggleFullscreen();
          }}
        />
        {mediaUrl && !isPlaying ? (
          <button className="local-player-center-action" type="button" onClick={togglePlayback} aria-label="Play video">
            <PlayIcon />
          </button>
        ) : null}
        <div className={`local-player-overlay ${isPointerActive ? "local-player-overlay--visible" : "local-player-overlay--hidden"}`}>
          <div className="local-player-topbar">
            <div className="local-player-title-block">
              <strong>{mediaTitle}</strong>
              <span>{subtitleLabel}</span>
            </div>
            <div className="local-player-view-modes">
              <div className="local-player-badge">
                <span className={`local-player-dot ${isPlaying ? "local-player-dot--live" : ""}`} />
                <span>{isPlaying ? "In sync" : "Paused in room"}</span>
              </div>
            </div>
          </div>

          <div className="local-player-bottom">
            <div className="local-player-scrubber">
              <input
                className="local-player-range"
                type="range"
                min={0}
                max={safeDuration}
                step={0.1}
                value={Math.min(currentTime, safeDuration)}
                onChange={(event) => {
                  revealControls();
                  handleTimelineInput(event);
                }}
                disabled={!mediaUrl || duration <= 0}
                aria-label="Playback timeline"
                style={
                  {
                    "--player-progress": `${progressPercent}%`
                  } as React.CSSProperties
                }
              />
            </div>

            <div className="local-player-controls">
              <div className="local-player-control-group">
                <button className="local-player-icon-button" type="button" onClick={() => {
                  revealControls();
                  togglePlayback();
                }} disabled={!mediaUrl} aria-label={isPlaying ? "Pause video" : "Play video"}>
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button className="local-player-icon-button" type="button" onClick={() => {
                  revealControls();
                  toggleMute();
                }} disabled={!mediaUrl} aria-label={isMuted || volume === 0 ? "Unmute video" : "Mute video"}>
                  {isMuted || volume === 0 ? <VolumeMutedIcon /> : <VolumeHighIcon />}
                </button>
                <input
                  className="local-player-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(event) => {
                    revealControls();
                    handleVolumeInput(event);
                  }}
                  disabled={!mediaUrl}
                  aria-label="Volume"
                  style={
                    {
                      "--player-progress": `${volumePercent}%`
                    } as React.CSSProperties
                  }
                />
              </div>

              <div className="local-player-time-block">
                <div className="local-player-time">
                  <strong>{formatTime(currentTime)}</strong>
                  <span>/ {formatTime(duration)}</span>
                </div>
                <div className="local-player-time-actions">
                  <button
                    className="local-player-toolbar-button local-player-toolbar-button--icon"
                    type="button"
                    onClick={() => {
                      revealControls();
                      onTheaterModeChange(!isTheaterMode);
                    }}
                    aria-label={isTheaterMode ? "Exit theater mode" : "Enter theater mode"}
                    title={isTheaterMode ? "Exit theater mode" : "Enter theater mode"}
                  >
                    <TheaterIcon />
                  </button>
                  <button
                    className="local-player-toolbar-button local-player-toolbar-button--icon"
                    type="button"
                    onClick={() => {
                      revealControls();
                      void toggleFullscreen();
                    }}
                    aria-label={isFullscreenMode ? "Exit fullscreen" : "Enter fullscreen"}
                    title={isFullscreenMode ? "Exit fullscreen" : "Enter fullscreen"}
                  >
                    <ExpandIcon />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="local-player-meta">
        <strong>{room.mediaSource.fileName}</strong>
        <span>{localMessage}</span>
        {room.transferState ? (
          <>
            <span>
              {room.transferState.phase} {Math.round(room.transferState.progress * 100)}%
            </span>
            {room.transferState.bufferedUntilTime !== undefined ? (
              <span>Buffered to {formatTime(room.transferState.bufferedUntilTime)}</span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );

  function applyAuthoritativeState(video: HTMLVideoElement, authoritativeRoom: RoomState) {
    suppressEventsRef.current = true;
    setIsPlaying(authoritativeRoom.playbackState === "playing");
    setCurrentTime(authoritativeRoom.currentTime);
    debugLog(debugRole, "applyAuthoritativeState", {
      playbackState: authoritativeRoom.playbackState,
      currentTime: authoritativeRoom.currentTime,
      localCurrentTime: video.currentTime,
      lastEventId: authoritativeRoom.lastEventId
    });

    const playableBufferedUntil = isHost ? Number.POSITIVE_INFINITY : getPlayableBufferedUntil(video);

    if (
      !isHost &&
      playableBufferedUntil !== undefined &&
      authoritativeRoom.currentTime > playableBufferedUntil - 0.25
    ) {
      pendingSeekTimeRef.current = authoritativeRoom.currentTime;
      requestNextRange("seek");
    } else if (Math.abs(video.currentTime - authoritativeRoom.currentTime) > DRIFT_THRESHOLD_SECONDS) {
      video.currentTime = authoritativeRoom.currentTime;
    }

    if (authoritativeRoom.playbackState === "playing") {
      const bufferedUntilTime = isHost ? Number.POSITIVE_INFINITY : getPlayableBufferedUntil(video);

      if (bufferedUntilTime !== undefined && authoritativeRoom.currentTime > bufferedUntilTime - 0.25) {
        pendingSeekTimeRef.current = authoritativeRoom.currentTime;
        requestNextRange("seek");
      } else {
        void video
          .play()
          .then(() => {
            debugLog(debugRole, "authoritative play resolved", {
              currentTime: video.currentTime
            });
          })
          .catch((error: unknown) => {
            debugLog(debugRole, "authoritative play rejected", {
              error: formatError(error)
            });
          });
      }
    } else {
      video.pause();
    }

    window.setTimeout(() => {
      suppressEventsRef.current = false;
    }, 150);
  }

  function restorePendingPlayback(video: HTMLVideoElement, trigger: "loadedmetadata" | "loadeddata" | "canplay") {
    const pendingPlaybackRestore = pendingPlaybackRestoreRef.current;

    if (!pendingPlaybackRestore) {
      return;
    }

    const playableBufferedUntil = isHost ? Number.POSITIVE_INFINITY : getPlayableBufferedUntil(video);
    const canRestoreAtTarget =
      pendingPlaybackRestore.time <= 0.25 ||
      playableBufferedUntil === undefined ||
      pendingPlaybackRestore.time <= playableBufferedUntil - 0.25;

    if (!canRestoreAtTarget) {
      debugLog(debugRole, "restorePendingPlayback waiting for more data", {
        trigger,
        targetTime: pendingPlaybackRestore.time,
        playableBufferedUntil
      });
      pendingSeekTimeRef.current = pendingPlaybackRestore.time;
      requestNextRange("seek");
      return;
    }

    debugLog(debugRole, "restorePendingPlayback applying", {
      trigger,
      targetTime: pendingPlaybackRestore.time,
      shouldPlay: pendingPlaybackRestore.shouldPlay,
      playableBufferedUntil
    });

    video.currentTime = pendingPlaybackRestore.time;
    setCurrentTime(pendingPlaybackRestore.time);

    if (pendingPlaybackRestore.shouldPlay) {
      void video
        .play()
        .then(() => {
          debugLog(debugRole, "play after restore resolved", {
            trigger,
            currentTime: video.currentTime
          });
        })
        .catch((error: unknown) => {
          debugLog(debugRole, "play after restore rejected", {
            trigger,
            error: formatError(error)
          });
        });
    }

    window.setTimeout(() => {
      suppressEventsRef.current = false;
    }, 150);

    pendingPlaybackRestoreRef.current = null;
  }

  function calculateBufferedUntilTime(contiguousBytes: number) {
    if (!durationRef.current || room.mediaSource.fileSize <= 0) {
      return undefined;
    }

    return Math.min(durationRef.current, (contiguousBytes / room.mediaSource.fileSize) * durationRef.current);
  }

  function buildTransferState(phase: TransferState["phase"], overrides: Partial<TransferState> = {}): TransferState {
    const bytesReceived = overrides.bytesReceived ?? contiguousBytesRef.current;
    const bytesPersisted = overrides.bytesPersisted ?? contiguousBytesRef.current;
    const bytesTotal = room.mediaSource.fileSize;
    const bufferedUntilTime = overrides.bufferedUntilTime ?? calculateBufferedUntilTime(contiguousBytesRef.current);
    const effectiveTransferState = lastReportedTransferRef.current ?? room.transferState;

    return {
      phase,
      bytesReceived,
      bytesTotal,
      bytesPersisted,
      progress: bytesTotal > 0 ? bytesPersisted / bytesTotal : 0,
      bufferedUntilTime,
      isPlaybackReady: overrides.isPlaybackReady ?? effectiveTransferState?.isPlaybackReady ?? false,
      pendingSeekTime: overrides.pendingSeekTime ?? pendingSeekTimeRef.current,
      reconnectAttempt: overrides.reconnectAttempt ?? (reconnectAttemptRef.current || undefined),
      lastRequestedRange: overrides.lastRequestedRange ?? requestedRangeRef.current ?? undefined,
      availableRanges: overrides.availableRanges ?? availableRangesRef.current,
      message: overrides.message
    };
  }

  function updateLocalMessage(nextMessage: string) {
    if (localMessageRef.current === nextMessage) {
      return;
    }

    localMessageRef.current = nextMessage;
    setLocalMessage(nextMessage);
  }

  function publishTransferState(nextState: TransferState, force = false) {
    const previousState = lastReportedTransferRef.current;

    if (!force && previousState) {
      const previousProgressBucket = Math.floor(previousState.progress / TRANSFER_PROGRESS_BUCKET);
      const nextProgressBucket = Math.floor(nextState.progress / TRANSFER_PROGRESS_BUCKET);
      const previousBufferedBucket =
        previousState.bufferedUntilTime !== undefined
          ? Math.floor(previousState.bufferedUntilTime / BUFFERED_TIME_BUCKET_SECONDS)
          : -1;
      const nextBufferedBucket =
        nextState.bufferedUntilTime !== undefined
          ? Math.floor(nextState.bufferedUntilTime / BUFFERED_TIME_BUCKET_SECONDS)
          : -1;

      if (
        previousState.phase === nextState.phase &&
        previousState.message === nextState.message &&
        previousProgressBucket === nextProgressBucket &&
        previousBufferedBucket === nextBufferedBucket &&
        previousState.isPlaybackReady === nextState.isPlaybackReady &&
        previousState.pendingSeekTime === nextState.pendingSeekTime
      ) {
        return;
      }
    }

    lastReportedTransferRef.current = nextState;
    onTransferState(nextState);
  }

  function createObjectUrl(bytes: Uint8Array, mimeType: string) {
    revokeObjectUrl();
    const safeBytes = Uint8Array.from(bytes);
    const url = URL.createObjectURL(new Blob([safeBytes], { type: mimeType }));
    objectUrlRef.current = url;
    return url;
  }

  function createObjectUrlFromFile(file: File) {
    revokeObjectUrl();
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    return url;
  }

  function revokeObjectUrl() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }

  function cleanupPeer(resetTransfer = true) {
    suppressDisconnectRef.current = true;
    dataChannelRef.current?.close();
    peerRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current = null;
    activePeerIdRef.current = null;
    transferStartedRef.current = false;
    pendingIceCandidatesRef.current = [];
    pendingChunkMetaRef.current = null;
    window.setTimeout(() => {
      suppressDisconnectRef.current = false;
    }, 0);

    if (resetTransfer) {
      requestedRangeRef.current = null;
    }
  }

  async function flushPendingIceCandidates(peer: RTCPeerConnection) {
    if (!peer.remoteDescription || pendingIceCandidatesRef.current.length === 0) {
      return;
    }

    const pendingCandidates = [...pendingIceCandidatesRef.current];
    pendingIceCandidatesRef.current = [];

    for (const candidate of pendingCandidates) {
      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
}

function debugLog(role: "host" | "guest", message: string, details?: Record<string, unknown>) {
  console.info(`[syncplay:local:${role}] ${message}`, details ?? {});
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return String(error);
}

function mergeRanges(ranges: ByteRange[], incomingRange: ByteRange) {
  const nextRanges = [...ranges, incomingRange].sort((left, right) => left.startByte - right.startByte);
  const merged: ByteRange[] = [];

  for (const range of nextRanges) {
    const lastRange = merged[merged.length - 1];

    if (!lastRange || range.startByte > lastRange.endByte) {
      merged.push({ ...range });
      continue;
    }

    lastRange.endByte = Math.max(lastRange.endByte, range.endByte);
  }

  return merged;
}

function getContiguousEnd(ranges: ByteRange[]) {
  let contiguousEnd = 0;

  for (const range of ranges) {
    if (range.startByte > contiguousEnd) {
      break;
    }

    contiguousEnd = Math.max(contiguousEnd, range.endByte);
  }

  return contiguousEnd;
}

function buildContiguousPrefix(totalLength: number, chunks: Map<number, Uint8Array>) {
  const merged = new Uint8Array(totalLength);
  const sortedChunks = Array.from(chunks.entries()).sort(([leftStart], [rightStart]) => leftStart - rightStart);

  for (const [startByte, chunk] of sortedChunks) {
    if (startByte >= totalLength) {
      break;
    }

    merged.set(chunk.subarray(0, Math.min(chunk.byteLength, totalLength - startByte)), startByte);
  }

  return merged;
}

function estimateByteOffset(targetTime: number, duration: number, totalBytes: number) {
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(totalBytes, Math.floor((targetTime / duration) * totalBytes)));
}

function formatTime(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return "0:00";
  }

  const safeSeconds = Math.floor(totalSeconds);
  const minutes = Math.floor(safeSeconds / 60).toString();
  const seconds = (safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getPlayableBufferedUntil(video: HTMLVideoElement | null) {
  const mediaBufferedUntil = getMediaBufferedEnd(video);

  if (mediaBufferedUntil !== undefined) {
    return mediaBufferedUntil;
  }

  return calculateBufferedTimeFromFile(video);
}

function hasCurrentPlayableData(video: HTMLVideoElement | null) {
  if (!video) {
    return false;
  }

  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && getPlayableBufferedUntil(video) !== undefined;
}

function getMediaBufferedEnd(video: HTMLVideoElement | null) {
  if (!video || video.buffered.length === 0) {
    return undefined;
  }

  try {
    return video.buffered.end(video.buffered.length - 1);
  } catch {
    return undefined;
  }
}

function calculateBufferedTimeFromFile(video: HTMLVideoElement | null) {
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
    return undefined;
  }

  for (let index = 0; index < video.seekable.length; index += 1) {
    try {
      const start = video.seekable.start(index);
      const end = video.seekable.end(index);

      if (video.currentTime >= start && video.currentTime <= end) {
        return end;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function yieldToUi() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function waitForChannelDrain(channel: RTCDataChannel) {
  channel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER_MARK;

  if (channel.bufferedAmount <= DATA_CHANNEL_LOW_WATER_MARK) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const handleBufferedAmountLow = () => {
      channel.removeEventListener("bufferedamountlow", handleBufferedAmountLow);
      resolve();
    };

    channel.addEventListener("bufferedamountlow", handleBufferedAmountLow, { once: true });
  });
}
