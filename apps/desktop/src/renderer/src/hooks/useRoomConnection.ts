import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ClientEnvelope,
  MediaSource,
  Participant,
  RoomState,
  ServerEvent,
  SubtitleTrack,
  TransferState
} from "@syncplay/shared";
import { normalizeRoomId } from "@syncplay/shared";

import { getWebSocketUrl } from "../lib/config";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface DebugEntry {
  id: string;
  scope: "socket" | "server" | "client" | "youtube" | "local";
  message: string;
  timestamp: number;
  details?: string;
}

type RemotePlaybackCommand =
  | {
      kind: "sync";
      room: RoomState;
      actorId?: string;
      receivedAt: number;
    }
  | {
      kind: "event";
      room: RoomState;
      actorId: string;
      action: "player_play" | "player_pause" | "player_seek";
      receivedAt: number;
    };

type PeerSignal =
  | {
      type: "peer_offer";
      roomId: string;
      sourceParticipantId: string;
      sdp: RTCSessionDescriptionInit;
      receivedAt: number;
    }
  | {
      type: "peer_answer";
      roomId: string;
      sourceParticipantId: string;
      sdp: RTCSessionDescriptionInit;
      receivedAt: number;
    }
  | {
      type: "peer_ice_candidate";
      roomId: string;
      sourceParticipantId: string;
      candidate: RTCIceCandidateInit;
      receivedAt: number;
    };

function buildGuestName() {
  const savedName = localStorage.getItem("syncplay:display-name");

  if (savedName) {
    return savedName;
  }

  const name = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
  localStorage.setItem("syncplay:display-name", name);
  return name;
}

