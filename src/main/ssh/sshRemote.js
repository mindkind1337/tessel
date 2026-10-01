// The app's side of the ssh2 connections, which live in the terminal host
// (sshHostBridge.js; see there for the messages):
// - decides, per saved host, whether Tessel's ssh2 client is used (the host
//   runs a terminal host that speaks it, and the host's ssh -G settings are
//   ones it supports) or the system ssh (ssh.exe + askpass) as before;
// - shows the host's questions in the SSH dialog (the same one as askpass:
//   'ssh:credential-request', pane id "ssh2:<hostId>") and sends the answer
//   to the terminal host, nowhere else;
// - gives remoteShell.js a child-process-like object over an exec channel,
//   so the Files / Changes session's protocol runs unchanged on the shared
//   connection;
// - feeds the host's connection states to remoteHosts.js (status bar).
// Nothing secret is logged or kept here: an answer goes from the dialog's
// IPC call straight into one message to the terminal host.
import { EventEmitter } from 'events'
import crypto from 'crypto'
import { sshTemplates, formatSshError } from './sshMessages'
import { createSshResolver } from './sshResolve'

export const PANE_PREFIX = 'ssh2:'
const MAX_SECRET = 4096
const CONNECT_TEST_TIMEOUT_MS = 10 * 60 * 1000

