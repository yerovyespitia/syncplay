export type PlaybackState = "playing" | "paused";

export interface Participant {
  id: string;
  displayName?: string;
  connectedAt: number;
}

export interface RoomState {
  roomId: string;
  videoId: string;
  playbackState: PlaybackState;
  currentTime: number;
  updatedAt: number;
  lastEventId: number;
  participants: Participant[];
}

export interface ServerEnvelope<TType extends ServerEvent["type"] = ServerEvent["type"]> {
  type: TType;
  payload: Extract<ServerEvent, { type: TType }>["payload"];
}

export interface ClientEnvelope<TType extends ClientEvent["type"] = ClientEvent["type"]> {
  type: TType;
  payload: Extract<ClientEvent, { type: TType }>["payload"];
}

export type ClientEvent =
  | {
      type: "create_room";
      payload: {
        videoId: string;
        displayName?: string;
      };
    }
  | {
      type: "join_room";
      payload: {
        roomId: string;
        displayName?: string;
      };
    }
  | {
      type: "request_sync";
      payload: {
        roomId: string;
      };
    }
  | {
      type: "player_play";
      payload: {
        roomId: string;
        currentTime: number;
      };
    }
  | {
      type: "player_pause";
      payload: {
        roomId: string;
        currentTime: number;
      };
    }
  | {
      type: "player_seek";
      payload: {
        roomId: string;
        currentTime: number;
      };
    }
  | {
      type: "leave_room";
      payload: {
        roomId: string;
      };
    };

export type ServerEvent =
  | {
      type: "room_created";
      payload: {
        selfId: string;
        room: RoomState;
      };
    }
  | {
      type: "room_joined";
      payload: {
        selfId: string;
        room: RoomState;
      };
    }
  | {
      type: "sync_snapshot";
      payload: {
        room: RoomState;
        actorId?: string;
      };
    }
  | {
      type: "player_state_changed";
      payload: {
        room: RoomState;
        actorId: string;
        action: "player_play" | "player_pause" | "player_seek";
      };
    }
  | {
      type: "presence_updated";
      payload: {
        room: RoomState;
      };
    }
  | {
      type: "server_error";
      payload: {
        message: string;
      };
    };

export interface DesktopApi {
  platform: string;
  electronVersion: string;
}
