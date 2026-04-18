import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  DEFAULT_TIMEOUT_MS,
  attemptPlayback,
  connectToTarget,
  getAppState,
  getLocalPlayerState,
  getVideoSnapshot,
  jsString,
  waitForTargets,
  waitForTestHook,
  waitForValue
} from "./perf-shared.mjs";

const execFileAsync = promisify(execFile);

const [, , cdpPortArg, firstMagnet, secondMagnet] = process.argv;

if (!cdpPortArg || !firstMagnet || !secondMagnet) {
  console.error("Usage: node scripts/e2e-magnet-switch.mjs <cdp-port> <first-magnet> <second-magnet>");
  process.exit(1);
}

const cdpPort = Number(cdpPortArg);

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`);
  process.exit(1);
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

async function clickButtonContaining(client, text) {
  return client.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((candidate) => candidate.textContent?.includes(${jsString(text)}));
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

async function ensureLobby(client, label) {
  const state = await getAppState(client);

  if (!state?.room) {
    return;
  }

  await client.evaluate("window.__syncplayTest.leaveCurrentRoom?.()");
  await waitForValue(
    `${label} lobby`,
    () => getAppState(client),
    (nextState) => !nextState?.room,
    DEFAULT_TIMEOUT_MS
  );
}

async function createMagnetRoom(host, magnetLink) {
  await host.evaluate('window.__syncplayTest.selectSourceOption("torrent_magnet")');
  await setMagnetLinkInUi(host, magnetLink);
  await clickButtonContaining(host, "Resolve magnet");

  const resolvedState = await waitForValue(
    "resolved magnet metadata",
    () => getAppState(host),
    (state) => Boolean(state?.torrentSession?.files?.length),
    DEFAULT_TIMEOUT_MS
  );
  const selectedTorrentFile = resolvedState.torrentSession.files[0];

  await selectTorrentFileInUi(host, selectedTorrentFile.index);
  const selectedState = await waitForValue(
    "selected torrent file",
    () => getAppState(host),
    (state) =>
      state?.selectedLocalFile?.type === "torrent_magnet" &&
      state?.selectedLocalFile?.magnetUri === magnetLink &&
      Boolean(state?.selectedLocalFile?.mediaId),
    DEFAULT_TIMEOUT_MS
  );

  await host.evaluate("window.__syncplayTest.createCurrentRoom()");
  const roomState = await waitForValue(
    "created magnet room",
    () => getAppState(host),
    (state) => Boolean(state?.room?.roomId),
    DEFAULT_TIMEOUT_MS
  );

  return {
    roomId: roomState.room.roomId,
    selectedTorrentFile,
    selectedState
  };
}

async function joinGuestRoom(guest, roomId) {
  await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`);
  return waitForValue(
    "guest room joined",
    () => getAppState(guest),
    (state) => state?.connectionStatus === "connected" && state?.room?.roomId === roomId,
    DEFAULT_TIMEOUT_MS
  );
}

async function ensurePlayback(client, label, expectedUrlFragment) {
  await attemptPlayback(client);

  return waitForValue(
    `${label} playback`,
    () => getVideoSnapshot(client),
    (snapshot) =>
      Boolean(snapshot) &&
      !snapshot.paused &&
      !snapshot.ended &&
      !snapshot.error &&
      Number(snapshot.duration) > 0 &&
      Number(snapshot.videoWidth) > 0 &&
      Number(snapshot.videoHeight) > 0 &&
      Number(snapshot.currentTime) > 1.5 &&
      (!expectedUrlFragment || snapshot.currentSrc.includes(expectedUrlFragment)),
    DEFAULT_TIMEOUT_MS
  );
}

async function waitForGuestTorrentReady(guest, magnetLink, roomId) {
  return waitForValue(
    "guest torrent ready",
    async () => ({
      app: await getAppState(guest),
      player: await getLocalPlayerState(guest),
      video: await getVideoSnapshot(guest)
    }),
    (state) =>
      state.app?.room?.roomId === roomId &&
      state.app?.torrentSession?.magnetUri === magnetLink &&
      state.app?.selectedLocalFile?.magnetUri === magnetLink &&
      state.player?.mediaUrl &&
      state.player?.roomTransferState?.isPlaybackReady === true &&
      state.video &&
      !state.video.error &&
      Number(state.video.duration) > 0 &&
      Number(state.video.videoWidth) > 0 &&
      Number(state.video.videoHeight) > 0,
    DEFAULT_TIMEOUT_MS
  );
}

