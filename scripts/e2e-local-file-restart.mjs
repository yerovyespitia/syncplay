import path from "node:path";

const [, , cdpPortArg, filePath, iterationCountArg = "1"] = process.argv;

if (!cdpPortArg || !filePath) {
  console.error("Usage: node scripts/e2e-local-file-restart.mjs <cdp-port> <file-path> [iteration-count]");
  process.exit(1);
}

const cdpPort = Number(cdpPortArg);
const iterationCount = Number(iterationCountArg);

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`);
  process.exit(1);
}

if (!Number.isFinite(iterationCount) || iterationCount <= 0) {
  console.error(`Invalid iteration count: ${iterationCountArg}`);
  process.exit(1);
}

const TARGET_URL_PREFIX = "http://localhost:5173";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SHORT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const ENDING_WINDOW_SECONDS = 5;
const RESTART_DRIFT_TOLERANCE_SECONDS = 0.75;

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

function getTargetKey(target) {
  return `${target.id}:${target.webSocketDebuggerUrl}`;
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

async function getRoomState(client) {
  return client.evaluate("window.__syncplayTest?.getState?.() ?? null");
}

async function getPlayerState(client) {
  return client.evaluate(`(() => {
    const video = document.querySelector("video");
    const roomState = window.__syncplayTest?.getState?.() ?? null;

    return {
      roomPlaybackState: roomState?.room?.playbackState ?? null,
      roomCurrentTime: roomState?.room?.currentTime ?? null,
      roomUpdatedAt: roomState?.room?.updatedAt ?? null,
      lastActionLabel: roomState?.lastActionLabel ?? null,
      video: video
        ? {
            paused: video.paused,
            ended: video.ended,
            currentTime: video.currentTime,
            duration: video.duration,
            muted: video.muted,
            readyState: video.readyState,
            currentSrc: video.currentSrc,
            error: video.error ? { code: video.error.code, message: video.error.message ?? null } : null
          }
        : null
    };
  })()`);
}

async function ensurePlayback(client, label) {
  await client.evaluate(`(() => {
    const video = document.querySelector("video");
    if (!video) {
      return false;
    }

    video.muted = true;
    return video.play().then(() => true).catch(() => false);
  })()`);

  return waitForValue(
    `${label} playback`,
    () => getPlayerState(client),
    (snapshot) =>
      Boolean(snapshot?.video) &&
      !snapshot.video.paused &&
      !snapshot.video.ended &&
      !snapshot.video.error &&
      Number(snapshot.video.duration) > 0 &&
      Number(snapshot.video.currentTime) > 1.5,
    DEFAULT_TIMEOUT_MS
  );
}

async function seekNearEnd(client, label) {
  const targetTime = await client.evaluate(`(() => {
    const video = document.querySelector("video");
    if (!video || !Number.isFinite(video.duration) || video.duration <= ${ENDING_WINDOW_SECONDS}) {
      return null;
    }

    const nextTime = Math.max(0, video.duration - ${ENDING_WINDOW_SECONDS});
    video.currentTime = nextTime;
    return nextTime;
  })()`);

  if (!Number.isFinite(targetTime)) {
    throw new Error(`${label} could not seek near end.`);
  }

  return waitForValue(
    `${label} seek near end`,
    () => getPlayerState(client),
    (snapshot) => Boolean(snapshot?.video) && Math.abs(snapshot.video.currentTime - targetTime) <= 0.75,
    SHORT_TIMEOUT_MS
  );
}

async function waitForEnded(client, label) {
  return waitForValue(
    `${label} ended`,
    () => getPlayerState(client),
    (snapshot) =>
      Boolean(snapshot?.video) &&
      snapshot.video.paused &&
      Number(snapshot.video.duration) > 0 &&
      snapshot.video.currentTime >= snapshot.video.duration - 0.4 &&
      (snapshot.video.ended || snapshot.roomPlaybackState === "paused"),
    SHORT_TIMEOUT_MS
  );
}

async function clickPlayButton(client, label) {
  const clicked = await client.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Play video"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      return false;
    }

    button.click();
    return true;
  })()`);

  if (!clicked) {
    throw new Error(`${label} play button was not clickable.`);
  }
}

async function waitForRestart(host, guest, actorLabel) {
  return waitForValue(
    `${actorLabel} restart sync`,
    async () => {
      const [hostState, guestState] = await Promise.all([getPlayerState(host), getPlayerState(guest)]);
      return { hostState, guestState };
    },
    ({ hostState, guestState }) => {
      if (!hostState?.video || !guestState?.video) {
        return false;
      }

      if (hostState.video.error || guestState.video.error) {
        return false;
      }

      const hostTime = hostState.video.currentTime;
      const guestTime = guestState.video.currentTime;

      return (
        !hostState.video.paused &&
        !guestState.video.paused &&
        !hostState.video.ended &&
        !guestState.video.ended &&
        hostTime >= 0 &&
        guestTime >= 0 &&
        hostTime <= 2.5 &&
        guestTime <= 2.5 &&
        Math.abs(hostTime - guestTime) <= RESTART_DRIFT_TOLERANCE_SECONDS &&
        hostState.roomPlaybackState === "playing" &&
        guestState.roomPlaybackState === "playing"
      );
    },
    SHORT_TIMEOUT_MS
  );
}

