import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ClientEnvelope, Participant, RoomState, ServerEvent } from "@syncplay/shared";
import { normalizeRoomId } from "@syncplay/shared";

import { getWebSocketUrl } from "../lib/config";

type ConnectionStatus = "connecting" | "connected" | "disconnected";

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
  const [error, setError] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [lastActionLabel, setLastActionLabel] = useState("Ready");
  const [displayName, setDisplayNameState] = useState(buildGuestName);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingMessagesRef = useRef<ClientEnvelope[]>([]);
  const displayNameRef = useRef(displayName);

  const setDisplayName = useCallback((value: string) => {
    const trimmedValue = value.slice(0, 32);
    setDisplayNameState(trimmedValue);
    displayNameRef.current = trimmedValue;
    localStorage.setItem("syncplay:display-name", trimmedValue);
  }, []);

  const connect = useCallback(() => {
    const existing = socketRef.current;

    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return existing;
    }

    setConnectionStatus("connecting");
    const socket = new WebSocket(getWebSocketUrl());

    socket.addEventListener("open", () => {
      setConnectionStatus("connected");
      setError(null);

      for (const message of pendingMessagesRef.current) {
        socket.send(JSON.stringify(message));
      }

      pendingMessagesRef.current = [];
    });

    socket.addEventListener("close", () => {
      setConnectionStatus("disconnected");
    });

    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(event.data) as ServerEvent;
      handleServerEvent(envelope);
    });

    socketRef.current = socket;
    return socket;
  }, []);

  useEffect(() => {
    const socket = connect();

    return () => {
      socket.close();
    };
  }, [connect]);

  const send = useCallback((message: ClientEnvelope) => {
    const socket = connect();

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }

    pendingMessagesRef.current.push(message);
  }, [connect]);

  const handleServerEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case "room_created":
      case "room_joined":
        setSelfId(event.payload.selfId);
        setRoom(event.payload.room);
        setLastActionLabel(`Joined room ${event.payload.room.roomId}`);
        return;
      case "presence_updated":
        setRoom(event.payload.room);
        setLastActionLabel(`${event.payload.room.participants.length} participant(s) connected`);
        return;
      case "sync_snapshot":
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
      case "server_error":
        setError(event.payload.message);
        return;
    }
  }, []);

  const createRoom = useCallback((videoId: string) => {
    send({
      type: "create_room",
      payload: {
        videoId,
        displayName: displayNameRef.current
      }
    });
  }, [send]);

  const joinRoom = useCallback((roomId: string) => {
    send({
      type: "join_room",
      payload: {
        roomId: normalizeRoomId(roomId),
        displayName: displayNameRef.current
      }
    });
  }, [send]);

  const leaveRoom = useCallback(() => {
    if (!room) {
      return;
    }

    send({
      type: "leave_room",
      payload: {
        roomId: room.roomId
      }
    });
    setRoom(null);
    setRemoteCommand(null);
  }, [room, send]);

  const requestSync = useCallback(() => {
    if (!room) {
      return;
    }

    send({
      type: "request_sync",
      payload: {
        roomId: room.roomId
      }
    });
  }, [room, send]);

  const sendPlaybackAction = useCallback((type: "player_play" | "player_pause" | "player_seek", currentTime: number) => {
    if (!room) {
      return;
    }

    send({
      type,
      payload: {
        roomId: room.roomId,
        currentTime
      }
    });
  }, [room, send]);

  const participants = useMemo<Participant[]>(() => room?.participants ?? [], [room]);

  return {
    connectionStatus,
    room,
    participants,
    remoteCommand,
    error,
    selfId,
    displayName,
    setDisplayName,
    lastActionLabel,
    createRoom,
    joinRoom,
    leaveRoom,
    requestSync,
    sendPlay: (currentTime: number) => sendPlaybackAction("player_play", currentTime),
    sendPause: (currentTime: number) => sendPlaybackAction("player_pause", currentTime),
    sendSeek: (currentTime: number) => sendPlaybackAction("player_seek", currentTime)
  };
}
