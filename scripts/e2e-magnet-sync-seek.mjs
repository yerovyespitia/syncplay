import {
  DEFAULT_TIMEOUT_MS,
  attemptPlayback,
  connectToTarget,
  delay,
  getAppState,
  getLocalPlayerState,
  getVideoSnapshot,
  jsString,
  waitForTargets,
  waitForTestHook,
  waitForValue
} from "./perf-shared.mjs";

const [, , cdpPortArg, magnetLink, targetProgressArg] = process.argv;

if (!cdpPortArg || !magnetLink) {
  console.error("Usage: node scripts/e2e-magnet-sync-seek.mjs <cdp-port> <magnet-link> [target-progress]");
  process.exit(1);
}

const cdpPort = Number(cdpPortArg);
const targetProgress = targetProgressArg === undefined ? 0.8 : Number(targetProgressArg);
const DRIFT_LIMIT_SECONDS = 3;
const SEEK_OFFSET_SECONDS = 40;

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`);
  process.exit(1);
}

if (!Number.isFinite(targetProgress) || targetProgress < 0 || targetProgress > 1) {
  console.error(`Invalid target progress: ${targetProgressArg}`);
  process.exit(1);
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

async function createMagnetRoom(host) {
  await host.evaluate("window.__syncplayTest.setForceIsolatedTorrentSessions(true)");
  await host.evaluate('window.__syncplayTest.selectSourceOption("torrent_magnet")');
  await setMagnetLinkInUi(host, magnetLink);
  await clickButtonContaining(host, "Resolve magnet");

  const resolvedState = await waitForValue(
    "host resolved magnet metadata",
    () => getAppState(host),
    (state) => Boolean(state?.torrentSession?.files?.length),
    DEFAULT_TIMEOUT_MS
  );
  const selectedTorrentFile = resolvedState.torrentSession.files[0];

  await selectTorrentFileInUi(host, selectedTorrentFile.index);
  await waitForValue(
    "host selected torrent file",
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
    selectedTorrentFile
  };
}

async function joinGuestRoom(guest, roomId) {
  await guest.evaluate("window.__syncplayTest.setForceIsolatedTorrentSessions(true)");
  await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`);
  return waitForValue(
    "guest room joined",
    () => getAppState(guest),
    (state) => state?.connectionStatus === "connected" && state?.room?.roomId === roomId,
    DEFAULT_TIMEOUT_MS
  );
}

async function ensurePlayback(client, label) {
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
      Number(snapshot.currentTime) > 1.5,
    DEFAULT_TIMEOUT_MS
  );
}

async function waitForGuestTorrentReady(guest, roomId) {
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

async function waitForDownloadProgress(host, guest) {
  return waitForValue(
    `${Math.round(targetProgress * 100)}% torrent progress on both windows`,
    async () => ({
      host: await getAppState(host),
      guest: await getAppState(guest)
    }),
    (state) =>
      (state.host?.torrentSession?.progress ?? 0) >= targetProgress &&
      (state.guest?.torrentSession?.progress ?? 0) >= targetProgress,
    DEFAULT_TIMEOUT_MS
  );
}

async function userSeekBy(client, offsetSeconds) {
  const stepCount = Math.max(1, Math.round(Math.abs(offsetSeconds) / 10));
  const key = offsetSeconds >= 0 ? "ArrowRight" : "ArrowLeft";

  for (let index = 0; index < stepCount; index += 1) {
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      windowsVirtualKeyCode: key === "ArrowRight" ? 39 : 37,
      nativeVirtualKeyCode: key === "ArrowRight" ? 39 : 37,
      key,
      code: key,
      bubbles: true
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: key === "ArrowRight" ? 39 : 37,
      nativeVirtualKeyCode: key === "ArrowRight" ? 39 : 37,
      key,
      code: key,
      bubbles: true
    });
    await delay(500);
  }

  return getVideoSnapshot(client);
}

async function measureSync(label, host, guest) {
  await delay(5000);
  const snapshot = {
    label,
    host: {
      app: await getAppState(host),
      video: await getVideoSnapshot(host),
      player: await getLocalPlayerState(host)
    },
    guest: {
      app: await getAppState(guest),
      video: await getVideoSnapshot(guest),
      player: await getLocalPlayerState(guest)
    }
  };
  const hostTime = snapshot.host.video?.currentTime ?? NaN;
  const guestTime = snapshot.guest.video?.currentTime ?? NaN;
  const driftSeconds = Math.abs(hostTime - guestTime);
  const hasMatchingPlaybackState = snapshot.host.video?.paused === snapshot.guest.video?.paused;

  return {
    ...snapshot,
    driftSeconds,
    hasMatchingPlaybackState,
    ok: hasMatchingPlaybackState && Number.isFinite(driftSeconds) && driftSeconds <= DRIFT_LIMIT_SECONDS
  };
}

async function assertSync(label, host, guest) {
  const result = await measureSync(label, host, guest);

  if (!result.ok) {
    throw new Error(
      `${label} sync failed: drift ${result.driftSeconds.toFixed(2)}s, hasMatchingPlaybackState=${result.hasMatchingPlaybackState}.\n${JSON.stringify(result, null, 2)}`
    );
  }

  return result;
}

async function resumeBoth(host, guest, label) {
  await ensurePlayback(host, `${label} host`);
  await ensurePlayback(guest, `${label} guest`);
}

async function main() {
  const [hostTarget] = await waitForTargets(cdpPort, 1);
  const host = await connectToTarget(hostTarget);
  let guest = null;

  try {
    await waitForTestHook(host, "host test hook");
    await ensureLobby(host, "host");
    await host.evaluate("window.syncplayDesktop.openDesktopWindow()");
    const targets = await waitForTargets(cdpPort, 2);
    const guestTarget = targets.find((target) => target.id !== hostTarget.id);

    if (!guestTarget) {
      throw new Error("Guest window target not found.");
    }

    guest = await connectToTarget(guestTarget);
    await waitForTestHook(guest, "guest test hook");
    await ensureLobby(guest, "guest");

    const { roomId, selectedTorrentFile } = await createMagnetRoom(host);
    await joinGuestRoom(guest, roomId);
    await ensurePlayback(host, "host");
    await waitForGuestTorrentReady(guest, roomId);
    await ensurePlayback(guest, "guest");
    const progressState = await waitForDownloadProgress(host, guest);

    await resumeBoth(host, guest, "after download");
    const initialSync = await assertSync("initial playback", host, guest);
    const guestSeek = await userSeekBy(guest, SEEK_OFFSET_SECONDS);
    const afterGuestSeek = await assertSync("after guest seek", host, guest);
    await resumeBoth(host, guest, "before host seek");
    const hostSeek = await userSeekBy(host, SEEK_OFFSET_SECONDS);
    const afterHostSeek = await assertSync("after host seek", host, guest);

    console.log(
      JSON.stringify(
        {
          roomId,
          selectedTorrentFile,
          targetProgress,
          progress: {
            host: progressState.host.torrentSession?.progress,
            guest: progressState.guest.torrentSession?.progress
          },
          initialSync,
          guestSeek,
          afterGuestSeek,
          hostSeek,
          afterHostSeek
        },
        null,
        2
      )
    );
  } finally {
    if (guest) {
      await guest.close().catch(() => undefined);
    }

    await host.close().catch(() => undefined);
  }
}

await main();
