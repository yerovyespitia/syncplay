import { DEFAULT_ICE_SERVERS, type IceServersResponse } from "@syncplay/shared";

import { getServerBaseUrl } from "./config";

const STUN_ONLY_CACHE_MS = 60 * 60 * 1000;
const CREDENTIAL_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const FAILED_LOOKUP_RETRY_MS = 60 * 1000;
const ICE_SERVER_FETCH_TIMEOUT_MS = 3000;

let cached: { promise: Promise<RTCIceServer[]>; refreshAt: number } | null = null;

// Fetches STUN/TURN servers from the signaling server, caching them until the
// TURN credentials are about to expire. Falls back to STUN when unreachable.
export function loadIceServers(): Promise<RTCIceServer[]> {
  if (cached && Date.now() < cached.refreshAt) {
    return cached.promise;
  }

  const entry = { promise: Promise.resolve<RTCIceServer[]>([]), refreshAt: Number.POSITIVE_INFINITY };
  entry.promise = fetchIceServers().then(({ iceServers, refreshAt }) => {
    entry.refreshAt = refreshAt;
    return iceServers;
  });
  cached = entry;
  return entry.promise;
}

async function fetchIceServers(): Promise<{ iceServers: RTCIceServer[]; refreshAt: number }> {
  try {
    const response = await fetch(new URL("/api/ice-servers", getServerBaseUrl()), {
      signal: AbortSignal.timeout(ICE_SERVER_FETCH_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`ICE server request failed with status ${response.status}`);
    }

    const body = (await response.json()) as IceServersResponse;
    if (!body.iceServers?.length) {
      throw new Error("ICE server response was empty");
    }

    return {
      iceServers: body.iceServers,
      refreshAt: body.expiresAt ? body.expiresAt - CREDENTIAL_EXPIRY_MARGIN_MS : Date.now() + STUN_ONLY_CACHE_MS
    };
  } catch {
    return { iceServers: DEFAULT_ICE_SERVERS, refreshAt: Date.now() + FAILED_LOOKUP_RETRY_MS };
  }
}
