// Creates a local-file room, joins it from a second window, and samples the
// guest every 500 ms. Prints state changes and a final RESULT line with what a
// viewer experiences: time from joining to playback, and seconds spent frozen
// while the room is playing (rebuffering).
// Usage: node scripts/bench-transfer/probe-guest.mjs <cdp-port> <file> [seconds] [result.json]
import {
  connectToTarget,
  getAppState,
  getLocalPlayerState,
  getVideoSnapshot,
  jsString,
  waitForTargets,
  waitForTestHook,
  waitForValue
} from "../perf-shared.mjs";

import { appendFile } from "node:fs/promises";

const [, , cdpPort, filePath, secondsArg = "60", resultPath] = process.argv;
const QUIET = process.env.PROBE_QUIET === "1";
const [hostTarget] = await waitForTargets(Number(cdpPort), 1);
const host = await connectToTarget(hostTarget);
await waitForTestHook(host, "host test hook");
await host.evaluate("window.syncplayDesktop.openDesktopWindow()");
const targets = await waitForTargets(Number(cdpPort), 2);
const guest = await connectToTarget(targets.find((target) => target.id !== hostTarget.id));
await waitForTestHook(guest, "guest test hook");

await host.evaluate('window.__syncplayTest.selectSourceOption("local_file")');
await host.evaluate(`window.__syncplayTest.selectLocalFileByPath(${jsString(filePath)})`);
await waitForValue("file", () => getAppState(host), (state) => Boolean(state?.selectedLocalFile?.fileId), 60_000);
await host.evaluate("window.__syncplayTest.createCurrentRoom()");
const hostState = await waitForValue("room", () => getAppState(host), (state) => Boolean(state?.room?.roomId), 60_000);
await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(hostState.room.roomId)})`);
const start = Date.now();
let last = "";
let readyAt = null;
let relayAt = null;
let playingAt = null;
let frozenMs = 0;
let lastSample = null;
while (Date.now() - start < Number(secondsArg) * 1000) {
  const sampleStart = Date.now();
  const [player, video, app] = await Promise.all([getLocalPlayerState(guest), getVideoSnapshot(guest), getAppState(guest)]);
  const sampleMs = Date.now() - sampleStart;
  if (sampleMs > 2000) console.log(`SLOW_SAMPLE ${sampleMs}ms at ${((sampleStart - start) / 1000).toFixed(1)}s (guest renderer unresponsive)`);
  const t = player?.roomTransferState ?? {};
  const line = JSON.stringify({
    phase: t.phase,
    msg: t.message,
    ready: t.isPlaybackReady,
    pendingSeek: t.pendingSeekTime,
    contigMiB: Math.round((player?.contiguousBytes ?? 0) / 1048576),
    ct: video ? Math.round(video.currentTime * 10) / 10 : null,
    rs: video?.readyState,
    buf: await guest.evaluate(
      "(() => { const v = document.querySelector('video'); return v ? Array.from({ length: v.buffered.length }, (_, i) => [Math.round(v.buffered.start(i)), Math.round(v.buffered.end(i))]) : null })()"
    ),
    ranges: (player?.availableRanges ?? []).map((range) => [Math.round(range.startByte / 1048576), Math.round(range.endByte / 1048576)]),
    paused: video?.paused,
    lanes: (player?.lanes ?? []).map((lane) => `${lane.index}:${lane.connectionState[0]}${lane.channelState?.[0] ?? "-"}${lane.stalled ? "S" : ""}`).join(" "),
    inflight: (player?.inFlightRequests ?? []).map((request) => `${request.lane}@${Math.round(request.startByte / 1048576)}`).join(" "),
    roomState: app?.room?.playbackState,
    roomTime: app?.room?.currentTime
  });
  const now = Date.now();
  if (!QUIET && line !== last) console.log(`${((now - start) / 1000).toFixed(1)}s ${line}`);
  last = line;
  if (readyAt === null && t.isPlaybackReady) readyAt = now - start;
  if (relayAt === null && (t.transportMode === "relay_http" || /relay/i.test(t.message ?? ""))) relayAt = now - start;
  if (playingAt === null && video && !video.paused && video.currentTime >= 1.5) playingAt = now - start;
  // Rebuffering: the room is playing, the guest has started, but its video didn't advance.
  if (playingAt !== null && lastSample && app?.room?.playbackState === "playing" && video) {
    if (video.currentTime - lastSample.ct < 0.05) frozenMs += now - lastSample.at;
  }
  if (video) lastSample = { ct: video.currentTime, at: now };
  if (playingAt !== null && now - start - playingAt > 60_000) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const result = { joinToReadyMs: readyAt, joinToPlaybackMs: playingAt, rebufferingSeconds: frozenMs / 1000, relayFallbackAtMs: relayAt };
console.log(`RESULT ${JSON.stringify(result)}`);
if (resultPath && resultPath !== "/dev/null") await appendFile(resultPath, `${JSON.stringify(result)}\n`);
await guest.close();
await host.close();
