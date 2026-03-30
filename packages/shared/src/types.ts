export type PlaybackState = "playing" | "paused";

export type TransferPhase =
  | "waiting_host"
  | "connecting_peer"
  | "buffering"
  | "ready"
  | "streaming"
  | "ended"
  | "failed";

export type RangeRequestReason = "initial" | "sequential" | "seek" | "resume";

export interface ByteRange {
  startByte: number;
  endByte: number;
}

export interface Participant {
  id: string;
  displayName?: string;
  connectedAt: number;
}

export interface YoutubeMediaSource {
  type: "youtube";
  videoId: string;
}

export interface LocalFileMediaSource {
  type: "local_file";
  mediaId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  duration?: number;
}

export type MediaSource = YoutubeMediaSource | LocalFileMediaSource;

export interface TransferState {
  phase: TransferPhase;
  bytesReceived: number;
  bytesTotal: number;
  bytesPersisted: number;
  progress: number;
  bufferedUntilTime?: number;
  isPlaybackReady: boolean;
  pendingSeekTime?: number;
  reconnectAttempt?: number;
  lastRequestedRange?: ByteRange;
  availableRanges: ByteRange[];
  message?: string;
}

export interface RoomState {
  roomId: string;
  mediaSource: MediaSource;
  playbackState: PlaybackState;
  currentTime: number;
  updatedAt: number;
  lastEventId: number;
  participants: Participant[];
  hostParticipantId?: string;
  transferState?: TransferState;
}

type PlaybackClientEvent =
  | {
      type: "player_play";
      payload: {
        roomId: string;
        currentTime: number;
      };
    }
  | {
      type: "player_pause";
      payload: {
        roomId: string;
        currentTime: number;
      };
    }
  | {
      type: "player_seek";
      payload: {
        roomId: string;
        currentTime: number;
      };
    };

export type ClientEvent =
  | {
      type: "create_room";
      payload: {
        mediaSource: MediaSource;
        displayName?: string;
      };
    }
  | {
      type: "join_room";
      payload: {
        roomId: string;
        displayName?: string;
      };
    }
  | {
      type: "request_sync";
      payload: {
        roomId: string;
      };
    }
  | PlaybackClientEvent
  | {
      type: "leave_room";
      payload: {
        roomId: string;
      };
    }
  | {
      type: "peer_offer";
      payload: {
        roomId: string;
        targetParticipantId: string;
        sdp: RTCSessionDescriptionInit;
      };
    }
  | {
      type: "peer_answer";
      payload: {
        roomId: string;
        targetParticipantId: string;
        sdp: RTCSessionDescriptionInit;
      };
    }
  | {
      type: "peer_ice_candidate";
      payload: {
        roomId: string;
        targetParticipantId: string;
        candidate: RTCIceCandidateInit;
      };
    }
  | {
      type: "peer_transfer_state";
      payload: {
        roomId: string;
        transferState: TransferState;
      };
    };

type PlaybackServerEvent =
  | {
      type: "player_state_changed";
      payload: {
        room: RoomState;
        actorId: string;
        action: "player_play" | "player_pause" | "player_seek";
      };
    };

export type ServerEvent =
  | {
      type: "room_created";
      payload: {
        selfId: string;
        room: RoomState;
      };
    }
  | {
      type: "room_joined";
      payload: {
        selfId: string;
        room: RoomState;
      };
    }
  | {
      type: "sync_snapshot";
      payload: {
        room: RoomState;
        actorId?: string;
      };
    }
  | PlaybackServerEvent
  | {
      type: "presence_updated";
      payload: {
        room: RoomState;
      };
    }
  | {
      type: "peer_offer";
      payload: {
        roomId: string;
        sourceParticipantId: string;
        sdp: RTCSessionDescriptionInit;
      };
    }
  | {
      type: "peer_answer";
      payload: {
        roomId: string;
        sourceParticipantId: string;
        sdp: RTCSessionDescriptionInit;
      };
    }
  | {
      type: "peer_ice_candidate";
      payload: {
        roomId: string;
        sourceParticipantId: string;
        candidate: RTCIceCandidateInit;
      };
    }
  | {
      type: "transfer_state_updated";
      payload: {
        room: RoomState;
      };
    }
  | {
      type: "local_file_buffering";
      payload: {
        room: RoomState;
      };
    }
  | {
      type: "local_file_ready";
      payload: {
        room: RoomState;
      };
    }
  | {
      type: "host_disconnected";
      payload: {
        roomId: string;
        message: string;
      };
    }
  | {
      type: "server_error";
      payload: {
        message: string;
      };
    };

export interface ServerEnvelope<TType extends ServerEvent["type"] = ServerEvent["type"]> {
  type: TType;
  payload: Extract<ServerEvent, { type: TType }>["payload"];
}

export interface ClientEnvelope<TType extends ClientEvent["type"] = ClientEvent["type"]> {
  type: TType;
  payload: Extract<ClientEvent, { type: TType }>["payload"];
}

export interface PickedLocalFile extends LocalFileMediaSource {
  fileId: string;
}

export interface TempMediaCacheMetadata {
  fileSize: number;
  mimeType: string;
  fileName: string;
}

export interface TempMediaCacheHandle {
  cacheId: string;
  mediaUrl: string;
  fileUrl: string;
  httpUrl: string;
}

export interface TempMediaRangeAvailability {
  availableEndByte: number;
}

export interface TempMediaStatus {
  availableRanges: ByteRange[];
  contiguousBytes: number;
}

export interface DesktopApi {
  platform: string;
  electronVersion: string;
  openDesktopWindow(): Promise<void>;
  pickLocalFile(): Promise<PickedLocalFile | null>;
  readLocalFile(fileId: string): Promise<Uint8Array>;
  readLocalFileChunk(fileId: string, offset: number, length: number): Promise<Uint8Array>;
  createTempMediaCache(mediaId: string, metadata: TempMediaCacheMetadata): Promise<TempMediaCacheHandle>;
  writeTempMediaChunk(cacheId: string, offset: number, bytes: Uint8Array): Promise<void>;
  markTempMediaRangeAvailable(cacheId: string, startByte: number, endByte: number): Promise<void>;
  waitForTempMediaRange(
    cacheId: string,
    startByte: number,
    endByte: number,
    timeoutMs?: number
  ): Promise<TempMediaRangeAvailability>;
  getTempMediaStatus(cacheId: string): Promise<TempMediaStatus>;
  removeTempMediaCache(cacheId: string): Promise<void>;
}
