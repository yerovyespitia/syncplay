import {
  DEFAULT_TIMEOUT_MS,
  connectToTarget,
  getAppState,
  getLocalPlayerState,
  getVideoSnapshot,
  jsString,
  waitForTargets,
  waitForTestHook,
  waitForValue
} from "./perf-shared.mjs"

const [, , cdpPortArg, sourceKind, sourceValue, scenario = "bidirectional"] = process.argv

if (!cdpPortArg || !sourceKind || !sourceValue || !["local", "magnet"].includes(sourceKind)) {
  console.error("Usage: node scripts/e2e-resync.mjs <cdp-port> <local|magnet> <file-path|magnet-link> [bidirectional|host-ahead]")
  process.exit(1)
}

const cdpPort = Number(cdpPortArg)

if (!Number.isFinite(cdpPort) || cdpPort <= 0) {
  console.error(`Invalid CDP port: ${cdpPortArg}`)
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

async function clickButtonContaining(client, text) {
  return client.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes(${jsString(text)})
    )

    if (!button || button.disabled) {
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

async function selectSource(host) {
  if (sourceKind === "local") {
    await host.evaluate('window.__syncplayTest.selectSourceOption("local_file")')
    await host.evaluate(`window.__syncplayTest.selectLocalFileByPath(${jsString(sourceValue)})`)
    await waitForValue(
      "selected local file",
      () => getAppState(host),
      (state) => Boolean(state?.selectedLocalFile?.fileId)
    )
    return getAppState(host)
  }

  await host.evaluate('window.__syncplayTest.selectSourceOption("torrent_magnet")')
  await setMagnetLinkInUi(host, sourceValue)
  await clickButtonContaining(host, "Resolve magnet")

  const torrentState = await waitForValue(
    "resolved magnet metadata",
    () => getAppState(host),
    (state) => Boolean(state?.torrentSession?.files?.length)
  )

  const selectedTorrentFile = torrentState.torrentSession.files[0]
  await selectTorrentFileInUi(host, selectedTorrentFile.index)
  await waitForValue(
    "selected torrent file",
    () => getAppState(host),
    (state) => state?.selectedLocalFile?.type === "torrent_magnet" && Boolean(state?.selectedLocalFile?.fileId)
  )

  return { ...(await getAppState(host)), selectedTorrentFile }
}

async function waitForLoadedVideo(client, label) {
  return waitForValue(
    `${label} video loaded`,
    () => getVideoSnapshot(client),
    (snapshot) =>
      Boolean(snapshot) &&
      Boolean(snapshot.currentSrc) &&
      !snapshot.error &&
      Number(snapshot.duration) > 0 &&
      Number(snapshot.videoWidth) > 0 &&
      Number(snapshot.videoHeight) > 0,
    DEFAULT_TIMEOUT_MS
  )
}

async function waitForGuestLoaded(client) {
  return waitForValue(
    "guest local player loaded",
    () => getLocalPlayerState(client),
    (state) => {
      const video = state?.video

      return (
        Boolean(state?.mediaUrl) &&
        Boolean(video?.currentSrc) &&
        !video?.error &&
        Number(video?.duration) > 0 &&
        Number(video?.videoWidth) > 0 &&
        Number(video?.videoHeight) > 0
      )
    },
    DEFAULT_TIMEOUT_MS
  )
}

async function pausePlayback(client) {
  await client.evaluate(`(() => {
    const video = document.querySelector("video")
    if (!video) {
      return false
    }

    video.pause()
    return true
  })()`)
}

async function setCurrentTimeAndClickResync(client, nextTime) {
  const result = await client.evaluate(`(() => {
    const video = document.querySelector("video")
    const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Resync")
    )

    if (!video || !button || button.disabled) {
      return { ok: false }
    }

    video.currentTime = ${nextTime}
    const actorTime = video.currentTime
    button.click()
    return { ok: true, actorTime }
  })()`)

  if (!result?.ok) {
    throw new Error("Could not set currentTime and click Resync.")
  }

  return result.actorTime
}

async function waitForAligned(left, right, label, toleranceSeconds = 2, timeoutMs = 30_000) {
  return waitForValue(
    label,
    async () => ({
      left: await getVideoSnapshot(left),
      right: await getVideoSnapshot(right)
    }),
    (snapshot) =>
      Boolean(snapshot.left) &&
      Boolean(snapshot.right) &&
      Math.abs(snapshot.left.currentTime - snapshot.right.currentTime) <= toleranceSeconds,
    timeoutMs
  )
}

async function verifyResync({ actor, follower, actorLabel, followerLabel, targetTime }) {
  const followerBefore = await getVideoSnapshot(follower)
  const initialDrift = Math.abs(targetTime - followerBefore.currentTime)

  if (initialDrift < 5) {
    throw new Error(
      `Failed to create visible drift before resync. ${actorLabel}=${targetTime}, ${followerLabel}=${followerBefore.currentTime}`
    )
  }

  const actorTimeBeforeClick = await setCurrentTimeAndClickResync(actor, targetTime)
  const alignedAfter = await waitForAligned(actor, follower, `${followerLabel} after ${actorLabel} resync`)

  return {
    actorLabel,
    followerLabel,
    targetTime,
    before: {
      actorTime: actorTimeBeforeClick,
      followerTime: followerBefore.currentTime,
      drift: initialDrift
    },
    after: {
      actorTime: alignedAfter.left.currentTime,
      followerTime: alignedAfter.right.currentTime,
      drift: Math.abs(alignedAfter.left.currentTime - alignedAfter.right.currentTime)
    }
  }
}

async function verifyHostAheadResync({ host, guest, duration }) {
  const hostBefore = await getVideoSnapshot(host)
  const guestBefore = await getVideoSnapshot(guest)
  const targetTime = Math.min(hostBefore.currentTime + 75, duration - 20)

  if (targetTime - guestBefore.currentTime < 30) {
    throw new Error(
      `Could not create host-ahead drift. host=${hostBefore.currentTime}, guest=${guestBefore.currentTime}, target=${targetTime}`
    )
  }

  const actorTimeBeforeClick = await setCurrentTimeAndClickResync(host, targetTime)

  await waitForValue(
    "guest pending host-ahead seek",
    () => getLocalPlayerState(guest),
    (state) =>
      state?.roomTransferState?.pendingSeekTime !== undefined &&
      Math.abs(state.roomTransferState.pendingSeekTime - targetTime) <= 1.5,
    30_000
  )

  const alignedAfter = await waitForAligned(host, guest, "guest after host-ahead resync", 2.5, DEFAULT_TIMEOUT_MS)

  return {
    actorLabel: "host",
    followerLabel: "guest",
    targetTime,
    before: {
      actorTime: actorTimeBeforeClick,
      followerTime: guestBefore.currentTime,
      drift: Math.abs(actorTimeBeforeClick - guestBefore.currentTime)
    },
    after: {
      actorTime: alignedAfter.left.currentTime,
      followerTime: alignedAfter.right.currentTime,
      drift: Math.abs(alignedAfter.left.currentTime - alignedAfter.right.currentTime)
    }
  }
}

async function main() {
  const [hostTarget] = await waitForTargets(cdpPort, 1)
  const host = await connectToTarget(hostTarget)

  try {
    await waitForTestHook(host, "host test hook")
    const selectedSource = await selectSource(host)

    await host.evaluate("window.__syncplayTest.createCurrentRoom()")
    const hostState = await waitForValue(
      "created room",
      () => getAppState(host),
      (state) => Boolean(state?.room?.roomId)
    )
    const roomId = hostState.room.roomId

    await host.evaluate("window.syncplayDesktop.openDesktopWindow()")
    const targets = await waitForTargets(cdpPort, 2)
    const guestTarget = targets.find((target) => target.id !== hostTarget.id)

    if (!guestTarget) {
      throw new Error("Guest window target not found.")
    }

    const guest = await connectToTarget(guestTarget)

    try {
      await waitForTestHook(guest, "guest test hook")
      await guest.evaluate(`window.__syncplayTest.joinRoomByCode(${jsString(roomId)})`)
      await waitForValue(
        "guest room connection",
        () => getAppState(guest),
        (state) => state?.connectionStatus === "connected" && state?.room?.roomId === roomId
      )

      const hostLoaded = await waitForLoadedVideo(host, "host")
      const guestLoaded = await waitForGuestLoaded(guest)

      await waitForValue(
        "active playback",
        async () => ({
          host: await getVideoSnapshot(host),
          guest: await getVideoSnapshot(guest)
        }),
        (snapshot) =>
          Boolean(snapshot.host) &&
          Boolean(snapshot.guest) &&
          !snapshot.host.paused &&
          !snapshot.guest.paused &&
          snapshot.host.currentTime > 18 &&
          snapshot.guest.currentTime > 18,
        DEFAULT_TIMEOUT_MS
      )

      const guestBeforeDrift = await getVideoSnapshot(guest)
      const duration = Math.min(hostLoaded.duration, guestLoaded.video.duration)

      if (scenario === "host-ahead") {
        const hostAhead = await verifyHostAheadResync({ host, guest, duration })

        console.log(
          JSON.stringify(
            {
              sourceKind,
              sourceValue,
              scenario,
              selectedSource,
              roomId,
              checks: [hostAhead]
            },
            null,
            2
          )
        )
        return
      }

      const guestTargetTime = Math.max(1, guestBeforeDrift.currentTime - 8)

      if (guestBeforeDrift.currentTime - guestTargetTime < 5) {
        throw new Error(`Not enough playback time to create guest drift. current=${guestBeforeDrift.currentTime}`)
      }

      const guestToHost = await verifyResync({
        actor: guest,
        follower: host,
        actorLabel: "guest",
        followerLabel: "host",
        targetTime: guestTargetTime
      })

      const hostBeforeDrift = await getVideoSnapshot(host)
      const hostTargetTime = Math.max(1, hostBeforeDrift.currentTime - 8)

      if (hostBeforeDrift.currentTime - hostTargetTime < 5) {
        throw new Error(`Not enough playback time to create host drift. current=${hostBeforeDrift.currentTime}`)
      }

      const hostToGuest = await verifyResync({
        actor: host,
        follower: guest,
        actorLabel: "host",
        followerLabel: "guest",
        targetTime: hostTargetTime
      })

      console.log(
        JSON.stringify(
          {
            sourceKind,
            sourceValue,
            scenario,
            selectedSource,
            roomId,
            checks: [guestToHost, hostToGuest]
          },
          null,
          2
        )
      )
    } finally {
      await guest.close()
    }
  } finally {
    await host.close()
  }
}

await main()
