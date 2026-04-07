import {
  DEFAULT_TIMEOUT_MS,
  connectToTarget,
  delay,
  getAppState,
  getLocalPlayerState,
  jsString,
  waitForTargets,
  waitForTestHook,
  waitForValue
} from "./perf-shared.mjs"

const [, , cdpPortArg, filePath] = process.argv
const DIAGNOSIS_TIMEOUT_MS = 2 * 60 * 1000

if (!cdpPortArg || !filePath) {
  console.error("Usage: node scripts/diagnose-local-progressive.mjs <cdp-port> <file-path>")
  process.exit(1)
}

const cdpPort = Number(cdpPortArg)

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

async function readResyncDisabled(client) {
  return client.evaluate('Boolean(document.querySelector(".action-button--sync")?.disabled)')
}

async function readDisplayedTime(client) {
  return client.evaluate('document.querySelector(".local-player-time strong")?.textContent ?? null')
}

async function main() {
  const [hostTarget] = await waitForTargets(cdpPort, 1)
  const host = await connectToTarget(hostTarget)
  await waitForTestHook(host, "host test hook")
  const guest = await openGuestWindow(host, hostTarget)
  await waitForTestHook(guest, "guest test hook")

  try {
    await ensureLobby(host)
    await ensureLobby(guest)

    await host.evaluate('window.__syncplayTest.selectSourceOption("local_file")')
    await host.evaluate(`window.__syncplayTest.selectLocalFileByPath(${jsString(filePath)})`)
    await waitForValue(
      "selected local file",
      () => getAppState(host),
      (state) => Boolean(state?.selectedLocalFile?.fileId),
      DEFAULT_TIMEOUT_MS
    )

    await host.evaluate("window.__syncplayTest.createCurrentRoom()")
    const hostState = await waitForValue(
      "created local room",
      () => getAppState(host),
      (state) => Boolean(state?.room?.roomId),
      DEFAULT_TIMEOUT_MS
    )

    await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(hostState.room.roomId)})`)
    await waitForValue(
      "guest room joined",
      () => getAppState(guest),
      (state) => Boolean(state?.room?.roomId),
      DEFAULT_TIMEOUT_MS
    )

    const startedAt = Date.now()
    const samples = []
    let firstReadySample = null
    let firstCanPlaySample = null
    let firstMotionSample = null
    let firstPlaybackSample = null
    let maxProgressWhileFrozen = 0
    let resyncToggleCount = 0
    let lastResyncDisabled = null

    while (Date.now() - startedAt < DIAGNOSIS_TIMEOUT_MS) {
      const [playerState, roomState, resyncDisabled, displayedTime] = await Promise.all([
        getLocalPlayerState(guest),
        getAppState(guest),
        readResyncDisabled(guest),
        readDisplayedTime(guest)
      ])

      const transferState = playerState?.roomTransferState ?? roomState?.room?.transferState ?? null
      const video = playerState?.video ?? null
      const sample = {
        atMs: Date.now() - startedAt,
        phase: transferState?.phase ?? null,
        progress: transferState?.progress ?? null,
        isPlaybackReady: transferState?.isPlaybackReady ?? null,
        currentTime: video?.currentTime ?? null,
        paused: video?.paused ?? null,
        readyState: video?.readyState ?? null,
        currentSrc: video?.currentSrc ?? null,
        resyncDisabled,
        displayedTime
      }

      samples.push(sample)

      if (lastResyncDisabled !== null && lastResyncDisabled !== resyncDisabled) {
        resyncToggleCount += 1
      }
      lastResyncDisabled = resyncDisabled

      if (!firstReadySample && transferState?.isPlaybackReady) {
        firstReadySample = sample
      }

      if (!firstCanPlaySample && video && video.readyState >= 3) {
        firstCanPlaySample = sample
      }

      if (video && Number.isFinite(video.currentTime)) {
        if (video.currentTime < 0.25 && typeof transferState?.progress === "number") {
          maxProgressWhileFrozen = Math.max(maxProgressWhileFrozen, transferState.progress)
        }

        if (!firstMotionSample && video.currentTime >= 0.25) {
          firstMotionSample = sample
        }

        if (!firstPlaybackSample && video.currentTime >= 1.5) {
          firstPlaybackSample = sample
          break
        }
      }

      await delay(500)
    }

    console.log(
      JSON.stringify(
        {
          roomId: hostState.room.roomId,
          filePath,
          firstReadySample,
          firstCanPlaySample,
          firstMotionSample,
          firstPlaybackSample,
          maxProgressWhileFrozen,
          resyncToggleCount,
          lastSamples: samples.slice(-16)
        },
        null,
        2
      )
    )
  } finally {
    await host.evaluate("window.__syncplayTest.leaveCurrentRoom?.()").catch(() => undefined)
    await guest.evaluate("window.__syncplayTest.leaveCurrentRoom?.()").catch(() => undefined)
    await delay(500)
    await host.close()
    await guest.close()
  }
}

await main()
