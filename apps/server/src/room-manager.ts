import {
  type MediaSource,
  type Participant,
  type PlaybackState,
  type RoomState,
  type TransferState,
  createRoomId,
  normalizeRoomId
} from "@syncplay/shared";

type RoomRecord = {
  state: RoomState;
  participants: Map<string, Participant>;
};

export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();

  createRoom(mediaSource: MediaSource, participant: Participant) {
    let roomId = createRoomId();

    while (this.rooms.has(roomId)) {
      roomId = createRoomId();
    }

    const now = Date.now();
    const room: RoomState = {
      roomId,
      mediaSource,
      playbackState: "paused",
      currentTime: 0,
      updatedAt: now,
      lastEventId: 0,
      participants: [participant],
      hostParticipantId: participant.id,
      transferState:
        mediaSource.type === "local_file"
          ? {
              phase: "waiting_host",
              bytesReceived: 0,
              bytesTotal: mediaSource.fileSize,
              bytesPersisted: 0,
              progress: 0,
              isPlaybackReady: false,
              availableRanges: []
            }
          : undefined
    };

    const record: RoomRecord = {
      state: room,
      participants: new Map([[participant.id, participant]])
    };

    this.rooms.set(roomId, record);

    return {
      room
    };
  }

  joinRoom(roomId: string, participant: Participant) {
    const record = this.rooms.get(normalizeRoomId(roomId));

    if (!record) {
      return {
        ok: false as const,
        reason: "Room not found."
      };
    }

    if (record.state.mediaSource.type === "local_file" && record.participants.size >= 2) {
      return {
        ok: false as const,
        reason: "Local file rooms support only two participants."
      };
    }

    record.participants.set(participant.id, participant);
    record.state.participants = Array.from(record.participants.values());
    record.state.updatedAt = Date.now();

    if (record.state.mediaSource.type === "local_file") {
      record.state.transferState = {
        phase: "connecting_peer",
        bytesReceived: 0,
        bytesTotal: record.state.mediaSource.fileSize,
        bytesPersisted: 0,
        progress: 0,
        isPlaybackReady: false,
        availableRanges: []
      };
    }

    return {
      ok: true as const,
      room: record.state
    };
  }

  leaveRoom(roomId: string, participantId: string) {
    const normalizedRoomId = normalizeRoomId(roomId);
    const record = this.rooms.get(normalizedRoomId);

    if (!record) {
      return null;
    }

    const wasHost = record.state.hostParticipantId === participantId;
    const roomBeforeRemoval = record.state;
    record.participants.delete(participantId);

    if (record.participants.size === 0 || wasHost) {
      this.rooms.delete(normalizedRoomId);
      return {
        room: roomBeforeRemoval,
        deleted: true,
        hostDisconnected: wasHost
      };
    }

    record.state.participants = Array.from(record.participants.values());
    record.state.updatedAt = Date.now();

    return {
      room: record.state,
      deleted: false,
      hostDisconnected: false
    };
  }

  getRoom(roomId: string) {
    return this.rooms.get(normalizeRoomId(roomId))?.state ?? null;
  }

  applyPlaybackAction(
    roomId: string,
    actorId: string,
    action: "player_play" | "player_pause" | "player_seek",
    currentTime: number
  ) {
    const record = this.rooms.get(normalizeRoomId(roomId));

    if (!record) {
      return null;
    }

    const safeCurrentTime = clampPlaybackTime(currentTime);
    const playbackState = resolvePlaybackState(record.state.playbackState, action);

    record.state = {
      ...record.state,
      playbackState,
      currentTime: safeCurrentTime,
      updatedAt: Date.now(),
      lastEventId: record.state.lastEventId + 1,
      participants: Array.from(record.participants.values()),
      transferState:
        record.state.transferState && action === "player_play"
          ? { ...record.state.transferState, phase: "streaming" }
          : record.state.transferState
    };

    this.rooms.set(record.state.roomId, record);

    return {
      room: record.state,
      actorId,
      action
    };
  }

  updateTransferState(roomId: string, transferState: TransferState) {
    const record = this.rooms.get(normalizeRoomId(roomId));

    if (!record) {
      return null;
    }

    record.state = {
      ...record.state,
      transferState,
      updatedAt: Date.now(),
      participants: Array.from(record.participants.values())
    };

    return record.state;
  }
}

function resolvePlaybackState(currentState: PlaybackState, action: "player_play" | "player_pause" | "player_seek"): PlaybackState {
  if (action === "player_play") {
    return "playing";
  }

  if (action === "player_pause") {
    return "paused";
  }

  return currentState;
}

function clampPlaybackTime(value: number) {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, value);
}
