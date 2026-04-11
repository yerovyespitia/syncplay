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

const torrentSource: MediaSource = {
  type: "torrent_magnet",
  magnetUri: "magnet:?xt=urn:btih:abcdef1234567890",
  infoHash: "abcdef1234567890",
  mediaId: "media-2",
  fileName: "movie.mp4",
  fileSize: 1024,
  mimeType: "video/mp4"
};

describe("RoomManager", () => {
  test("creates and joins rooms", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(created.room.hostParticipantId).toBe(participantA.id);
    expect(created.room.chatMessages).toEqual([]);
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

  test("resyncs the room to the requesting participant time", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined.ok).toBeTrue();

    const result = manager.requestSync(created.room.roomId, 31.25);

    expect(result?.currentTime).toBe(31.25);
    expect(result?.lastEventId).toBe(2);
  });

  test("deletes empty rooms when everybody leaves", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);

    manager.leaveRoom(created.room.roomId, participantA.id);

    expect(manager.getRoom(created.room.roomId)).toBeNull();
  });

  test("deletes youtube rooms when the host leaves", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);
    manager.joinRoom(created.room.roomId, participantB);

    const left = manager.leaveRoom(created.room.roomId, participantA.id);

    expect(left?.deleted).toBeTrue();
    expect(left?.hostDisconnected).toBeTrue();
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

  test("resets local-file playback when the guest joins", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);

    manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_play", 42);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined.ok).toBeTrue();
    if (joined.ok) {
      expect(joined.room.playbackState).toBe("paused");
      expect(joined.room.currentTime).toBe(0);
      expect(joined.room.lastEventId).toBe(2);
      expect(joined.room.transferState?.phase).toBe("connecting_peer");
      expect(joined.room.transferState?.isPlaybackReady).toBeFalse();
    }
  });

  test("initializes transfer state for torrent magnet rooms", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(torrentSource, participantA);

    expect(created.room.transferState?.phase).toBe("waiting_host");
    expect(created.room.transferState?.bytesTotal).toBe(torrentSource.fileSize);
  });

  test("limits torrent magnet rooms to two participants", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(torrentSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined.ok).toBeTrue();

    const thirdJoin = manager.joinRoom(created.room.roomId, {
      id: "c",
      connectedAt: 3
    });

    expect(thirdJoin.ok).toBeFalse();
  });

  test("stores user chat messages in the room", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);
    const result = manager.addChatMessage(created.room.roomId, {
      kind: "user",
      senderParticipantId: participantA.id,
      senderDisplayName: "Alice",
      text: "Hello room"
    });

    expect(result).not.toBeNull();
    expect(result?.message.kind).toBe("user");
    expect(result?.room.chatMessages).toHaveLength(1);
    expect(result?.room.chatMessages[0]?.text).toBe("Hello room");
  });

  test("stores system chat messages in the room", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);
    const result = manager.addChatMessage(created.room.roomId, {
      kind: "system",
      senderParticipantId: participantA.id,
      senderDisplayName: "Alice",
      text: "Alice joined the room."
    });

    expect(result?.room.chatMessages[0]?.kind).toBe("system");
    expect(result?.room.chatMessages[0]?.senderDisplayName).toBe("Alice");
  });

  test("keeps only the latest 100 chat messages", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(youtubeSource, participantA);

    for (let index = 0; index < 105; index += 1) {
      manager.addChatMessage(created.room.roomId, {
        kind: "user",
        senderParticipantId: participantA.id,
        senderDisplayName: "Alice",
        text: `Message ${index}`
      });
    }

    const room = manager.getRoom(created.room.roomId);
    expect(room?.chatMessages).toHaveLength(100);
    expect(room?.chatMessages[0]?.text).toBe("Message 5");
    expect(room?.chatMessages.at(-1)?.text).toBe("Message 104");
  });

  test("preserves elapsed playback time when subtitles are updated mid-playback", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);
    const originalNow = Date.now;

    try {
      let now = 1_000;
      Date.now = () => now;

      manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_play", 4);
      now = 6_000;

      const room = manager.updateSubtitleTrack(created.room.roomId, {
        fileName: "The.Net.Spanish-WWW.MY-SUBS.CO.srt",
        label: "The Net Spanish",
        language: "es",
        format: "srt",
        content: "1\n00:00:01,000 --> 00:00:03,000\nHola",
        uploadedAt: now,
        uploadedByParticipantId: participantA.id
      });

      expect(room?.currentTime).toBe(9);
      expect(room?.updatedAt).toBe(now);
      expect(room?.playbackState).toBe("playing");
    } finally {
      Date.now = originalNow;
    }
  });

  test("preserves elapsed playback time when transfer state updates mid-playback", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);
    const originalNow = Date.now;

    try {
      let now = 10_000;
      Date.now = () => now;

      manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_play", 12);
      now = 13_500;

      const room = manager.updateTransferState(created.room.roomId, {
        phase: "streaming",
        bytesReceived: 512,
        bytesTotal: localFileSource.fileSize,
        bytesPersisted: 512,
        progress: 0.5,
        isPlaybackReady: true,
        availableRanges: [{ startByte: 0, endByte: 512 }]
      });

      expect(room?.currentTime).toBe(15.5);
      expect(room?.updatedAt).toBe(now);
      expect(room?.playbackState).toBe("playing");
    } finally {
      Date.now = originalNow;
    }
  });

  test("starts local-file playback from the beginning when the guest becomes ready", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined.ok).toBeTrue();
    if (!joined.ok) {
      return;
    }

    const room = manager.updateTransferState(created.room.roomId, {
      phase: "ready",
      bytesReceived: localFileSource.fileSize,
      bytesTotal: localFileSource.fileSize,
      bytesPersisted: localFileSource.fileSize,
      progress: 1,
      isPlaybackReady: true,
      availableRanges: [{ startByte: 0, endByte: localFileSource.fileSize }],
      message: "Ready to play"
    });

    expect(room?.playbackState).toBe("playing");
    expect(room?.currentTime).toBe(0);
    expect(room?.lastEventId).toBe(2);
    expect(room?.transferState?.phase).toBe("ready");
    expect(room?.transferState?.isPlaybackReady).toBeTrue();
  });

  test("does not reset local-file playback to the beginning when the guest becomes ready after a seek", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);

    expect(joined.ok).toBeTrue();
    if (!joined.ok) {
      return;
    }

    manager.updateTransferState(created.room.roomId, {
      phase: "streaming",
      bytesReceived: localFileSource.fileSize,
      bytesTotal: localFileSource.fileSize,
      bytesPersisted: localFileSource.fileSize,
      progress: 1,
      isPlaybackReady: true,
      availableRanges: [{ startByte: 0, endByte: localFileSource.fileSize }],
      message: "Playback resumed"
    });

    manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_play", 1.5);
    manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_seek", 11.5);

    const room = manager.updateTransferState(created.room.roomId, {
      phase: "ready",
      bytesReceived: localFileSource.fileSize,
      bytesTotal: localFileSource.fileSize,
      bytesPersisted: localFileSource.fileSize,
      progress: 1,
      isPlaybackReady: true,
      availableRanges: [{ startByte: 0, endByte: localFileSource.fileSize }],
      message: "Ready to play"
    });

    expect(room?.currentTime).toBe(11.5);
    expect(room?.playbackState).toBe("playing");
    expect(room?.transferState?.phase).toBe("ready");
    expect(room?.transferState?.isPlaybackReady).toBeTrue();
  });

  test("does not rewind playback when a lagging guest pauses after the room has advanced", () => {
    const manager = new RoomManager();
    const created = manager.createRoom(localFileSource, participantA);
    const joined = manager.joinRoom(created.room.roomId, participantB);
    const originalNow = Date.now;

    expect(joined.ok).toBeTrue();
    if (!joined.ok) {
      return;
    }

    try {
      let now = 10_000;
      Date.now = () => now;

      manager.updateTransferState(created.room.roomId, {
        phase: "ready",
        bytesReceived: localFileSource.fileSize,
        bytesTotal: localFileSource.fileSize,
        bytesPersisted: localFileSource.fileSize,
        progress: 1,
        isPlaybackReady: true,
        availableRanges: [{ startByte: 0, endByte: localFileSource.fileSize }],
        message: "Ready to play"
      });

      manager.applyPlaybackAction(created.room.roomId, participantA.id, "player_seek", 20);
      now = 22_500;

      const room = manager.applyPlaybackAction(created.room.roomId, participantB.id, "player_pause", 14);

      expect(room?.room.currentTime).toBe(32.5);
      expect(room?.room.playbackState).toBe("paused");
    } finally {
      Date.now = originalNow;
    }
  });
});
