// Session search, as the main process sees it: a full-text search over what
// was said in the agents' conversations. Opt-in (nothing is read or indexed
// until the user turns it on). The index and its background work run in a
// separate utility process (worker.js, core.js), started only while the
// search is on, so indexing never freezes the window; this side only passes
// the window's requests (the IPC guard lets the main window alone ask) and
// says when the window is hidden (the indexing then waits).
import fs from 'fs'
import { join } from 'path'
import { databaseSize, removeDatabase } from './store.js'

const METHODS = ['status', 'enable', 'disable', 'clear', 'setHistoryDays', 'search']
const REPLY_MS = 15000
const OFF = { available: true, enabled: false, phase: 'idle', filesIndexed: 0, filesDue: 0, filesFailed: 0, sessions: 0, sizeBytes: 0 }

export function createSessionSearch({
  dir,
  // (dir) -> { postMessage(msg), on('message' | 'exit', fn), kill() }: the
  // utility process (Electron's utilityProcess.fork of sessionSearchWorker.js).
  fork,
  isPaused = () => false,
  pausedCheckMs = 2000,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  log = null
} = {}) {
  const policyPath = join(dir, 'session-search', 'policy.json')
  const dbPath = join(dir, 'session-search', 'index.sqlite')
  let child = null
  let nextId = 0
  const waiting = new Map() // id -> { resolve, timer }
  let pausedTimer = null
  let lastPaused = null
  let closed = false

  function policyEnabled() {
    try {
      return JSON.parse(fs.readFileSync(policyPath, 'utf8')).enabled === true
    } catch {
      return false
    }
  }
  function historyDays() {
    try {
      const n = JSON.parse(fs.readFileSync(policyPath, 'utf8')).historyDays
      return Number.isInteger(n) ? n : 90
    } catch {
      return 90
    }
  }

  function settleAll(result) {
    for (const [, w] of waiting) {
      timers.clearTimeout(w.timer)
      w.resolve(result)
    }
    waiting.clear()
  }
  function stopChild() {
    if (pausedTimer) timers.clearInterval(pausedTimer)
    pausedTimer = null
    lastPaused = null
    const c = child
    child = null
    settleAll({ ok: false, code: 'closed' })
    if (c) {
      try {
        c.kill()
      } catch {
        // already gone
      }
    }
  }
  function tellPaused() {
    if (!child) return
    let paused = false
    try {
      paused = !!isPaused()
    } catch {
      paused = false
    }
    if (paused === lastPaused) return
    lastPaused = paused
    child.postMessage({ paused })
  }
  function ensureChild() {
    if (child || closed || typeof fork !== 'function') return child
    try {
      const c = fork(dir)
      c.on('message', (msg) => {
        const w = msg && waiting.get(msg.id)
        if (!w) return
        waiting.delete(msg.id)
        timers.clearTimeout(w.timer)
        w.resolve(msg.result)
      })
      c.on('exit', () => {
        if (child !== c) return
        child = null
        if (pausedTimer) timers.clearInterval(pausedTimer)
        pausedTimer = null
        lastPaused = null
        settleAll({ ok: false, code: 'closed' })
      })
      child = c
      tellPaused()
      pausedTimer = timers.setInterval(tellPaused, pausedCheckMs)
      if (pausedTimer && typeof pausedTimer.unref === 'function') pausedTimer.unref()
    } catch (err) {
      child = null
      if (log) log.warn('sessionSearch', `its process did not start: ${err && err.message}`) // i18n-ignore
    }
    return child
  }
  function call(method, ...args) {
    const c = ensureChild()
    if (!c) return Promise.resolve({ ok: false, code: 'unavailable' })
    return new Promise((resolve) => {
      const id = ++nextId
      const timer = timers.setTimeout(() => {
        waiting.delete(id)
        resolve({ ok: false, code: 'timeout' })
      }, REPLY_MS)
      waiting.set(id, { resolve, timer })
      c.postMessage({ id, method, args })
    })
  }

  const api = {
    // Off: answered here, without starting anything (the index kept on disk,
    // if any, by its size).
    async status() {
      if (!child && !policyEnabled()) return { ...OFF, available: typeof fork === 'function', historyDays: historyDays(), sizeBytes: databaseSize(dbPath) }
      const res = await call('status')
      return res && typeof res.enabled === 'boolean' ? res : { ...OFF, available: false, historyDays: historyDays() }
    },
    enable: () => call('enable'),
    // Stops at once: the indexing's process ends with it (the index stays).
    async disable() {
      const res = child || policyEnabled() ? await call('disable') : { ok: true }
      stopChild()
      return res && res.ok ? res : { ok: true }
    },
    // Off: the files go from here, no process started. On: its process
    // deletes them and starts over from nothing.
    async clear() {
      if (!child && !policyEnabled()) return removeDatabase(dbPath) ? { ok: true } : { ok: false, code: 'busy' }
      return call('clear')
    },
    setHistoryDays: (days) => call('setHistoryDays', days),
    async search(q) {
      if (!child && !policyEnabled()) return { ok: false, code: 'disabled' }
      return call('search', q)
    },
    // Turned on before: its process starts with the app (once Electron is
    // ready), and indexes what changed since.
    start() {
      if (policyEnabled()) ensureChild()
    },
    close() {
      closed = true
      stopChild()
    },
    register(ipcMain) {
      for (const method of METHODS) ipcMain.handle(`sessionSearch:${method}`, (_e, arg) => api[method](arg)) // i18n-ignore
    }
  }
  return api
}
