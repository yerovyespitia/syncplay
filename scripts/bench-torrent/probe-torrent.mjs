// Viewer-experience probe for magnet rooms. The host resolves the magnet and
// creates the room; the guest joins with an isolated torrent client (so it
// really downloads from the swarm) and is sampled every 500 ms.
//
// Measures: guest join → playback, seconds frozen while the room plays (first
// 45 s of playback), and seek recovery after the host jumps to 60%.
//
// Usage: node scripts/bench-torrent/probe-torrent.mjs <cdp-port> <magnet> [timeout-seconds] [result.jsonl]
import { appendFile } from "node:fs/promises";

import {
  connectToTarget,
  getAppState,
  getVideoSnapshot,
  jsString,
  waitForTargets,
  waitForTestHook,
  waitForValue
} from "../perf-shared.mjs";

const [, , cdpPort, magnetLink, timeoutArg = "240", resultPath] = process.argv;
const STOP_AFTER_SEEK_MS = Number(process.env.PROBE_STOP_AFTER_SEEK_MS ?? Infinity);
const TIMEOUT_MS = Number(timeoutArg) * 1000;
const PLAYBACK_WINDOW_MS = Number(process.env.PROBE_PLAYBACK_WINDOW_MS ?? 45_000);
const SEEK_FRACTION = 0.6;
const QUIET = process.env.PROBE_QUIET === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const [hostTarget] = await waitForTargets(Number(cdpPort), 1);
const host = await connectToTarget(hostTarget);
await waitForTestHook(host, "host test hook");
await host.evaluate("window.syncplayDesktop.openDesktopWindow()");
const targets = await waitForTargets(Number(cdpPort), 2);
const guest = await connectToTarget(targets.find((target) => target.id !== hostTarget.id));
await waitForTestHook(guest, "guest test hook");
await guest.evaluate("window.__syncplayTest.setForceIsolatedTorrentSessions?.(true)");

