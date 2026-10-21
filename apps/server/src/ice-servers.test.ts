import { describe, expect, test } from "bun:test";

import { IceServerProvider } from "./ice-servers";

describe("IceServerProvider", () => {
  test("returns STUN servers when TURN keys are missing", async () => {
    let fetchCalls = 0;
    const provider = new IceServerProvider(undefined, undefined, (async () => {
      fetchCalls += 1;
      return new Response();
    }) as unknown as typeof fetch);

    const { iceServers, expiresAt } = await provider.getIceServers();
    expect(iceServers.length).toBeGreaterThan(0);
    expect(expiresAt).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  test("generates, filters and caches Cloudflare TURN credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new IceServerProvider("key-id", "api-token", (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Response.json(
        {
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
            {
              urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"],
              username: "user",
              credential: "secret"
            }
          ]
        },
        { status: 201 }
      );
    }) as unknown as typeof fetch);

    const now = Date.now();
    const { iceServers, expiresAt } = await provider.getIceServers(now);
    await provider.getIceServers(now + 60_000);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers");
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer api-token");
    expect(iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "user", credential: "secret" }
    ]);
    expect(expiresAt).toBe(now + 12 * 60 * 60 * 1000);
  });

  test("falls back to STUN and backs off when Cloudflare rejects the request", async () => {
    let fetchCalls = 0;
    const provider = new IceServerProvider("key-id", "bad-token", (async () => {
      fetchCalls += 1;
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch);

    const now = Date.now();
    const { iceServers } = await provider.getIceServers(now);
    await provider.getIceServers(now + 1000);
    expect(iceServers.every((server) => server.username === undefined)).toBe(true);
    expect(fetchCalls).toBe(1);
  });
});
