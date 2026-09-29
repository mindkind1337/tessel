// After Orca's window-visibility-interval.ts (MIT, Copyright (c) 2026 Lovecast Inc.)

const MAX_VISIBILITY_JITTER_MS = 400

export function isWindowVisible() {
  return (
    typeof document === 'undefined' ||
    document.visibilityState === undefined ||
    document.visibilityState === 'visible'
  )
}

export function installWindowVisibilityInterval(args) {
  const setIntervalFn =
    args.setIntervalFn ?? ((callback, intervalMs) => setInterval(callback, intervalMs))
  const clearIntervalFn = args.clearIntervalFn ?? ((handle) => clearInterval(handle))
  let intervalId = null
  let visibilityJitterId = null
  const visibilityJitterMs = args.jitterOnVisible
    ? Math.max(
        0,
        Math.min(
          MAX_VISIBILITY_JITTER_MS,
          Math.floor(args.jitterFn?.() ?? Math.random() * (MAX_VISIBILITY_JITTER_MS + 1)),
        ),
      )
    : 0

  const stop = () => {
    if (visibilityJitterId !== null) {
      clearTimeout(visibilityJitterId)
      visibilityJitterId = null
    }
    if (intervalId !== null) {
      clearIntervalFn(intervalId)
      intervalId = null
    }
  }
  const start = (jitterVisibleRun) => {
    if (intervalId !== null || !isWindowVisible()) {
      return
    }
    const visibleRun = args.runOnVisible ?? args.run
    if (jitterVisibleRun) {
      visibilityJitterId = setTimeout(() => {
        visibilityJitterId = null
        if (isWindowVisible()) {
          visibleRun()
        }
      }, visibilityJitterMs)
    } else {
      visibleRun()
    }
    // Why: many callers shell out or cross IPC. Keep their interval alive only
    // while Orca can present the refreshed data, but still refresh a visible
    // unfocused window so status UI does not go stale on a second display.
    intervalId = setIntervalFn(args.run, args.intervalMs)
  }
  const reconcile = () => {
    if (isWindowVisible()) {
      start(args.jitterOnVisible === true)
    } else {
      stop()
    }
  }

  start(false)
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', reconcile)
  }
  return () => {
    stop()
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', reconcile)
    }
  }
}