async function assertStableSync(host, guest, label) {
  for (let index = 0; index < 5; index += 1) {
    const [hostState, guestState] = await Promise.all([getPlayerState(host), getPlayerState(guest)]);

    if (!hostState?.video || !guestState?.video) {
      throw new Error(`${label}: missing video state.`);
    }

    if (hostState.video.paused || guestState.video.paused || hostState.video.ended || guestState.video.ended) {
      throw new Error(`${label}: playback was not stable after restart.`);
    }

    if (Math.abs(hostState.video.currentTime - guestState.video.currentTime) > RESTART_DRIFT_TOLERANCE_SECONDS) {
      throw new Error(
        `${label}: drift too high after restart (${hostState.video.currentTime.toFixed(2)} vs ${guestState.video.currentTime.toFixed(2)}).`
      );
    }

    await delay(400);
  }
}

async function collectFailureState(host, guest) {
  const [hostState, guestState, hostRoomState, guestRoomState] = await Promise.all([
    getPlayerState(host),
    getPlayerState(guest),
    getRoomState(host),
    getRoomState(guest)
  ]);

  return {
    hostState,
    guestState,
    hostRoomState,
    guestRoomState
  };
}

async function setupHostAndGuest() {
  const [hostTarget] = await waitForTargets(1);
  const host = await connectToTarget(hostTarget);

  await host.evaluate("window.location.reload()");
  await waitForValue("host test hook", () => host.evaluate("Boolean(window.__syncplayTest)"), Boolean);
  await host.evaluate(`window.__syncplayTest.selectSourceOption("local_file")`);
  await host.evaluate(`window.__syncplayTest.selectLocalFileByPath(${jsString(filePath)})`);
  await waitForValue(
    "selected local file",
    () => getRoomState(host),
    (state) => Boolean(state?.selectedLocalFile?.fileId)
  );
  await host.evaluate("window.__syncplayTest.createCurrentRoom()");

  const hostRoomState = await waitForValue(
    "created room",
    () => getRoomState(host),
    (state) => Boolean(state?.room?.roomId)
  );
  const roomId = hostRoomState.room.roomId;

  const targetsBeforeGuest = await fetchTargets();
  const knownTargetKeys = new Set(targetsBeforeGuest.map(getTargetKey));
  await host.evaluate("window.syncplayDesktop.openDesktopWindow()");

  const guestTarget = await waitForValue(
    "new guest window",
    async () => {
      const targets = await fetchTargets();
      return targets.find(
        (target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          target.url.startsWith(TARGET_URL_PREFIX) &&
          !knownTargetKeys.has(getTargetKey(target))
      ) ?? null;
    },
    Boolean
  );

  if (!guestTarget) {
    throw new Error("Guest window target not found.");
  }

  const guest = await connectToTarget(guestTarget);

  await waitForValue("guest test hook", () => guest.evaluate("Boolean(window.__syncplayTest)"), Boolean);
  await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`);
  await waitForValue(
    "guest room connection",
    () => getRoomState(guest),
    (state) => state?.connectionStatus === "connected" && state?.room?.roomId === roomId
  );

  await waitForValue(
    "host video loaded",
    () => getPlayerState(host),
    (state) => Boolean(state?.video?.currentSrc) && Number(state?.video?.duration) > 0
  );
  await waitForValue(
    "guest video loaded",
    () => getPlayerState(guest),
    (state) => Boolean(state?.video?.currentSrc) && Number(state?.video?.duration) > 0
  );

  await ensurePlayback(host, "host");
  await ensurePlayback(guest, "guest");

  return { host, guest, roomId };
}

async function runRestartScenario(host, guest, actor) {
  await seekNearEnd(host, "host");
  await waitForEnded(host, "host");
  await waitForEnded(guest, "guest");

  const actorClient = actor === "host" ? host : guest;
  await clickPlayButton(actorClient, actor);
  await waitForRestart(host, guest, actor);
  await assertStableSync(host, guest, `${actor} restart`);
}

async function main() {
  const { host, guest, roomId } = await setupHostAndGuest();

  try {
    const results = [];

    for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
      await runRestartScenario(host, guest, "host");
      await runRestartScenario(host, guest, "guest");
      results.push({ iteration, status: "passed" });
    }

    console.log(
      JSON.stringify(
        {
          filePath: path.resolve(filePath),
          roomId,
          iterations: results
        },
        null,
        2
      )
    );
  } catch (error) {
    const failureState = await collectFailureState(host, guest).catch(() => null);
    console.error(
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          failureState
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    await guest.evaluate("window.close()").catch(() => undefined);
    await guest.close();
    await host.close();
  }
}

await main();
