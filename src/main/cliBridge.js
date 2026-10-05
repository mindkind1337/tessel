// The tessel command's requests that the window answers (open a project or a
// file, a new pane, the panes' list, a board card): sent on 'cli:request'
// with an id, answered on 'cli:reply'. Requests wait while the window is
// loading (it says 'cli:ready' once its workspaces are back), each with a
// time limit.
import crypto from 'crypto'
import { CliError } from './cliServer'
import { t } from './i18n'

export function createCliBridge({ send, timeoutMs = 30000, timers = { setTimeout, clearTimeout } }) {
  const pending = new Map() // id -> { resolve, reject, timer }
  let ready = false
  let waiting = [] // sends held until the window is ready

  // opts.timeoutMs: a longer wait for this one (an approval the user answers).
  function ask(method, params = {}, opts = {}) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const limit = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : timeoutMs
      const timer = timers.setTimeout(() => {
        pending.delete(id)
        reject(new CliError('timeout', t('main.cli.windowTimeout', 'Tessel’s window did not answer in time.')))
      }, limit)
      const entry = { resolve, reject, timer, sent: false }
      pending.set(id, entry)
      const go = () => {
        if (!pending.has(id)) return
        entry.sent = true
        send('cli:request', { id, method, params })
      }
      if (ready) go()
      else waiting.push(go)
    })
  }

  // The window's answer: { id, ok, result } | { id, ok: false, error: { code, message } }.
  function reply(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return false
    const p = pending.get(msg.id)
    if (!p) return false
    pending.delete(msg.id)
    timers.clearTimeout(p.timer)
    if (msg.ok === true) p.resolve(msg.result === undefined ? null : msg.result)
    else {
      const e = msg.error && typeof msg.error === 'object' ? msg.error : {}
      const code = typeof e.code === 'string' && /^[a-z_]{1,40}$/.test(e.code) ? e.code : 'failed'
      const message = typeof e.message === 'string' && e.message ? e.message.slice(0, 2000) : t('main.cli.failed', 'Tessel could not do it.')
      p.reject(new CliError(code, message))
    }
    return true
  }

  function setReady(value) {
    ready = !!value
    if (!ready) return
    const list = waiting
    waiting = []
    for (const go of list) go()
  }

  // The window went away (reload, crash): what it was already asked is lost;
  // the command gets an error now rather than at the time limit. What was
  // not sent yet waits for the reloaded window.
  function windowGone() {
    ready = false
    for (const [id, p] of pending) {
      if (!p.sent) continue
      timers.clearTimeout(p.timer)
      p.reject(new CliError('window_reloaded', t('main.cli.windowReloaded', 'Tessel’s window reloaded before it answered. Try again.')))
      pending.delete(id)
    }
  }

  return { ask, reply, setReady, windowGone, isReady: () => ready, pendingCount: () => pending.size }
}
