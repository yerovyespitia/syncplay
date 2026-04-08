import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

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
import {
  isWebTorrentSelectedFile,
  type SelectedTorrentFileSource
} from "../lib/torrentSessionProvider";

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
  localFile: SelectedTorrentFileSource | File | null;
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
const REQUEST_WINDOW_BYTES = 8 * 1024 * 1024;
const MIN_PROGRESSIVE_START_BYTES = 8 * 1024 * 1024;
const MAX_PROGRESSIVE_START_BYTES = 32 * 1024 * 1024;
const TRAILING_METADATA_WINDOW_BYTES = 4 * 1024 * 1024;
const MIN_INITIAL_BUFFER_BYTES = 4 * 1024 * 1024;
const MIN_INITIAL_BUFFER_SECONDS = 12;
const MIN_READY_MEDIA_BUFFER_AHEAD_SECONDS = 3;
const STARTUP_PREFETCH_TARGET_SECONDS = 24;
const STREAMING_PREFETCH_TARGET_SECONDS = 14;
const LOW_BUFFER_AHEAD_SECONDS = 6;
const SEEK_RESUME_PADDING_SECONDS = 2;
const MAX_PREFETCH_INFLIGHT_REQUESTS = 4;
const MAX_PROGRESSIVE_SEEK_CHASE_AHEAD_SECONDS = 3;
const LOCAL_SEEK_ACK_GRACE_MS = 2000;
const TRANSFER_PROGRESS_BUCKET = 0.02;
const BUFFERED_TIME_BUCKET_SECONDS = 5;
const DRIFT_THRESHOLD_SECONDS = 1.2;
const PLAYBACK_END_TOLERANCE_SECONDS = 0.35;
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

type BrowserFileSystemWritable = {
  write(data: BufferSource | Blob | string | { type: "write"; position?: number; data: BufferSource | Blob | string }): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
};

type BrowserFileSystemFileHandle = {
  createWritable(options?: { keepExistingData?: boolean }): Promise<BrowserFileSystemWritable>;
  getFile(): Promise<File>;
};

type BrowserFileSystemDirectoryHandle = {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileSystemFileHandle>;
  removeEntry(name: string): Promise<void>;
};

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

const LOCAL_MEDIA_DB_NAME = "syncplay-local-media";
const LOCAL_MEDIA_DB_VERSION = 2;
const LOCAL_MEDIA_CHUNK_STORE = "media-chunks";
const LOCAL_MEDIA_META_STORE = "media-meta";
const LOCAL_MEDIA_FILE_STORE = "media-files";

type StoredLocalMediaMeta = {
  mediaId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  updatedAt: number;
};

let localMediaDbPromise: Promise<IDBDatabase> | null = null;

function openLocalMediaDb() {
  if (localMediaDbPromise) {
    return localMediaDbPromise;
  }

  localMediaDbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LOCAL_MEDIA_DB_NAME, LOCAL_MEDIA_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(LOCAL_MEDIA_CHUNK_STORE)) {
        const chunkStore = database.createObjectStore(LOCAL_MEDIA_CHUNK_STORE, {
          keyPath: ["mediaId", "startByte"]
        });
        chunkStore.createIndex("byMediaId", "mediaId", { unique: false });
      }

      if (!database.objectStoreNames.contains(LOCAL_MEDIA_META_STORE)) {
        database.createObjectStore(LOCAL_MEDIA_META_STORE, {
          keyPath: "mediaId"
        });
      }

      if (!database.objectStoreNames.contains(LOCAL_MEDIA_FILE_STORE)) {
        database.createObjectStore(LOCAL_MEDIA_FILE_STORE, {
          keyPath: "mediaId"
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open local media database"));
  });

  return localMediaDbPromise;
}

function idbRequestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function idbTransactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

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

function toBlobPart(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
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

function decodeSubtitleContent(bytes: Uint8Array) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }

  const windows1252 = new TextDecoder("windows-1252").decode(bytes);
  const utf8ReplacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  const windows1252ReplacementCount = (windows1252.match(/\uFFFD/g) ?? []).length;

  return windows1252ReplacementCount <= utf8ReplacementCount ? windows1252 : utf8;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function readChunkBytesFromEntries(chunkEntries: Array<[number, Uint8Array]>, startByte: number, length: number) {
  if (length <= 0) {
    return new Uint8Array(0);
  }

  const result = new Uint8Array(length);
  let offset = startByte;
  let written = 0;

  for (const [chunkStart, bytes] of chunkEntries) {
    const chunkEnd = chunkStart + bytes.byteLength;

    if (chunkEnd <= offset) {
      continue;
    }

    if (chunkStart > offset) {
      break;
    }

    const localStart = Math.max(0, offset - chunkStart);
    const remaining = length - written;
    const localEnd = Math.min(bytes.byteLength, localStart + remaining);
    const slice = bytes.subarray(localStart, localEnd);
    result.set(slice, written);
    written += slice.byteLength;
    offset = chunkStart + localEnd;

    if (written >= length) {
      break;
    }
  }

  return written === length ? result : null;
}