export function useRoomConnection() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [remoteCommand, setRemoteCommand] = useState<RemotePlaybackCommand | null>(null);
  const [peerSignal, setPeerSignal] = useState<PeerSignal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [lastActionLabel, setLastActionLabel] = useState("Ready");
  const [displayName, setDisplayNameState] = useState(buildGuestName);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingMessagesRef = useRef<ClientEnvelope[]>([]);
  const displayNameRef = useRef(displayName);
  const roomRef = useRef<RoomState | null>(null);
  const pendingLeaveRoomIdRef = useRef<string | null>(null);

  const pushDebugEntry = useCallback((entry: Omit<DebugEntry, "id" | "timestamp">) => {
    const nextEntry: DebugEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...entry
    };

    setDebugEntries((current) => [nextEntry, ...current].slice(0, 40));
  }, []);

  const setDisplayName = useCallback((value: string) => {
    const trimmedValue = value.slice(0, 32);
    setDisplayNameState(trimmedValue);
    displayNameRef.current = trimmedValue;
    localStorage.setItem("syncplay:display-name", trimmedValue);
  }, []);

  const handleServerEvent = useCallback((event: ServerEvent) => {
    pushDebugEntry({
      scope: "server",
      message: event.type,
      details: JSON.stringify(event.payload)
    });

    switch (event.type) {
      case "room_created":
      case "room_joined":
        roomRef.current = event.payload.room;
        pendingLeaveRoomIdRef.current = null;
        setSelfId(event.payload.selfId);
        setRoom(event.payload.room);
        setLastActionLabel(`Joined room ${event.payload.room.roomId}`);
        return;
      case "presence_updated":
        roomRef.current = event.payload.room;
        setRoom(event.payload.room);
        setError(null);
        setLastActionLabel(`${event.payload.room.participants.length} participant(s) connected`);
        return;
      case "chat_message_received":
        setRoom((current) => {
          if (!current || current.roomId !== event.payload.message.roomId) {
            return current;
          }

          if (current.chatMessages.some((message) => message.id === event.payload.message.id)) {
            return current;
          }

          const nextRoom = {
            ...current,
            chatMessages: [...current.chatMessages, event.payload.message]
          };

          roomRef.current = nextRoom;
          return nextRoom;
        });
        setLastActionLabel(`New chat message from ${event.payload.message.senderDisplayName ?? "room"}`);
        return;
      case "transfer_state_updated":
      case "local_file_ready":
      case "local_file_buffering":
      case "subtitle_track_updated":
        roomRef.current = event.payload.room;
        setRoom(event.payload.room);
        return;
      case "sync_snapshot":
        roomRef.current = event.payload.room;
        setRoom(event.payload.room);
        setRemoteCommand({
          kind: "sync",
          room: event.payload.room,
          actorId: event.payload.actorId,
          receivedAt: Date.now()
        });
        setLastActionLabel("Synced with room state");
        return;
      case "player_state_changed":
        roomRef.current = event.payload.room;
        setRoom(event.payload.room);
        setRemoteCommand({
          kind: "event",
          room: event.payload.room,
          actorId: event.payload.actorId,
          action: event.payload.action,
          receivedAt: Date.now()
        });
        setLastActionLabel(`${event.payload.action.replace("player_", "")} @ ${event.payload.room.currentTime.toFixed(1)}s`);
        return;
      case "peer_offer":
        setPeerSignal({
          type: "peer_offer",
          ...event.payload,
          receivedAt: Date.now()
        });
        return;
      case "peer_answer":
        setPeerSignal({
          type: "peer_answer",
          ...event.payload,
          receivedAt: Date.now()
        });
        return;
      case "peer_ice_candidate":
        setPeerSignal({
          type: "peer_ice_candidate",
          ...event.payload,
          receivedAt: Date.now()
        });
        return;
      case "host_disconnected":
        roomRef.current = null;
        pendingLeaveRoomIdRef.current = event.payload.roomId;
        setError(event.payload.message);
        setRoom(null);
        setPeerSignal(null);
        return;
      case "server_error": {
        if (event.payload.message === "Room not found." && !roomRef.current && pendingLeaveRoomIdRef.current) {
          return;
        }

        setError(event.payload.message);
        return;
      }
    }
  }, [pushDebugEntry]);

  const connect = useCallback(() => {
    const existing = socketRef.current;

    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return existing;
    }

    setConnectionStatus("connecting");
    pushDebugEntry({
      scope: "socket",
      message: "connecting",
      details: getWebSocketUrl()
    });
    const socket = new WebSocket(getWebSocketUrl());

    socket.addEventListener("open", () => {
      setConnectionStatus("connected");
      setError(null);
      pushDebugEntry({
        scope: "socket",
        message: "open"
      });

      for (const message of pendingMessagesRef.current) {
        socket.send(JSON.stringify(message));
      }

      pendingMessagesRef.current = [];
    });

    socket.addEventListener("close", () => {
      setConnectionStatus("disconnected");
      pushDebugEntry({
        scope: "socket",
        message: "close"
      });
    });

    socket.addEventListener("error", () => {
      pushDebugEntry({
        scope: "socket",
        message: "error"
      });
    });

    socket.addEventListener("message", (event) => {
      handleServerEvent(JSON.parse(event.data) as ServerEvent);
    });

    socketRef.current = socket;
    return socket;
  }, [handleServerEvent, pushDebugEntry]);

  useEffect(() => {
    const socket = connect();

    return () => {
      socket.close();
    };
  }, [connect]);

  const send = useCallback(
    (message: ClientEnvelope) => {
      const socket = connect();
      pushDebugEntry({
        scope: "client",
        message: message.type,
        details: JSON.stringify(message.payload)
      });

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        return;
      }

      pendingMessagesRef.current.push(message);
    },
    [connect, pushDebugEntry]
  );

  const createRoom = useCallback(
    (mediaSource: MediaSource) => {
      send({
        type: "create_room",
        payload: {
          mediaSource,
          displayName: displayNameRef.current
        }
      });
    },
    [send]
  );

  const joinRoom = useCallback(
    (roomId: string) => {
      setError(null);
      send({
        type: "join_room",
        payload: {
          roomId: normalizeRoomId(roomId),
          displayName: displayNameRef.current
        }
      });
    },
    [send]
  );

  const leaveRoom = useCallback(() => {
    const currentRoom = roomRef.current;

    if (!currentRoom) {
      return;
    }

    pendingLeaveRoomIdRef.current = currentRoom.roomId;
    roomRef.current = null;
    setError(null);
    send({
      type: "leave_room",
      payload: {
        roomId: currentRoom.roomId
      }
    });
    setRoom(null);
    setPeerSignal(null);
    setRemoteCommand(null);
  }, [send]);

  const requestSync = useCallback((currentTime?: number) => {
    const currentRoom = roomRef.current;

    if (!currentRoom) {
      return;
    }

    send({
      type: "request_sync",
      payload: {
        roomId: currentRoom.roomId,
        currentTime
      }
    });
  }, [send]);

  const sendChatMessage = useCallback(
    (text: string) => {
      const currentRoom = roomRef.current;

      if (!currentRoom) {
        return;
      }

      send({
        type: "send_chat_message",
        payload: {
          roomId: currentRoom.roomId,
          text
        }
      });
    },
    [send]
  );

  const sendPlaybackAction = useCallback(
    (type: "player_play" | "player_pause" | "player_seek", currentTime: number) => {
      const activeRoom = roomRef.current;

      if (!activeRoom) {
        return;
      }

      send({
        type,
        payload: {
          roomId: activeRoom.roomId,
          currentTime
        }
      });
    },
    [send]
  );

  const sendPeerOffer = useCallback(
    (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => {
      const currentRoom = roomRef.current;

      if (!currentRoom) {
        return;
      }

      send({
        type: "peer_offer",
        payload: {
          roomId: currentRoom.roomId,
          targetParticipantId,
          sdp
        }
      });
    },
    [send]
  );

  const sendPeerAnswer = useCallback(
    (targetParticipantId: string, sdp: RTCSessionDescriptionInit) => {
      const currentRoom = roomRef.current;

      if (!currentRoom) {
        return;
      }

      send({
        type: "peer_answer",
        payload: {
          roomId: currentRoom.roomId,
          targetParticipantId,
          sdp
        }
      });
    },
    [send]
  );

  const sendPeerIceCandidate = useCallback(
    (targetParticipantId: string, candidate: RTCIceCandidateInit) => {
      const currentRoom = roomRef.current;

      if (!currentRoom) {
        return;
      }

      send({
        type: "peer_ice_candidate",
        payload: {
          roomId: currentRoom.roomId,
          targetParticipantId,
          candidate
        }
      });
    },
    [send]
  );

  const updateTransferState = useCallback(
    (transferState: TransferState) => {
      const currentRoom = roomRef.current;

      if (!currentRoom) {
        return;
      }

      send({
        type: "peer_transfer_state",
        payload: {
          roomId: currentRoom.roomId,
          transferState
        }
      });
    },
    [send]
  );

  const updateSubtitleTrack = useCallback(
    (subtitleTrack: SubtitleTrack) => {
      const currentRoom = roomRef.current;

      if (!currentRoom) {
        return;
      }

      send({
        type: "update_subtitle_track",
        payload: {
          roomId: currentRoom.roomId,
          subtitleTrack
        }
      });
    },
    [send]
  );

  const participants = useMemo<Participant[]>(() => room?.participants ?? [], [room]);

  return {
    connectionStatus,
    room,
    participants,
    remoteCommand,
    peerSignal,
    error,
    selfId,
    displayName,
    debugEntries,
    setDisplayName,
    pushDebugEntry,
    lastActionLabel,
    createRoom,
    joinRoom,
    leaveRoom,
    requestSync,
    sendChatMessage,
    updateTransferState,
    updateSubtitleTrack,
    sendPeerOffer,
    sendPeerAnswer,
    sendPeerIceCandidate,
    sendPlay: (currentTime: number) => sendPlaybackAction("player_play", currentTime),
    sendPause: (currentTime: number) => sendPlaybackAction("player_pause", currentTime),
    sendSeek: (currentTime: number) => sendPlaybackAction("player_seek", currentTime)
  };
}