// A child process for remoteShell.js (stdin / stdout / stderr / exit / kill)
// on an exec channel of the host's connection.
class ChannelChild extends EventEmitter {
  constructor(sendMsg) {
    super()
    this.sendMsg = sendMsg
    this.open = false
    this.ended = false
    this.queue = []
    this.failCode = null
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    const self = this
    this.stdin = Object.assign(new EventEmitter(), {
      write(data) {
        if (self.ended) return false
        const b64 = Buffer.from(data).toString('base64')
        if (self.open) self.sendMsg('ssh-write', { data: b64 })
        else self.queue.push(b64)
        return true
      },
      end() {
        if (self.ended) return
        if (self.open) self.sendMsg('ssh-eof', {})
        else self.queue.push(null)
      }
    })
  }
  opened() {
    this.open = true
    for (const q of this.queue.splice(0)) {
      if (q === null) this.sendMsg('ssh-eof', {})
      else this.sendMsg('ssh-write', { data: q })
    }
  }
  exited(code, signal) {
    if (this.ended) return
    this.ended = true
    this.open = false
    this.queue = []
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
  kill() {
    if (!this.ended) this.sendMsg('ssh-close', {})
    return true
  }
}

// host: the terminal host client (ptyClient.js). hosts: remoteHosts.js.
// send(channel, payload): to the window. t: i18n.
export function createSshRemote({ host, hosts, send = () => {}, log = null, t, sshExe = () => null, resolver = null, enabled = () => true } = {}) {
  const resolve = resolver || createSshResolver({ sshExe })
  const prompts = new Map() // promptId -> { hostId, kind }
  const chans = new Map() // ch -> ChannelChild
  const tests = new Map() // cid -> resolve
  const label = (hostId) => {
    try {
      const h = hosts.get(hostId)
      return (h && h.label) || hostId
    } catch {
      return hostId
    }
  }
  const warn = (msg) => {
    try {
      if (log) log.warn('ssh', msg)
    } catch {
      /* never mind */
    }
  }

  const templates = () => sshTemplates(t)
  function errorText(hostId, code, params) {
    return formatSshError(templates(), code, params, label(hostId))
  }

  // Which client a saved host uses. -> { mode: 'ssh2', spec } | { mode: 'system', reason }
  async function modeFor(target) {
    if (!enabled()) return { mode: 'system', reason: 'disabled' }
    try {
      await host.ensure()
    } catch {
      return { mode: 'system', reason: 'no-host' }
    }
    if (!host.features || !host.features.ssh) return { mode: 'system', reason: 'old-host' }
    const r = await resolve.resolve(target)
    if (!r.ok) return { mode: 'system', reason: r.reason || 'unsupported' }
    return { mode: 'ssh2', spec: r.spec }
  }

  // What a remote terminal needs (pty:create): its texts in the interface's
  // language, the spec, the folder.
  function terminalRequest(target, spec, remotePath) {
    return {
      hostId: target.id,
      spec,
      ...(remotePath ? { remotePath } : {}),
      texts: { ...templates(), label: target.label || target.host }
    }
  }

  // --- Questions -------------------------------------------------------------------
  function hostKeyText(p) {
    const k = p.hostKey || {}
    return t(
      'main.ssh.hostKeyQuestion',
      'Tessel has never connected to {{host}} (port {{port}}) and cannot check that it is the right machine.\n\n{{keyType}} key fingerprint:\n{{fingerprint}}\n\nCompare it with the fingerprint your administrator gave you, or the one the host shows (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub). If it matches, Tessel remembers this key for this host.',
      { host: k.host || label(p.hostId), port: k.port || 22, keyType: k.keyType || '', fingerprint: k.fingerprint || '' }
    )
  }

  function showPrompt(p) {
    if (!p || typeof p.promptId !== 'string' || prompts.has(p.promptId)) return
    const kinds = ['password', 'passphrase', 'keyboard-interactive', 'hostkey']
    if (!kinds.includes(p.kind)) return
    prompts.set(p.promptId, { hostId: p.hostId, kind: p.kind })
    let detail = p.detail || ''
    if (p.kind === 'hostkey') detail = hostKeyText(p)
    else if (p.kind === 'password') detail = p.detail || `${p.user}@${p.host}`
    send('ssh:credential-request', {
      paneId: `${PANE_PREFIX}${p.hostId}`,
      promptId: p.promptId,
      hostId: p.hostId,
      label: label(p.hostId),
      kind: p.kind,
      detail,
      retry: !!p.retry
    })
  }

  function dropPrompt(promptId) {
    const p = prompts.get(promptId)
    if (!p) return
    prompts.delete(promptId)
    send('ssh:credential-resolved', { paneId: `${PANE_PREFIX}${p.hostId}`, promptId })
  }

  // The dialog's answer ({ paneId, promptId, value }); value null = Cancel.
  async function submit(req) {
    const promptId = req && typeof req.promptId === 'string' ? req.promptId : ''
    const p = prompts.get(promptId)
    if (!p || req.paneId !== `${PANE_PREFIX}${p.hostId}`) return { ok: false, error: 'stale' }
    let value = req.value
    if (value !== null) {
      if (typeof value !== 'string' || value.length > MAX_SECRET || /[\r\n\0]/.test(value)) return { ok: false, error: 'invalid' }
      if (p.kind === 'hostkey' && value !== 'yes' && value !== 'no') return { ok: false, error: 'invalid' }
      if (!value && (p.kind === 'password' || p.kind === 'passphrase')) return { ok: false, error: 'invalid' }
    }
    let res
    try {
      res = await host.request('ssh-answer', { promptId, value }, 10000)
    } catch {
      res = { ok: false, error: 'failed' }
    }
    value = null
    if (res && (res.ok || res.error === 'stale')) dropPrompt(promptId)
    return res && res.ok ? { ok: true } : { ok: false, error: (res && res.error) || 'failed' }
  }

  // --- Events from the terminal host -------------------------------------------------
  function onEvent(msg) {
    switch (msg.op) {
      case 'ssh-prompt':
        return showPrompt(msg)
      case 'ssh-prompt-done':
        return dropPrompt(msg.promptId)
      case 'ssh-state': {
        const hostId = String(msg.hostId || '')
        if (!hostId || !hosts.connectionState) return
        const error = msg.status === 'error' || msg.code === 'lost' ? errorText(hostId, msg.code || 'failed', msg.params) : ''
        if (msg.status === 'error') warn(`ssh ${hostId}: ${msg.code || 'failed'}`)
        hosts.connectionState(hostId, msg.status, error)
        return
      }
      case 'ssh-open': {
        const c = chans.get(msg.ch)
        if (c) c.opened()
        return
      }
      case 'ssh-out': {
        const c = chans.get(msg.ch)
        if (c && typeof msg.data === 'string') (msg.err ? c.stderr : c.stdout).emit('data', Buffer.from(msg.data, 'base64'))
        return
      }
      case 'ssh-exit': {
        const c = chans.get(msg.ch)
        if (!c) return
        chans.delete(msg.ch)
        if (msg.fail && msg.fail !== 'lost') {
          c.failCode = msg.fail === 'auth-cancelled' ? 'auth-cancelled' : 'ssh'
          c.stderr.emit('data', Buffer.from(errorText(c.hostId, msg.fail, msg.params) + '\n'))
        }
        c.exited(typeof msg.code === 'number' ? msg.code : 255, msg.signal || null)
        return
      }
      case 'ssh-connected': {
        const done = tests.get(msg.cid)
        if (done) {
          tests.delete(msg.cid)
          done(msg)
        }
        return
      }
      default:
    }
  }

  // The terminal host connection is back: its questions and states again.
  async function onConnected() {
    try {
      const res = await host.request('ssh-sync', {}, 5000)
      if (!res || !res.ok) return
      for (const p of res.prompts || []) showPrompt(p)
      for (const [hostId, st] of Object.entries(res.states || {})) onEvent({ op: 'ssh-state', hostId, ...st })
    } catch {
      /* an older host: nothing to sync */
    }
  }

  // It went away: its channels and questions with it.
  function onLost() {
    for (const [ch, c] of [...chans]) {
      chans.delete(ch)
      c.exited(255, null)
    }
    for (const id of [...prompts.keys()]) dropPrompt(id)
    for (const [cid, done] of [...tests]) {
      tests.delete(cid)
      done({ ok: false, fail: 'lost' })
    }
  }

  // --- Channels ------------------------------------------------------------------------
  // A spawnImpl for remoteShell.createRemoteSession: the Files session's
  // `exec /bin/sh` on the host's connection.
  function spawnFor(hostId, spec) {
    return () => {
      const ch = crypto.randomBytes(12).toString('hex')
      const child = new ChannelChild((op, body) => host.send(op, { ch, ...body }))
      child.hostId = hostId
      chans.set(ch, child)
      host
        .request('ssh-exec', { ch, hostId, spec })
        .then((res) => {
          if (!res || !res.ok) throw new Error('refused') // i18n-ignore internal
        })
        .catch(() => {
          if (chans.get(ch) !== child) return
          chans.delete(ch)
          child.failCode = 'ssh'
          child.stderr.emit('data', Buffer.from(errorText(hostId, 'failed', { detail: 'terminal host' }) + '\n'))
          child.exited(255, null)
        })
      return child
    }
  }

  // Test connection: signed in (asking what it must). -> { success, error? }
  async function testConnection(hostId, spec) {
    const cid = crypto.randomBytes(12).toString('hex')
    const result = new Promise((resolveTest) => {
      tests.set(cid, resolveTest)
      setTimeout(() => {
        if (tests.delete(cid)) resolveTest({ ok: false, fail: 'timeout' })
      }, CONNECT_TEST_TIMEOUT_MS).unref?.()
    })
    try {
      const res = await host.request('ssh-connect', { cid, hostId, spec })
      if (!res || !res.ok) {
        tests.delete(cid)
        return { success: false, error: errorText(hostId, 'failed', { detail: 'invalid' }) }
      }
    } catch {
      tests.delete(cid)
      return { success: false, error: errorText(hostId, 'failed', { detail: 'terminal host' }) }
    }
    const r = await result
    return r.ok ? { success: true } : { success: false, error: errorText(hostId, r.fail || 'failed', r.params) }
  }

  // Disconnect / removal: the host's connections end, its kept credentials
  // are forgotten. (Its terminals are ended by the caller.)
  function disconnect(hostId) {
    for (const [id, p] of [...prompts]) if (p.hostId === hostId) dropPrompt(id)
    if (!host.connected) return
    host.request('ssh-disconnect', { hostId }, 5000).catch(() => {})
  }

  const isPane = (paneId) => typeof paneId === 'string' && paneId.startsWith(PANE_PREFIX)

  return { modeFor, terminalRequest, spawnFor, testConnection, disconnect, submit, isPane, onEvent, onConnected, onLost, errorText, clearCache: () => resolve.clear && resolve.clear() }
}
