import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ByteRange,
  HostedFileMediaSource,
  PickedLocalFile,
  RangeRequestReason,
  RoomState,
  SubtitleFileFormat,
  SubtitleTrack,
  TransferState
} from "@syncplay/shared";

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
  room: RoomState & { mediaSource: HostedFileMediaSource };
  selfId: string | null;
  localFile: PickedLocalFile | File | null;
  isTheaterMode: boolean;
  showDebugInfo?: boolean;
  showLoadingOverlay?: boolean;
  loadingPercent?: number;
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
  onSubtitleTrackChange: (subtitleTrack: SubtitleTrack) => void;
}

const CHUNK_SIZE = 128 * 1024;
const REQUEST_WINDOW_BYTES = 2 * 1024 * 1024;
const MIN_INITIAL_BUFFER_BYTES = 4 * 1024 * 1024;
const MIN_INITIAL_BUFFER_SECONDS = 12;
const LOW_BUFFER_AHEAD_SECONDS = 6;
const SEEK_RESUME_PADDING_SECONDS = 2;
const TRANSFER_PROGRESS_BUCKET = 0.02;
const BUFFERED_TIME_BUCKET_SECONDS = 5;
const DRIFT_THRESHOLD_SECONDS = 1.2;
const DATA_CHANNEL_HIGH_WATER_MARK = 4 * 1024 * 1024;
const DATA_CHANNEL_LOW_WATER_MARK = 512 * 1024;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const CONTROLS_IDLE_DELAY_MS = 3000;
const MEDIA_TITLE_MAX_LENGTH = 50;

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
  createTempMediaCache: async () => ({
    cacheId: "",
    mediaUrl: ""
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

function formatMediaTitle(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const normalizedTitle = withoutExtension.replace(/[_-]+/g, " ").trim() || fileName;

  if (normalizedTitle.length <= MEDIA_TITLE_MAX_LENGTH) {
    return normalizedTitle;
  }

  return `${normalizedTitle.slice(0, MEDIA_TITLE_MAX_LENGTH)}...`;
}

function detectSubtitleFormat(fileName: string): SubtitleFileFormat | null {
  const normalized = fileName.toLowerCase();

  if (normalized.endsWith(".srt")) {
    return "srt";
  }

  if (normalized.endsWith(".vtt")) {
    return "vtt";
  }

  return null;
}

function normalizeSubtitleLabel(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").trim() || "Custom subtitles";
}

function normalizeVttContent(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return normalized.startsWith("WEBVTT") ? normalized : `WEBVTT\n\n${normalized}`;
}

function convertSrtToVtt(content: string) {
  const normalized = content
    .replace(/\uFEFF/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^(\d+)\n/gm, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();

  return `WEBVTT\n\n${normalized}`;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
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

function Seek10Icon({ mirrored = false }: { mirrored?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={mirrored ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 3v5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

function ClosedCaptionsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2" y="5" width="20" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="12.75" y="12" textAnchor="middle" dominantBaseline="central" fill="currentColor" stroke="currentColor" strokeWidth="0.6" fontSize="9.5" fontWeight="900" fontFamily="sans-serif" letterSpacing="1.5">CC</text>
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
  showDebugInfo = false,
  showLoadingOverlay = false,
  loadingPercent = 0,
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
  onTransferState,
  onSubtitleTrackChange
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
  const availableRangesRef = useRef<ByteRange[]>([]);
  const contiguousBytesRef = useRef(0);
  const inFlightRequestsRef = useRef<Array<ByteRange & { reason: RangeRequestReason; targetTime?: number }>>([]);
  const objectUrlRef = useRef<string | null>(null);
  const cacheIdRef = useRef<string | null>(null);
  const cacheMediaUrlRef = useRef<string | null>(null);
  const cacheFileUrlRef = useRef<string | null>(null);
  const mediaUrlCandidatesRef = useRef<string[]>([]);
  const activeMediaUrlIndexRef = useRef(-1);
  const pendingSeekTimeRef = useRef<number | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const preparingHostMediaRef = useRef(false);
  const durationRef = useRef(room.mediaSource.duration ?? 0);
  const pendingPlaybackRestoreRef = useRef<PendingPlaybackRestore | null>(null);
  const suppressDisconnectRef = useRef(false);
  const lastReportedTransferRef = useRef<TransferState | null>(null);
  const localMessageRef = useRef("Waiting for peer connection");
  const controlsHideTimeoutRef = useRef<number | null>(null);
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleObjectUrlRef = useRef<string | null>(null);
  const subtitleTrackListenersRef = useRef<Array<{ track: TextTrack; listener: () => void }>>([]);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [activeSubtitleLines, setActiveSubtitleLines] = useState<string[]>([]);
  const [localMessage, setLocalMessage] = useState("Waiting for peer connection");
  const [isFullscreenMode, setIsFullscreenMode] = useState(false);
  const [isPlaying, setIsPlaying] = useState(room.playbackState === "playing");
  const [isMuted, setIsMuted] = useState(false);
  const [isCaptionsEnabled, setIsCaptionsEnabled] = useState(Boolean(room.subtitleTrack));
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(room.currentTime);
  const [duration, setDuration] = useState(room.mediaSource.duration ?? 0);
  const [isPointerActive, setIsPointerActive] = useState(true);
  const debugRole = isHost ? "host" : "guest";
  const desktopApi = window.syncplayDesktop ?? fallbackDesktopApi;
  const mediaTitle = useMemo(() => formatMediaTitle(room.mediaSource.fileName), [room.mediaSource.fileName]);
  const subtitleLabel = `${isHost ? "Host" : "Guest"} • Local file${room.subtitleTrack ? " • Shared subtitles" : ""}`;
  const hasSubtitleTrack = Boolean(room.subtitleTrack && subtitleUrl);
  const subtitleButtonTitle = hasSubtitleTrack ? "Replace subtitles (.srt, .vtt)" : "Upload subtitles (.srt, .vtt)";
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
    if (showLoadingOverlay) {
      const video = videoRef.current;
      if (video) {
        video.pause();
        if (video.currentTime > 0) {
          video.currentTime = 0;
        }
      }
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [showLoadingOverlay]);

  useEffect(() => {
    return () => {
      if (controlsHideTimeoutRef.current !== null) {
        window.clearTimeout(controlsHideTimeoutRef.current);
      }
      detachSubtitleTrackListeners();
      revokeSubtitleUrl();
      cleanupPeer();
      revokeObjectUrl();
      void clearTempCache();
    };
  }, []);

  useEffect(() => {
    if (!room.subtitleTrack) {
      detachSubtitleTrackListeners();
      revokeSubtitleUrl();
      setIsCaptionsEnabled(false);
      setActiveSubtitleLines([]);
      return;
    }

    const subtitleContent =
      room.subtitleTrack.format === "srt"
        ? convertSrtToVtt(room.subtitleTrack.content)
        : normalizeVttContent(room.subtitleTrack.content);
    const nextUrl = URL.createObjectURL(new Blob([subtitleContent], { type: "text/vtt" }));

    revokeSubtitleUrl();
    subtitleObjectUrlRef.current = nextUrl;
    setSubtitleUrl(nextUrl);
    setIsCaptionsEnabled(true);

    return () => {
      if (subtitleObjectUrlRef.current === nextUrl) {
        revokeSubtitleUrl();
      }
    };
  }, [room.subtitleTrack]);

  useEffect(() => {
    syncSubtitleTrackMode();
  }, [isCaptionsEnabled, subtitleUrl, mediaUrl]);

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
    function handleKeyDown(event: KeyboardEvent) {
      if (!mediaUrl || event.repeat || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === " " || key === "k") {
        event.preventDefault();
        revealControls();
        togglePlayback();
        return;
      }

      if (key === "m") {
        event.preventDefault();
        revealControls();
        toggleMute();
        return;
      }

      if (key === "t") {
        event.preventDefault();
        revealControls();
        onTheaterModeChange(!isTheaterMode);
        return;
      }

      if (key === "f") {
        event.preventDefault();
        revealControls();
        void toggleFullscreen();
        return;
      }

      if (key === "c") {
        event.preventDefault();
        revealControls();
        handleClosedCaptionsAction();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        revealControls();
        seekBy(10);
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        revealControls();
        seekBy(-10);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isTheaterMode, mediaUrl]);

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
        const bufferedUntilTime = getExpectedBufferedUntil(video.currentTime);

        if (bufferedUntilTime !== undefined && bufferedUntilTime - video.currentTime < LOW_BUFFER_AHEAD_SECONDS) {
          requestNextRange("sequential");
        }
      }
    }, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, [isHost, mediaUrl, room]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    window.__syncplayLocalPlayerDebug = {
      getState: () => ({
        role: debugRole,
        roomId: room.roomId,
        mediaUrl,
        cacheId: cacheIdRef.current,
        cacheMediaUrl: cacheMediaUrlRef.current,
        cacheFileUrl: cacheFileUrlRef.current,
        mediaUrlCandidates: mediaUrlCandidatesRef.current,
        activeMediaUrlIndex: activeMediaUrlIndexRef.current,
        contiguousBytes: contiguousBytesRef.current,
        availableRanges: availableRangesRef.current,
        roomTransferState: room.transferState,
        video: videoRef.current
          ? {
              currentSrc: videoRef.current.currentSrc,
              readyState: videoRef.current.readyState,
              networkState: videoRef.current.networkState,
              currentTime: videoRef.current.currentTime,
              duration: videoRef.current.duration,
              videoWidth: videoRef.current.videoWidth,
              videoHeight: videoRef.current.videoHeight,
              error: videoRef.current.error
                ? {
                    code: videoRef.current.error.code,
                    message: videoRef.current.error.message ?? null
                  }
                : null
            }
          : null
      })
    };

    return () => {
      delete window.__syncplayLocalPlayerDebug;
    };
  }, [debugRole, mediaUrl, room]);

  useEffect(() => {
    if (isHost || mediaUrl) {
      return;
    }

    if ((room.transferState?.bytesPersisted ?? 0) < room.mediaSource.fileSize) {
      return;
    }

    maybeActivateCompletedGuestMedia("room-transfer-complete");
  }, [isHost, mediaUrl, room.mediaSource.fileSize, room.transferState?.bytesPersisted]);

  async function ensureTempCache() {
    if (cacheIdRef.current) {
      return {
        cacheId: cacheIdRef.current,
        mediaUrl: cacheMediaUrlRef.current
      };
    }

    if (!window.syncplayDesktop) {
      debugLog(debugRole, "desktop bridge unavailable for temp cache");
    }

    const cacheHandle = await desktopApi.createTempMediaCache(room.mediaSource.mediaId, {
      fileSize: room.mediaSource.fileSize,
      mimeType: room.mediaSource.mimeType,
      fileName: room.mediaSource.fileName
    });
    cacheIdRef.current = cacheHandle.cacheId;
    cacheMediaUrlRef.current = cacheHandle.mediaUrl;
    cacheFileUrlRef.current = cacheHandle.fileUrl;
    mediaUrlCandidatesRef.current = [cacheHandle.localHttpUrl].filter(Boolean);
    activeMediaUrlIndexRef.current = -1;

    return cacheHandle;
  }

  async function clearTempCache() {
    if (!cacheIdRef.current) {
      return;
    }

    const cacheId = cacheIdRef.current;
    cacheIdRef.current = null;
    cacheMediaUrlRef.current = null;
    cacheFileUrlRef.current = null;
    mediaUrlCandidatesRef.current = [];
    activeMediaUrlIndexRef.current = -1;
    await desktopApi.removeTempMediaCache(cacheId);
  }

  function maybeActivateCompletedGuestMedia(trigger: string) {
    const persistedBytes = Math.max(contiguousBytesRef.current, room.transferState?.bytesPersisted ?? 0);

    if (isHost || mediaUrl || persistedBytes < room.mediaSource.fileSize) {
      return false;
    }

    return switchToNextGuestMediaUrl(trigger);
  }

  function switchToNextGuestMediaUrl(trigger: string) {
    if (isHost) {
      return false;
    }

    const nextIndex = activeMediaUrlIndexRef.current + 1;
    const nextUrl = mediaUrlCandidatesRef.current[nextIndex];

    if (!nextUrl) {
      debugLog(debugRole, "guest media fallback exhausted", {
        trigger,
        activeIndex: activeMediaUrlIndexRef.current,
        candidates: mediaUrlCandidatesRef.current
      });
      return false;
    }

    activeMediaUrlIndexRef.current = nextIndex;
    setMediaUrl(nextUrl);
    updateLocalMessage(nextIndex === 0 ? "Opening downloaded media" : "Retrying media source");
    debugLog(debugRole, "guest media source selected", {
      trigger,
      index: nextIndex,
      url: nextUrl
    });
    return true;
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
    const hostFileName = "fileId" in localFile ? localFile.fileName : localFile.name;
    const hostFileSize = "fileId" in localFile ? localFile.fileSize : localFile.size;
    const hostMimeType = "fileId" in localFile ? localFile.mimeType : localFile.type;
    debugLog(debugRole, "prepareHostMedia start", {
      fileName: hostFileName,
      fileSize: hostFileSize,
      mimeType: hostMimeType
    });

    try {
      const url = "fileId" in localFile ? localFile.streamUrl || localFile.fileUrl : createObjectUrlFromFile(localFile);
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
    cleanupPeer();
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
    cleanupPeer();
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

    cleanupPeer();

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
        if (message.duration && Number.isFinite(message.duration) && message.duration > 0) {
          setDuration(message.duration);
        }
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
        inFlightRequestsRef.current = inFlightRequestsRef.current.filter(
          (request) =>
            !(
              request.startByte === message.startByte &&
              request.reason === message.reason &&
              request.targetTime === message.targetTime
            )
        );
        if (message.reason === "seek" && typeof message.targetTime === "number") {
          pendingSeekTimeRef.current = message.targetTime;
        }
        maybePromotePlaybackReady();
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
        updateLocalMessage("Finalizing local file");
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
      const chunk = await readLocalChunk(localFile, offset, length);

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

  async function readLocalChunk(file: PickedLocalFile | File, offset: number, length: number) {
    if ("fileId" in file) {
      return desktopApi.readLocalFileChunk(file.fileId, offset, length);
    }

    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  }

  async function handleBinaryChunk(payload: Blob | ArrayBuffer) {
    const range = pendingChunkMetaRef.current;

    if (!range) {
      return;
    }

    const chunk = payload instanceof Blob ? new Uint8Array(await payload.arrayBuffer()) : new Uint8Array(payload);
    pendingChunkMetaRef.current = null;

    const cacheHandle = await ensureTempCache();
    if (cacheHandle.cacheId) {
      await desktopApi.writeTempMediaChunk(cacheHandle.cacheId, range.startByte, chunk);
      await desktopApi.markTempMediaRangeAvailable(cacheHandle.cacheId, range.startByte, range.startByte + chunk.byteLength);
    }

    availableRangesRef.current = mergeRanges(availableRangesRef.current, {
      startByte: range.startByte,
      endByte: range.startByte + chunk.byteLength
    });
    contiguousBytesRef.current = getContiguousEnd(availableRangesRef.current);

    publishTransferState(
      buildTransferState("buffering", {
        message: pendingSeekTimeRef.current !== undefined ? `Buffering at ${formatTime(pendingSeekTimeRef.current)}` : "Preparing playback"
      })
    );

    maybeActivateCompletedGuestMedia("all-bytes-persisted");
    maybePromotePlaybackReady();
    maybeResumePendingSeek();
  }

  function maybePromotePlaybackReady() {
    if (isHost) {
      return;
    }

    if (!mediaUrl) {
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

    if (!mediaUrl) {
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
    updateLocalMessage(room.playbackState === "playing" ? "Playback resumed" : "Ready to play");
    publishTransferState(
      buildTransferState(room.playbackState === "playing" ? "streaming" : "ready", {
        bufferedUntilTime,
        isPlaybackReady: true,
        message: room.playbackState === "playing" ? "Playback resumed" : "Ready at seek position"
      })
    );
  }

  function requestNextRange(reason: RangeRequestReason) {
    if (isHost || !dataChannelRef.current || dataChannelRef.current.readyState !== "open") {
      return;
    }

    const targetTime = pendingSeekTimeRef.current;
    const targetByte =
      targetTime !== undefined ? estimateByteOffset(targetTime, durationRef.current, room.mediaSource.fileSize) : undefined;
    const preferredStartByte = reason === "seek" && targetByte !== undefined ? targetByte : contiguousBytesRef.current;
    const startByte = getNextMissingStartByte(preferredStartByte);

    if (startByte >= room.mediaSource.fileSize) {
      return;
    }

    const endByte = Math.min(
      room.mediaSource.fileSize,
      Math.max(startByte + REQUEST_WINDOW_BYTES, targetByte !== undefined ? targetByte + REQUEST_WINDOW_BYTES : 0)
    );

    if (isRangeCoveredByAvailable(startByte, endByte) || isRangeCoveredByInflight(startByte, endByte)) {
      return;
    }

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

    inFlightRequestsRef.current = [...inFlightRequestsRef.current, { ...requestRange, reason, targetTime }];
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
    if (availableRangesRef.current.length === 0 || contiguousBytesRef.current >= room.mediaSource.fileSize) {
      return false;
    }

    if (mediaUrl) {
      return false;
    }

    return true;
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

    if (!isHost && !hasCurrentPlayableData(video)) {
      pendingSeekTimeRef.current = video.currentTime;
      updateLocalMessage(`Buffering at ${formatTime(video.currentTime)}`);
      publishTransferState(
        buildTransferState("buffering", {
          pendingSeekTime: video.currentTime,
          message: `Buffering at ${formatTime(video.currentTime)}`
        })
      );
      requestNextRange("seek");
      return;
    }

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

    if (!isHost && room.playbackState === "playing") {
      const bufferedUntilTime = getPlayableBufferedUntil(video);
      const reachedBufferedEdge =
        bufferedUntilTime !== undefined && video.currentTime >= bufferedUntilTime - 0.35;
      const reachedLocalBlobEnd =
        Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.35;

      if (reachedBufferedEdge || reachedLocalBlobEnd) {
        pendingSeekTimeRef.current = video.currentTime;
        updateLocalMessage(`Buffering at ${formatTime(video.currentTime)}`);
        publishTransferState(
          buildTransferState("buffering", {
            pendingSeekTime: video.currentTime,
            message: `Buffering at ${formatTime(video.currentTime)}`
          })
        );
        requestNextRange("seek");
        return;
      }
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

    if ((isHost || durationRef.current <= 0) && Number.isFinite(video.duration) && video.duration > 0) {
      setDuration(video.duration);
    }

    restorePendingPlayback(video, "loadedmetadata");
    syncSubtitleTrackMode();
  }

  function handleTimeUpdate() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    setCurrentTime(video.currentTime);

    if ((isHost || durationRef.current <= 0) && Number.isFinite(video.duration) && video.duration > 0) {
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

    if (!video || !mediaUrl || showLoadingOverlay) {
      return;
    }

    if (video.paused) {
      void video.play();
      return;
    }

    video.pause();
  }

  function seekBy(offsetSeconds: number) {
    const video = videoRef.current;

    if (!video || !mediaUrl) {
      return;
    }

    const videoDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : durationRef.current;
    const maxTime = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Math.max(video.currentTime + offsetSeconds, 0);
    const nextTime = Math.min(Math.max(video.currentTime + offsetSeconds, 0), maxTime);

    if (Math.abs(nextTime - video.currentTime) < 0.01) {
      return;
    }

    video.currentTime = nextTime;
    setCurrentTime(nextTime);
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

  function revokeSubtitleUrl() {
    if (!subtitleObjectUrlRef.current) {
      setSubtitleUrl(null);
      return;
    }

    URL.revokeObjectURL(subtitleObjectUrlRef.current);
    subtitleObjectUrlRef.current = null;
    setSubtitleUrl(null);
  }

  function detachSubtitleTrackListeners() {
    for (const entry of subtitleTrackListenersRef.current) {
      entry.track.removeEventListener("cuechange", entry.listener);
    }

    subtitleTrackListenersRef.current = [];
  }

  function syncActiveSubtitleLines() {
    const video = videoRef.current;

    if (!video || !subtitleUrl || !isCaptionsEnabled) {
      setActiveSubtitleLines([]);
      return;
    }

    const nextLines: string[] = [];

    for (let trackIndex = 0; trackIndex < video.textTracks.length; trackIndex += 1) {
      const activeCues = video.textTracks[trackIndex].activeCues;

      if (!activeCues) {
        continue;
      }

      for (let cueIndex = 0; cueIndex < activeCues.length; cueIndex += 1) {
        const cue = activeCues[cueIndex];

        if (!(cue instanceof VTTCue)) {
          continue;
        }

        const text = cue.text
          .split("\n")
          .map((line: string) => line.trim())
          .filter(Boolean);

        nextLines.push(...text);
      }
    }

    setActiveSubtitleLines(nextLines);
  }

  function syncSubtitleTrackMode() {
    const video = videoRef.current;

    if (!video) {
      setActiveSubtitleLines([]);
      return;
    }

    detachSubtitleTrackListeners();

    for (let index = 0; index < video.textTracks.length; index += 1) {
      const textTrack = video.textTracks[index];
      textTrack.mode = isCaptionsEnabled && subtitleUrl ? "hidden" : "disabled";

      if (isCaptionsEnabled && subtitleUrl) {
        const listener = () => {
          syncActiveSubtitleLines();
        };

        textTrack.addEventListener("cuechange", listener);
        subtitleTrackListenersRef.current.push({ track: textTrack, listener });
      }
    }

    syncActiveSubtitleLines();
  }

  function handleClosedCaptionsAction() {
    subtitleInputRef.current?.click();
  }

  async function handleSubtitleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || !selfId) {
      return;
    }

    const format = detectSubtitleFormat(file.name);

    if (!format) {
      updateLocalMessage("Use an .srt or .vtt subtitle file");
      return;
    }

    try {
      const content = await file.text();
      const normalizedContent = content.trim();

      if (!normalizedContent) {
        updateLocalMessage("Subtitle file is empty");
        return;
      }

      onSubtitleTrackChange({
        fileName: file.name,
        label: normalizeSubtitleLabel(file.name),
        language: "en",
        format,
        content: normalizedContent,
        uploadedAt: Date.now(),
        uploadedByParticipantId: selfId
      });
      updateLocalMessage(`Subtitles synced: ${file.name}`);
      setIsCaptionsEnabled(true);
    } catch {
      updateLocalMessage("Could not read subtitle file");
    }
  }

  return (
    <div className={`local-player-shell ${isTheaterMode ? "local-player-shell--theater" : ""}`}>
      <input
        ref={subtitleInputRef}
        className="hidden-file-input"
        type="file"
        accept=".srt,.vtt,text/vtt,application/x-subrip"
        onChange={handleSubtitleFileChange}
      />
      <div
        className={`local-player-wrapper ${isFullscreenMode ? "local-player-wrapper--fullscreen" : ""}`}
        onMouseMove={revealControls}
        onMouseEnter={revealControls}
      >
        <video
          key={mediaUrl ?? "empty-media"}
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
              syncSubtitleTrackMode();
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
              syncSubtitleTrackMode();
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
            if (!isHost && switchToNextGuestMediaUrl("video-error")) {
              window.setTimeout(() => {
                const nextVideo = videoRef.current;
                nextVideo?.load();
              }, 0);
            }
          }}
          onPlay={handlePlay}
          onPause={handlePause}
          onSeeked={handleSeeked}
          onTimeUpdate={handleTimeUpdate}
          onVolumeChange={handleVolumeChange}
          onClick={() => {
            togglePlayback();
          }}
          onDoubleClick={() => {
            void toggleFullscreen();
          }}
        >
          {subtitleUrl && room.subtitleTrack ? (
            <track
              key={`${room.subtitleTrack.uploadedAt}-${room.subtitleTrack.fileName}`}
              kind="subtitles"
              src={subtitleUrl}
              srcLang={room.subtitleTrack.language}
              label={room.subtitleTrack.label}
              default={isCaptionsEnabled}
              onLoad={() => {
                syncSubtitleTrackMode();
              }}
            />
          ) : null}
        </video>
        {activeSubtitleLines.length > 0 ? (
          <div
            className={`local-player-subtitle-overlay ${
              isPointerActive ? "local-player-subtitle-overlay--controls-visible" : "local-player-subtitle-overlay--controls-hidden"
            }`}
            aria-live="off"
          >
            {activeSubtitleLines.map((line, index) => (
              <span key={`${index}-${line}`} className="local-player-subtitle-line">
                {line}
              </span>
            ))}
          </div>
        ) : null}
        {showLoadingOverlay ? (
          <div className="local-player-loading-overlay" aria-live="polite">
            <div className="local-player-loading-content">
              <p className="local-player-loading-label">{isHost ? "Buffering for guest" : "Buffering video"}</p>
              <strong className="local-player-loading-percent">{loadingPercent}%</strong>
              <div
                className="local-player-loading-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={loadingPercent}
                aria-label={`Loading playback ${loadingPercent}%`}
              >
                <span style={{ width: `${loadingPercent}%` }} />
              </div>
              <p className="local-player-loading-hint">{isHost ? "Playback will unlock once your guest has enough buffer to start" : "Downloading enough video to start playback in sync"}</p>
            </div>
          </div>
        ) : null}
        {mediaUrl ? (
          <div
            className={`local-player-center-controls ${
              isPointerActive ? "local-player-center-controls--visible" : "local-player-center-controls--hidden"
            }`}
          >
            <button
              className="local-player-center-action local-player-center-action--seek"
              type="button"
              onClick={() => {
                revealControls();
                seekBy(-10);
              }}
              aria-label="Back 10 seconds"
              title="Back 10 seconds (Left Arrow)"
            >
              <span className="local-player-seek-content">
                <Seek10Icon />
                <span className="local-player-seek-label">10</span>
              </span>
            </button>
            <button
              className="local-player-center-action"
              type="button"
              onClick={() => {
                revealControls();
                togglePlayback();
              }}
              aria-label={isPlaying ? "Pause video" : "Play video"}
              title={`${isPlaying ? "Pause video" : "Play video"} (Space)`}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              className="local-player-center-action local-player-center-action--seek"
              type="button"
              onClick={() => {
                revealControls();
                seekBy(10);
              }}
              aria-label="Forward 10 seconds"
              title="Forward 10 seconds (Right Arrow)"
            >
              <span className="local-player-seek-content">
                <Seek10Icon mirrored />
                <span className="local-player-seek-label">10</span>
              </span>
            </button>
          </div>
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
                disabled={!mediaUrl || duration <= 0 || showLoadingOverlay}
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
                }} disabled={!mediaUrl || showLoadingOverlay} aria-label={isPlaying ? "Pause video" : "Play video"} title={`${isPlaying ? "Pause video" : "Play video"} (Space)`}>
                  {isPlaying ? <PauseIcon /> : <PlayIcon />}
                </button>
                <button className="local-player-icon-button" type="button" onClick={() => {
                  revealControls();
                  toggleMute();
                }} disabled={!mediaUrl} aria-label={isMuted || volume === 0 ? "Unmute video" : "Mute video"} title={`${isMuted || volume === 0 ? "Unmute video" : "Mute video"} (M)`}>
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
                    title={`${isTheaterMode ? "Exit theater mode" : "Enter theater mode"} (T)`}
                  >
                    <TheaterIcon />
                  </button>
                  <button
                    className={`local-player-toolbar-button local-player-toolbar-button--icon ${
                      hasSubtitleTrack && isCaptionsEnabled ? "local-player-toolbar-button--active" : ""
                    }`}
                    type="button"
                    onClick={() => {
                      revealControls();
                      handleClosedCaptionsAction();
                    }}
                    aria-label={hasSubtitleTrack ? "Replace subtitles" : "Upload subtitles"}
                    title={subtitleButtonTitle}
                  >
                    <ClosedCaptionsIcon />
                  </button>
                  <button
                    className="local-player-toolbar-button local-player-toolbar-button--icon"
                    type="button"
                    onClick={() => {
                      revealControls();
                      void toggleFullscreen();
                    }}
                    aria-label={isFullscreenMode ? "Exit fullscreen" : "Enter fullscreen"}
                    title={`${isFullscreenMode ? "Exit fullscreen" : "Enter fullscreen"} (F)`}
                  >
                    <ExpandIcon />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {showDebugInfo ? (
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
      ) : null}
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

      if (!isHost && !hasCurrentPlayableData(video)) {
        pendingPlaybackRestoreRef.current = {
          time: authoritativeRoom.currentTime,
          shouldPlay: true
        };
        pendingSeekTimeRef.current = authoritativeRoom.currentTime;
        requestNextRange("seek");
      } else if (bufferedUntilTime !== undefined && authoritativeRoom.currentTime > bufferedUntilTime - 0.25) {
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

  function calculateBufferedUntilTime(bytes: number) {
    if (!durationRef.current || room.mediaSource.fileSize <= 0) {
      return undefined;
    }

    return Math.min(durationRef.current, (bytes / room.mediaSource.fileSize) * durationRef.current);
  }

  function getRangeContainingByte(byteOffset: number) {
    return availableRangesRef.current.find((range) => byteOffset >= range.startByte && byteOffset < range.endByte);
  }

  function getExpectedBufferedUntil(time: number) {
    const estimatedByte = estimateByteOffset(time, durationRef.current, room.mediaSource.fileSize);
    const containingRange = getRangeContainingByte(estimatedByte);

    if (!containingRange) {
      return undefined;
    }

    return calculateBufferedUntilTime(containingRange.endByte);
  }

  function getPlayableBufferedUntil(video: HTMLVideoElement | null) {
    const mediaBufferedUntil = getMediaBufferedEnd(video);

    if (mediaBufferedUntil !== undefined) {
      return mediaBufferedUntil;
    }

    if (!video) {
      return undefined;
    }

    return getExpectedBufferedUntil(video.currentTime);
  }

  function hasCurrentPlayableData(video: HTMLVideoElement | null) {
    if (!video) {
      return false;
    }

    const playableBufferedUntil = getPlayableBufferedUntil(video);
    return (
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      playableBufferedUntil !== undefined &&
      playableBufferedUntil >= video.currentTime
    );
  }

  function isRangeCoveredByAvailable(startByte: number, endByte: number) {
    return availableRangesRef.current.some((range) => startByte >= range.startByte && endByte <= range.endByte);
  }

  function isRangeCoveredByInflight(startByte: number, endByte: number) {
    return inFlightRequestsRef.current.some((range) => startByte >= range.startByte && endByte <= range.endByte);
  }

  function getNextMissingStartByte(preferredStartByte: number) {
    for (const range of availableRangesRef.current) {
      if (preferredStartByte < range.startByte) {
        return preferredStartByte;
      }

      if (preferredStartByte >= range.startByte && preferredStartByte < range.endByte) {
        return range.endByte;
      }
    }

    return preferredStartByte;
  }

  function sumRangeBytes(ranges: ByteRange[]) {
    return ranges.reduce((total, range) => total + Math.max(0, range.endByte - range.startByte), 0);
  }

  function getLastRequestedRange() {
    const inFlightRequests = inFlightRequestsRef.current;
    return inFlightRequests[inFlightRequests.length - 1];
  }

  function buildTransferState(phase: TransferState["phase"], overrides: Partial<TransferState> = {}): TransferState {
    const bytesReceived = overrides.bytesReceived ?? sumRangeBytes(availableRangesRef.current);
    const bytesPersisted = overrides.bytesPersisted ?? bytesReceived;
    const bytesTotal = room.mediaSource.fileSize;
    const video = videoRef.current;
    const bufferedUntilTime =
      overrides.bufferedUntilTime ?? getPlayableBufferedUntil(video) ?? getExpectedBufferedUntil(room.currentTime);
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
      lastRequestedRange: overrides.lastRequestedRange ?? getLastRequestedRange(),
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

  function cleanupPeer() {
    suppressDisconnectRef.current = true;
    dataChannelRef.current?.close();
    peerRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current = null;
    activePeerIdRef.current = null;
    pendingIceCandidatesRef.current = [];
    pendingChunkMetaRef.current = null;
    inFlightRequestsRef.current = [];
    window.setTimeout(() => {
      suppressDisconnectRef.current = false;
    }, 0);
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
