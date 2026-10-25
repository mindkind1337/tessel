// A save run a moment after the last change, but at the latest maxWaitMs after
// the first change waiting: changes arriving every few hundred milliseconds
// (agents working) push a plain debounce back for ever, and the save that
// finally runs then holds the main process for the whole backlog.
export function createSaveScheduler(run, { quietMs = 500, maxWaitMs = 5000, now = Date.now } = {}) {
  let timer = null
  let first = 0
  function schedule() {
    if (timer) clearTimeout(timer)
    const t = now()
    if (!first) first = t
    const wait = Math.max(0, Math.min(quietMs, first + maxWaitMs - t))
    timer = setTimeout(() => {
      timer = null
      first = 0
      run()
    }, wait)
  }
  // Closing the window: what waits is run now. -> whether anything waited
  function flush() {
    if (!timer) return false
    clearTimeout(timer)
    timer = null
    first = 0
    run()
    return true
  }
  // Forgets what waits (the caller saves it itself). -> whether anything waited
  function cancel() {
    if (!timer) return false
    clearTimeout(timer)
    timer = null
    first = 0
    return true
  }
  // A save that failed: run again in ms, unless a change already waits (it
  // saves everything). It counts as waiting, so closing the window runs it.
  function retry(ms) {
    if (timer) return
    first = now()
    timer = setTimeout(() => {
      timer = null
      first = 0
      run()
    }, ms)
  }
  return { schedule, flush, cancel, retry, pending: () => timer !== null }
}
