const [, , cdpPortArg, filePath, subtitlePath] = process.argv;

if (!cdpPortArg || !filePath || !subtitlePath) {
  console.error("Usage: node scripts/e2e-local-file-subtitle-visibility.mjs <cdp-port> <file-path> <subtitle-path>");
  process.exit(1);
}

const cdpPort = Number(cdpPortArg);

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`);
  process.exit(1);
}

const TARGET_URL_PREFIX = "http://localhost:5173";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const SUBTITLE_SEEK_SECONDS = 40.8;
const VISIBILITY_STABILITY_MS = 1_500;

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));

      if (!("id" in message)) {
        return;
      }

      const pendingRequest = this.pending.get(message.id);

      if (!pendingRequest) {
        return;
      }

      this.pending.delete(message.id);

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message ?? "Unknown CDP error"));
        return;
      }

      pendingRequest.resolve(message.result);
    });

    this.ws.addEventListener("close", () => {
      for (const pendingRequest of this.pending.values()) {
        pendingRequest.reject(new Error("CDP connection closed."));
      }

      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.nextId;

    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime evaluation failed.";
      throw new Error(description);
    }

    return result.result?.value;
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTargets() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);

  if (!response.ok) {
    throw new Error(`Failed to fetch CDP targets (${response.status}).`);
  }

  return response.json();
}

async function waitForTargets(count, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const targets = (await fetchTargets()).filter(
      (target) => target.type === "page" && typeof target.url === "string" && target.url.startsWith(TARGET_URL_PREFIX)
    );

    if (targets.length >= count) {
      return targets;
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${count} renderer target(s).`);
}

