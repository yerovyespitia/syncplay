import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ClientEnvelope, ServerEvent } from "@syncplay/shared";

import { createSyncPlayServer } from "./index";

type TestSocket = {
  socket: WebSocket;
  send: (message: ClientEnvelope) => void;
  nextEvent: <TType extends ServerEvent["type"]>(type: TType, timeoutMs?: number) => Promise<Extract<ServerEvent, { type: TType }>>;
  clear: () => void;
};

describe("syncplay server chat", () => {
  let server: ReturnType<typeof createSyncPlayServer>;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    server = createSyncPlayServer(0);
  });

  afterEach(async () => {
    for (const socket of sockets) {
      socket.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    server.stop(true);
    sockets.length = 0;
  });

  test("rejects empty chat messages", async () => {
    const host = await openSocket(server.port, sockets);
    const created = await createRoom(host, "Alice");

    host.send({
      type: "send_chat_message",
      payload: {
        roomId: created.payload.room.roomId,
        text: "   "
      }
    });

    const errorEvent = await host.nextEvent("server_error");
    expect(errorEvent.payload.message).toBe("Message cannot be empty.");
  });

  test("emits a system message when a participant joins", async () => {
    const host = await openSocket(server.port, sockets);
    const guest = await openSocket(server.port, sockets);
    const created = await createRoom(host, "Alice");

    guest.send({
      type: "join_room",
      payload: {
        roomId: created.payload.room.roomId,
        displayName: "Bob"
      }
    });

    const hostMessage = await host.nextEvent("chat_message_received");
    const guestMessage = await guest.nextEvent("chat_message_received");

    expect(hostMessage.payload.message.kind).toBe("system");
    expect(hostMessage.payload.message.text).toBe("Bob joined the room.");
    expect(guestMessage.payload.message.text).toBe("Bob joined the room.");
  });

  test("emits a system message when a non-host participant leaves", async () => {
    const host = await openSocket(server.port, sockets);
    const guest = await openSocket(server.port, sockets);
    const created = await createRoom(host, "Alice");
    await joinRoom(guest, created.payload.room.roomId, "Bob");

    await host.nextEvent("chat_message_received");
    await guest.nextEvent("chat_message_received");

    guest.send({
      type: "leave_room",
      payload: {
        roomId: created.payload.room.roomId
      }
    });

    const hostMessage = await host.nextEvent("chat_message_received");
    expect(hostMessage.payload.message.text).toBe("Bob left the room.");
  });

  test("broadcasts chat messages only to the correct room", async () => {
    const hostA = await openSocket(server.port, sockets);
    const guestA = await openSocket(server.port, sockets);
    const hostB = await openSocket(server.port, sockets);
    const roomA = await createRoom(hostA, "Alice");
    const roomB = await createRoom(hostB, "Carol");

    await joinRoom(guestA, roomA.payload.room.roomId, "Bob");
    await hostA.nextEvent("chat_message_received");
    await guestA.nextEvent("chat_message_received");
    hostB.clear();

    hostA.send({
      type: "send_chat_message",
      payload: {
        roomId: roomA.payload.room.roomId,
        text: "Hello Bob"
      }
    });

    const guestMessage = await guestA.nextEvent("chat_message_received");
    expect(guestMessage.payload.message.kind).toBe("user");
    expect(guestMessage.payload.message.text).toBe("Hello Bob");

    await expectNoEvent(hostB, "chat_message_received", 150);
    expect(roomB.payload.room.roomId).not.toBe(roomA.payload.room.roomId);
  });

  test("rejects invalid torrent magnet rooms", async () => {
    const host = await openSocket(server.port, sockets);

    host.send({
      type: "create_room",
      payload: {
        mediaSource: {
          type: "torrent_magnet",
          magnetUri: "",
          infoHash: "",
          mediaId: "media-1",
          fileName: "",
          fileSize: 0,
          mimeType: "video/mp4"
        },
        displayName: "Alice"
      }
    });

    const errorEvent = await host.nextEvent("server_error");
    expect(errorEvent.payload.message).toBe("Missing torrent magnet metadata.");
  });
});

async function createRoom(socket: TestSocket, displayName: string) {
  socket.send({
    type: "create_room",
    payload: {
      mediaSource: {
        type: "youtube",
        videoId: "abc123"
      },
      displayName
    }
  });

  return socket.nextEvent("room_created");
}

async function joinRoom(socket: TestSocket, roomId: string, displayName: string) {
  socket.send({
    type: "join_room",
    payload: {
      roomId,
      displayName
    }
  });

  return socket.nextEvent("room_joined");
}

async function openSocket(port: number, sockets: WebSocket[]): Promise<TestSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(socket);
  const queue: ServerEvent[] = [];
  const waiters = new Map<ServerEvent["type"], Array<(event: ServerEvent) => void>>();

  socket.addEventListener("message", (message) => {
    const event = JSON.parse(String(message.data)) as ServerEvent;
    const listeners = waiters.get(event.type);

    if (listeners && listeners.length > 0) {
      const resolve = listeners.shift();
      resolve?.(event);
      return;
    }

    queue.push(event);
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });

  return {
    socket,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    clear() {
      queue.length = 0;
    },
    nextEvent(type, timeoutMs = 500) {
      const queuedIndex = queue.findIndex((event) => event.type === type);

      if (queuedIndex >= 0) {
        const [queued] = queue.splice(queuedIndex, 1);
        return Promise.resolve(queued as Extract<ServerEvent, { type: typeof type }>);
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const listeners = waiters.get(type);

          if (listeners) {
            waiters.set(
              type,
              listeners.filter((listener) => listener !== onEvent)
            );
          }

          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);

        const onEvent = (event: ServerEvent) => {
          clearTimeout(timeout);
          resolve(event as Extract<ServerEvent, { type: typeof type }>);
        };

        waiters.set(type, [...(waiters.get(type) ?? []), onEvent]);
      });
    }
  };
}

async function expectNoEvent(socket: TestSocket, type: ServerEvent["type"], timeoutMs: number) {
  try {
    await socket.nextEvent(type, timeoutMs);
    throw new Error(`Expected no ${type} event`);
  } catch (error) {
    expect((error as Error).message).toContain(`Timed out waiting for ${type}`);
  }
}
