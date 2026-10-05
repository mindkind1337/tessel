// The past conversations list (Agent Session History) is read here, in a
// utility process the main process starts when the list is asked for: it
// reads hundreds of transcript files, which blocked the window's process for
// 130-250 ms each time (at startup when the panel is open). It answers
// { id, args: [query, home, roots] } with { id, rows } or { id, error }.
import { listSessions } from './agentSessions'

export function serve(port, list = listSessions) {
  port.on('message', (event) => {
    const msg = event && event.data !== undefined ? event.data : event
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.args)) return
    try {
      port.postMessage({ id: msg.id, rows: list(...msg.args) })
    } catch (err) {
      port.postMessage({ id: msg.id, error: String((err && err.message) || err) })
    }
  })
}

// Started by Electron's utilityProcess.fork.
if (process.parentPort && typeof process.parentPort.on === 'function') serve(process.parentPort)
