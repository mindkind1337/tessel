// The window's memory in the log: its page's process is read every everyMs,
// and a size over warnMB, or a rise of riseMB within riseWindowMs, is written
// at once, then at most once every quietMs.
//
// Why: on 2026-10-25 the window grew by 7 GB in a minute while a remote
// project was shown (its Changes list held every untracked file of a
// server's huge tree) and froze; the log only said "renderer unresponsive".
//
// pid() -> the page's OS process id (0: no window). metrics() ->
// app.getAppMetrics() ([{ pid, memory: { privateBytes?, workingSetSize } }],
// in KB). context() -> more to say (the project shown). log(message).
export function watchWindowMemory({
  pid,
  metrics,
  log,
  context,
  everyMs = 15000,
  warnMB = 2048,
  riseMB = 1024,
  riseWindowMs = 60000,
  quietMs = 300000,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval
} = {}) {
  let samples = [] // { t, mb } of the current page process, newest last
  let lastPid = 0
  let lastReport = -Infinity

  const safe = (fn, fallback) => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }

  function tick() {
    const p = safe(() => pid(), 0)
    if (!p) return
    // A new page process (a reload, a crash): its own history.
    if (p !== lastPid) {
      lastPid = p
      samples = []
    }
    const m = safe(() => (metrics() || []).find((x) => x && x.pid === p), null)
    const kb = m && m.memory ? m.memory.privateBytes || m.memory.workingSetSize : 0
    if (!(kb > 0)) return
    const t = now()
    const mb = Math.round(kb / 1024)
    samples = samples.filter((s) => t - s.t <= riseWindowMs)
    samples.push({ t, mb })
    const low = Math.min(...samples.map((s) => s.mb))
    const rise = mb - low
    if (mb < warnMB && rise < riseMB) return
    if (t - lastReport < quietMs) return
    lastReport = t
    const ctx = safe(() => (context ? context() : ''), '')
    const risen = rise >= 100 ? ` (+${rise} MB in ${Math.round(riseWindowMs / 1000)} s)` : ''
    safe(() => log(`the window's page holds ${mb} MB${risen}${ctx ? `, ${ctx}` : ''}`), null)
  }

  const timer = setTimer(tick, everyMs)
  if (timer && timer.unref) timer.unref()
  return { stop: () => clearTimer(timer), tick }
}
