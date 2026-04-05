import {
  DEFAULT_TIMEOUT_MS,
  attemptPlayback,
  buildStats,
  collectTransferSummary,
  connectToTarget,
  createMetricsTracker,
  getAppState,
  getLocalPlayerState,
  getVideoSnapshot,
  jsString,
  markMetric,
  printReport,
  summarizeRuns,
  waitForTargets,
  waitForTestHook,
  waitForValue,
  writeReportIfRequested
} from "./perf-shared.mjs"

const [, , cdpPortArg, filePath, iterationCountArg = "1", reportPath] = process.argv

if (!cdpPortArg || !filePath) {
  console.error("Usage: node scripts/perf-local-file.mjs <cdp-port> <file-path> [iteration-count] [report-path]")
  process.exit(1)
}

const cdpPort = Number(cdpPortArg)
const iterationCount = Number(iterationCountArg)

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`)
  process.exit(1)
}

if (!Number.isFinite(iterationCount) || iterationCount <= 0) {
  console.error(`Invalid iteration count: ${iterationCountArg}`)
  process.exit(1)
}

async function openGuestWindow(host, hostTarget) {
  await host.evaluate("window.syncplayDesktop.openDesktopWindow()")
  const targets = await waitForTargets(cdpPort, 2)
  const guestTarget = targets.find((target) => target.id !== hostTarget.id)

  if (!guestTarget) {
    throw new Error("Guest window target not found.")
  }

  return connectToTarget(guestTarget)
}

async function ensureLobby(client) {
  const state = await getAppState(client)

  if (!state?.room) {
    return
  }

  await client.evaluate("window.__syncplayTest.leaveCurrentRoom?.()")
  await waitForValue(
    "window returned to lobby",
    () => getAppState(client),
    (nextState) => !nextState?.room,
    DEFAULT_TIMEOUT_MS
  )
}

async function createRoomWithLocalFile(host, filePath) {
  await host.evaluate('window.__syncplayTest.selectSourceOption("local_file")')
  await host.evaluate(`window.__syncplayTest.selectLocalFileByPath(${jsString(filePath)})`)
  await waitForValue(
    "selected local file",
    () => getAppState(host),
    (state) => Boolean(state?.selectedLocalFile?.fileId),
    DEFAULT_TIMEOUT_MS
  )
  await host.evaluate("window.__syncplayTest.createCurrentRoom()")
  return waitForValue(
    "created local room",
    () => getAppState(host),
    (state) => Boolean(state?.room?.roomId),
    DEFAULT_TIMEOUT_MS
  )
}

async function joinGuestRoom(guest, roomId) {
  await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`)
  return waitForValue(
    "guest room joined",
    () => getAppState(guest),
    (state) => Boolean(state?.room?.roomId),
    DEFAULT_TIMEOUT_MS
  )
}

async function waitForGuestPerformanceMilestones(guest, tracker) {
  await waitForValue(
    "guest transfer state available",
    async () => {
      const state = await getLocalPlayerState(guest)
      const transferState = state?.roomTransferState

      if (transferState?.phase === "connecting_peer") {
        markMetric(tracker, "guest_connecting_peer", collectTransferSummary(transferState))
      }

      if (transferState?.phase === "buffering") {
        markMetric(tracker, "guest_buffering_started", collectTransferSummary(transferState))
      }

      return state
    },
    (state) => Boolean(state?.roomTransferState),
    DEFAULT_TIMEOUT_MS
  )

  await waitForValue(
    "guest media url",
    async () => {
      const state = await getLocalPlayerState(guest)

      if (state?.mediaUrl) {
        markMetric(tracker, "guest_media_url_ready", {
          mediaUrl: state.mediaUrl,
          activeMediaUrlIndex: state.activeMediaUrlIndex
        })
      }

      return state
    },
    (state) => Boolean(state?.mediaUrl),
    DEFAULT_TIMEOUT_MS
  )

  await waitForValue(
    "guest playback ready",
    async () => {
      const state = await getLocalPlayerState(guest)
      const transferState = state?.roomTransferState

      if (transferState?.phase === "ready" && transferState.isPlaybackReady) {
        markMetric(tracker, "guest_ready", collectTransferSummary(transferState))
      }

      return state
    },
    (state) => state?.roomTransferState?.phase === "ready" && state?.roomTransferState?.isPlaybackReady === true,
    DEFAULT_TIMEOUT_MS
  )

  await waitForValue(
    "guest canplay state",
    async () => {
      const snapshot = await getVideoSnapshot(guest)

      if (snapshot && snapshot.readyState >= 3 && !snapshot.error && Number(snapshot.duration) > 0) {
        markMetric(tracker, "guest_canplay", snapshot)
      }

      return snapshot
    },
    (snapshot) => Boolean(snapshot) && snapshot.readyState >= 3 && !snapshot.error && Number(snapshot.duration) > 0,
    DEFAULT_TIMEOUT_MS
  )

  await attemptPlayback(guest)

  const firstPlayback = await waitForValue(
    "guest playback progress",
    async () => {
      const snapshot = await getVideoSnapshot(guest)

      if (
        snapshot &&
        !snapshot.paused &&
        !snapshot.error &&
        Number(snapshot.currentTime) >= 1.5
      ) {
        markMetric(tracker, "guest_first_playback", snapshot)
      }

      return snapshot
    },
    (snapshot) =>
      Boolean(snapshot) &&
      !snapshot.paused &&
      !snapshot.error &&
      Number(snapshot.currentTime) >= 1.5,
    DEFAULT_TIMEOUT_MS
  )

  return firstPlayback
}

