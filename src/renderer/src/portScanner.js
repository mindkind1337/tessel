// i18n-pending: text here does not go through t() yet
// Scans the live ports of every workspace copy, like Orca's
// WorkspacePortScanner (MIT, Copyright (c) 2026 Lovecast Inc.): every 30 s
// while the window is visible, at once when it becomes visible again, and
// shortly after the panes change (a new pane, a closed one). Nothing runs
// while the window is hidden.
import { reactive, watch } from 'vue'

export const WORKSPACE_PORT_SCAN_INTERVAL_MS = 30000
const PROBES_SETTLE_MS = 1500

// getProbes: () => [{ id, pids, path }]; api: { scanPorts, killPort }.
export function createPortScanner({
  getProbes,
  api = typeof window !== 'undefined' ? window.shellApi : null,
  doc = typeof document !== 'undefined' ? document : null,
  intervalMs = WORKSPACE_PORT_SCAN_INTERVAL_MS,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (t) => clearInterval(t),
  setDelay = (fn, ms) => setTimeout(fn, ms),
  clearDelay = (t) => clearTimeout(t)
} = {}) {
  const state = reactive({
    byCard: {}, // card key -> [port]
    external: [], // listeners owned by no workspace (Orca's "External Ports")
    scannedAt: 0,
    refreshing: false,
    unavailableReason: ''
  })
  let timer = null
  let settle = null
  let inFlight = null
  let stopWatch = null

  const visible = () => !doc || doc.visibilityState !== 'hidden'

  async function refresh() {
    if (!api || !api.scanPorts) return
    if (inFlight) return inFlight
    state.refreshing = true
    inFlight = (async () => {
      try {
        const res = await api.scanPorts({ probes: getProbes() })
        if (res && res.ok) {
          state.byCard = res.ports || {}
          state.external = Array.isArray(res.external) ? res.external : []
          state.scannedAt = res.scannedAt || Date.now()
          state.unavailableReason = ''
        } else {
          state.unavailableReason = (res && (res.unavailableReason || res.error)) || 'Workspace port scan failed.'
        }
      } catch (e) {
        state.unavailableReason = e.message || 'Workspace port scan failed.'
      } finally {
        state.refreshing = false
        inFlight = null
      }
    })()
    return inFlight
  }

  function startTimer() {
    if (timer === null) timer = setTimer(() => visible() && refresh(), intervalMs)
  }
  function stopTimer() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  function onVisibility() {
    if (visible()) {
      refresh()
      startTimer()
    } else stopTimer()
  }

  function start(source) {
    if (doc) doc.addEventListener('visibilitychange', onVisibility)
    if (visible()) {
      refresh()
      startTimer()
    }
    if (source) {
      stopWatch = watch(source, () => {
        if (settle) clearDelay(settle)
        settle = setDelay(() => {
          settle = null
          if (visible()) refresh()
        }, PROBES_SETTLE_MS)
      })
    }
  }

  function stop() {
    stopTimer()
    if (settle) clearDelay(settle)
    settle = null
    if (doc) doc.removeEventListener('visibilitychange', onVisibility)
    if (stopWatch) stopWatch()
    stopWatch = null
  }

  // Orca's Stop Process: main re-scans before it stops anything.
  async function kill(port) {
    if (!api || !api.killPort) return { ok: false, reason: 'Restart Tessel to enable this.' }
    const res = await api.killPort({ probes: getProbes(), pid: port.pid, port: port.port })
    if (res && res.ok) {
      // A refresh already running started before the stop: wait, then list again.
      if (inFlight) await inFlight
      await refresh()
    }
    return res || { ok: false, reason: 'Failed to stop the process.' }
  }

  return { state, refresh, start, stop, kill }
}

// Orca's workspace-port-urls.ts.
function hostForLocalAction(host) {
  if (!host) return 'localhost'
  return host.includes(':') ? `[${host}]` : host
}

export function addressForPort(port) {
  return `${hostForLocalAction(port.connectHost)}:${port.port}`
}

export function browserUrlForPort(port) {
  const protocol = port.protocol === 'https' ? 'https' : 'http'
  return `${protocol}://${hostForLocalAction(port.connectHost)}:${port.port}`
}
