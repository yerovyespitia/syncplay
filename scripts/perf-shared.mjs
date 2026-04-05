import fs from "node:fs/promises"

export const TARGET_URL_PREFIX = "http://localhost:5173"
export const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000
export const POLL_INTERVAL_MS = 250

export class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.nextId = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true })
      this.ws.addEventListener("error", reject, { once: true })
    })

    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data))

      if (!("id" in message)) {
        return
      }

      const pendingRequest = this.pending.get(message.id)

      if (!pendingRequest) {
        return
      }

      this.pending.delete(message.id)

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message ?? "Unknown CDP error"))
        return
      }

      pendingRequest.resolve(message.result)
    })

    this.ws.addEventListener("close", () => {
      for (const pendingRequest of this.pending.values()) {
        pendingRequest.reject(new Error("CDP connection closed."))
      }

      this.pending.clear()
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = ++this.nextId

    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })

    this.ws.send(JSON.stringify({ id, method, params }))
    return response
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    })

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Runtime evaluation failed."
      throw new Error(description)
    }

    return result.result?.value
  }

  async captureScreenshot(filePath) {
    await this.send("Page.enable")
    const result = await this.send("Page.captureScreenshot", {
      format: "png"
    })
    await fs.writeFile(filePath, Buffer.from(result.data, "base64"))
    return filePath
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close()
    }
  }
}

export async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchTargets(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)

  if (!response.ok) {
    throw new Error(`Failed to fetch CDP targets (${response.status}).`)
  }

  return response.json()
}

export async function waitForTargets(cdpPort, count, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const targets = (await fetchTargets(cdpPort)).filter(
      (target) => target.type === "page" && typeof target.url === "string" && target.url.startsWith(TARGET_URL_PREFIX)
    )

    if (targets.length >= count) {
      return targets
    }

    await delay(POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting for ${count} renderer target(s).`)
}

export async function connectToTarget(target) {
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.send("Runtime.enable")
  return client
}

export async function waitForValue(label, getter, predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastValue = null

  while (Date.now() < deadline) {
    lastValue = await getter()

    if (predicate(lastValue)) {
      return lastValue
    }

    await delay(POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue, null, 2)}`)
}

export function jsString(value) {
  return JSON.stringify(value)
}

export async function waitForTestHook(client, label = "test hook") {
  await waitForValue(
    label,
    () => client.evaluate("Boolean(window.__syncplayTest)"),
    Boolean
  )
}

export async function getAppState(client) {
  return client.evaluate("window.__syncplayTest?.getState?.() ?? null")
}

export async function getLocalPlayerState(client) {
  return client.evaluate("window.__syncplayLocalPlayerDebug?.getState?.() ?? null")
}

export async function getVideoSnapshot(client) {
  return client.evaluate(`(() => {
    const video = document.querySelector("video")

    if (!video) {
      return null
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
    }
  })()`)
}

export async function attemptPlayback(client) {
  return client.evaluate(`(() => {
    const video = document.querySelector("video")
    if (!video) {
      return false
    }

    video.muted = true
    return video.play().then(() => true).catch(() => false)
  })()`)
}

export function createMetricsTracker(startTime = Date.now()) {
  return {
    startTime,
    marks: {}
  }
}

export function markMetric(tracker, name, details) {
  if (tracker.marks[name]) {
    return
  }

  tracker.marks[name] = {
    atMs: Date.now() - tracker.startTime,
    ...(details ? { details } : {})
  }
}

export function collectTransferSummary(transferState) {
  if (!transferState) {
    return null
  }

  return {
    phase: transferState.phase,
    progress: transferState.progress,
    bytesReceived: transferState.bytesReceived,
    bytesPersisted: transferState.bytesPersisted,
    bytesTotal: transferState.bytesTotal,
    bufferedUntilTime: transferState.bufferedUntilTime,
    isPlaybackReady: transferState.isPlaybackReady,
    pendingSeekTime: transferState.pendingSeekTime,
    reconnectAttempt: transferState.reconnectAttempt,
    lastRequestedRange: transferState.lastRequestedRange,
    availableRangeCount: transferState.availableRanges?.length ?? 0,
    message: transferState.message
  }
}

export function buildStats(values) {
  if (!values.length) {
    return null
  }

  const sorted = [...values].sort((left, right) => left - right)
  const sum = sorted.reduce((total, value) => total + value, 0)
  const middleIndex = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? (sorted[middleIndex - 1] + sorted[middleIndex]) / 2
      : sorted[middleIndex]

  return {
    count: sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: Number((sum / sorted.length).toFixed(2)),
    medianMs: Number(median.toFixed(2))
  }
}

export function summarizeRuns(runs) {
  const metricNames = new Set()

  for (const run of runs) {
    for (const metricName of Object.keys(run.metrics ?? {})) {
      metricNames.add(metricName)
    }
  }

  const metrics = {}

  for (const metricName of metricNames) {
    const values = runs
      .map((run) => run.metrics?.[metricName]?.atMs)
      .filter((value) => Number.isFinite(value))
    metrics[metricName] = buildStats(values)
  }

  return {
    totalRuns: runs.length,
    successfulRuns: runs.filter((run) => !run.error).length,
    failedRuns: runs.filter((run) => Boolean(run.error)).length,
    metrics
  }
}

export async function writeReportIfRequested(reportPath, payload) {
  if (!reportPath) {
    return
  }

  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`)
}

export function printReport(payload) {
  console.log(JSON.stringify(payload, null, 2))
}
