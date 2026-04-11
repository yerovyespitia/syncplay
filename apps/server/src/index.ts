import type { ChatMessage, ClientEvent, Participant, ServerEnvelope, TransferState } from "@syncplay/shared";
import { normalizeRoomId } from "@syncplay/shared";

import {
  buildHostJoinMessage,
  buildJoinMessage,
  buildLeaveMessage,
  buildPlaybackActionMessage,
  buildResyncMessage,
  buildSubtitleAddedMessage,
  normalizeChatMessageText,
  resolveParticipantName
} from "./chat";
import { RoomManager } from "./room-manager";

type SocketData = {
  participantId: string;
  roomId?: string;
};

type SyncPlayServer = ReturnType<typeof Bun.serve<SocketData>>;

const clientEventTypes = new Set<ClientEvent["type"]>([
  "create_room",
  "join_room",
  "request_sync",
  "player_play",
  "player_pause",
  "player_seek",
  "leave_room",
  "send_chat_message",
  "peer_offer",
  "peer_answer",
  "peer_ice_candidate",
  "peer_transfer_state",
  "update_subtitle_track"
]);

function hasValidTorrentMediaSource(
  mediaSource: Extract<ClientEvent, { type: "create_room" }>["payload"]["mediaSource"]
) {
  if (mediaSource.type !== "torrent_magnet") {
    return true;
  }

  return Boolean(
    mediaSource.magnetUri &&
      mediaSource.infoHash &&
      mediaSource.mediaId &&
      mediaSource.fileName &&
      Number.isFinite(mediaSource.fileSize) &&
      mediaSource.fileSize > 0
  );
}

export function createSyncPlayServer(port = Number(process.env.PORT ?? 8787)) {
  const roomManager = new RoomManager();
  const roomMembers = new Map<string, Set<Bun.ServerWebSocket<SocketData>>>();

  const server = Bun.serve<SocketData>({
    port,
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

        const roomBeforeLeave = roomManager.getRoom(roomId);
        const leavingParticipant = roomBeforeLeave?.participants.find((participant) => participant.id === ws.data.participantId);
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

          if (leavingParticipant) {
            broadcastChatMessage(result.room.roomId, createSystemChatMessage(roomId, leavingParticipant, buildLeaveMessage(leavingParticipant)));
          }
        }
      }
    }
  });

  function handleEvent(ws: Bun.ServerWebSocket<SocketData>, event: ClientEvent) {
    switch (event.type) {
      case "create_room": {
        if (event.payload.mediaSource.type === "youtube" && !event.payload.mediaSource.videoId) {
          sendError(ws, "Missing YouTube video id.");
          return;
        }

        if (!hasValidTorrentMediaSource(event.payload.mediaSource)) {
          sendError(ws, "Missing torrent magnet metadata.");
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
        broadcastChatMessage(created.room.roomId, createSystemChatMessage(created.room.roomId, participant, buildHostJoinMessage(participant)));
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
        broadcastChatMessage(joined.room.roomId, createSystemChatMessage(joined.room.roomId, participant, buildJoinMessage(participant)));
        return;
      }

      case "request_sync": {
        const room = roomManager.requestSync(event.payload.roomId, event.payload.currentTime);

        if (!room) {
          sendError(ws, "Room not found.");
          return;
        }

        broadcast(room.roomId, {
          type: "sync_snapshot",
          payload: {
            room,
            actorId: ws.data.participantId
          }
        });

        const actor = room.participants.find((participant) => participant.id === ws.data.participantId);

        if (actor) {
          broadcastChatMessage(
            room.roomId,
            createSystemChatMessage(room.roomId, actor, buildResyncMessage(actor, room.currentTime))
          );
        }
        return;
      }

      case "leave_room": {
        const roomId = event.payload.roomId;
        const roomBeforeLeave = roomManager.getRoom(roomId);
        const leavingParticipant = roomBeforeLeave?.participants.find((participant) => participant.id === ws.data.participantId);
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

          if (leavingParticipant) {
            broadcastChatMessage(result.room.roomId, createSystemChatMessage(roomId, leavingParticipant, buildLeaveMessage(leavingParticipant)));
          }
        }

        return;
      }

      case "send_chat_message": {
        const text = normalizeChatMessageText(event.payload.text);

        if (!text) {
          sendError(ws, "Message cannot be empty.");
          return;
        }

        const room = roomManager.getRoom(event.payload.roomId);

        if (!room) {
          sendError(ws, "Room not found.");
          return;
        }

        const participant = room.participants.find((entry) => entry.id === ws.data.participantId);

        if (!participant) {
          sendError(ws, "Participant is not in the room.");
          return;
        }

        const added = roomManager.addChatMessage(event.payload.roomId, {
          kind: "user",
          senderParticipantId: participant.id,
          senderDisplayName: resolveParticipantName(participant),
          text
        });

        if (!added) {
          sendError(ws, "Room not found.");
          return;
        }

        broadcastChatMessage(added.room.roomId, added.message);
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

        const actor = applied.room.participants.find((p) => p.id === ws.data.participantId);
        if (actor && applied.room.participants.length > 1) {
          broadcastChatMessage(
            applied.room.roomId,
            createSystemChatMessage(applied.room.roomId, actor, buildPlaybackActionMessage(actor, event.type, applied.room.currentTime))
          );
        }
        return;
      }

      case "peer_offer":
      case "peer_answer":
      case "peer_ice_candidate": {
        const room = roomManager.getRoom(event.payload.roomId);

        if (!room || room.participants.length <= 1) {
          return;
        }

        const targetSocket = findRoomSocket(event.payload.roomId, event.payload.targetParticipantId);

        if (!targetSocket) {
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
          broadcast(room.roomId, {
            type: "sync_snapshot",
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

      case "update_subtitle_track": {
        const room = roomManager.updateSubtitleTrack(event.payload.roomId, event.payload.subtitleTrack);

        if (!room) {
          sendError(ws, "Room not found.");
          return;
        }

        broadcast(room.roomId, {
          type: "subtitle_track_updated",
          payload: { room }
        });

        const actor = room.participants.find((participant) => participant.id === ws.data.participantId);

        if (actor) {
          broadcastChatMessage(
            room.roomId,
            createSystemChatMessage(room.roomId, actor, buildSubtitleAddedMessage(actor, event.payload.subtitleTrack.fileName))
          );
        }
        return;
      }
    }
  }

  function createSystemChatMessage(roomId: string, participant: Participant, text: string) {
    const added = roomManager.addChatMessage(roomId, {
      kind: "system",
      senderParticipantId: participant.id,
      senderDisplayName: resolveParticipantName(participant),
      text
    });

    return added?.message ?? null;
  }

  function broadcastChatMessage(roomId: string, message: ChatMessage | null) {
    if (!message) {
      return;
    }

    broadcast(roomId, {
      type: "chat_message_received",
      payload: {
        message
      }
    });
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

  return server;
}

function buildParticipant(id: string, displayName?: string) {
  return {
    id,
    displayName: displayName?.trim() || undefined,
    connectedAt: Date.now()
  };
}

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

if (import.meta.main) {
  createSyncPlayServer();
}
