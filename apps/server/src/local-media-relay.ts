import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ByteRange, HostedFileMediaSource } from "@syncplay/shared";

const RELAY_ROOT_PREFIX = "syncplay-local-relay-";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const RANGE_WAIT_TIMEOUT_MS = 30_000;

type RelayWaiter = {
  startByte: number;
  endByte: number;
  resolve: (availableEndByte: number) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface LocalMediaRelaySession {
  sessionId: string;
  roomId: string;
  mediaId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  filePath: string;
  expiresAt: number;
  availableRanges: ByteRange[];
  uploadedBytes: number;
  contiguousBytes: number;
  largestRequestedEndByte: number;
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

function getContiguousAvailableEnd(ranges: ByteRange[], startByte: number, requestedEndByte: number) {
  for (const range of ranges) {
    if (startByte < range.startByte) {
      return startByte;
    }

    if (startByte >= range.startByte && startByte < range.endByte) {
      return Math.min(range.endByte, requestedEndByte);
    }
  }

  return startByte;
}

type RelayRecord = LocalMediaRelaySession & {
  tempDir: string;
  waiters: RelayWaiter[];
};

export class LocalMediaRelayManager {
  private readonly sessions = new Map<string, RelayRecord>();
  private readonly sessionIdsByRoomMedia = new Map<string, string>();

  async createOrReuseSession(roomId: string, mediaSource: HostedFileMediaSource) {
    this.cleanupExpiredSessions();

    const key = this.buildRoomMediaKey(roomId, mediaSource.mediaId);
    const existingSessionId = this.sessionIdsByRoomMedia.get(key);

    if (existingSessionId) {
      const existing = this.sessions.get(existingSessionId);

      if (existing) {
        existing.expiresAt = Date.now() + SESSION_TTL_MS;
        return this.toPublicSession(existing);
      }
    }

    const sessionId = crypto.randomUUID();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), RELAY_ROOT_PREFIX));
    const filePath = path.join(tempDir, `${sessionId}.bin`);
    const fileHandle = await open(filePath, "w");
    await fileHandle.truncate(mediaSource.fileSize);
    await fileHandle.close();

    const record: RelayRecord = {
      sessionId,
      roomId,
      mediaId: mediaSource.mediaId,
      fileName: mediaSource.fileName,
      fileSize: mediaSource.fileSize,
      mimeType: mediaSource.mimeType,
      filePath,
      expiresAt: Date.now() + SESSION_TTL_MS,
      availableRanges: [],
      uploadedBytes: 0,
      contiguousBytes: 0,
      largestRequestedEndByte: 0,
      waiters: [],
      tempDir
    };

    this.sessions.set(sessionId, record);
    this.sessionIdsByRoomMedia.set(key, sessionId);
    return this.toPublicSession(record);
  }

  getSession(sessionId: string) {
    this.cleanupExpiredSessions();
    const session = this.sessions.get(sessionId);
    return session ? this.toPublicSession(session) : null;
  }

  noteRequestedRange(sessionId: string, startByte: number, endByte: number) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return null;
    }

    session.largestRequestedEndByte = Math.max(session.largestRequestedEndByte, startByte, endByte);
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return this.toPublicSession(session);
  }

  async writeRange(sessionId: string, startByte: number, endByte: number, bytes: Uint8Array) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error("Relay session not found.");
    }

    if (startByte < 0 || endByte <= startByte || endByte > session.fileSize) {
      throw new Error("Invalid relay byte range.");
    }

    if (bytes.byteLength !== endByte - startByte) {
      throw new Error("Relay upload byte length does not match requested range.");
    }

    const fileHandle = await open(session.filePath, "r+");

    try {
      await fileHandle.write(bytes, 0, bytes.byteLength, startByte);
    } finally {
      await fileHandle.close();
    }

    session.availableRanges = mergeRanges(session.availableRanges, { startByte, endByte });
    session.contiguousBytes = getContiguousEnd(session.availableRanges);
    session.uploadedBytes = session.availableRanges.reduce(
      (total, range) => total + Math.max(0, range.endByte - range.startByte),
      0
    );
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    this.resolveWaiters(session);
    return this.toPublicSession(session);
  }

  async readRange(sessionId: string, startByte: number, endByte: number) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error("Relay session not found.");
    }

    const availableEndByte = getContiguousAvailableEnd(session.availableRanges, startByte, endByte);

    if (availableEndByte <= startByte) {
      await this.waitForRange(session, startByte, endByte);
    }

    const finalAvailableEndByte = getContiguousAvailableEnd(session.availableRanges, startByte, endByte);

    if (finalAvailableEndByte <= startByte) {
      throw new Error("Requested relay media range is not available.");
    }

    const fileHandle = await open(session.filePath, "r");
    const byteLength = finalAvailableEndByte - startByte;
    const buffer = Buffer.alloc(byteLength);

    try {
      const { bytesRead } = await fileHandle.read(buffer, 0, byteLength, startByte);
      return buffer.subarray(0, bytesRead);
    } finally {
      await fileHandle.close();
    }
  }

  async destroySession(sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return false;
    }

    this.sessions.delete(sessionId);
    this.sessionIdsByRoomMedia.delete(this.buildRoomMediaKey(session.roomId, session.mediaId));

    for (const waiter of session.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Relay session removed."));
    }

    await rm(session.tempDir, { recursive: true, force: true });
    return true;
  }

  async destroySessionsForRoom(roomId: string) {
    const matchingSessionIds = Array.from(this.sessions.values())
      .filter((session) => session.roomId === roomId)
      .map((session) => session.sessionId);

    await Promise.all(matchingSessionIds.map((sessionId) => this.destroySession(sessionId)));
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessionIds = Array.from(this.sessions.values())
      .filter((session) => session.expiresAt <= now)
      .map((session) => session.sessionId);

    for (const sessionId of expiredSessionIds) {
      void this.destroySession(sessionId);
    }
  }

  private waitForRange(session: RelayRecord, startByte: number, endByte: number) {
    const availableEndByte = getContiguousAvailableEnd(session.availableRanges, startByte, endByte);

    if (availableEndByte > startByte) {
      return Promise.resolve(availableEndByte);
    }

    return new Promise<number>((resolve, reject) => {
      const waiter: RelayWaiter = {
        startByte,
        endByte,
        resolve,
        reject,
        timeout: setTimeout(() => {
          session.waiters = session.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error("Timed out waiting for relay bytes."));
        }, RANGE_WAIT_TIMEOUT_MS)
      };

      session.waiters.push(waiter);
    });
  }

  private resolveWaiters(session: RelayRecord) {
    const pendingWaiters: RelayWaiter[] = [];

    for (const waiter of session.waiters) {
      const availableEndByte = getContiguousAvailableEnd(session.availableRanges, waiter.startByte, waiter.endByte);

      if (availableEndByte > waiter.startByte) {
        clearTimeout(waiter.timeout);
        waiter.resolve(availableEndByte);
        continue;
      }

      pendingWaiters.push(waiter);
    }

    session.waiters = pendingWaiters;
  }

  private toPublicSession(session: RelayRecord): LocalMediaRelaySession {
    return {
      sessionId: session.sessionId,
      roomId: session.roomId,
      mediaId: session.mediaId,
      fileName: session.fileName,
      fileSize: session.fileSize,
      mimeType: session.mimeType,
      filePath: session.filePath,
      expiresAt: session.expiresAt,
      availableRanges: [...session.availableRanges],
      uploadedBytes: session.uploadedBytes,
      contiguousBytes: session.contiguousBytes,
      largestRequestedEndByte: session.largestRequestedEndByte
    };
  }

  private buildRoomMediaKey(roomId: string, mediaId: string) {
    return `${roomId}:${mediaId}`;
  }
}

export function parseRangeHeader(rangeHeader: string | null, fileSize: number) {
  if (!rangeHeader) {
    return null;
  }

  const match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    return null;
  }

  const startByte = Number(match[1]);
  const inclusiveEndByte = match[2] ? Number(match[2]) : fileSize - 1;

  if (!Number.isFinite(startByte) || !Number.isFinite(inclusiveEndByte) || startByte < 0 || startByte >= fileSize) {
    return null;
  }

  const endByte = Math.min(fileSize, inclusiveEndByte + 1);

  if (endByte <= startByte) {
    return null;
  }

  return { startByte, endByte };
}

export function buildPlaybackPath(sessionId: string, fileName: string) {
  return `/api/local-media/sessions/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}`;
}

export function buildUploadPath(sessionId: string) {
  return `/api/local-media/sessions/${encodeURIComponent(sessionId)}/ranges`;
}
