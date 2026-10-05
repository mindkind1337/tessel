// listSessions (agentSessions.js) answered by its own process
// (sessionListWorker.js), so reading the transcripts never freezes the
// window. Started on the first ask, stopped after IDLE_MS without one. If it
// cannot start, fails or does not answer in time, the list is read here as
// before (fallback).
const IDLE_MS = 2 * 60 * 1000
const REPLY_MS = 30 * 1000

export function createSessionLister({ fork, fallback, timers = globalThis, idleMs = IDLE_MS, replyMs = REPLY_MS, log = null }) {
  let child = null
  let nextId = 0
  let idleTimer = null
  let closed = false
  const waiting = new Map() // id -> { resolve, args, timer }

  function settle(id, rows, failed) {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    timers.clearTimeout(w.timer)
    if (failed) w.resolve(runFallback(w.args))
    else w.resolve(rows)
    armIdle()
  }
  function runFallback(args) {
    try {
      return fallback(...args)
    } catch {
      return []
    }
  }
  function armIdle() {
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = null
    if (!child || waiting.size) return
    idleTimer = timers.setTimeout(() => {
      idleTimer = null
      if (child && !waiting.size) stop()
    }, idleMs)
    if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref()
  }
  function ensureChild() {
    if (child || closed || typeof fork !== 'function') return child
    try {
      const c = fork()
      c.on('message', (msg) => {
        if (!msg || !waiting.has(msg.id)) return
        settle(msg.id, Array.isArray(msg.rows) ? msg.rows : [], !Array.isArray(msg.rows))
      })
      c.on('exit', () => {
        if (child !== c) return
        child = null
        for (const id of [...waiting.keys()]) settle(id, null, true)
      })
      child = c
    } catch (err) {
      child = null
      if (log) log.warn('sessions', `the session list process did not start: ${err && err.message}`) // i18n-ignore
    }
    return child
  }
  function stop() {
    const c = child
    child = null
    if (c) {
      try {
        c.kill()
      } catch {
        /* already gone */
      }
    }
    for (const id of [...waiting.keys()]) settle(id, null, true)
  }
  function list(...args) {
    const c = ensureChild()
    if (!c) return Promise.resolve(runFallback(args))
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = null
    return new Promise((resolve) => {
      const id = ++nextId
      const timer = timers.setTimeout(() => settle(id, null, true), replyMs)
      waiting.set(id, { resolve, args, timer })
      try {
        c.postMessage({ id, args })
      } catch {
        settle(id, null, true)
      }
    })
  }
  return {
    list,
    close() {
      closed = true
      stop()
    }
  }
}
