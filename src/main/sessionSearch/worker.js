// Session search's own process (a utility process the main process starts
// only once the search is turned on): the index and its background work live
// here, so indexing never takes time from the window's process. It answers
// { id, method, args } with { id, result } and takes { paused } (the window
// is hidden or minimized: the indexing waits).
import { createSessionSearchCore } from './core.js'

const METHODS = ['status', 'enable', 'disable', 'clear', 'setHistoryDays', 'search']

export function serve(port, { dir, home, createCore = createSessionSearchCore } = {}) {
  let paused = false
  const core = createCore({ dir, ...(home ? { home } : {}), isPaused: () => paused })
  port.on('message', (event) => {
    const msg = event && event.data !== undefined ? event.data : event
    if (!msg || typeof msg !== 'object') return
    if (typeof msg.paused === 'boolean') {
      paused = msg.paused
      return
    }
    if (!METHODS.includes(msg.method)) return
    let result
    try {
      result = core[msg.method](...(Array.isArray(msg.args) ? msg.args : []))
    } catch (err) {
      result = { ok: false, code: 'failed', error: String((err && err.message) || err) }
    }
    port.postMessage({ id: msg.id, result })
  })
  return core
}

// Started by Electron's utilityProcess.fork (its data folder as the argument).
if (process.parentPort && typeof process.parentPort.on === 'function') {
  const core = serve(process.parentPort, { dir: process.argv[2] })
  process.on('exit', () => core.close())
}
