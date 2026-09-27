// A Claude Code session's own inbox (cross-session messaging, v2.1.234+ on
// Windows): a named pipe where a message starts a turn when the session is
// idle, or is read between tool calls when it works. Nothing is typed into
// its terminal, so neither its input line nor an approval prompt is touched.
// The pipe and its key come from the session's hooks (teamMcp reportSession),
// in the per-pane report; the key never leaves the main process.
import net from 'net'
import { join } from 'path'
import { readJson } from './fileRead'

const PIPE = /^\\\\\.\\pipe\\[A-Za-z0-9._\\-]{1,200}$/
const PANE = /^[A-Za-z0-9._-]{1,100}$/

// The inbox of the conversation a pane is in now, or null.
export function inboxOf(sessionsDir, paneId, sessionId) {
  if (!PANE.test(String(paneId || '')) || String(paneId).startsWith('.')) return null
  const r = readJson(join(sessionsDir, `${paneId}.json`))
  if (!r || r.agent !== 'claude' || !sessionId || r.sessionId !== sessionId) return null
  if (typeof r.inbox !== 'string' || !PIPE.test(r.inbox)) return null
  if (typeof r.inboxToken !== 'string' || !r.inboxToken || r.inboxToken.length > 200) return null
  return { pipe: r.inbox, token: r.inboxToken }
}

// -> Promise<{ ok: true } | { ok: false, error }>. Written in one line after
// the auth line, as Claude Code requires on Windows.
export function postToInbox({ sessionsDir, paneId, sessionId, text, timeoutMs = 3000 }) {
  const box = inboxOf(sessionsDir, paneId, sessionId)
  if (!box) return Promise.resolve({ ok: false, error: 'no inbox reported for this conversation' })
  const body = String(text || '').trim()
  if (!body) return Promise.resolve({ ok: false, error: 'empty message' })
  return new Promise((resolve) => {
    let done = false
    const finish = (res) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(res)
    }
    const sock = net.connect(box.pipe, () => {
      const lines =
        JSON.stringify({ type: 'auth', token: box.token }) +
        '\n' +
        JSON.stringify({ type: 'user', message: { role: 'user', content: body } }) +
        '\n'
      sock.end(lines, () => finish({ ok: true }))
    })
    const timer = setTimeout(() => {
      sock.destroy()
      finish({ ok: false, error: 'the inbox did not answer' })
    }, timeoutMs)
    sock.on('error', (err) => finish({ ok: false, error: err.code || err.message }))
  })
}