async function runIteration(iterationIndex, host, guest) {
  const tracker = createMetricsTracker()

  try {
    await ensureLobby(host)
    await ensureLobby(guest)
    markMetric(tracker, "host_ready")

    const hostState = await createRoomWithLocalFile(host, filePath)
    markMetric(tracker, "room_created", {
      roomId: hostState.room.roomId,
      selectedLocalFile: hostState.selectedLocalFile
    })

    markMetric(tracker, "guest_window_ready")

    await joinGuestRoom(guest, hostState.room.roomId)
    markMetric(tracker, "guest_joined_room")

    const guestPlayback = await waitForGuestPerformanceMilestones(guest, tracker)
    const guestPlayerState = await getLocalPlayerState(guest)
    const hostAppState = await getAppState(host)

    return {
      iteration: iterationIndex,
      metrics: tracker.marks,
      guestTransferState: collectTransferSummary(guestPlayerState?.roomTransferState),
      guestVideo: guestPlayback,
      hostRoomTransferState: collectTransferSummary(hostAppState?.room?.transferState)
    }
  } catch (error) {
    return {
      iteration: iterationIndex,
      metrics: tracker.marks,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function main() {
  const [hostTarget] = await waitForTargets(cdpPort, 1)
  const host = await connectToTarget(hostTarget)
  let guest = null
  const runs = []

  try {
    await waitForTestHook(host, "host test hook")
    guest = await openGuestWindow(host, hostTarget)
    await waitForTestHook(guest, "guest test hook")

    for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
      runs.push(await runIteration(iteration, host, guest))
    }
  } finally {
    if (guest) {
      await guest.close().catch(() => undefined)
    }

    await host.close().catch(() => undefined)
  }

  const report = {
    kind: "local_file_guest_performance",
    generatedAt: new Date().toISOString(),
    filePath,
    iterationCount,
    summary: summarizeRuns(runs),
    focusMetrics: {
      guest_join_to_ready: buildStats(
        runs
          .map((run) => {
            const joined = run.metrics?.guest_joined_room?.atMs
            const ready = run.metrics?.guest_ready?.atMs
            return Number.isFinite(joined) && Number.isFinite(ready) ? ready - joined : null
          })
          .filter((value) => Number.isFinite(value))
      ),
      guest_join_to_canplay: buildStats(
        runs
          .map((run) => {
            const joined = run.metrics?.guest_joined_room?.atMs
            const canplay = run.metrics?.guest_canplay?.atMs
            return Number.isFinite(joined) && Number.isFinite(canplay) ? canplay - joined : null
          })
          .filter((value) => Number.isFinite(value))
      ),
      guest_join_to_first_playback: buildStats(
        runs
          .map((run) => {
            const joined = run.metrics?.guest_joined_room?.atMs
            const playback = run.metrics?.guest_first_playback?.atMs
            return Number.isFinite(joined) && Number.isFinite(playback) ? playback - joined : null
          })
          .filter((value) => Number.isFinite(value))
      )
    },
    runs
  }

  await writeReportIfRequested(reportPath, report)
  printReport(report)
}

await main()
