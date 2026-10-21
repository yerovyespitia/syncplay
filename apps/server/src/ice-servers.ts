import { DEFAULT_ICE_SERVERS, type IceServerConfig, type IceServersResponse } from "@syncplay/shared";

const TURN_CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;
const TURN_CREDENTIAL_REFRESH_MARGIN_MS = 60 * 60 * 1000;
const FAILED_LOOKUP_RETRY_MS = 60 * 1000;

/**
 * Hands out ICE servers for WebRTC peers. When Cloudflare Realtime TURN keys are
 * configured, short-lived TURN credentials are generated so peers behind strict
 * NATs can still connect; media never flows through this server.
 */
export class IceServerProvider {
  private cached: { response: IceServersResponse; refreshAt: number } | null = null;
  private pending: Promise<IceServersResponse> | null = null;

  constructor(
    private readonly turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID,
    private readonly turnKeyApiToken = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getIceServers(now = Date.now()): Promise<IceServersResponse> {
    if (!this.turnKeyId || !this.turnKeyApiToken) {
      return { iceServers: DEFAULT_ICE_SERVERS };
    }

    if (this.cached && this.cached.refreshAt > now) {
      return this.cached.response;
    }

    this.pending ??= this.generateTurnIceServers(this.turnKeyId, this.turnKeyApiToken, now).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async generateTurnIceServers(turnKeyId: string, turnKeyApiToken: string, now: number) {
    try {
      const response = await this.fetchImpl(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${turnKeyApiToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS })
        }
      );

      if (!response.ok) {
        throw new Error(`TURN credential request failed with status ${response.status}`);
      }

      const body = (await response.json()) as { iceServers?: IceServerConfig[] };
      const iceServers = (body.iceServers ?? []).map(stripPort53Urls).filter((server) => server.urls.length > 0);

      if (iceServers.length === 0) {
        throw new Error("TURN credential response did not include ICE servers");
      }

      const expiresAt = now + TURN_CREDENTIAL_TTL_SECONDS * 1000;
      this.cached = {
        response: { iceServers, expiresAt },
        refreshAt: expiresAt - TURN_CREDENTIAL_REFRESH_MARGIN_MS
      };
    } catch (error) {
      console.warn("Falling back to STUN-only ICE servers", error);
      // Keep still-valid credentials if we have them; either way, back off
      // instead of calling Cloudflare on every request during an outage.
      const stillValid = this.cached?.response.expiresAt !== undefined && this.cached.response.expiresAt > now;
      this.cached = {
        response: stillValid && this.cached ? this.cached.response : { iceServers: DEFAULT_ICE_SERVERS },
        refreshAt: now + FAILED_LOOKUP_RETRY_MS
      };
    }

    return this.cached.response;
  }
}

// Cloudflare documents that the port 53 alternate URLs can time out in browsers.
function stripPort53Urls(server: IceServerConfig) {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return {
    ...server,
    urls: urls.filter((url) => !/:53(\?|$)/.test(url))
  };
}
