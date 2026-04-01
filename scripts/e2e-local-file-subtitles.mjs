import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [, , cdpPortArg, filePath, subtitlePath] = process.argv;

if (!cdpPortArg || !filePath || !subtitlePath) {
  console.error("Usage: node scripts/e2e-local-file-subtitles.mjs <cdp-port> <file-path> <subtitle-path>");
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
const STABILITY_WINDOW_MS = 12_000;
const STABILITY_SAMPLE_MS = 600;

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

  async captureScreenshot(filePath) {
    await this.send("Page.enable");
    const result = await this.send("Page.captureScreenshot", {
      format: "png"
    });
    await fs.writeFile(filePath, Buffer.from(result.data, "base64"));
    return filePath;
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
    const subtitles = Array.from(document.querySelectorAll(".local-player-subtitle-line")).map((node) => node.textContent);

    if (!video) {
      return null;
    }

    return {
      paused: video.paused,
      ended: video.ended,
      currentSrc: video.currentSrc,
      readyState: video.readyState,
      networkState: video.networkState,
      currentTime: video.currentTime,
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      subtitleLines: subtitles,
      error: video.error ? { code: video.error.code, message: video.error.message ?? null } : null
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
    () => getPlayerSnapshot(client),
    (snapshot) =>
      Boolean(snapshot) &&
      !snapshot.paused &&
      !snapshot.ended &&
      !snapshot.error &&
      Number(snapshot.duration) > 0 &&
      Number(snapshot.videoWidth) > 0 &&
      Number(snapshot.videoHeight) > 0 &&
      Number(snapshot.currentTime) > 1.5,
    DEFAULT_TIMEOUT_MS
  );
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

async function uploadSubtitle(client, filePath) {
  return client.evaluate(`window.__syncplayLocalPlayerDebug?.uploadSubtitleByPath?.(${jsString(filePath)}) ?? false`);
}

async function collectSamples(client, label, durationMs = STABILITY_WINDOW_MS) {
  const samples = [];
  const deadline = Date.now() + durationMs;

  while (Date.now() < deadline) {
    const snapshot = await getPlayerSnapshot(client);

    if (!snapshot) {
      throw new Error(`${label} player is not available.`);
    }

    samples.push({
      at: Date.now(),
      currentTime: snapshot.currentTime,
      paused: snapshot.paused,
      error: snapshot.error,
      subtitleLines: snapshot.subtitleLines
    });

    await delay(STABILITY_SAMPLE_MS);
  }

  return samples;
}

function analyzeSamples(label, beforeTime, samples) {
  if (samples.length === 0) {
    throw new Error(`No ${label} samples collected.`);
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const minTime = Math.min(...samples.map((sample) => sample.currentTime));
  const maxBackwardJump = samples.reduce((largest, sample, index) => {
    if (index === 0) {
      return largest;
    }

    const previous = samples[index - 1];
    return Math.max(largest, previous.currentTime - sample.currentTime);
  }, 0);
  const hadPause = samples.some((sample) => sample.paused);
  const hadError = samples.some((sample) => sample.error);

  if (hadError) {
    throw new Error(`${label} encountered a media error during subtitle sync.`);
  }

  if (hadPause) {
    throw new Error(`${label} paused unexpectedly during subtitle sync.`);
  }

  if (minTime < Math.max(1, beforeTime - 2)) {
    throw new Error(`${label} jumped backwards near the beginning after subtitles were added.`);
  }

  if (maxBackwardJump > 1.5) {
    throw new Error(`${label} had a backward jump of ${maxBackwardJump.toFixed(2)}s after subtitle sync.`);
  }

  if (last.currentTime < first.currentTime + 6) {
    throw new Error(`${label} did not keep progressing after subtitle sync.`);
  }

  return {
    firstTime: first.currentTime,
    lastTime: last.currentTime,
    minTime,
    maxBackwardJump
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
        "host video loaded",
        () => getPlayerSnapshot(host),
        (snapshot) =>
          Boolean(snapshot) &&
          !snapshot.error &&
          Boolean(snapshot.currentSrc) &&
          Number(snapshot.duration) > 0 &&
          Number(snapshot.videoWidth) > 0 &&
          Number(snapshot.videoHeight) > 0
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

      await ensurePlayback(host, "host");
      await ensurePlayback(guest, "guest");
      await seekTo(host, 20);

      const hostBeforeSubtitle = await waitForValue(
        "host advanced playback",
        () => getPlayerSnapshot(host),
        (snapshot) => Boolean(snapshot) && !snapshot.paused && snapshot.currentTime >= 20
      );
      const guestBeforeSubtitle = await waitForValue(
        "guest advanced playback",
        () => getPlayerSnapshot(guest),
        (snapshot) => Boolean(snapshot) && !snapshot.paused && snapshot.currentTime >= 18
      );

      const uploadWorked = await uploadSubtitle(host, subtitlePath);

      if (!uploadWorked) {
        throw new Error("Subtitle upload hook failed.");
      }

      await waitForValue(
        "host subtitle state",
        () => host.evaluate("window.__syncplayTest.getState()"),
        (state) => Boolean(state?.room?.subtitleTrack?.fileName)
      );
      await waitForValue(
        "guest subtitle state",
        () => guest.evaluate("window.__syncplayTest.getState()"),
        (state) => Boolean(state?.room?.subtitleTrack?.fileName)
      );

      const [hostSamples, guestSamples] = await Promise.all([
        collectSamples(host, "host"),
        collectSamples(guest, "guest")
      ]);

      const hostAnalysis = analyzeSamples("host", hostBeforeSubtitle.currentTime, hostSamples);
      const guestAnalysis = analyzeSamples("guest", guestBeforeSubtitle.currentTime, guestSamples);
      const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "syncplay-e2e-subtitles-"));
      const hostScreenshotPath = await host.captureScreenshot(path.join(screenshotDir, "host-after-subtitles.png"));
      const guestScreenshotPath = await guest.captureScreenshot(path.join(screenshotDir, "guest-after-subtitles.png"));

      console.log(
        JSON.stringify(
          {
            filePath,
            subtitlePath,
            roomId,
            hostBeforeSubtitle,
            guestBeforeSubtitle,
            hostAnalysis,
            guestAnalysis,
            hostScreenshotPath,
            guestScreenshotPath
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
