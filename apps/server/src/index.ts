import type { ChatMessage, ClientEvent, HostedFileMediaSource, Participant, ServerEnvelope, TransferState } from "@syncplay/shared";
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
import {
  LocalMediaRelayManager,
  buildPlaybackPath,
  buildUploadPath,
  parseRangeHeader
} from "./local-media-relay";
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
  "update_subtitle_track",
  "start_relay_fallback"
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
  const relayManager = new LocalMediaRelayManager();

  const server = Bun.serve<SocketData>({
    port,
    async fetch(request, serverRef) {
      const { pathname } = new URL(request.url);

      if (pathname === "/health") {
        return Response.json({ ok: true });
      }

      if (pathname.startsWith("/api/local-media/")) {
        return handleRelayRequest(request);
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
          void relayManager.destroySessionsForRoom(result.room.roomId);
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
        } else {
          void relayManager.destroySessionsForRoom(result.room.roomId);
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
          void relayManager.destroySessionsForRoom(result.room.roomId);
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
        } else {
          void relayManager.destroySessionsForRoom(result.room.roomId);
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

      case "start_relay_fallback": {
        const room = roomManager.getRoom(event.payload.roomId);

        if (!room || room.mediaSource.type !== "local_file") {
          sendError(ws, "Room not found.");
          return;
        }

        void createRelaySessionForRoom(room.roomId, room.mediaSource, event.payload.reason)
          .then((nextRoom) => {
            broadcast(nextRoom.roomId, {
              type: "transfer_state_updated",
              payload: { room: nextRoom }
            });
            broadcast(nextRoom.roomId, {
              type: "relay_session_ready",
              payload: { room: nextRoom }
            });
          })
          .catch((error: unknown) => {
            const failedRoom =
              roomManager.patchTransferState(room.roomId, {
                transportMode: "p2p",
                transportReason: event.payload.reason,
                message: "Relay unavailable, retrying direct transfer"
              }) ?? room;
            broadcast(failedRoom.roomId, {
              type: "transfer_state_updated",
              payload: { room: failedRoom }
            });
            broadcast(failedRoom.roomId, {
              type: "relay_session_failed",
              payload: {
                room: failedRoom,
                message: error instanceof Error ? error.message : "Relay session could not be created."
              }
            });
          });
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

  async function handleRelayRequest(request: Request) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments[2] === "sessions" && segments.length === 3 && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { roomId?: string } | null;
      const room = body?.roomId ? roomManager.getRoom(body.roomId) : null;

      if (!room || room.mediaSource.type !== "local_file") {
        return Response.json({ message: "Room not found." }, { status: 404 });
      }

      const relaySession = await relayManager.createOrReuseSession(room.roomId, room.mediaSource);
      return Response.json(buildRelaySessionPayload(relaySession));
    }

    if (segments[2] !== "sessions" || !segments[3]) {
      return new Response("Not found", { status: 404 });
    }

    const sessionId = decodeURIComponent(segments[3]);
    const session = relayManager.getSession(sessionId);

    if (!session) {
      return Response.json({ message: "Relay session not found." }, { status: 404 });
    }

    if (segments.length === 4 && request.method === "DELETE") {
      await relayManager.destroySession(sessionId);
      return new Response(null, { status: 204 });
    }

    if (segments.length === 5 && segments[4] === "status" && request.method === "GET") {
      return Response.json(buildRelayStatusPayload(session));
    }

    if (segments.length === 5 && segments[4] === "ranges" && request.method === "PUT") {
      const startByte = Number(request.headers.get("x-start-byte"));
      const endByte = Number(request.headers.get("x-end-byte"));

      if (!Number.isFinite(startByte) || !Number.isFinite(endByte)) {
        return Response.json({ message: "Invalid relay byte range headers." }, { status: 400 });
      }

      const bytes = new Uint8Array(await request.arrayBuffer());
      const updatedSession = await relayManager.writeRange(sessionId, startByte, endByte, bytes);
      return Response.json(buildRelayStatusPayload(updatedSession));
    }

    if (segments.length >= 5 && (request.method === "GET" || request.method === "HEAD")) {
      const parsedRange =
        request.headers.get("range") === null
          ? {
              startByte: 0,
              endByte: session.fileSize
            }
          : parseRangeHeader(request.headers.get("range"), session.fileSize);

      if (!parsedRange) {
        return new Response("Invalid byte range.", {
          status: 416,
          headers: {
            "Content-Range": `bytes */${session.fileSize}`
          }
        });
      }

      relayManager.noteRequestedRange(sessionId, parsedRange.startByte, parsedRange.endByte);
      const contentLength = parsedRange.endByte - parsedRange.startByte;
      const hasRangeRequest = request.headers.get("range") !== null;
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": String(contentLength),
        "Content-Type": session.mimeType
      });

      if (hasRangeRequest) {
        headers.set("Content-Range", `bytes ${parsedRange.startByte}-${parsedRange.endByte - 1}/${session.fileSize}`);
      }

      if (request.method === "HEAD") {
        return new Response(null, {
          status: hasRangeRequest ? 206 : 200,
          headers
        });
      }

      try {
        const bytes = await relayManager.readRange(sessionId, parsedRange.startByte, parsedRange.endByte);
        return new Response(bytes, {
          status: hasRangeRequest ? 206 : 200,
          headers
        });
      } catch (error) {
        return Response.json(
          { message: error instanceof Error ? error.message : "Requested media file is not available yet." },
          { status: 503 }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async function createRelaySessionForRoom(
    roomId: string,
    mediaSource: HostedFileMediaSource,
    reason: Extract<ClientEvent, { type: "start_relay_fallback" }>["payload"]["reason"]
  ) {
    const relaySession = await relayManager.createOrReuseSession(roomId, mediaSource);
    const nextRoom = roomManager.patchTransferState(roomId, {
      transportMode: "relay_http",
      transportReason: reason,
      relaySessionId: relaySession.sessionId,
      relayPlaybackUrl: buildPlaybackPath(relaySession.sessionId, relaySession.fileName),
      message: "Switching to optimized relay"
    });

    if (!nextRoom) {
      throw new Error("Room not found.");
    }

    return nextRoom;
  }

  function buildRelaySessionPayload(session: ReturnType<LocalMediaRelayManager["getSession"]> extends infer T ? NonNullable<T> : never) {
    return {
      sessionId: session.sessionId,
      roomId: session.roomId,
      mediaId: session.mediaId,
      uploadUrl: buildUploadPath(session.sessionId),
      playbackUrl: buildPlaybackPath(session.sessionId, session.fileName),
      expiresAt: session.expiresAt
    };
  }

  function buildRelayStatusPayload(session: ReturnType<LocalMediaRelayManager["getSession"]> extends infer T ? NonNullable<T> : never) {
    return {
      sessionId: session.sessionId,
      availableRanges: session.availableRanges,
      contiguousBytes: session.contiguousBytes,
      uploadedBytes: session.uploadedBytes,
      largestRequestedEndByte: session.largestRequestedEndByte,
      expiresAt: session.expiresAt
    };
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
