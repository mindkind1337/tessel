// listSessions (agentSessions.js) answered by its own process
// (sessionListWorker.js), so reading the transcripts never freezes the
// window. Started on the first ask, stopped after IDLE_MS without one. If it
// cannot start, fails or does not answer in time, the list is read here as
// before (fallback).
//
// call(method, ...args): the other agent file readings done there too (a
// pane's model, its sub-agents, the conversation to resume: see
// sessionListWorker.js METHODS), each with its own fallback here
// (fallbacks[method]) when the process cannot start, dies or cannot send its
// answer. One that does not answer in time is not read here again (that is
// the freeze it avoids): the call fails, and its handler answers as for an
// unreadable file (nothing found).
const IDLE_MS = 2 * 60 * 1000
const REPLY_MS = 30 * 1000

export function createSessionLister({ fork, fallback, fallbacks = {}, timers = globalThis, idleMs = IDLE_MS, replyMs = REPLY_MS, log = null }) {
  let child = null
  let nextId = 0
  let idleTimer = null
  let closed = false
  const waiting = new Map() // id -> { resolve, local, timer, method }

  // failed: its local fallback answers instead (a list, or the method's).
  // error: a method that threw there throws here (never run twice).
  function settle(id, value, failed, error = null) {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    timers.clearTimeout(w.timer)
    if (failed) w.resolve(w.local())
    else if (error !== null) w.resolve(Promise.reject(new Error(error)))
    else w.resolve(value)
    armIdle()
  }
  function runFallback(args) {
    try {
      return fallback(...args)
    } catch {
      return []
    }
  }
  // A method's own fallback, here: its answer, or its error as a rejection
  // (as when it ran here before).
  function runMethod(method, args) {
    const fn = fallbacks[method]
    if (typeof fn !== 'function') return Promise.reject(new Error(`no fallback for ${method}`)) // i18n-ignore internal
    try {
      return Promise.resolve(fn(...args))
    } catch (err) {
      return Promise.reject(err)
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
        const w = waiting.get(msg.id)
        if (w.method) {
          // Its answer could not be sent (not cloneable): read here instead.
          if (msg.failed === true) settle(msg.id, null, true)
          else if (typeof msg.error === 'string') settle(msg.id, null, false, msg.error)
          else settle(msg.id, msg.value, msg.ok !== true)
        }
        else settle(msg.id, Array.isArray(msg.rows) ? msg.rows : [], !Array.isArray(msg.rows))
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
  function ask(message, local, method) {
    const c = ensureChild()
    if (!c) return null
    if (idleTimer) timers.clearTimeout(idleTimer)
    idleTimer = null
    return new Promise((resolve) => {
      const id = ++nextId
      // A list late: read here as before. A method late: failed (above).
      const timer = timers.setTimeout(() => (method ? settle(id, null, false, 'no answer in time') : settle(id, null, true)), replyMs)
      waiting.set(id, { resolve, local, timer, method })
      try {
        c.postMessage({ id, ...message })
      } catch {
        settle(id, null, true)
      }
    })
  }
  function list(...args) {
    return ask({ args }, () => runFallback(args), null) || Promise.resolve(runFallback(args))
  }
  // -> a Promise of the method's answer (or of its fallback's).
  function call(method, ...args) {
    return ask({ method, args }, () => runMethod(method, args), method) || runMethod(method, args)
  }
  return {
    list,
    call,
    close() {
      closed = true
      stop()
    }
  }
}
