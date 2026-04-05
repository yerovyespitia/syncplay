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

const [, , cdpPortArg, magnetLink, iterationCountArg = "1", reportPath] = process.argv

if (!cdpPortArg || !magnetLink) {
  console.error("Usage: node scripts/perf-magnet.mjs <cdp-port> <magnet-link> [iteration-count] [report-path]")
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

async function setMagnetLinkInUi(client, value) {
  return client.evaluate(`(() => {
    const input = document.querySelector("#magnet-link")
    if (!input) {
      return false
    }

    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
    descriptor.set.call(input, ${jsString(value)})
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
    return true
  })()`)
}

async function clickResolveMagnet(client) {
  return client.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"))
    const button = buttons.find((candidate) => candidate.textContent?.includes("Resolve magnet"))
    if (!button) {
      return false
    }

    button.click()
    return true
  })()`)
}

async function selectTorrentFileInUi(client, fileIndex) {
  return client.evaluate(`(() => {
    const select = document.querySelector("#torrent-file")
    if (!select) {
      return false
    }

    select.value = ${jsString(String(fileIndex))}
    select.dispatchEvent(new Event("change", { bubbles: true }))
    return true
  })()`)
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

async function createRoomWithMagnet(host, tracker) {
  await host.evaluate('window.__syncplayTest.selectSourceOption("torrent_magnet")')
  await setMagnetLinkInUi(host, magnetLink)
  await clickResolveMagnet(host)
  markMetric(tracker, "magnet_resolve_started")

  const resolvedState = await waitForValue(
    "resolved magnet metadata",
    async () => {
      const state = await getAppState(host)

      if (state?.torrentSession?.files?.length) {
        markMetric(tracker, "magnet_metadata_resolved", {
          sessionId: state.torrentSession.sessionId,
          fileCount: state.torrentSession.files.length,
          peerCount: state.torrentSession.peerCount
        })
      }

      return state
    },
    (state) => Boolean(state?.torrentSession?.files?.length),
    DEFAULT_TIMEOUT_MS
  )

  const selectedTorrentFile = resolvedState.torrentSession.files[0]
  await selectTorrentFileInUi(host, selectedTorrentFile.index)
  markMetric(tracker, "magnet_file_select_started", {
    fileIndex: selectedTorrentFile.index,
    fileName: selectedTorrentFile.name,
    fileSize: selectedTorrentFile.size
  })

  const selectedState = await waitForValue(
    "selected torrent file",
    async () => {
      const state = await getAppState(host)

      if (state?.selectedLocalFile?.type === "torrent_magnet" && state?.selectedLocalFile?.mediaId) {
        markMetric(tracker, "magnet_file_selected", {
          selectedLocalFile: state.selectedLocalFile,
          torrentSession: state.torrentSession
        })
      }

      return state
    },
    (state) => state?.selectedLocalFile?.type === "torrent_magnet" && Boolean(state?.selectedLocalFile?.mediaId),
    DEFAULT_TIMEOUT_MS
  )

  await host.evaluate("window.__syncplayTest.createCurrentRoom()")
  const roomState = await waitForValue(
    "created magnet room",
    () => getAppState(host),
    (state) => Boolean(state?.room?.roomId),
    DEFAULT_TIMEOUT_MS
  )

  return {
    roomState,
    selectedState
  }
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

  return waitForValue(
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
}

async function runIteration(iterationIndex, host, guest) {
  const tracker = createMetricsTracker()

  try {
    await ensureLobby(host)
    await ensureLobby(guest)
    markMetric(tracker, "host_ready")

    const { roomState, selectedState } = await createRoomWithMagnet(host, tracker)
    markMetric(tracker, "room_created", {
      roomId: roomState.room.roomId,
      selectedLocalFile: selectedState.selectedLocalFile
    })

    markMetric(tracker, "guest_window_ready")

    await joinGuestRoom(guest, roomState.room.roomId)
    markMetric(tracker, "guest_joined_room")

    const guestPlayback = await waitForGuestPerformanceMilestones(guest, tracker)
    const guestPlayerState = await getLocalPlayerState(guest)
    const hostAppState = await getAppState(host)

    return {
      iteration: iterationIndex,
      metrics: tracker.marks,
      magnetSession: hostAppState?.torrentSession ?? null,
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
    kind: "magnet_guest_performance",
    generatedAt: new Date().toISOString(),
    magnetLink,
    iterationCount,
    summary: summarizeRuns(runs),
    focusMetrics: {
      host_magnet_resolve_time: buildStats(
        runs
          .map((run) => {
            const start = run.metrics?.magnet_resolve_started?.atMs
            const resolved = run.metrics?.magnet_metadata_resolved?.atMs
            return Number.isFinite(start) && Number.isFinite(resolved) ? resolved - start : null
          })
          .filter((value) => Number.isFinite(value))
      ),
      host_file_select_time: buildStats(
        runs
          .map((run) => {
            const start = run.metrics?.magnet_file_select_started?.atMs
            const selected = run.metrics?.magnet_file_selected?.atMs
            return Number.isFinite(start) && Number.isFinite(selected) ? selected - start : null
          })
          .filter((value) => Number.isFinite(value))
      ),
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
