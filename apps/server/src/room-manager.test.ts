import { describe, expect, test } from "bun:test";

import { RoomManager } from "./room-manager";

const participantA = {
  id: "a",
  connectedAt: 1
};

const participantB = {
  id: "b",
  connectedAt: 2
};

describe("RoomManager", () => {
  test("creates and joins rooms", () => {
    const manager = new RoomManager();
    const created = manager.createRoom("abc123", participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined?.room.participants).toHaveLength(2);
    expect(joined?.room.roomId).toBe(created.room.roomId);
  });

  test("applies playback updates", () => {
    const manager = new RoomManager();
    const created = manager.createRoom("abc123", participantA);
    const result = manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_play", 42);

    expect(result?.room.playbackState).toBe("playing");
    expect(result?.room.currentTime).toBe(42);
    expect(result?.room.lastEventId).toBe(1);
  });

  test("deletes empty rooms when everybody leaves", () => {
    const manager = new RoomManager();
    const created = manager.createRoom("abc123", participantA);

    manager.leaveRoom(created.room.roomId, participantA.id);

    expect(manager.getRoom(created.room.roomId)).toBeNull();
  });
});