function isDesktopPickedLocalFile(value: SelectedTorrentFileSource | File): value is PickedLocalFile {
  return "fileId" in value;
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
  const pendingChunkMetaQueueRef = useRef<ByteRange[]>([]);
  const availableRangesRef = useRef<ByteRange[]>([]);
  const contiguousBytesRef = useRef(0);
  const inFlightRequestsRef = useRef<Array<ByteRange & { reason: RangeRequestReason; targetTime?: number; issuedAt: number }>>(
    []
  );
  const objectUrlRef = useRef<string | null>(null);
  const cacheIdRef = useRef<string | null>(null);
  const cacheMediaUrlRef = useRef<string | null>(null);
  const cacheFileUrlRef = useRef<string | null>(null);
  const cacheHttpUrlRef = useRef<string | null>(null);
  const cacheLocalHttpUrlRef = useRef<string | null>(null);
  const mediaUrlCandidatesRef = useRef<string[]>([]);
  const activeMediaUrlIndexRef = useRef(-1);
  const guestBrowserDirectoryRef = useRef<BrowserFileSystemDirectoryHandle | null>(null);
  const guestBrowserFileHandleRef = useRef<BrowserFileSystemFileHandle | null>(null);
  const guestBrowserWritableRef = useRef<BrowserFileSystemWritable | null>(null);
  const guestBrowserFileNameRef = useRef<string | null>(null);
  const guestBrowserChunkMapRef = useRef<Map<number, Uint8Array>>(new Map());
  const guestBrowserMediaUrlRef = useRef<string | null>(null);
  const pendingBinaryChunkTaskRef = useRef<Promise<void>>(Promise.resolve());
  const pendingGuestBrowserPersistenceTaskRef = useRef<Promise<void>>(Promise.resolve());
  const guestBrowserPersistenceErrorRef = useRef<string | null>(null);
  const guestBrowserMetaStoredRef = useRef(false);
  const guestBrowserPlaybackChunksStoredRef = useRef(false);
  const guestBrowserStoragePersistentRef = useRef(false);
  const guestBrowserStoragePersistenceAttemptedRef = useRef(false);
  const guestBrowserFallbackToMemoryRef = useRef(false);
  const guestBrowserPersistedFileRef = useRef<File | null>(null);
  const guestBrowserPersistedBytesRef = useRef(0);
  const pendingSeekTimeRef = useRef<number | undefined>(undefined);
  const ignoredProgrammaticSeekTimesRef = useRef<Array<{ time: number; issuedAt: number }>>([]);
  const dispatchedLocalSeekTimesRef = useRef<Array<{ time: number; issuedAt: number }>>([]);
  const latestRequestedProgrammaticSeekRef = useRef<{ time: number; issuedAt: number } | null>(null);
  const latestRequestedLocalSeekRef = useRef<{ time: number; issuedAt: number } | null>(null);
  const latestSeekIntentRef = useRef<{ time: number; issuedAt: number } | null>(null);
  const reconnectAttemptRef = useRef(0);
  const preparingHostMediaRef = useRef(false);
  const durationRef = useRef(room.mediaSource.duration ?? 0);
  const pendingPlaybackRestoreRef = useRef<PendingPlaybackRestore | null>(null);
  const suppressDisconnectRef = useRef(false);
  const lastReportedTransferRef = useRef<TransferState | null>(null);
  const remoteParticipantIdRef = useRef<string | null>(null);
  const skipNextLocalPlayEventRef = useRef(false);
  const forwardNextLocalPauseEventRef = useRef(false);
  const suppressNextLocalPauseEventRef = useRef(false);
  const pendingLocalSeekAckRef = useRef<{ time: number; issuedAt: number } | null>(null);
  const pendingLocalPlayAckRef = useRef<number | null>(null);
  const pendingLocalPauseAckRef = useRef<number | null>(null);
  const localMessageRef = useRef("Waiting for peer connection");
  const controlsHideTimeoutRef = useRef<number | null>(null);
  const lastAudibleVolumeRef = useRef(1);
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleObjectUrlRef = useRef<string | null>(null);
  const subtitleMenuRef = useRef<HTMLDivElement | null>(null);
  const subtitleTrackListenersRef = useRef<Array<{ track: TextTrack; listener: () => void }>>([]);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [activeSubtitleLines, setActiveSubtitleLines] = useState<string[]>([]);
  const [isSubtitleMenuOpen, setIsSubtitleMenuOpen] = useState(false);
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
  const subtitleButtonTitle = hasSubtitleTrack ? "Subtitle options" : "Upload subtitles (.srt, .vtt)";
  const safeDuration = Math.max(duration, 0);
  const progressPercent = safeDuration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;
  const playableBufferedUntil =
    safeDuration > 0 ? Math.min(safeDuration, Math.max(0, getPlayableBufferedUntil(videoRef.current) ?? 0)) : 0;
  const bufferedPercent = safeDuration > 0 ? Math.min(100, (playableBufferedUntil / safeDuration) * 100) : 0;
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
    remoteParticipantIdRef.current = remoteParticipantId;

    if (remoteParticipantId) {
      return;
    }

    cleanupPeer();
    reconnectAttemptRef.current = 0;
    updateLocalMessage(isHost ? "Waiting for peer connection" : "Waiting for host");
  }, [isHost, remoteParticipantId]);

  useEffect(() => {
    debugLog(debugRole, "desktop bridge status", {
      hasDesktopApi: Boolean(window.syncplayDesktop),
      roomId: room.roomId
    });
  }, [debugRole, room.roomId]);

  useEffect(() => {
    if (isHost || window.syncplayDesktop || !("serviceWorker" in navigator)) {
      return;
    }

    function handleServiceWorkerMessage(event: MessageEvent) {
      const message = event.data as
        | { type: "syncplay-local-media-meta"; mediaId: string }
        | { type: "syncplay-local-media-range"; mediaId: string; startByte: number; endByte: number }
        | undefined;

      if (!message || message.mediaId !== room.mediaSource.mediaId) {
        return;
      }

      const responsePort = event.ports[0];

      if (!responsePort) {
        return;
      }

      if (message.type === "syncplay-local-media-meta") {
        responsePort.postMessage({
          ok: true,
          fileName: room.mediaSource.fileName,
          fileSize: room.mediaSource.fileSize,
          mimeType: room.mediaSource.mimeType
        });
        return;
      }

      const length = message.endByte - message.startByte + 1;
      const chunkEntries = Array.from(guestBrowserChunkMapRef.current.entries()).sort((left, right) => left[0] - right[0]);
      const bytes = readChunkBytesFromEntries(chunkEntries, message.startByte, length);

      if (!bytes) {
        responsePort.postMessage({ ok: false });
        return;
      }

      responsePort.postMessage(
        {
          ok: true,
          bytes: bytes.buffer
        },
        [bytes.buffer]
      );
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    };
  }, [isHost, room.mediaSource.fileName, room.mediaSource.fileSize, room.mediaSource.mediaId, room.mediaSource.mimeType]);

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
      revokeGuestBrowserMediaUrl();
      void clearTempCache();
      void clearGuestBrowserCache();
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
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const textTracks = video.textTracks;
    const handleTrackListChange = () => {
      syncSubtitleTrackMode();
    };
    const handleCueRefresh = () => {
      syncActiveSubtitleLines();
    };

    textTracks.addEventListener("addtrack", handleTrackListChange);
    textTracks.addEventListener("change", handleTrackListChange);
    textTracks.addEventListener("removetrack", handleTrackListChange);
    video.addEventListener("seeked", handleCueRefresh);
    video.addEventListener("timeupdate", handleCueRefresh);

    return () => {
      textTracks.removeEventListener("addtrack", handleTrackListChange);
      textTracks.removeEventListener("change", handleTrackListChange);
      textTracks.removeEventListener("removetrack", handleTrackListChange);
      video.removeEventListener("seeked", handleCueRefresh);
      video.removeEventListener("timeupdate", handleCueRefresh);
    };
  }, [mediaUrl, subtitleUrl, isCaptionsEnabled]);

  useEffect(() => {
    if (!isSubtitleMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (subtitleMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsSubtitleMenuOpen(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsSubtitleMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isSubtitleMenuOpen]);

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

    if (lastAppliedEventIdRef.current > remoteCommand.room.lastEventId) {
      debugLog(debugRole, "ignoring stale remote command", {
        kind: remoteCommand.kind,
        remoteLastEventId: remoteCommand.room.lastEventId,
        lastAppliedEventId: lastAppliedEventIdRef.current
      });
      return;
    }

    if (remoteCommand.kind === "event" && remoteCommand.actorId === selfId) {
      const shouldReconcileSelfEvent =
        video.paused !== (remoteCommand.room.playbackState === "paused") ||
        Math.abs(video.currentTime - remoteCommand.room.currentTime) > DRIFT_THRESHOLD_SECONDS;

      if (shouldReconcileSelfEvent) {
        if (shouldDeferAuthoritativePlayback(video, remoteCommand.room)) {
          return;
        }
        debugLog(debugRole, "reconciling self-authored event", {
          action: remoteCommand.action,
          roomPlaybackState: remoteCommand.room.playbackState,
          roomCurrentTime: remoteCommand.room.currentTime,
          localPlaybackState: video.paused ? "paused" : "playing",
          localCurrentTime: video.currentTime,
          lastEventId: remoteCommand.room.lastEventId
        });
        applyAuthoritativeState(video, remoteCommand.room);
      }

      lastAppliedEventIdRef.current = remoteCommand.room.lastEventId;
      return;
    }

    if (lastAppliedEventIdRef.current === remoteCommand.room.lastEventId && remoteCommand.kind === "event") {
      return;
    }

    if (shouldDeferAuthoritativePlayback(video, remoteCommand.room)) {
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

      if (shouldDeferAuthoritativePlayback(video, room)) {
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
      uploadSubtitleByPath: async (filePath: string) => {
        if (!selfId || !window.syncplayDesktop) {
          return false;
        }

        const pickedFile = await desktopApi.pickLocalFileByPath(filePath);

        if (!pickedFile) {
          return false;
        }

        const bytes = await desktopApi.readLocalFile(pickedFile.fileId);
        const content = decodeSubtitleContent(bytes).trim();
        const format = detectSubtitleFormat(pickedFile.fileName);

        if (!format || !content) {
          return false;
        }

        onSubtitleTrackChange({
          fileName: pickedFile.fileName,
          label: normalizeSubtitleLabel(pickedFile.fileName),
          language: "en",
          format,
          content,
          uploadedAt: Date.now(),
          uploadedByParticipantId: selfId
        });

        setIsCaptionsEnabled(true);
        setIsSubtitleMenuOpen(false);
        updateLocalMessage(`Subtitles synced: ${pickedFile.fileName}`);
        return true;
      },
      sampleGuestBytes: (startByte: number, length: number) => {
        if (length <= 0) {
          return [];
        }

        const chunkEntries = Array.from(guestBrowserChunkMapRef.current.entries()).sort((left, right) => left[0] - right[0]);
        const result: number[] = [];
        let offset = startByte;

        for (const [chunkStart, bytes] of chunkEntries) {
          const chunkEnd = chunkStart + bytes.byteLength;

          if (chunkEnd <= offset) {
            continue;
          }

          if (chunkStart > offset) {
            break;
          }

          const localStart = Math.max(0, offset - chunkStart);
          const remaining = length - result.length;
          const localEnd = Math.min(bytes.byteLength, localStart + remaining);

          for (let index = localStart; index < localEnd; index += 1) {
            result.push(bytes[index] ?? 0);
          }

          offset = chunkStart + localEnd;

          if (result.length >= length) {
            break;
          }
        }

        return result;
      },
      getState: () => ({
        role: debugRole,
        roomId: room.roomId,
        mediaUrl,
        cacheId: cacheIdRef.current,
        cacheMediaUrl: cacheMediaUrlRef.current,
        cacheFileUrl: cacheFileUrlRef.current,
        cacheHttpUrl: cacheHttpUrlRef.current,
        cacheLocalHttpUrl: cacheLocalHttpUrlRef.current,
        mediaUrlCandidates: mediaUrlCandidatesRef.current,
        activeMediaUrlIndex: activeMediaUrlIndexRef.current,
        guestBrowserFallbackToMemory: guestBrowserFallbackToMemoryRef.current,
        guestBrowserPersistedBytes: guestBrowserPersistedBytesRef.current,
        guestBrowserPersistedFileSize: guestBrowserPersistedFileRef.current?.size ?? null,
        guestBrowserChunkCount: guestBrowserChunkMapRef.current.size,
        guestBrowserFirstChunkStart:
          Array.from(guestBrowserChunkMapRef.current.keys()).sort((left, right) => left - right)[0] ?? null,
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
  }, [debugRole, desktopApi, mediaUrl, onSubtitleTrackChange, room, selfId]);

  useEffect(() => {
    if (isHost || mediaUrl) {
      return;
    }

    if (!hasMinimumProgressiveStartBytes()) {
      return;
    }

    void maybeActivateEarlyGuestMedia("progressive-threshold-reached").finally(() => {
      if ((room.transferState?.bytesPersisted ?? 0) >= room.mediaSource.fileSize) {
        void finalizeGuestBrowserMedia("room-transfer-complete");
      }
    });
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
    cacheHttpUrlRef.current = cacheHandle.httpUrl;
    cacheLocalHttpUrlRef.current = cacheHandle.localHttpUrl;
    mediaUrlCandidatesRef.current = [cacheHandle.httpUrl].filter(Boolean);
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
    cacheHttpUrlRef.current = null;
    cacheLocalHttpUrlRef.current = null;
    mediaUrlCandidatesRef.current = [];
    activeMediaUrlIndexRef.current = -1;
    await desktopApi.removeTempMediaCache(cacheId);
  }

  async function storeGuestBrowserMediaMeta() {
    if (isHost || window.syncplayDesktop) {
      return;
    }

    if (guestBrowserMetaStoredRef.current) {
      return;
    }

    const database = await openLocalMediaDb();
    const transaction = database.transaction([LOCAL_MEDIA_META_STORE], "readwrite");
    const store = transaction.objectStore(LOCAL_MEDIA_META_STORE);
    const meta: StoredLocalMediaMeta = {
      mediaId: room.mediaSource.mediaId,
      fileName: room.mediaSource.fileName,
      fileSize: room.mediaSource.fileSize,
      mimeType: room.mediaSource.mimeType,
      updatedAt: Date.now()
    };

    store.put(meta);
    await idbTransactionDone(transaction);
    guestBrowserMetaStoredRef.current = true;
  }

  async function storeGuestBrowserChunk(startByte: number, chunk: Uint8Array) {
    if (isHost || window.syncplayDesktop || chunk.byteLength === 0) {
      return;
    }

    const database = await openLocalMediaDb();
    const transaction = database.transaction([LOCAL_MEDIA_CHUNK_STORE], "readwrite");
    const store = transaction.objectStore(LOCAL_MEDIA_CHUNK_STORE);

    store.put({
      mediaId: room.mediaSource.mediaId,
      startByte,
      endByte: startByte + chunk.byteLength,
      bytes: toBlobPart(chunk).buffer
    });
    await idbTransactionDone(transaction);
  }

  async function persistGuestBrowserChunksForPlayback(orderedChunks: Array<[number, Uint8Array]>) {
    if (isHost || window.syncplayDesktop || guestBrowserPlaybackChunksStoredRef.current) {
      return;
    }

    const database = await openLocalMediaDb();
    const transaction = database.transaction([LOCAL_MEDIA_CHUNK_STORE, LOCAL_MEDIA_META_STORE], "readwrite");
    const chunkStore = transaction.objectStore(LOCAL_MEDIA_CHUNK_STORE);
    const chunkIndex = chunkStore.index("byMediaId");
    const cursorRequest = chunkIndex.openKeyCursor(IDBKeyRange.only(room.mediaSource.mediaId));

    await new Promise<void>((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor) {
          resolve();
          return;
        }

        chunkStore.delete(cursor.primaryKey);
        cursor.continue();
      };

      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Failed to clear local playback chunks"));
    });

    transaction.objectStore(LOCAL_MEDIA_META_STORE).put({
      mediaId: room.mediaSource.mediaId,
      fileName: room.mediaSource.fileName,
      fileSize: room.mediaSource.fileSize,
      mimeType: room.mediaSource.mimeType,
      updatedAt: Date.now()
    } satisfies StoredLocalMediaMeta);

    const batchedParts: Uint8Array[] = [];
    let batchStartByte = 0;
    let batchSize = 0;
    const maxBatchBytes = 8 * 1024 * 1024;

    function flushBatch() {
      if (batchedParts.length === 0) {
        return;
      }

      const mergedBytes = new Uint8Array(batchSize);
      let offset = 0;

      for (const part of batchedParts) {
        mergedBytes.set(part, offset);
        offset += part.byteLength;
      }

      chunkStore.put({
        mediaId: room.mediaSource.mediaId,
        startByte: batchStartByte,
        endByte: batchStartByte + mergedBytes.byteLength,
        bytes: mergedBytes.buffer
      });

      batchedParts.length = 0;
      batchSize = 0;
    }

    for (const [startByte, bytes] of orderedChunks) {
      if (batchedParts.length === 0) {
        batchStartByte = startByte;
      }

      if (batchSize > 0 && batchSize + bytes.byteLength > maxBatchBytes) {
        flushBatch();
        batchStartByte = startByte;
      }

      batchedParts.push(toBlobPart(bytes));
      batchSize += bytes.byteLength;
    }

    flushBatch();
    await idbTransactionDone(transaction);
    guestBrowserPlaybackChunksStoredRef.current = true;
  }

  function enqueueGuestBrowserChunkPersistence(startByte: number, chunk: Uint8Array) {
    if (isHost || window.syncplayDesktop || chunk.byteLength === 0) {
      return;
    }

    const chunkCopy = toBlobPart(chunk);
    pendingGuestBrowserPersistenceTaskRef.current = pendingGuestBrowserPersistenceTaskRef.current
      .then(async () => {
        await storeGuestBrowserMediaMeta();
        await storeGuestBrowserChunk(startByte, chunkCopy);
      })
      .catch((error: unknown) => {
        const formattedError = formatError(error);
        guestBrowserPersistenceErrorRef.current =
          typeof formattedError === "string" ? formattedError : `${formattedError.name}: ${formattedError.message}`;
        reportLocalDebug("guest browser chunk persistence failed", {
          startByte,
          error: formattedError
        });
      });
  }

  async function waitForGuestBrowserChunkPersistence() {
    try {
      await pendingGuestBrowserPersistenceTaskRef.current;
    } catch {
      // Individual persistence failures are captured and logged above.
    }

    if (guestBrowserPersistenceErrorRef.current) {
      throw new Error(guestBrowserPersistenceErrorRef.current);
    }
  }

  async function storeGuestBrowserFile(file: File) {
    if (isHost || window.syncplayDesktop) {
      return;
    }

    debugLog(debugRole, "guest browser file persistence started", {
      size: file.size,
      type: file.type
    });
    const database = await openLocalMediaDb();
    const transaction = database.transaction([LOCAL_MEDIA_FILE_STORE], "readwrite");
    transaction.objectStore(LOCAL_MEDIA_FILE_STORE).put({
      mediaId: room.mediaSource.mediaId,
      file
    });
    await idbTransactionDone(transaction);
    debugLog(debugRole, "guest browser file persistence completed", {
      size: file.size
    });
  }

  async function clearGuestBrowserStoredMedia() {
    if (isHost || window.syncplayDesktop) {
      return;
    }

    const database = await openLocalMediaDb();
    const transaction = database.transaction([LOCAL_MEDIA_CHUNK_STORE, LOCAL_MEDIA_META_STORE, LOCAL_MEDIA_FILE_STORE], "readwrite");
    const chunkStore = transaction.objectStore(LOCAL_MEDIA_CHUNK_STORE);
    const chunkIndex = chunkStore.index("byMediaId");
    const cursorRequest = chunkIndex.openKeyCursor(IDBKeyRange.only(room.mediaSource.mediaId));

    await new Promise<void>((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;

        if (!cursor) {
          resolve();
          return;
        }

        chunkStore.delete(cursor.primaryKey);
        cursor.continue();
      };

      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("Failed to clear media chunks"));
    });

    transaction.objectStore(LOCAL_MEDIA_META_STORE).delete(room.mediaSource.mediaId);
    transaction.objectStore(LOCAL_MEDIA_FILE_STORE).delete(room.mediaSource.mediaId);
    await idbTransactionDone(transaction);
  }

  async function getGuestBrowserPlaybackUrl() {
    if (isHost || window.syncplayDesktop) {
      return null;
    }

    const registration = await window.__syncplayLocalMediaServiceWorkerReady;

    if (!registration) {
      return null;
    }

    return `/__syncplay-local-media/${encodeURIComponent(room.mediaSource.mediaId)}?updatedAt=${Date.now()}`;
  }

  async function ensureGuestBrowserWritable() {
    if (isHost || window.syncplayDesktop) {
      return null;
    }

    if (guestBrowserWritableRef.current) {
      return guestBrowserWritableRef.current;
    }

    if (guestBrowserFallbackToMemoryRef.current) {
      return null;
    }

    await ensureGuestBrowserStoragePersistence();

    const storageDirectory = (navigator.storage as StorageManager & {
      getDirectory?: () => Promise<BrowserFileSystemDirectoryHandle>;
    }).getDirectory;

    if (!storageDirectory) {
      return null;
    }

    const directory = await storageDirectory.call(navigator.storage);
    const fileName = `syncplay-${room.roomId}-${room.mediaSource.mediaId}.media`;
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: true });

    guestBrowserDirectoryRef.current = directory;
    guestBrowserFileHandleRef.current = fileHandle;
    guestBrowserWritableRef.current = writable;
    guestBrowserFileNameRef.current = fileName;
    return writable;
  }

  async function ensureGuestBrowserStoragePersistence(force = false) {
    if (isHost || window.syncplayDesktop) {
      return guestBrowserStoragePersistentRef.current;
    }

    if (!force && guestBrowserStoragePersistenceAttemptedRef.current) {
      return guestBrowserStoragePersistentRef.current;
    }

    guestBrowserStoragePersistenceAttemptedRef.current = true;

    try {
      const persistent = await navigator.storage.persist?.();
      guestBrowserStoragePersistentRef.current = Boolean(persistent);
      const estimate = await navigator.storage.estimate?.();
      debugLog(debugRole, "guest browser storage status", {
        persistent: guestBrowserStoragePersistentRef.current,
        quota: estimate?.quota,
        usage: estimate?.usage
      });
    } catch (error) {
      debugLog(debugRole, "guest browser storage persistence failed", {
        error: formatError(error)
      });
    }

    return guestBrowserStoragePersistentRef.current;
  }

  async function persistGuestChunkInBrowser(startByte: number, chunk: Uint8Array) {
    if (isHost || chunk.byteLength === 0) {
      return;
    }

    const chunkCopy = toBlobPart(chunk);
    guestBrowserChunkMapRef.current.set(startByte, chunkCopy);
  }

  async function finalizeGuestBrowserMedia(trigger: string) {
    if (isHost || window.syncplayDesktop || guestBrowserMediaUrlRef.current) {
      return guestBrowserMediaUrlRef.current;
    }

    if (!hasMinimumProgressiveStartBytes()) {
      return null;
    }

    const persistedBytes = Math.max(contiguousBytesRef.current, room.transferState?.bytesPersisted ?? 0);

    if (persistedBytes <= 0) {
      return null;
    }

    await waitForGuestBrowserChunkPersistence();

    if (guestBrowserPersistedFileRef.current) {
      const persistedFile = guestBrowserPersistedFileRef.current;
      const persistedBytes = guestBrowserPersistedBytesRef.current;
      const orderedChunks = Array.from(guestBrowserChunkMapRef.current.entries()).sort((left, right) => left[0] - right[0]);
      let expectedStartByte = persistedBytes;

      for (const [startByte, bytes] of orderedChunks) {
        if (startByte !== expectedStartByte) {
          debugLog(debugRole, "guest browser mixed media finalization waiting for contiguous chunk", {
            trigger,
            expectedStartByte,
            actualStartByte: startByte,
            persistedBytes,
            chunkCount: orderedChunks.length
          });
          return null;
        }

        expectedStartByte += bytes.byteLength;
      }

      const nextFile = new File(
        [persistedFile.slice(0, persistedBytes), ...orderedChunks.map(([, bytes]) => toBlobPart(bytes))],
        room.mediaSource.fileName,
        { type: room.mediaSource.mimeType }
      );
      const nextUrl = URL.createObjectURL(nextFile);
      guestBrowserMediaUrlRef.current = nextUrl;
      mediaUrlCandidatesRef.current = [...mediaUrlCandidatesRef.current, nextUrl];
      debugLog(debugRole, "guest browser media finalized from mixed storage", {
        trigger,
        persistedBytes,
        chunkCount: orderedChunks.length,
        totalBytes: expectedStartByte
      });
      return nextUrl;
    }

    if (guestBrowserWritableRef.current && guestBrowserFileHandleRef.current) {
      await guestBrowserWritableRef.current.close();
      guestBrowserWritableRef.current = null;

      const cachedFile = await guestBrowserFileHandleRef.current.getFile();
      const nextUrl = URL.createObjectURL(cachedFile);
      guestBrowserMediaUrlRef.current = nextUrl;
      mediaUrlCandidatesRef.current = [...mediaUrlCandidatesRef.current, nextUrl];
      debugLog(debugRole, "guest browser media finalized from file system", {
        trigger,
        size: cachedFile.size,
        type: cachedFile.type || room.mediaSource.mimeType
      });
      return nextUrl;
    }

    const orderedChunks = Array.from(guestBrowserChunkMapRef.current.entries()).sort((left, right) => left[0] - right[0]);

    if (orderedChunks.length === 0) {
      return null;
    }

    let expectedStartByte = 0;

    for (const [startByte, bytes] of orderedChunks) {
      if (startByte !== expectedStartByte) {
        return null;
      }

      expectedStartByte += bytes.byteLength;
    }

    if (expectedStartByte < getProgressiveStartThresholdBytes()) {
      return null;
    }

    const nextFile = new File(
      orderedChunks.map(([, bytes]) => toBlobPart(bytes)),
      room.mediaSource.fileName,
      { type: room.mediaSource.mimeType }
    );
    const playbackUrl = await getGuestBrowserPlaybackUrl();

    if (playbackUrl) {
      guestBrowserMediaUrlRef.current = playbackUrl;
      mediaUrlCandidatesRef.current = [...mediaUrlCandidatesRef.current, playbackUrl];
      debugLog(debugRole, "guest browser media finalized through service worker", {
        trigger,
        url: playbackUrl,
        source: "memory"
      });
      return playbackUrl;
    }

    const nextUrl = URL.createObjectURL(nextFile);
    guestBrowserMediaUrlRef.current = nextUrl;
    mediaUrlCandidatesRef.current = [...mediaUrlCandidatesRef.current, nextUrl];
    debugLog(debugRole, "guest browser media finalized from memory", {
      trigger,
      chunkCount: orderedChunks.length,
      bytes: expectedStartByte
    });
    return nextUrl;
  }

  async function clearGuestBrowserCache() {
    guestBrowserChunkMapRef.current.clear();
    guestBrowserFallbackToMemoryRef.current = false;
    guestBrowserPersistedFileRef.current = null;
    guestBrowserPersistedBytesRef.current = 0;
    guestBrowserPersistenceErrorRef.current = null;
    guestBrowserMetaStoredRef.current = false;
    guestBrowserPlaybackChunksStoredRef.current = false;
    pendingGuestBrowserPersistenceTaskRef.current = Promise.resolve();

    if (guestBrowserWritableRef.current) {
      await guestBrowserWritableRef.current.close().catch(() => undefined);
      guestBrowserWritableRef.current = null;
    }

    const directory = guestBrowserDirectoryRef.current;
    const fileName = guestBrowserFileNameRef.current;

    guestBrowserDirectoryRef.current = null;
    guestBrowserFileHandleRef.current = null;
    guestBrowserFileNameRef.current = null;

    if (directory && fileName) {
      await directory.removeEntry(fileName).catch(() => undefined);
    }

    await clearGuestBrowserStoredMedia().catch(() => undefined);
  }

  function revokeGuestBrowserMediaUrl() {
    if (guestBrowserMediaUrlRef.current) {
      if (guestBrowserMediaUrlRef.current.startsWith("blob:")) {
        URL.revokeObjectURL(guestBrowserMediaUrlRef.current);
      }
      guestBrowserMediaUrlRef.current = null;
    }
  }

  async function switchGuestBrowserStorageToMemoryFallback(safePersistedBytes = contiguousBytesRef.current) {
    if (guestBrowserFallbackToMemoryRef.current) {
      return;
    }

    const fileHandle = guestBrowserFileHandleRef.current;

    if (guestBrowserWritableRef.current) {
      await guestBrowserWritableRef.current.close().catch(() => undefined);
      guestBrowserWritableRef.current = null;
    }

    if (fileHandle) {
      const persistedFile = await fileHandle.getFile();
      guestBrowserPersistedFileRef.current = persistedFile;
      guestBrowserPersistedBytesRef.current = Math.max(0, Math.min(safePersistedBytes, persistedFile.size));
    }

    guestBrowserFallbackToMemoryRef.current = true;
    debugLog(debugRole, "guest browser storage fell back to memory", {
      safePersistedBytes: guestBrowserPersistedBytesRef.current,
      fileSize: guestBrowserPersistedFileRef.current?.size ?? 0
    });
  }

  function maybeActivateCompletedGuestMedia(trigger: string) {
    const persistedBytes = Math.max(contiguousBytesRef.current, room.transferState?.bytesPersisted ?? 0);

    if (isHost || persistedBytes < room.mediaSource.fileSize) {
      return false;
    }

    if (window.syncplayDesktop) {
      const localHttpUrl = cacheLocalHttpUrlRef.current;

      if (localHttpUrl && !mediaUrlCandidatesRef.current.includes(localHttpUrl)) {
        mediaUrlCandidatesRef.current = [...mediaUrlCandidatesRef.current, localHttpUrl];
      }

      return false;
    }

    return switchToNextGuestMediaUrl(trigger);
  }

  async function maybeActivateEarlyGuestMedia(trigger: string) {
    if (isHost || mediaUrl || !hasMinimumProgressiveStartBytes()) {
      return false;
    }

    if (window.syncplayDesktop) {
      const cacheHandle = await ensureTempCache();

      if (!cacheHandle.cacheId) {
        return false;
      }

      return switchToNextGuestMediaUrl(trigger);
    }

    await finalizeGuestBrowserMedia(trigger);
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

  function isGuestCacheTransferComplete() {
    if (isHost) {
      return true;
    }

    return Math.max(contiguousBytesRef.current, room.transferState?.bytesPersisted ?? 0) >= room.mediaSource.fileSize;
  }

  function isUsingProgressiveGuestMediaUrl() {
    if (!mediaUrl) {
      return false;
    }

    return mediaUrl === cacheHttpUrlRef.current;
  }

  function canSeekThroughCurrentMediaSource() {
    if (isHost) {
      return true;
    }

    if (isGuestCacheTransferComplete()) {
      return true;
    }

    return Boolean(cacheLocalHttpUrlRef.current) && mediaUrl === cacheLocalHttpUrlRef.current;
  }

  function shouldChaseAuthoritativeBufferTarget(video: HTMLVideoElement, authoritativeTime: number) {
    if (canSeekThroughCurrentMediaSource()) {
      return true;
    }

    const existingPendingSeekTime = pendingSeekTimeRef.current;

    if (existingPendingSeekTime !== undefined) {
      return Math.abs(existingPendingSeekTime - authoritativeTime) <= MAX_PROGRESSIVE_SEEK_CHASE_AHEAD_SECONDS;
    }

    return authoritativeTime - video.currentTime <= MAX_PROGRESSIVE_SEEK_CHASE_AHEAD_SECONDS;
  }

  function handleGuestVideoError() {
    if (isHost) {
      return false;
    }

    if (!isGuestCacheTransferComplete() && isUsingProgressiveGuestMediaUrl()) {
      updateLocalMessage("Waiting for more media data");
      requestNextRange(pendingSeekTimeRef.current !== undefined ? "seek" : "resume");
      window.setTimeout(() => {
        const retryVideo = videoRef.current;
        retryVideo?.load();
      }, 250);
      return true;
    }

    if (switchToNextGuestMediaUrl("video-error")) {
      window.setTimeout(() => {
        const nextVideo = videoRef.current;
        nextVideo?.load();
      }, 0);
      return true;
    }

    return false;
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
    const hostFileName = localFile instanceof File ? localFile.name : localFile.fileName;
    const hostFileSize = localFile instanceof File ? localFile.size : localFile.fileSize;
    const hostMimeType = localFile instanceof File ? localFile.type : localFile.mimeType;
    debugLog(debugRole, "prepareHostMedia start", {
      fileName: hostFileName,
      fileSize: hostFileSize,
      mimeType: hostMimeType
    });

    try {
      const url =
        localFile instanceof File
          ? createObjectUrlFromFile(localFile)
          : isWebTorrentSelectedFile(localFile)
            ? localFile.playbackUrl
            : localFile.streamUrl || localFile.fileUrl;
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
      requestTrailingMetadataRange();
      maybeRequestProgressivePrefetch("initial");
    };

    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        void handleControlMessage(targetParticipantId, JSON.parse(event.data) as PeerControlMessage);
        return;
      }

      pendingBinaryChunkTaskRef.current = pendingBinaryChunkTaskRef.current
        .then(() => handleBinaryChunk(event.data))
        .catch((error: unknown) => {
          reportLocalDebug("binary chunk handling failed", {
            error: formatError(error)
          });
        });
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
        if (room.hostParticipantId === selfId && remoteParticipantIdRef.current === targetParticipantId) {
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
        pendingChunkMetaQueueRef.current = [
          ...pendingChunkMetaQueueRef.current,
          {
            startByte: message.startByte,
            endByte: message.endByte
          }
        ];
        return;
      case "range-complete":
        const matchingRequest = inFlightRequestsRef.current.find(
          (request) =>
            request.startByte === message.startByte &&
            request.reason === message.reason &&
            request.targetTime === message.targetTime
        );
        inFlightRequestsRef.current = inFlightRequestsRef.current.filter(
          (request) =>
            !(
              request.startByte === message.startByte &&
              request.reason === message.reason &&
              request.targetTime === message.targetTime
            )
        );
        if (
          message.reason === "seek" &&
          typeof message.targetTime === "number" &&
          !isStaleSeekCompletion(message.targetTime, matchingRequest?.issuedAt)
        ) {
          pendingSeekTimeRef.current = message.targetTime;
        }
        maybePromotePlaybackReady();
        maybeResumePendingSeek();
        maybeRequestProgressivePrefetch(pendingSeekTimeRef.current !== undefined ? "seek" : "sequential");
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

  async function readLocalChunk(file: SelectedTorrentFileSource | File, offset: number, length: number) {
    if (file instanceof File) {
      return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    }

    if (isDesktopPickedLocalFile(file)) {
      return desktopApi.readLocalFileChunk(file.fileId, offset, length);
    }

    return file.readChunk(offset, length);
  }

  async function handleBinaryChunk(payload: Blob | ArrayBuffer) {
    const range = pendingChunkMetaQueueRef.current[0];

    if (!range) {
      return;
    }

    pendingChunkMetaQueueRef.current = pendingChunkMetaQueueRef.current.slice(1);
    const chunk = payload instanceof Blob ? new Uint8Array(await payload.arrayBuffer()) : new Uint8Array(payload);

    const cacheHandle = await ensureTempCache();
    if (cacheHandle.cacheId) {
      await desktopApi.writeTempMediaChunk(cacheHandle.cacheId, range.startByte, chunk);
      await desktopApi.markTempMediaRangeAvailable(cacheHandle.cacheId, range.startByte, range.startByte + chunk.byteLength);
    } else {
      await persistGuestChunkInBrowser(range.startByte, chunk);
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

    if (hasMinimumProgressiveStartBytes()) {
      await maybeActivateEarlyGuestMedia("progressive-buffer-ready");
    }

    if (contiguousBytesRef.current >= room.mediaSource.fileSize) {
      await finalizeGuestBrowserMedia("all-bytes-persisted");
    }

    maybeActivateCompletedGuestMedia("all-bytes-persisted");
    maybePromotePlaybackReady();
    maybeResumePendingSeek();
    maybeRequestProgressivePrefetch(pendingSeekTimeRef.current !== undefined ? "seek" : "sequential");
  }

  function maybePromotePlaybackReady() {
    if (isHost) {
      return;
    }

    if (!mediaUrl) {
      return;
    }

    const video = videoRef.current;

    if (!video) {
      return;
    }

    const actualMediaBufferedUntil = getMediaBufferedEnd(video);
    const hasPlayableFrame = video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    const hasProgressiveStartupBuffer = hasMinimumProgressiveStartBytes();
    const isReady = hasPlayableFrame && hasProgressiveStartupBuffer;

    if (!isReady) {
      return;
    }

    updateLocalMessage("Ready to play");
    publishTransferState(
      buildTransferState("ready", {
        bufferedUntilTime: actualMediaBufferedUntil ?? getExpectedBufferedUntil(video.currentTime),
        isPlaybackReady: true,
        message: "Ready to play"
      })
    );

    if (dataChannelRef.current) {
      dataChannelRef.current.send(
        JSON.stringify({
          type: "buffer-ready",
          bufferedUntilTime: actualMediaBufferedUntil ?? getExpectedBufferedUntil(video.currentTime)
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
      shouldPlay: room.playbackState === "playing" && pendingLocalPauseAckRef.current === null
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
      return false;
    }

    const targetTime = pendingSeekTimeRef.current;
    const targetByte =
      targetTime !== undefined ? estimateByteOffset(targetTime, durationRef.current, room.mediaSource.fileSize) : undefined;
    const preferredStartByte =
      reason === "seek" && targetByte !== undefined ? targetByte : getNextRequestedStartByte(contiguousBytesRef.current);
    const startByte = getNextMissingStartByte(preferredStartByte);

    if (startByte >= room.mediaSource.fileSize) {
      return false;
    }

    const endByte = Math.min(
      room.mediaSource.fileSize,
      Math.max(startByte + REQUEST_WINDOW_BYTES, targetByte !== undefined ? targetByte + REQUEST_WINDOW_BYTES : 0)
    );

    if (isRangeCoveredByAvailable(startByte, endByte) || isRangeCoveredByInflight(startByte, endByte)) {
      return false;
    }

    requestSpecificRange(startByte, endByte, reason, targetTime);

    if (reason === "seek" && targetTime !== undefined && dataChannelRef.current) {
      dataChannelRef.current.send(
        JSON.stringify({
          type: "seek-buffering",
          targetTime
        } satisfies PeerControlMessage)
      );
    }

    return true;
  }

  function maybeRequestProgressivePrefetch(reason: RangeRequestReason) {
    if (isHost || !dataChannelRef.current || dataChannelRef.current.readyState !== "open") {
      return;
    }

    if (contiguousBytesRef.current >= room.mediaSource.fileSize) {
      return;
    }

    const targetTime = pendingSeekTimeRef.current;
    const video = videoRef.current;
    const bufferedAheadSeconds = getBufferedAheadSeconds(video);
    const isPlaybackReady = lastReportedTransferRef.current?.isPlaybackReady ?? room.transferState?.isPlaybackReady ?? false;
    const targetAheadSeconds =
      targetTime !== undefined
        ? SEEK_RESUME_PADDING_SECONDS * 2
        : isPlaybackReady
          ? STREAMING_PREFETCH_TARGET_SECONDS
          : STARTUP_PREFETCH_TARGET_SECONDS;
    const shouldAggressivelyPrefetch =
      !mediaUrl || bufferedAheadSeconds === undefined || bufferedAheadSeconds < targetAheadSeconds;

    if (!shouldAggressivelyPrefetch) {
      return;
    }

    while (inFlightRequestsRef.current.length < MAX_PREFETCH_INFLIGHT_REQUESTS) {
      if (!requestNextRange(reason)) {
        break;
      }
    }
  }

  function requestTrailingMetadataRange() {
    if (isHost || room.mediaSource.fileSize <= TRAILING_METADATA_WINDOW_BYTES) {
      return;
    }

    const startByte = Math.max(0, room.mediaSource.fileSize - TRAILING_METADATA_WINDOW_BYTES);
    const endByte = room.mediaSource.fileSize;

    if (isRangeCoveredByAvailable(startByte, endByte) || isRangeCoveredByInflight(startByte, endByte)) {
      return;
    }

    requestSpecificRange(startByte, endByte, "resume");
  }

  function requestSpecificRange(startByte: number, endByte: number, reason: RangeRequestReason, targetTime?: number) {
    if (isHost || !dataChannelRef.current || dataChannelRef.current.readyState !== "open") {
      return;
    }

    if (startByte >= endByte || startByte >= room.mediaSource.fileSize) {
      return;
    }

    const requestIssuedAt =
      reason === "seek" && targetTime !== undefined
        ? latestSeekIntentRef.current && Math.abs(latestSeekIntentRef.current.time - targetTime) <= 0.5
          ? latestSeekIntentRef.current.issuedAt
          : Date.now()
        : Date.now();

    const requestRange = {
      startByte,
      endByte,
      issuedAt: requestIssuedAt
    };

    const effectiveTransferState = lastReportedTransferRef.current ?? room.transferState;
    const nextPhase =
      reason === "initial" || reason === "resume"
        ? "buffering"
        : effectiveTransferState?.isPlaybackReady
          ? room.playbackState === "playing"
            ? "streaming"
            : "ready"
          : effectiveTransferState?.phase ?? "buffering";
    const nextMessage =
      reason === "seek" && targetTime !== undefined
        ? `Buffering at ${formatTime(targetTime)}`
        : reason === "initial" || reason === "resume"
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

    if (skipNextLocalPlayEventRef.current) {
      skipNextLocalPlayEventRef.current = false;
      debugLog(debugRole, "handlePlay ignored duplicate restart play", {
        currentTime: video.currentTime
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
      suppressNextLocalPauseEventRef.current = true;
      forwardNextLocalPauseEventRef.current = false;
      video.pause();
      pendingSeekTimeRef.current = video.currentTime;
      requestNextRange("seek");
      return;
    }

    pendingLocalPlayAckRef.current = Date.now();
    pendingLocalPauseAckRef.current = null;
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

    if (forwardNextLocalPauseEventRef.current) {
      forwardNextLocalPauseEventRef.current = false;
      suppressNextLocalPauseEventRef.current = false;
      pendingSeekTimeRef.current = undefined;
      pendingPlaybackRestoreRef.current = null;
      pendingLocalPlayAckRef.current = null;
      setIsPlaying(false);
      debugLog(debugRole, "handlePause forwarding user pause", {
        currentTime: video.currentTime
      });
      onPause(video.currentTime);
      return;
    }

    if (suppressNextLocalPauseEventRef.current) {
      suppressNextLocalPauseEventRef.current = false;
      forwardNextLocalPauseEventRef.current = false;
      debugLog(debugRole, "handlePause ignored internal buffering pause", {
        currentTime: video.currentTime,
        pendingSeekTime: pendingSeekTimeRef.current
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

    pendingLocalPlayAckRef.current = null;
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

    const ignoredProgrammaticSeek = consumeMatchingRecentSeek(
      ignoredProgrammaticSeekTimesRef,
      video.currentTime,
      0.5
    );
    if (ignoredProgrammaticSeek) {
      const latestRequestedProgrammaticSeek = latestRequestedProgrammaticSeekRef.current;

      if (
        latestRequestedProgrammaticSeek &&
        latestRequestedProgrammaticSeek.issuedAt > ignoredProgrammaticSeek.issuedAt &&
        Math.abs(latestRequestedProgrammaticSeek.time - video.currentTime) > 0.5
      ) {
        video.currentTime = latestRequestedProgrammaticSeek.time;
        setCurrentTime(latestRequestedProgrammaticSeek.time);
        return;
      }

      if (
        latestRequestedProgrammaticSeek &&
        Math.abs(latestRequestedProgrammaticSeek.time - ignoredProgrammaticSeek.time) <= 0.5
      ) {
        latestRequestedProgrammaticSeekRef.current = null;
      }

      debugLog(debugRole, "handleSeeked ignored programmatic seek", {
        currentTime: video.currentTime,
        ignoredProgrammaticSeekTime: ignoredProgrammaticSeek.time
      });
      return;
    }

    const dispatchedLocalSeek = consumeMatchingRecentSeek(
      dispatchedLocalSeekTimesRef,
      video.currentTime,
      0.5
    );
    if (dispatchedLocalSeek) {
      const latestRequestedLocalSeek = latestRequestedLocalSeekRef.current;

      if (
        latestRequestedLocalSeek &&
        latestRequestedLocalSeek.issuedAt > dispatchedLocalSeek.issuedAt &&
        Math.abs(latestRequestedLocalSeek.time - video.currentTime) > 0.5
      ) {
        video.currentTime = latestRequestedLocalSeek.time;
        setCurrentTime(latestRequestedLocalSeek.time);
        return;
      }

      if (
        latestRequestedLocalSeek &&
        Math.abs(latestRequestedLocalSeek.time - dispatchedLocalSeek.time) <= 0.5
      ) {
        latestRequestedLocalSeekRef.current = null;
      }

      debugLog(debugRole, "handleSeeked ignored already-dispatched local seek", {
        currentTime: video.currentTime,
        dispatchedLocalSeekTime: dispatchedLocalSeek.time
      });
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
      pendingLocalSeekAckRef.current = {
        time: video.currentTime,
        issuedAt: Date.now()
      };
      onSeek(video.currentTime);
      return;
    }

    pendingSeekTimeRef.current = video.currentTime;
    pendingLocalSeekAckRef.current = {
      time: video.currentTime,
      issuedAt: Date.now()
    };
    suppressNextLocalPauseEventRef.current = true;
    forwardNextLocalPauseEventRef.current = false;
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

    if (video.volume > 0) {
      lastAudibleVolumeRef.current = video.volume;
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
      if (isPlaybackAtEnd(video, durationRef.current)) {
        restartPlaybackFromBeginning(video, { shouldResume: true });
        return;
      }

      requestLocalPlayback(video);
      return;
    }

    pendingLocalPauseAckRef.current = Date.now();
    pendingLocalPlayAckRef.current = null;
    forwardNextLocalPauseEventRef.current = false;
    suppressNextLocalPauseEventRef.current = true;
    pendingSeekTimeRef.current = undefined;
    pendingPlaybackRestoreRef.current = null;
    setIsPlaying(false);
    onPause(video.currentTime);
    video.pause();
  }

  function seekBy(offsetSeconds: number) {
    const video = videoRef.current;

    if (!video || !mediaUrl) {
      return;
    }

    const seekAnchorTime = getSeekAnchorTime(video);
    const videoDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : durationRef.current;
    const maxTime = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : Math.max(seekAnchorTime + offsetSeconds, 0);
    const nextTime = Math.min(Math.max(seekAnchorTime + offsetSeconds, 0), maxTime);

    if (Math.abs(nextTime - seekAnchorTime) < 0.01) {
      return;
    }

    applyImmediateSeek(video, nextTime);
  }

  function getSeekAnchorTime(video: HTMLVideoElement) {
    const latestSeekIntent = latestSeekIntentRef.current;

    if (!latestSeekIntent) {
      return video.currentTime;
    }

    if (Date.now() - latestSeekIntent.issuedAt > LOCAL_SEEK_ACK_GRACE_MS) {
      return video.currentTime;
    }

    if (Math.abs(latestSeekIntent.time - video.currentTime) <= 0.05) {
      return video.currentTime;
    }

    return latestSeekIntent.time;
  }

  function restartPlaybackFromBeginning(video: HTMLVideoElement, options?: { shouldResume?: boolean }) {
    const restartTime = 0;

    if (Math.abs(video.currentTime - restartTime) <= 0.05) {
      if (options?.shouldResume) {
        resumePlaybackAfterRestart(video, restartTime);
      }
      return;
    }

    latestRequestedLocalSeekRef.current = pushRecentSeek(dispatchedLocalSeekTimesRef, restartTime);
    latestSeekIntentRef.current = latestRequestedLocalSeekRef.current;
    pendingSeekTimeRef.current = undefined;
    video.currentTime = restartTime;
    setCurrentTime(restartTime);
    onSeek(restartTime);

    if (options?.shouldResume) {
      window.setTimeout(() => {
        if (videoRef.current !== video) {
          return;
        }

        resumePlaybackAfterRestart(video, restartTime);
      }, 0);
    }
  }

  function resumePlaybackAfterRestart(video: HTMLVideoElement, restartTime: number) {
    skipNextLocalPlayEventRef.current = true;
    pendingLocalPlayAckRef.current = Date.now();
    pendingLocalPauseAckRef.current = null;
    setIsPlaying(true);
    onPlay(restartTime);
    void video.play();
  }

  function handleTimelineInput(event: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const nextTime = Number(event.target.value);
    applyImmediateSeek(video, nextTime);
  }

  function handleVolumeInput(event: React.ChangeEvent<HTMLInputElement>) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const nextVolume = Number(event.target.value);
    video.volume = nextVolume;
    video.muted = nextVolume === 0;
    if (nextVolume > 0) {
      lastAudibleVolumeRef.current = nextVolume;
    }
    setVolume(nextVolume);
    setIsMuted(video.muted);
  }

  function toggleMute() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.muted || video.volume === 0) {
      const restoredVolume = video.volume === 0 ? 1 : lastAudibleVolumeRef.current > 0 ? lastAudibleVolumeRef.current : 1;
      video.volume = restoredVolume;
      video.muted = false;
      setVolume(restoredVolume);
      setIsMuted(false);
      return;
    }

    lastAudibleVolumeRef.current = video.volume > 0 ? video.volume : lastAudibleVolumeRef.current;
    video.muted = true;
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

        if (!cue || typeof cue !== "object" || !("text" in cue) || typeof cue.text !== "string") {
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
    if (!hasSubtitleTrack) {
      subtitleInputRef.current?.click();
      return;
    }

    setIsSubtitleMenuOpen((current) => !current);
  }

  function handleToggleCaptions() {
    setIsCaptionsEnabled((current) => !current);
    setIsSubtitleMenuOpen(false);
  }

  function handleReplaceSubtitles() {
    setIsSubtitleMenuOpen(false);
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
      const bytes = new Uint8Array(await file.arrayBuffer());
      const normalizedContent = decodeSubtitleContent(bytes).trim();

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
      setIsSubtitleMenuOpen(false);
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
            handleGuestVideoError();
          }}
          onPlay={handlePlay}
          onPause={handlePause}
          onSeeked={handleSeeked}
          onTimeUpdate={handleTimeUpdate}
          onVolumeChange={handleVolumeChange}
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
              <div
                className="local-player-scrubber-track"
                aria-hidden="true"
                style={
                  {
                    "--player-progress": `${progressPercent}%`,
                    "--player-buffered": `${Math.max(progressPercent, bufferedPercent)}%`
                  } as React.CSSProperties
                }
              />
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
                  <div ref={subtitleMenuRef} className="local-player-subtitle-menu-anchor">
                    <button
                      className={`local-player-toolbar-button local-player-toolbar-button--icon ${
                        hasSubtitleTrack && isCaptionsEnabled ? "local-player-toolbar-button--active" : ""
                      }`}
                      type="button"
                      onClick={() => {
                        revealControls();
                        handleClosedCaptionsAction();
                      }}
                      aria-label={hasSubtitleTrack ? "Subtitle options" : "Upload subtitles"}
                      aria-expanded={hasSubtitleTrack ? isSubtitleMenuOpen : undefined}
                      aria-haspopup={hasSubtitleTrack ? "menu" : undefined}
                      title={subtitleButtonTitle}
                    >
                      <ClosedCaptionsIcon />
                    </button>
                    {hasSubtitleTrack && isSubtitleMenuOpen ? (
                      <div className="local-player-subtitle-menu" role="menu" aria-label="Subtitle options">
                        <button
                          className="local-player-subtitle-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={handleToggleCaptions}
                        >
                          {isCaptionsEnabled ? "Hide subtitles" : "Show subtitles"}
                        </button>
                        <button
                          className="local-player-subtitle-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={handleReplaceSubtitles}
                        >
                          Replace subtitles
                        </button>
                      </div>
                    ) : null}
                  </div>
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
                {formatTransferProgressLabel(room.transferState)}
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
    debugLog(debugRole, "applyAuthoritativeState", {
      playbackState: authoritativeRoom.playbackState,
      currentTime: authoritativeRoom.currentTime,
      localCurrentTime: video.currentTime,
      lastEventId: authoritativeRoom.lastEventId
    });
    reportLocalDebug("applyAuthoritativeState", {
      playbackState: authoritativeRoom.playbackState,
      currentTime: authoritativeRoom.currentTime,
      localCurrentTime: video.currentTime,
      localPaused: video.paused,
      lastEventId: authoritativeRoom.lastEventId
    });

    const canSeekThroughMediaSource = canSeekThroughCurrentMediaSource();
    const playableBufferedUntil = isHost ? Number.POSITIVE_INFINITY : getPlayableBufferedUntil(video);
    const shouldAwaitBufferedPlayback =
      !isHost &&
      !canSeekThroughMediaSource &&
      ((!hasCurrentPlayableData(video) && authoritativeRoom.playbackState === "playing") ||
        (playableBufferedUntil !== undefined && authoritativeRoom.currentTime > playableBufferedUntil - 0.25));
    const shouldChaseAuthoritativeTime = shouldChaseAuthoritativeBufferTarget(video, authoritativeRoom.currentTime);

    if (shouldAwaitBufferedPlayback) {
      pendingSeekTimeRef.current = shouldChaseAuthoritativeTime ? authoritativeRoom.currentTime : undefined;
      setCurrentTime(video.currentTime);
      maybeRequestProgressivePrefetch(shouldChaseAuthoritativeTime ? "seek" : "sequential");
    } else if (Math.abs(video.currentTime - authoritativeRoom.currentTime) > DRIFT_THRESHOLD_SECONDS) {
      pendingSeekTimeRef.current = undefined;
      latestRequestedProgrammaticSeekRef.current = pushRecentSeek(
        ignoredProgrammaticSeekTimesRef,
        authoritativeRoom.currentTime
      );
      latestSeekIntentRef.current = latestRequestedProgrammaticSeekRef.current;
      video.currentTime = authoritativeRoom.currentTime;
      setCurrentTime(authoritativeRoom.currentTime);
    } else {
      pendingSeekTimeRef.current = undefined;
      setCurrentTime(video.currentTime);
    }

    if (authoritativeRoom.playbackState === "playing") {
      const bufferedUntilTime = isHost ? Number.POSITIVE_INFINITY : getPlayableBufferedUntil(video);

      if (!isHost && !canSeekThroughMediaSource && !hasCurrentPlayableData(video)) {
        pendingPlaybackRestoreRef.current = {
          time: shouldChaseAuthoritativeTime ? authoritativeRoom.currentTime : video.currentTime,
          shouldPlay: true
        };
        pendingSeekTimeRef.current = shouldChaseAuthoritativeTime ? authoritativeRoom.currentTime : undefined;
        maybeRequestProgressivePrefetch(shouldChaseAuthoritativeTime ? "seek" : "sequential");
      } else if (
        !canSeekThroughMediaSource &&
        bufferedUntilTime !== undefined &&
        authoritativeRoom.currentTime > bufferedUntilTime - 0.25
      ) {
        pendingSeekTimeRef.current = shouldChaseAuthoritativeTime ? authoritativeRoom.currentTime : undefined;
        maybeRequestProgressivePrefetch(shouldChaseAuthoritativeTime ? "seek" : "sequential");
      } else {
        void video
          .play()
        .then(() => {
          debugLog(debugRole, "authoritative play resolved", {
            currentTime: video.currentTime
          });
          reportLocalDebug("authoritative play resolved", {
            currentTime: video.currentTime,
            paused: video.paused,
            lastEventId: authoritativeRoom.lastEventId
          });
        })
        .catch((error: unknown) => {
          debugLog(debugRole, "authoritative play rejected", {
            error: formatError(error)
          });
          reportLocalDebug("authoritative play rejected", {
            error: formatError(error),
            currentTime: video.currentTime,
            paused: video.paused,
            lastEventId: authoritativeRoom.lastEventId
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

    const canSeekThroughMediaSource = canSeekThroughCurrentMediaSource();
    const playableBufferedUntil = isHost ? Number.POSITIVE_INFINITY : getPlayableBufferedUntil(video);
    const canRestoreAtTarget =
      canSeekThroughMediaSource ||
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
      maybeRequestProgressivePrefetch("seek");
      return;
    }

    debugLog(debugRole, "restorePendingPlayback applying", {
      trigger,
      targetTime: pendingPlaybackRestore.time,
      shouldPlay: pendingPlaybackRestore.shouldPlay,
      playableBufferedUntil
    });

    latestRequestedProgrammaticSeekRef.current = pushRecentSeek(
      ignoredProgrammaticSeekTimesRef,
      pendingPlaybackRestore.time
    );
    latestSeekIntentRef.current = latestRequestedProgrammaticSeekRef.current;
    video.currentTime = pendingPlaybackRestore.time;
    setCurrentTime(pendingPlaybackRestore.time);

    if (pendingPlaybackRestore.shouldPlay && pendingLocalPauseAckRef.current === null) {
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

  function getNextRequestedStartByte(preferredStartByte: number) {
    const requestedRanges = inFlightRequestsRef.current.reduce(
      (ranges, range) =>
        mergeRanges(ranges, {
          startByte: range.startByte,
          endByte: range.endByte
        }),
      availableRangesRef.current
    );

    for (const range of requestedRanges) {
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

  function getBufferedAheadSeconds(video: HTMLVideoElement | null) {
    if (!video) {
      return undefined;
    }

    const mediaBufferedUntil = getMediaBufferedEnd(video);

    if (mediaBufferedUntil !== undefined) {
      return Math.max(0, mediaBufferedUntil - video.currentTime);
    }

    const expectedBufferedUntil = getExpectedBufferedUntil(video.currentTime);

    if (expectedBufferedUntil !== undefined) {
      return Math.max(0, expectedBufferedUntil - video.currentTime);
    }

    return undefined;
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
    pendingChunkMetaQueueRef.current = [];
    pendingBinaryChunkTaskRef.current = Promise.resolve();
    pendingGuestBrowserPersistenceTaskRef.current = Promise.resolve();
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

  function getProgressiveStartThresholdBytes() {
    const estimatedBytesFromDuration =
      durationRef.current > 0
        ? estimateByteOffset(
            Math.max(MIN_INITIAL_BUFFER_SECONDS, SEEK_RESUME_PADDING_SECONDS * 2),
            durationRef.current,
            room.mediaSource.fileSize
          )
        : 0;
    const boundedEstimate = estimatedBytesFromDuration
      ? Math.min(MAX_PROGRESSIVE_START_BYTES, Math.max(MIN_PROGRESSIVE_START_BYTES, estimatedBytesFromDuration))
      : MIN_PROGRESSIVE_START_BYTES;

    return Math.min(room.mediaSource.fileSize, Math.max(MIN_INITIAL_BUFFER_BYTES, boundedEstimate));
  }

  function hasMinimumProgressiveStartBytes() {
    return contiguousBytesRef.current >= getProgressiveStartThresholdBytes();
  }

  function applyImmediateSeek(video: HTMLVideoElement, nextTime: number) {
    if (!Number.isFinite(nextTime) || nextTime < 0) {
      return;
    }

    const bufferedUntilTime = getPlayableBufferedUntil(video);

    if (!isHost) {
      pendingLocalSeekAckRef.current = {
        time: nextTime,
        issuedAt: Date.now()
      };
    }

    latestRequestedLocalSeekRef.current = pushRecentSeek(dispatchedLocalSeekTimesRef, nextTime);
    latestSeekIntentRef.current = latestRequestedLocalSeekRef.current;
    pendingSeekTimeRef.current = undefined;
    video.currentTime = nextTime;
    setCurrentTime(nextTime);

    if (isHost) {
      onSeek(nextTime);
      return;
    }

    if (bufferedUntilTime !== undefined && nextTime <= bufferedUntilTime - SEEK_RESUME_PADDING_SECONDS) {
      onSeek(nextTime);
      return;
    }

    pendingSeekTimeRef.current = nextTime;
    suppressNextLocalPauseEventRef.current = true;
    forwardNextLocalPauseEventRef.current = false;
    video.pause();
    onSeek(nextTime);
    requestNextRange("seek");
  }

  function requestLocalPlayback(video: HTMLVideoElement) {
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
      suppressNextLocalPauseEventRef.current = true;
      forwardNextLocalPauseEventRef.current = false;
      video.pause();
      pendingSeekTimeRef.current = video.currentTime;
      requestNextRange("seek");
      return;
    }

    pendingSeekTimeRef.current = undefined;
    pendingLocalPauseAckRef.current = null;
    pendingLocalPlayAckRef.current = Date.now();
    skipNextLocalPlayEventRef.current = true;
    setIsPlaying(true);
    onPlay(video.currentTime);
    void video.play().catch(() => {
      skipNextLocalPlayEventRef.current = false;
    });
  }

  function shouldDeferAuthoritativePlayback(video: HTMLVideoElement, authoritativeRoom: RoomState) {
    if (isHost) {
      return false;
    }

    const pendingLocalPlayAck = pendingLocalPlayAckRef.current;

    if (pendingLocalPlayAck !== null) {
      if (authoritativeRoom.playbackState === "playing") {
        pendingLocalPlayAckRef.current = null;
      } else if (Date.now() - pendingLocalPlayAck <= LOCAL_SEEK_ACK_GRACE_MS) {
        debugLog(debugRole, "deferring stale authoritative playback update during local play", {
          localCurrentTime: video.currentTime,
          authoritativeTime: authoritativeRoom.currentTime,
          lastEventId: authoritativeRoom.lastEventId
        });
        return true;
      } else {
        pendingLocalPlayAckRef.current = null;
      }
    }

    const pendingLocalPauseAck = pendingLocalPauseAckRef.current;

    if (pendingLocalPauseAck !== null) {
      if (authoritativeRoom.playbackState === "paused") {
        pendingLocalPauseAckRef.current = null;
      } else if (Date.now() - pendingLocalPauseAck <= LOCAL_SEEK_ACK_GRACE_MS) {
        debugLog(debugRole, "deferring stale authoritative playback update during local pause", {
          localCurrentTime: video.currentTime,
          authoritativeTime: authoritativeRoom.currentTime,
          lastEventId: authoritativeRoom.lastEventId
        });
        return true;
      } else {
        pendingLocalPauseAckRef.current = null;
      }
    }

    const pendingLocalSeekAck = pendingLocalSeekAckRef.current;

    if (!pendingLocalSeekAck) {
      return false;
    }

    if (Math.abs(authoritativeRoom.currentTime - pendingLocalSeekAck.time) <= DRIFT_THRESHOLD_SECONDS) {
      pendingLocalSeekAckRef.current = null;
      return false;
    }

    if (Date.now() - pendingLocalSeekAck.issuedAt > LOCAL_SEEK_ACK_GRACE_MS) {
      pendingLocalSeekAckRef.current = null;
      return false;
    }

    debugLog(debugRole, "deferring stale authoritative playback update during local seek", {
      localCurrentTime: video.currentTime,
      pendingSeekTime: pendingLocalSeekAck.time,
      authoritativeTime: authoritativeRoom.currentTime,
      lastEventId: authoritativeRoom.lastEventId
    });
    return true;
  }

  function isStaleSeekCompletion(targetTime: number, requestIssuedAt?: number) {
    const latestSeekIntent = latestSeekIntentRef.current;

    if (!latestSeekIntent || requestIssuedAt === undefined) {
      return false;
    }

    if (latestSeekIntent.issuedAt <= requestIssuedAt) {
      return false;
    }

    if (Math.abs(latestSeekIntent.time - targetTime) <= 0.5) {
      return false;
    }

    debugLog(debugRole, "ignoring stale seek range completion", {
      completedSeekTime: targetTime,
      requestIssuedAt,
      latestSeekIntentTime: latestSeekIntent.time,
      latestSeekIntentIssuedAt: latestSeekIntent.issuedAt
    });
    return true;
  }
}

function pushRecentSeek(queueRef: RefObject<Array<{ time: number; issuedAt: number }>>, time: number) {
  const nextEntry = {
    time,
    issuedAt: Date.now()
  };
  const recentEntries = queueRef.current.filter((entry) => nextEntry.issuedAt - entry.issuedAt <= LOCAL_SEEK_ACK_GRACE_MS);
  queueRef.current = [...recentEntries, nextEntry].slice(-8);
  return nextEntry;
}

function consumeMatchingRecentSeek(
  queueRef: RefObject<Array<{ time: number; issuedAt: number }>>,
  time: number,
  toleranceSeconds: number
) {
  const now = Date.now();
  const matchIndex = queueRef.current.findIndex(
    (entry) =>
      now - entry.issuedAt <= LOCAL_SEEK_ACK_GRACE_MS &&
      Math.abs(entry.time - time) <= toleranceSeconds
  );

  if (matchIndex === -1) {
    queueRef.current = queueRef.current.filter((entry) => now - entry.issuedAt <= LOCAL_SEEK_ACK_GRACE_MS);
    return null;
  }

  const [matchedEntry] = queueRef.current.splice(matchIndex, 1);
  return matchedEntry ?? null;
}

function debugLog(role: "host" | "guest", message: string, details?: Record<string, unknown>) {
  void role;
  void message;
  void details;
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

function isPlaybackAtEnd(video: HTMLVideoElement, fallbackDuration: number) {
  const effectiveDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallbackDuration;

  if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) {
    return video.ended;
  }

  return video.ended || video.currentTime >= effectiveDuration - PLAYBACK_END_TOLERANCE_SECONDS;
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

function formatTransferProgressLabel(transferState: TransferState) {
  const percent = Math.round(transferState.progress * 100);

  if (transferState.isPlaybackReady) {
    return `Playback ready ${percent}%`;
  }

  return `Startup ready ${percent}%`;
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