async function waitForValue(label, getter, predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;

  while (Date.now() < deadline) {
    lastValue = await getter();

    if (predicate(lastValue)) {
      return lastValue;
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

async function connectToTarget(target) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  return client;
}

function jsString(value) {
  return JSON.stringify(value);
}

async function getPlayerSnapshot(client) {
  return client.evaluate(`(() => {
    const video = document.querySelector("video");
    const debugState = window.__syncplayLocalPlayerDebug?.getState?.() ?? null;

    return {
      subtitleLines: Array.from(document.querySelectorAll(".local-player-subtitle-line")).map((node) => node.textContent),
      debugState,
      currentTime: video?.currentTime ?? null,
      paused: video?.paused ?? null
    };
  })()`);
}

async function ensurePlayback(client) {
  await client.evaluate(`(() => {
    const video = document.querySelector("video");
    if (!video) {
      return false;
    }

    video.muted = true;
    return video.play().then(() => true).catch(() => false);
  })()`);
}

async function seekTo(client, seconds) {
  return client.evaluate(`(() => {
    const video = document.querySelector("video");

    if (!video) {
      return false;
    }

    video.currentTime = ${JSON.stringify(seconds)};
    return true;
  })()`);
}

async function toggleCaptions(client, nextValue) {
  return client.evaluate(`window.__syncplayLocalPlayerDebug?.setCaptionsEnabled?.(${nextValue ? "true" : "false"}) ?? false`);
}

async function prepareSubtitleMoment(host, guest) {
  await seekTo(host, SUBTITLE_SEEK_SECONDS);
  await ensurePlayback(host);
  await ensurePlayback(guest);

  await waitForValue(
    "host subtitle lines",
    () => getPlayerSnapshot(host),
    (snapshot) => Array.isArray(snapshot?.subtitleLines) && snapshot.subtitleLines.length > 0
  );
  await waitForValue(
    "guest subtitle lines",
    () => getPlayerSnapshot(guest),
    (snapshot) => Array.isArray(snapshot?.subtitleLines) && snapshot.subtitleLines.length > 0
  );
}

async function assertVisibilityPersists(client, role, shouldBeVisible) {
  const stateAfterToggle = await waitForValue(
    `${role} subtitle toggle`,
    () => getPlayerSnapshot(client),
    (snapshot) => {
      const lines = snapshot?.subtitleLines ?? [];
      return shouldBeVisible ? lines.length > 0 : lines.length === 0;
    }
  );

  await delay(VISIBILITY_STABILITY_MS);

  const stableState = await getPlayerSnapshot(client);
  const stableLines = stableState?.subtitleLines ?? [];

  if (shouldBeVisible && stableLines.length === 0) {
    throw new Error(`${role} subtitles disappeared again after being shown.`);
  }

  if (!shouldBeVisible && stableLines.length > 0) {
    throw new Error(`${role} subtitles became visible again after being hidden.`);
  }

  return {
    stateAfterToggle,
    stableState
  };
}

async function main() {
  const [hostTarget] = await waitForTargets(1);
  const host = await connectToTarget(hostTarget);

  try {
    await waitForValue("host test hook", () => host.evaluate("Boolean(window.__syncplayTest)"), Boolean);

    await host.evaluate(`window.__syncplayTest.selectSourceOption("local_file")`);
    await host.evaluate(`window.__syncplayTest.selectLocalFileByPath(${jsString(filePath)})`);
    await waitForValue(
      "selected local file",
      () => host.evaluate("window.__syncplayTest.getState()"),
      (state) => Boolean(state?.selectedLocalFile?.fileId)
    );
    await host.evaluate("window.__syncplayTest.createCurrentRoom()");

    const hostState = await waitForValue(
      "created room",
      () => host.evaluate("window.__syncplayTest.getState()"),
      (state) => Boolean(state?.room?.roomId)
    );
    const roomId = hostState.room.roomId;

    await host.evaluate("window.syncplayDesktop.openDesktopWindow()");

    const targets = await waitForTargets(2);
    const guestTarget = targets.find((target) => target.id !== hostTarget.id);

    if (!guestTarget) {
      throw new Error("Guest window target not found.");
    }

    const guest = await connectToTarget(guestTarget);

    try {
      await waitForValue("guest test hook", () => guest.evaluate("Boolean(window.__syncplayTest)"), Boolean);
      await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`);

      await waitForValue(
        "guest room connection",
        () => guest.evaluate("window.__syncplayTest.getState()"),
        (state) => state?.connectionStatus === "connected" && state?.room?.roomId === roomId
      );

      await waitForValue(
        "guest local player loaded",
        () => guest.evaluate("window.__syncplayLocalPlayerDebug?.getState?.() ?? null"),
        (state) => {
          const video = state?.video;
          return (
            Boolean(state?.mediaUrl) &&
            Boolean(video?.currentSrc) &&
            !video?.error &&
            Number(video?.duration) > 0 &&
            Number(video?.videoWidth) > 0 &&
            Number(video?.videoHeight) > 0
          );
        }
      );

      await ensurePlayback(host);
      await ensurePlayback(guest);
      await host.evaluate(`window.__syncplayLocalPlayerDebug?.uploadSubtitleByPath?.(${jsString(subtitlePath)}) ?? false`);

      await waitForValue(
        "guest subtitle state",
        () => guest.evaluate("window.__syncplayLocalPlayerDebug?.getState?.() ?? null"),
        (state) => Boolean(state?.subtitleFileName)
      );

      await prepareSubtitleMoment(host, guest);

      const guestHide = await toggleCaptions(guest, false);

      if (!guestHide) {
        throw new Error("Guest caption toggle hook failed.");
      }

      const guestHidden = await assertVisibilityPersists(guest, "guest", false);
      const hostUnaffectedAfterGuestHide = await waitForValue(
        "host still visible after guest hides",
        () => getPlayerSnapshot(host),
        (snapshot) => Array.isArray(snapshot?.subtitleLines) && snapshot.subtitleLines.length > 0
      );

      const guestShow = await toggleCaptions(guest, true);

      if (!guestShow) {
        throw new Error("Guest caption show hook failed.");
      }

      const guestShown = await assertVisibilityPersists(guest, "guest", true);
      await prepareSubtitleMoment(host, guest);
      const hostHide = await toggleCaptions(host, false);

      if (!hostHide) {
        throw new Error("Host caption toggle hook failed.");
      }

      const hostHidden = await assertVisibilityPersists(host, "host", false);
      const guestUnaffectedAfterHostHide = await waitForValue(
        "guest still visible after host hides",
        () => getPlayerSnapshot(guest),
        (snapshot) => Array.isArray(snapshot?.subtitleLines) && snapshot.subtitleLines.length > 0
      );

      console.log(
        JSON.stringify(
          {
            roomId,
            filePath,
            subtitlePath,
            guestHidden,
            hostUnaffectedAfterGuestHide,
            guestShown,
            hostHidden,
            guestUnaffectedAfterHostHide
          },
          null,
          2
        )
      );
    } finally {
      await guest.close();
    }
  } finally {
    await host.close();
  }
}

await main();