// --- Host: resolve magnet, pick the video, create the room --------------------
const hostStart = Date.now();
await host.evaluate('window.__syncplayTest.selectSourceOption("torrent_magnet")');
await waitForValue("magnet input", () => host.evaluate('Boolean(document.querySelector("#magnet-link"))'), Boolean, TIMEOUT_MS);
await host.evaluate(`(() => {
  const input = document.querySelector("#magnet-link");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setValue.call(input, ${jsString(magnetLink)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Resolve magnet"))?.click();
})()`);
const resolved = await waitForValue("host magnet metadata", () => getAppState(host), (state) => Boolean(state?.torrentSession?.files?.length), TIMEOUT_MS);
const hostMetadataMs = Date.now() - hostStart;
const videoFile = resolved.torrentSession.files.reduce((largest, file) => (file.size > largest.size ? file : largest));
// Single-video torrents are auto-selected; otherwise pick the largest video.
if (resolved.torrentSession.files.length > 1) {
  await waitForValue("torrent file select", () => host.evaluate('Boolean(document.querySelector("#torrent-file"))'), Boolean, TIMEOUT_MS);
  await host.evaluate(`(() => {
    const select = document.querySelector("#torrent-file");
    select.value = ${jsString(String(videoFile.index))};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}
await waitForValue("host file selected", () => getAppState(host), (state) => state?.selectedLocalFile?.type === "torrent_magnet" && Boolean(state?.selectedLocalFile?.mediaId), TIMEOUT_MS);
await host.evaluate("window.__syncplayTest.createCurrentRoom()");
const hostState = await waitForValue("room", () => getAppState(host), (state) => Boolean(state?.room?.roomId), TIMEOUT_MS);

// Records media element events so a seek failure can be attributed to a side.
const recordVideoEvents = `(() => {
  window.__probeVideoEvents = [];
  const attach = () => {
    const video = document.querySelector("video");
    if (!video || video.__probeAttached) return;
    video.__probeAttached = true;
    for (const type of ["error", "emptied", "loadstart", "pause", "seeking", "waiting", "abort", "stalled"]) {
      video.addEventListener(type, () => window.__probeVideoEvents.push({
        type, at: Date.now(), ct: Math.round(video.currentTime * 10) / 10, rs: video.readyState,
        error: video.error ? video.error.code + ":" + video.error.message : null, src: video.currentSrc.slice(-60)
      }));
    }
  };
  setInterval(attach, 200);
})()`;
await host.evaluate(recordVideoEvents);
await guest.evaluate(recordVideoEvents);

// PROBE_PLAY_BEFORE_JOIN=1: the host starts playing alone and the guest joins a
// few seconds later (a friend joining a movie that already started).
if (process.env.PROBE_PLAY_BEFORE_JOIN === "1") {
  await host.evaluate("document.querySelector('video')?.play()").catch(() => undefined);
  await sleep(3000);
}

// --- Guest joins; the host presses play right away ----------------------------
await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(hostState.room.roomId)})`);
const joinedAt = Date.now();
await sleep(500);
await host.evaluate("document.querySelector('video')?.play()").catch(() => undefined);

let playingAt = null;
let frozenMs = 0;
let lastSample = null;
let seekIssuedAt = null;
let seekTarget = null;
let seekRecoveredAt = null;
let guestMetadataAt = null;
let lastPlayPressAt = Date.now();
let last = "";

while (Date.now() - joinedAt < TIMEOUT_MS) {
  const [video, app, hostVideo] = await Promise.all([getVideoSnapshot(guest), getAppState(guest), getVideoSnapshot(host)]);
  const now = Date.now();
  const elapsed = now - joinedAt;
  const session = app?.torrentSession;
  if (guestMetadataAt === null && session?.files?.length) guestMetadataAt = elapsed;
  // Real playback: decodable data (readyState >= HAVE_FUTURE_DATA) and the
  // position actually advancing. Room sync can move currentTime on an element
  // that has no data yet, so neither paused nor currentTime alone is enough.
  const advancing = Boolean(video && lastSample && video.currentTime - lastSample.ct >= 0.05 && video.currentTime - lastSample.ct < 2);
  const reallyPlaying = Boolean(video && !video.paused && video.readyState >= 3 && advancing);
  if (playingAt === null && reallyPlaying && video.currentTime >= 1.5) playingAt = elapsed;

  const inSeekPhase = seekIssuedAt !== null;
  // Like a user: when the "waiting for guest" overlay has cleared (guest ready)
  // but the room is paused, the host presses play again. Applies to both versions.
  // PROBE_PLAY_ONCE=1 disables this to reproduce the "play pressed too early" race.
  if (
    process.env.PROBE_PLAY_ONCE !== "1" &&
    !inSeekPhase &&
    app?.room?.playbackState === "paused" &&
    app.room.transferState?.isPlaybackReady &&
    now - lastPlayPressAt > 2000
  ) {
    lastPlayPressAt = now;
    await host.evaluate("document.querySelector('video')?.play()").catch(() => undefined);
  }
  if (playingAt !== null && !inSeekPhase && lastSample && app?.room?.playbackState === "playing" && video) {
    if (!reallyPlaying) frozenMs += now - lastSample.at;
  }
  if (video) lastSample = { ct: video.currentTime, at: now };

  // After the playback window, the host seeks far ahead (pieces nobody has yet).
  if (playingAt !== null && !inSeekPhase && elapsed - playingAt >= PLAYBACK_WINDOW_MS && video?.duration > 0) {
    seekTarget = Math.floor(video.duration * SEEK_FRACTION);
    seekIssuedAt = elapsed;
    // Seek the way a user does: through the player's timeline control.
    await host.evaluate(`(() => {
      const timeline = Array.from(document.querySelectorAll('input[type="range"]')).find((input) => Number(input.max) > 60);
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setValue.call(timeline, String(${seekTarget}));
      timeline.dispatchEvent(new Event("input", { bubbles: true }));
      timeline.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
  }
  if (inSeekPhase && elapsed - seekIssuedAt > STOP_AFTER_SEEK_MS) break;
  const playingPastTarget = (snapshot) =>
    Boolean(snapshot) &&
    !snapshot.paused &&
    snapshot.readyState >= 3 &&
    snapshot.currentTime >= seekTarget + 1.5 &&
    snapshot.currentTime < seekTarget + 30;
  // The seek counts as recovered once host and guest both play at the new spot.
  if (inSeekPhase && seekRecoveredAt === null && playingPastTarget(video) && playingPastTarget(hostVideo)) {
    seekRecoveredAt = elapsed;
    break;
  }

  const line = JSON.stringify({
    phase: session?.phase,
    peers: session?.peerCount,
    dlMiBps: session ? Math.round((session.downloadSpeed / 1048576) * 10) / 10 : null,
    gotMiB: session ? Math.round(session.downloadedBytes / 1048576) : null,
    ct: video ? Math.round(video.currentTime * 10) / 10 : null,
    rs: video?.readyState,
    paused: video?.paused,
    room: app?.room?.playbackState,
    roomT: app?.room ? Math.round(app.room.currentTime) : null,
    hostCt: hostVideo ? Math.round(hostVideo.currentTime * 10) / 10 : null,
    hostRs: hostVideo?.readyState
  });
  if (!QUIET && line !== last) console.log(`${(elapsed / 1000).toFixed(1)}s ${line}`);
  last = line;
  await sleep(500);
}

const result = {
  hostMetadataMs,
  guestMetadataMs: guestMetadataAt,
  joinToPlaybackMs: playingAt,
  rebufferingSeconds: playingAt === null ? null : frozenMs / 1000,
  seekRecoveryMs: seekIssuedAt === null || seekRecoveredAt === null ? null : seekRecoveredAt - seekIssuedAt,
  seekAttempted: seekIssuedAt !== null
};
if (process.env.PROBE_DUMP_EVENTS === "all") {
  for (const [label, client] of [["host", host], ["guest", guest]]) {
    const events = await client.evaluate("window.__probeVideoEvents ?? []");
    for (const event of events.filter((candidate) => candidate.at - joinedAt < 30_000)) {
      console.log(`EVENT ${label} +${event.at - joinedAt}ms ${JSON.stringify({ ...event, at: undefined })}`);
    }
  }
}
if (process.env.PROBE_DUMP_EVENTS === "1" && seekIssuedAt !== null) {
  const seekWallClock = joinedAt + seekIssuedAt;
  for (const [label, client] of [["host", host], ["guest", guest]]) {
    const events = await client.evaluate("window.__probeVideoEvents ?? []");
    for (const event of events.filter((candidate) => candidate.at >= seekWallClock - 500 && candidate.at <= seekWallClock + 8000)) {
      console.log(`EVENT ${label} +${event.at - seekWallClock}ms ${JSON.stringify({ ...event, at: undefined })}`);
    }
  }
}
console.log(`RESULT ${JSON.stringify(result)}`);
if (resultPath && resultPath !== "/dev/null") await appendFile(resultPath, `${JSON.stringify(result)}\n`);
await guest.close();
await host.close();
