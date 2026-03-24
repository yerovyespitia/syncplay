import { describe, expect, test } from "bun:test";

import type { MediaSource } from "@syncplay/shared";

import { RoomManager } from "./room-manager";

const participantA = {
  id: "a",
  connectedAt: 1
};

const participantB = {
  id: "b",
  connectedAt: 2
};

const youtubeSource: MediaSource = {
  type: "youtube",
  videoId: "abc123"
};

const localFileSource: MediaSource = {
  type: "local_file",
  mediaId: "media-1",
  fileName: "movie.mp4",
  fileSize: 1024,
  mimeType: "video/mp4"
};

describe("RoomManager", () => {
  test("creates and joins rooms", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined.ok).toBeTrue();
    if (joined.ok) {
      expect(joined.room.participants).toHaveLength(2);
      expect(joined.room.roomId).toBe(created.room.roomId);
    }
  });

  test("applies playback updates", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);
    const result = manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_play", 42);

    expect(result?.room.playbackState).toBe("playing");
    expect(result?.room.currentTime).toBe(42);
    expect(result?.room.lastEventId).toBe(1);
  });

  test("deletes empty rooms when everybody leaves", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);

    manager.leaveRoom(created.room.roomId, participantA.id);

    expect(manager.getRoom(created.room.roomId)).toBeNull();
  });

  test("limits local file rooms to two participants", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined.ok).toBeTrue();

    const thirdJoin = manager.joinRoom(created.room.roomId, {
      id: "c",
      connectedAt: 3
    });

    expect(thirdJoin.ok).toBeFalse();
  });
});
