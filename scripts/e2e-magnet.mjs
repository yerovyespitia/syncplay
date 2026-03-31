import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const [, , cdpPortArg, magnetLink] = process.argv;

if (!cdpPortArg || !magnetLink) {
  console.error("Usage: node scripts/e2e-magnet.mjs <cdp-port> <magnet-link>");
  process.exit(1);
}

const cdpPort = Number(cdpPortArg);

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`);
  process.exit(1);
}

const TARGET_URL_PREFIX = "http://localhost:5173";
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const POLL_INTERVAL_MS = 500;

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
      error: video.error ? { code: video.error.code, message: video.error.message ?? null } : null
    };
  })()`);
}

async function analyzeScreenshot(filePath) {
  const script = `
from PIL import Image
img = Image.open(${JSON.stringify(filePath)}).convert("RGB")
w, h = img.size
left = int(w * 0.2)
top = int(h * 0.2)
right = int(w * 0.8)
bottom = int(h * 0.8)
crop = img.crop((left, top, right, bottom))
pixels = list(crop.getdata())
avg = sum((r + g + b) / 3 for r, g, b in pixels) / len(pixels)
max_channel = max(max(r, g, b) for r, g, b in pixels)
print({"averageBrightness": round(avg, 2), "maxChannel": int(max_channel)})
`;
  const { stdout } = await execFileAsync("python3", ["-c", script]);
  return JSON.parse(stdout.trim().replace(/'/g, '"'));
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

async function setMagnetLinkInUi(client, value) {
  return client.evaluate(`(() => {
    const input = document.querySelector("#magnet-link");
    if (!input) {
      return false;
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor.set.call(input, ${jsString(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

async function clickResolveMagnet(client) {
  return client.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((candidate) => candidate.textContent?.includes("Resolve magnet"));
    if (!button) {
      return false;
    }

    button.click();
    return true;
  })()`);
}

async function selectTorrentFileInUi(client, fileIndex) {
  return client.evaluate(`(() => {
    const select = document.querySelector("#torrent-file");
    if (!select) {
      return false;
    }

    select.value = ${jsString(String(fileIndex))};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  const [hostTarget] = await waitForTargets(1);
  const host = await connectToTarget(hostTarget);

  try {
    await waitForValue(
      "host test hook",
      () => host.evaluate("Boolean(window.__syncplayTest)"),
      Boolean
    );

    await host.evaluate(`window.__syncplayTest.selectSourceOption("torrent_magnet")`);
    await setMagnetLinkInUi(host, magnetLink);
    await clickResolveMagnet(host);

    const torrentState = await waitForValue(
      "resolved magnet metadata",
      () => host.evaluate("window.__syncplayTest.getState()"),
      (state) => Boolean(state?.torrentSession?.files?.length)
    );

    const selectedTorrentFile = torrentState.torrentSession.files[0];
    await selectTorrentFileInUi(host, selectedTorrentFile.index);

    await waitForValue(
      "selected torrent file",
      () => host.evaluate("window.__syncplayTest.getState()"),
      (state) => state?.selectedLocalFile?.type === "torrent_magnet" && Boolean(state?.selectedLocalFile?.fileId)
    );

    await host.evaluate(`window.__syncplayTest.createCurrentRoom()`);

    const hostState = await waitForValue(
      "created torrent room",
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
      await waitForValue(
        "guest test hook",
        () => guest.evaluate("Boolean(window.__syncplayTest)"),
        Boolean
      );

      await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`);

      const guestRoomState = await waitForValue(
        "guest room connection",
        () => guest.evaluate("window.__syncplayTest.getState()"),
        (state) => state?.connectionStatus === "connected" && state?.room?.roomId === roomId
      );

      const hostLoadedState = await waitForValue(
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

      const guestLoadedState = await waitForValue(
        "guest local player loaded",
        () => guest.evaluate("window.__syncplayLocalPlayerDebug?.getState?.() ?? null"),
        (state) => {
          if (!state?.roomTransferState || !state?.video) {
            return false;
          }

          const video = state.video;

          return (
            Boolean(state.mediaUrl) &&
            Boolean(video.currentSrc) &&
            !video.error &&
            Number(video.duration) > 0 &&
            Number(video.videoWidth) > 0 &&
            Number(video.videoHeight) > 0
          );
        }
      );

      const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "syncplay-magnet-e2e-"));
      const hostPlaybackState = await ensurePlayback(host, "host");
      const guestPlaybackState = await ensurePlayback(guest, "guest");
      const hostScreenshotPath = await host.captureScreenshot(path.join(screenshotDir, "host.png"));
      const guestScreenshotPath = await guest.captureScreenshot(path.join(screenshotDir, "guest.png"));
      const hostScreenshotAnalysis = await analyzeScreenshot(hostScreenshotPath);
      const guestScreenshotAnalysis = await analyzeScreenshot(guestScreenshotPath);

      if (hostScreenshotAnalysis.maxChannel <= 10 || hostScreenshotAnalysis.averageBrightness <= 3) {
        throw new Error(`Host screenshot appears too dark: ${JSON.stringify(hostScreenshotAnalysis)}`);
      }

      if (guestScreenshotAnalysis.maxChannel <= 10 || guestScreenshotAnalysis.averageBrightness <= 3) {
        throw new Error(`Guest screenshot appears too dark: ${JSON.stringify(guestScreenshotAnalysis)}`);
      }

      console.log(
        JSON.stringify(
          {
            magnetLink,
            selectedTorrentFile,
            roomId,
            host: {
              connectionStatus: hostState.connectionStatus,
              selectedLocalFile: hostState.selectedLocalFile,
              loaded: hostLoadedState,
              playback: hostPlaybackState,
              screenshotAnalysis: hostScreenshotAnalysis,
              screenshotPath: hostScreenshotPath
            },
            guest: {
              connectionStatus: guestRoomState.connectionStatus,
              roomTransferState: guestLoadedState.roomTransferState,
              mediaUrl: guestLoadedState.mediaUrl,
              activeMediaUrlIndex: guestLoadedState.activeMediaUrlIndex,
              video: guestLoadedState.video,
              playback: guestPlaybackState,
              screenshotAnalysis: guestScreenshotAnalysis,
              screenshotPath: guestScreenshotPath
            }
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
