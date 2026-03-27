import type { ClientEvent, ServerEnvelope, TransferState } from "@syncplay/shared";
import { normalizeRoomId } from "@syncplay/shared";

import { RoomManager } from "./room-manager";

type SocketData = {
  participantId: string;
  roomId?: string;
};

const serverPort = Number(process.env.PORT ?? 8787);
const roomManager = new RoomManager();
const roomMembers = new Map<string, Set<Bun.ServerWebSocket<SocketData>>>();

const server = Bun.serve<SocketData>({
  port: serverPort,
  fetch(request, serverRef) {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (pathname === "/ws") {
      const participantId = crypto.randomUUID();
      const upgraded = serverRef.upgrade(request, {
        data: {
          participantId
        }
      });

      if (upgraded) {
        return undefined;
      }

      return new Response("Upgrade failed", { status: 400 });
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(ws, message) {
      const parsed = safeParseMessage(message);

      if (!parsed) {
        sendError(ws, "Invalid message payload.");
        return;
      }

      handleEvent(ws, parsed);
    },
    close(ws) {
      const roomId = ws.data.roomId;

      if (!roomId) {
        return;
      }

      removeSocketFromRoom(roomId, ws);
      const result = roomManager.leaveRoom(roomId, ws.data.participantId);

      if (!result) {
        return;
      }

      if (result.hostDisconnected) {
        broadcast(result.room.roomId, {
          type: "host_disconnected",
          payload: {
            roomId: result.room.roomId,
            message: "The host left the room."
          }
        });
        roomMembers.delete(normalizeRoomId(result.room.roomId));
        return;
      }

      if (!result.deleted) {
        broadcast(result.room.roomId, {
          type: "presence_updated",
          payload: { room: result.room }
        });
      }
    }
  }
});

console.log(`SyncPlay server running on http://127.0.0.1:${server.port}`);

function handleEvent(ws: Bun.ServerWebSocket<SocketData>, event: ClientEvent) {
  switch (event.type) {
    case "create_room": {
      if (event.payload.mediaSource.type === "youtube" && !event.payload.mediaSource.videoId) {
        sendError(ws, "Missing YouTube video id.");
        return;
      }

      const participant = buildParticipant(ws.data.participantId, event.payload.displayName);
      const created = roomManager.createRoom(event.payload.mediaSource, participant);
      ws.data.roomId = created.room.roomId;
      addSocketToRoom(created.room.roomId, ws);
      send(ws, {
        type: "room_created",
        payload: {
          selfId: ws.data.participantId,
          room: created.room
        }
      });
      broadcast(created.room.roomId, {
        type: "presence_updated",
        payload: {
          room: created.room
        }
      });
      return;
    }

    case "join_room": {
      const roomId = normalizeRoomId(event.payload.roomId);
      const participant = buildParticipant(ws.data.participantId, event.payload.displayName);
      const joined = roomManager.joinRoom(roomId, participant);

      if (!joined.ok) {
        sendError(ws, joined.reason);
        return;
      }

      ws.data.roomId = joined.room.roomId;
      addSocketToRoom(joined.room.roomId, ws);
      send(ws, {
        type: "room_joined",
        payload: {
          selfId: ws.data.participantId,
          room: joined.room
        }
      });
      broadcast(joined.room.roomId, {
        type: "presence_updated",
        payload: {
          room: joined.room
        }
      });
      broadcast(joined.room.roomId, {
        type: "sync_snapshot",
        payload: {
          room: joined.room,
          actorId: ws.data.participantId
        }
      });
      return;
    }

    case "request_sync": {
      const room = roomManager.getRoom(event.payload.roomId);

      if (!room) {
        sendError(ws, "Room not found.");
        return;
      }

      send(ws, {
        type: "sync_snapshot",
        payload: {
          room
        }
      });
      return;
    }

    case "leave_room": {
      const roomId = event.payload.roomId;
      removeSocketFromRoom(roomId, ws);
      const result = roomManager.leaveRoom(roomId, ws.data.participantId);
      ws.data.roomId = undefined;

      if (!result) {
        return;
      }

      if (result.hostDisconnected) {
        broadcast(result.room.roomId, {
          type: "host_disconnected",
          payload: {
            roomId: result.room.roomId,
            message: "The host left the room."
          }
        });
        roomMembers.delete(normalizeRoomId(result.room.roomId));
        return;
      }

      if (!result.deleted) {
        broadcast(result.room.roomId, {
          type: "presence_updated",
          payload: { room: result.room }
        });
      }

      return;
    }

    case "player_play":
    case "player_pause":
    case "player_seek": {
      const applied = roomManager.applyPlaybackAction(
        event.payload.roomId,
        ws.data.participantId,
        event.type,
        event.payload.currentTime
      );

      if (!applied) {
        sendError(ws, "Room not found.");
        return;
      }

      broadcast(applied.room.roomId, {
        type: "player_state_changed",
        payload: applied
      });
      return;
    }

    case "peer_offer":
    case "peer_answer":
    case "peer_ice_candidate": {
      const targetSocket = findRoomSocket(event.payload.roomId, event.payload.targetParticipantId);

      if (!targetSocket) {
        sendError(ws, "Target participant is not available.");
        return;
      }

      send(targetSocket, {
        type: event.type,
        payload: {
          roomId: event.payload.roomId,
          sourceParticipantId: ws.data.participantId,
          ...(event.type === "peer_ice_candidate"
            ? { candidate: event.payload.candidate }
            : { sdp: event.payload.sdp })
        }
      } as ServerEnvelope);
      return;
    }

    case "peer_transfer_state": {
      const transferState = event.payload.transferState as TransferState;
      const room = roomManager.updateTransferState(event.payload.roomId, transferState);

      if (!room) {
        sendError(ws, "Room not found.");
        return;
      }

      broadcast(room.roomId, {
        type: "transfer_state_updated",
        payload: { room }
      });

      if (transferState.phase === "ready") {
        broadcast(room.roomId, {
          type: "local_file_ready",
          payload: { room }
        });
      }

      if (transferState.phase === "buffering") {
        broadcast(room.roomId, {
          type: "local_file_buffering",
          payload: { room }
        });
      }

      return;
    }
  }
}

function buildParticipant(id: string, displayName?: string) {
  return {
    id,
    displayName: displayName?.trim() || undefined,
    connectedAt: Date.now()
  };
}

function send(ws: Bun.ServerWebSocket<SocketData>, event: ServerEnvelope) {
  ws.send(JSON.stringify(event));
}

function sendError(ws: Bun.ServerWebSocket<SocketData>, message: string) {
  send(ws, {
    type: "server_error",
    payload: {
      message
    }
  });
}

function broadcast(roomId: string, event: ServerEnvelope) {
  const members = roomMembers.get(normalizeRoomId(roomId));

  if (!members) {
    return;
  }

  const payload = JSON.stringify(event);

  for (const member of members) {
    member.send(payload);
  }
}

function addSocketToRoom(roomId: string, ws: Bun.ServerWebSocket<SocketData>) {
  const normalizedRoomId = normalizeRoomId(roomId);
  let members = roomMembers.get(normalizedRoomId);

  if (!members) {
    members = new Set();
    roomMembers.set(normalizedRoomId, members);
  }

  members.add(ws);
}

function removeSocketFromRoom(roomId: string, ws: Bun.ServerWebSocket<SocketData>) {
  const normalizedRoomId = normalizeRoomId(roomId);
  const members = roomMembers.get(normalizedRoomId);

  if (!members) {
    return;
  }

  members.delete(ws);

  if (members.size === 0) {
    roomMembers.delete(normalizedRoomId);
  }
}

function findRoomSocket(roomId: string, participantId: string) {
  const members = roomMembers.get(normalizeRoomId(roomId));

  if (!members) {
    return null;
  }

  for (const member of members) {
    if (member.data.participantId === participantId) {
      return member;
    }
  }

  return null;
}

const clientEventTypes = new Set<ClientEvent["type"]>([
  "create_room",
  "join_room",
  "request_sync",
  "player_play",
  "player_pause",
  "player_seek",
  "leave_room",
  "peer_offer",
  "peer_answer",
  "peer_ice_candidate",
  "peer_transfer_state"
]);

function safeParseMessage(message: string | Buffer): ClientEvent | null {
  try {
    const decoded = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
    const parsed = JSON.parse(decoded) as { type?: unknown };

    if (!parsed || typeof parsed !== "object" || !clientEventTypes.has(parsed.type as ClientEvent["type"])) {
      return null;
    }

    return parsed as ClientEvent;
  } catch {
    return null;
  }
}
