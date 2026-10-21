export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type IceServersResponse = {
  iceServers: IceServerConfig[];
  /** Epoch ms after which TURN credentials stop working; absent for STUN-only lists. */
  expiresAt?: number;
};

export const DEFAULT_ICE_SERVERS: IceServerConfig[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }
];
