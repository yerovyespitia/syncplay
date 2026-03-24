import { type PlaybackState, type Participant, type RoomState, createRoomId, normalizeRoomId } from "@syncplay/shared";

type RoomRecord = {
  state: RoomState;
  participants: Map<string, Participant>;
};

export class RoomManager {
  private readonly rooms = new Map<string, RoomRecord>();

  createRoom(videoId: string, participant: Participant) {
    let roomId = createRoomId();

    while (this.rooms.has(roomId)) {
      roomId = createRoomId();
    }

    const now = Date.now();
    const room: RoomState = {
      roomId,
      videoId,
      playbackState: "paused",
      currentTime: 0,
      updatedAt: now,
      lastEventId: 0,
      participants: [participant]
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
      return null;
    }

    record.participants.set(participant.id, participant);
    record.state.participants = Array.from(record.participants.values());
    record.state.updatedAt = Date.now();

    return {
      room: record.state
    };
  }

  leaveRoom(roomId: string, participantId: string) {
    const normalizedRoomId = normalizeRoomId(roomId);
    const record = this.rooms.get(normalizedRoomId);

    if (!record) {
      return null;
    }

    record.participants.delete(participantId);

    if (record.participants.size === 0) {
      this.rooms.delete(normalizedRoomId);
      return null;
    }

    record.state.participants = Array.from(record.participants.values());
    record.state.updatedAt = Date.now();

    return record.state;
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
      participants: Array.from(record.participants.values())
    };

    this.rooms.set(record.state.roomId, record);

    return {
      room: record.state,
      actorId,
      action
    };
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
