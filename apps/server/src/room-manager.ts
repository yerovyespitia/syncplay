import {
  type ChatMessage,
  type MediaSource,
  type Participant,
  type PlaybackState,
  type RoomState,
  type SubtitleTrack,
  type TransferState,
  createRoomId,
  normalizeRoomId
} from "@syncplay/shared";

type RoomRecord = {
  state: RoomState;
  participants: Map<string, Participant>;
};

const MAX_CHAT_MESSAGES = 100;

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
      chatMessages: [],
      hostParticipantId: participant.id,
      transferState:
        mediaSource.type === "local_file" || mediaSource.type === "torrent_magnet"
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

    if (
      (record.state.mediaSource.type === "local_file" || record.state.mediaSource.type === "torrent_magnet") &&
      record.participants.size >= 2
    ) {
      return {
        ok: false as const,
        reason: "Local file rooms support only two participants."
      };
    }

    const nextState = advanceRoomPlayback(record.state);
    record.participants.set(participant.id, participant);
    nextState.participants = Array.from(record.participants.values());
    nextState.updatedAt = Date.now();

    if (nextState.mediaSource.type === "local_file" || nextState.mediaSource.type === "torrent_magnet") {
      nextState.playbackState = "paused";
      nextState.currentTime = 0;
      nextState.lastEventId += 1;
      nextState.transferState = {
        phase: "connecting_peer",
        bytesReceived: 0,
        bytesTotal: nextState.mediaSource.fileSize,
        bytesPersisted: 0,
        progress: 0,
        isPlaybackReady: false,
        availableRanges: []
      };
    }

    record.state = nextState;

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

    const nextState = advanceRoomPlayback(record.state);
    nextState.participants = Array.from(record.participants.values());
    nextState.updatedAt = Date.now();
    record.state = nextState;

    return {
      room: record.state,
      deleted: false,
      hostDisconnected: false
    };
  }

  getRoom(roomId: string) {
    return this.rooms.get(normalizeRoomId(roomId))?.state ?? null;
  }

  requestSync(roomId: string, currentTime?: number) {
    const record = this.rooms.get(normalizeRoomId(roomId));

    if (!record) {
      return null;
    }

    if (currentTime === undefined) {
      record.state = advanceRoomPlayback(record.state);
      return record.state;
    }

    const nextState = advanceRoomPlayback(record.state);

    record.state = {
      ...nextState,
      currentTime: clampPlaybackTime(currentTime),
      updatedAt: Date.now(),
      lastEventId: nextState.lastEventId + 1,
      participants: Array.from(record.participants.values())
    };

    return record.state;
  }

  addChatMessage(
    roomId: string,
    message: Omit<ChatMessage, "id" | "roomId" | "createdAt">
  ) {
    const record = this.rooms.get(normalizeRoomId(roomId));

    if (!record) {
      return null;
    }

    const nextState = advanceRoomPlayback(record.state);
    const nextMessage: ChatMessage = {
      id: crypto.randomUUID(),
      roomId: nextState.roomId,
      createdAt: Date.now(),
      ...message
    };

    record.state = {
      ...nextState,
      chatMessages: appendChatMessage(nextState.chatMessages, nextMessage),
      updatedAt: Date.now(),
      participants: Array.from(record.participants.values())
    };

    return {
      room: record.state,
      message: nextMessage
    };
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

    const nextState = advanceRoomPlayback(record.state);
    const safeCurrentTime = clampPlaybackTime(currentTime);
    const resolvedCurrentTime =
      action === "player_seek" ? safeCurrentTime : Math.max(safeCurrentTime, nextState.currentTime);
    const playbackState = resolvePlaybackState(record.state.playbackState, action);

    record.state = {
      ...nextState,
      playbackState,
      currentTime: resolvedCurrentTime,
      updatedAt: Date.now(),
      lastEventId: nextState.lastEventId + 1,
      participants: Array.from(record.participants.values()),
      transferState:
        nextState.transferState && action === "player_play"
          ? { ...nextState.transferState, phase: "streaming" }
          : nextState.transferState
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

    const nextState = advanceRoomPlayback(record.state);

    const shouldStartFromBeginning =
      (nextState.mediaSource.type === "local_file" || nextState.mediaSource.type === "torrent_magnet") &&
      nextState.participants.length > 1 &&
      transferState.phase === "ready" &&
      nextState.transferState?.phase !== "ready" &&
      nextState.currentTime <= 0.25;

    record.state = {
      ...nextState,
      playbackState: shouldStartFromBeginning ? "playing" : nextState.playbackState,
      currentTime: shouldStartFromBeginning ? 0 : nextState.currentTime,
      lastEventId: shouldStartFromBeginning ? nextState.lastEventId + 1 : nextState.lastEventId,
      transferState,
      updatedAt: Date.now(),
      participants: Array.from(record.participants.values())
    };

    return record.state;
  }

  updateSubtitleTrack(roomId: string, subtitleTrack: SubtitleTrack) {
    const record = this.rooms.get(normalizeRoomId(roomId));

    if (!record) {
      return null;
    }

    const nextState = advanceRoomPlayback(record.state);

    record.state = {
      ...nextState,
      subtitleTrack,
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

function advanceRoomPlayback(room: RoomState, now = Date.now()): RoomState {
  if (room.playbackState !== "playing") {
    return room;
  }

  const elapsedSeconds = Math.max(0, (now - room.updatedAt) / 1000);

  if (elapsedSeconds <= 0) {
    return room;
  }

  return {
    ...room,
    currentTime: clampPlaybackTime(room.currentTime + elapsedSeconds),
    updatedAt: now
  };
}

function appendChatMessage(messages: ChatMessage[], nextMessage: ChatMessage) {
  const nextMessages = [...messages, nextMessage];

  if (nextMessages.length <= MAX_CHAT_MESSAGES) {
    return nextMessages;
  }

  return nextMessages.slice(nextMessages.length - MAX_CHAT_MESSAGES);
}