async function runMagnetRound({ host, guest, magnetLink, label, previousMediaUrl }) {
  await ensureLobby(host, `${label} host`);
  await ensureLobby(guest, `${label} guest`);

  const { roomId, selectedTorrentFile, selectedState } = await createMagnetRoom(host, magnetLink);
  await joinGuestRoom(guest, roomId);

  const expectedFileName = encodeURIComponent(selectedTorrentFile.name);
  const hostPlayback = await ensurePlayback(host, `${label} host`, expectedFileName);
  const guestReady = await waitForGuestTorrentReady(guest, magnetLink, roomId);
  const guestPlayback = await ensurePlayback(guest, `${label} guest`, expectedFileName);

  if (previousMediaUrl && guestReady.player.mediaUrl === previousMediaUrl) {
    throw new Error(`${label} guest reused previous media URL.`);
  }

  if (guestReady.player.roomTransferState.bytesTotal !== selectedTorrentFile.size) {
    throw new Error(
      `${label} guest bytesTotal mismatch: expected ${selectedTorrentFile.size}, got ${guestReady.player.roomTransferState.bytesTotal}`
    );
  }

  if (guestReady.app.room.mediaSource.fileSize !== selectedTorrentFile.size) {
    throw new Error(
      `${label} room fileSize mismatch: expected ${selectedTorrentFile.size}, got ${guestReady.app.room.mediaSource.fileSize}`
    );
  }

  const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), `syncplay-${label}-`));
  const hostScreenshotPath = await host.captureScreenshot(path.join(screenshotDir, "host.png"));
  const guestScreenshotPath = await guest.captureScreenshot(path.join(screenshotDir, "guest.png"));
  const hostScreenshotAnalysis = await analyzeScreenshot(hostScreenshotPath);
  const guestScreenshotAnalysis = await analyzeScreenshot(guestScreenshotPath);

  if (hostScreenshotAnalysis.maxChannel <= 10 || hostScreenshotAnalysis.averageBrightness <= 3) {
    throw new Error(`${label} host screenshot appears too dark: ${JSON.stringify(hostScreenshotAnalysis)}`);
  }

  if (guestScreenshotAnalysis.maxChannel <= 10 || guestScreenshotAnalysis.averageBrightness <= 3) {
    throw new Error(`${label} guest screenshot appears too dark: ${JSON.stringify(guestScreenshotAnalysis)}`);
  }

  return {
    label,
    magnetLink,
    roomId,
    selectedTorrentFile,
    host: {
      selectedLocalFile: selectedState.selectedLocalFile,
      playback: hostPlayback,
      screenshotAnalysis: hostScreenshotAnalysis,
      screenshotPath: hostScreenshotPath
    },
    guest: {
      selectedLocalFile: guestReady.app.selectedLocalFile,
      torrentSession: guestReady.app.torrentSession,
      transferState: guestReady.player.roomTransferState,
      mediaUrl: guestReady.player.mediaUrl,
      playback: guestPlayback,
      screenshotAnalysis: guestScreenshotAnalysis,
      screenshotPath: guestScreenshotPath
    }
  };
}

async function main() {
  const [hostTarget] = await waitForTargets(cdpPort, 1);
  const host = await connectToTarget(hostTarget);
  let guest = null;

  try {
    await waitForTestHook(host, "host test hook");
    await host.evaluate("window.syncplayDesktop.openDesktopWindow()");
    const targets = await waitForTargets(cdpPort, 2);
    const guestTarget = targets.find((target) => target.id !== hostTarget.id);

    if (!guestTarget) {
      throw new Error("Guest window target not found.");
    }

    guest = await connectToTarget(guestTarget);
    await waitForTestHook(guest, "guest test hook");

    const firstRun = await runMagnetRound({
      host,
      guest,
      magnetLink: firstMagnet,
      label: "first-magnet"
    });

    await host.evaluate("window.__syncplayTest.leaveCurrentRoom?.()");
    await waitForValue("host left first room", () => getAppState(host), (state) => !state?.room, DEFAULT_TIMEOUT_MS);
    await waitForValue("guest returned to lobby", () => getAppState(guest), (state) => !state?.room, DEFAULT_TIMEOUT_MS);

    const secondRun = await runMagnetRound({
      host,
      guest,
      magnetLink: secondMagnet,
      label: "second-magnet",
      previousMediaUrl: firstRun.guest.mediaUrl
    });

    console.log(JSON.stringify({ firstRun, secondRun }, null, 2));
  } finally {
    if (guest) {
      await guest.close().catch(() => undefined);
    }

    await host.close().catch(() => undefined);
  }
}

await main();
