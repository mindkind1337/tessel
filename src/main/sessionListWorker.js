// The past conversations list (Agent Session History) is read here, in a
// utility process the main process starts when the list is asked for: it
// reads hundreds of transcript files, which blocked the window's process for
// 130-250 ms each time (at startup when the panel is open). It answers
// { id, args: [query, home, roots] } with { id, rows } or { id, error }.
//
// The other readings of the agents' own files are done here too, for the
// same reason: { id, method, args } -> { id, ok: true, value } or
// { id, error }. A pane header's model (agents:model held the main process
// 3.5 s at a start, every pane asking at once), a conversation's sub-agents
// (agents:children 3.5 s: folders listed, transcripts' heads and tails read,
// databases queried) and the conversation a pane resumes (sessions:find
// 1.3 s). They only read files: what they keep between calls (the files
// they found, the heads they parsed) is kept here.
import { listSessions, findCodexSession } from './agentSessions'
import { agentModel } from './agentModel'
import { findAgentSession } from './agentResume'
import { SUBAGENT_READERS } from './agentChildren'

export const METHODS = {
  agentModel: (query, home) => agentModel(query, home),
  children: (name, ...args) => {
    if (!Object.prototype.hasOwnProperty.call(SUBAGENT_READERS, name)) return []
    return SUBAGENT_READERS[name](...args)
  },
  findAgentSession: (query, home) => findAgentSession(query, home),
  findCodexSession: (query, home, now, root) => findCodexSession(query, home, now, root)
}

export function serve(port, list = listSessions, methods = METHODS) {
  port.on('message', (event) => {
    const msg = event && event.data !== undefined ? event.data : event
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.args)) return
    if (typeof msg.method === 'string') {
      const fn = Object.prototype.hasOwnProperty.call(methods, msg.method) ? methods[msg.method] : null
      if (!fn) return port.postMessage({ id: msg.id, error: `unknown method ${msg.method}` }) // i18n-ignore internal
      // Some readers are async (Copilot's and Kimi's logs): answered when done.
      Promise.resolve()
        .then(() => fn(...msg.args))
        .then(
          (value) => port.postMessage({ id: msg.id, ok: true, value }),
          (err) => port.postMessage({ id: msg.id, error: String((err && err.message) || err) })
        )
        // Not cloneable: the main process reads it itself (its fallback).
        .catch(() => port.postMessage({ id: msg.id, failed: true }))
      return
    }
    try {
      port.postMessage({ id: msg.id, rows: list(...msg.args) })
    } catch (err) {
      port.postMessage({ id: msg.id, error: String((err && err.message) || err) })
    }
  })
}

// Started by Electron's utilityProcess.fork.
if (process.parentPort && typeof process.parentPort.on === 'function') serve(process.parentPort)
