import {
  DEFAULT_TIMEOUT_MS,
  attemptPlayback,
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

if (!cdpPortArg || !filePath) {
  console.error("Usage: node scripts/e2e-local-file-host-leave.mjs <cdp-port> <file-path>")
  process.exit(1)
}

const cdpPort = Number(cdpPortArg)

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`)
  process.exit(1)
}

async function openGuestWindow(host, hostTarget) {
  const existingTargets = await waitForTargets(cdpPort, 1)
  const reusableGuestTarget = existingTargets.find((target) => target.id !== hostTarget.id)

  if (reusableGuestTarget) {
    return connectToTarget(reusableGuestTarget)
  }

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

function summarizeState(state) {
  return {
    roomId: state?.room?.roomId ?? null,
    error: state?.error ?? null,
    lastActionLabel: state?.lastActionLabel ?? null,
    recentDebugEntries: Array.isArray(state?.debugEntries)
      ? state.debugEntries.slice(0, 10).map((entry) => ({
          scope: entry.scope,
          message: entry.message
        }))
      : []
  }
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
    const hostRoomState = await waitForValue(
      "created local room",
      () => getAppState(host),
      (state) => Boolean(state?.room?.roomId),
      DEFAULT_TIMEOUT_MS
    )
    const roomId = hostRoomState.room.roomId

    await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`)
    await waitForValue(
      "guest room joined",
      () => getAppState(guest),
      (state) => state?.room?.roomId === roomId,
      DEFAULT_TIMEOUT_MS
    )
    await waitForValue(
      "host local player ready",
      () => getLocalPlayerState(host),
      (state) => Boolean(state?.video?.currentSrc) && Number(state?.video?.duration) > 0,
      DEFAULT_TIMEOUT_MS
    )
    await waitForValue(
      "guest local player ready",
      () => getLocalPlayerState(guest),
      (state) => Boolean(state?.video?.currentSrc) && Number(state?.video?.duration) > 0,
      DEFAULT_TIMEOUT_MS
    )

    await attemptPlayback(host)
    await waitForValue(
      "host playback advanced",
      () => getLocalPlayerState(host),
      (state) => (state?.video?.currentTime ?? 0) > 1.5,
      DEFAULT_TIMEOUT_MS
    )

    await delay(1500)
    await host.evaluate("window.__syncplayTest.leaveCurrentRoom?.()")

    const hostAfterLeave = await waitForValue(
      "host lobby without error",
      () => getAppState(host),
      (state) => !state?.room && !state?.error,
      DEFAULT_TIMEOUT_MS
    )
    const guestAfterLeave = await waitForValue(
      "guest host disconnected message",
      () => getAppState(guest),
      (state) => !state?.room && state?.error === "The host left the room.",
      DEFAULT_TIMEOUT_MS
    )

    console.log(
      JSON.stringify(
        {
          ok: true,
          roomId,
          host: summarizeState(hostAfterLeave),
          guest: summarizeState(guestAfterLeave)
        },
        null,
        2
      )
    )
  } finally {
    await host.close().catch(() => undefined)
    await guest.close().catch(() => undefined)
  }
}

await main()
