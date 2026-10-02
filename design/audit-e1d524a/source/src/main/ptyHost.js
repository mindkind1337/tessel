// Terminal host: a small background process that owns every terminal (PTY).
//
// Why: if terminals live inside the app process, anything that restarts the
// app (a crash, a reload, a code update while an agent is editing this very
// project) kills every shell and agent mid-task. Here they keep running; the
// app reconnects, re-attaches to each terminal and replays its recent output.
// VS Code's "pty host" and tmux work the same way.
//
// Runs as plain Node (Electron with ELECTRON_RUN_AS_NODE=1), listens on a
// per-user named pipe, and talks newline-delimited JSON. Every client must
// present the token from the token file (readable only by this user), so no
// other process can drive the terminals.
//
// It exits when the app asks it to (the window was closed on purpose), or
// when it has had no terminals and no app connected for a minute.
import net from 'net'
import fs from 'fs'
import { spawn } from 'child_process'
import * as pty from 'node-pty'
import { createLogger } from './logger'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { PROTOCOL } from './ptyProtocol'

// Each terminal also feeds a headless (invisible) terminal. When the app
// re-attaches or saves output, it gets that terminal's finished screen and
// scrollback, not the raw output stream. Agents redraw their screen many times
// a second (spinners, status lines); a raw stream keeps only the last few
// minutes of redraws, the real screen keeps the whole conversation.
const SCROLLBACK = 5000

function makeScreen(cols, rows) {
  const vt = new HeadlessTerminal({
    cols: Math.max(2, cols | 0),
    rows: Math.max(1, rows | 0),
    scrollback: SCROLLBACK,
    allowProposedApi: true
  })
  const ser = new SerializeAddon()
  vt.loadAddon(ser)
  return { vt, ser }
}

// The screen + scrollback as text with colours, once pending output is parsed.
function snapshot(entry) {
  return new Promise((resolve) => {
    try {
      entry.screen.vt.write('', () => {
        try {
          resolve(entry.screen.ser.serialize({ scrollback: SCROLLBACK }))
        } catch {
          resolve('')
        }
      })
    } catch {
      resolve('')
    }
  })
}

const PIPE = process.env.TESSEL_PTYHOST_PIPE
const TOKEN = process.env.TESSEL_PTYHOST_TOKEN
const LOG_DIR = process.env.TESSEL_LOG_DIR
const log = LOG_DIR ? createLogger({ dir: LOG_DIR, name: 'pty-host' }) : null
const say = (level, msg) => log && log[level]('host', msg)

if (!PIPE || !TOKEN) {
  process.exit(2)
}

const ptys = new Map() // id -> { child, meta, buffer, exited, exitCode, signal }
const clients = new Set()
let idleTimer = null

function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n'
  for (const c of clients) {
    if (c.authed && !c.destroyed) c.write(line)
  }
}

function describePty(id, p) {
  return {
    id,
    pid: p.child ? p.child.pid : null,
    exited: p.exited,
    exitCode: p.exitCode,
    ...p.meta
  }
}

function taskkillTree(pid) {
  if (!pid) return
  const k = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  })
  k.on('error', () => {})
}

// Ask the shell to stop (Ctrl+C, exit), then force-kill its process tree.
function terminate(id, forceDelay = 1500) {
  const p = ptys.get(id)
  if (!p) return
  ptys.delete(id)
  try {
    p.screen.vt.dispose()
  } catch {
    /* already gone */
  }
  if (p.exited || !p.child) return
  if (p.meta.backend === 'conpty') {
    try {
      p.child.write('\x03')
      p.child.write('exit\r')
    } catch {
      /* already gone */
    }
    const pid = p.child.pid
    setTimeout(() => taskkillTree(pid), forceDelay).unref()
    return
  }
  try {
    p.child.kill()
  } catch {
    /* ignore */
  }
}

function checkIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const alive = [...ptys.values()].some((p) => !p.exited)
  if (!alive && clients.size === 0) {
    idleTimer = setTimeout(() => {
      say('info', 'idle with no terminals and no app connected: exiting')
      process.exit(0)
    }, 60000)
  }
}

function handle(sock, msg) {
  const reply = (body) => {
    if (msg.req !== undefined) sock.write(JSON.stringify({ ...body, req: msg.req }) + '\n')
  }

  if (!sock.authed) {
    if (msg.op === 'hello' && msg.token === TOKEN) {
      sock.authed = true
      reply({
        op: 'hello',
        ok: true,
        protocol: PROTOCOL,
        pid: process.pid,
        ptys: [...ptys].map(([id, p]) => describePty(id, p))
      })
    } else {
      say('warn', 'rejected a client without the right token')
      sock.destroy()
    }
    return
  }

  switch (msg.op) {
    case 'create': {
      if (ptys.has(msg.id)) {
        reply({ ok: false, error: `terminal ${msg.id} already exists` })
        return
      }
      let child
      try {
        child = pty.spawn(msg.file, msg.args || [], {
          name: 'xterm-256color',
          cols: Math.max(2, msg.cols | 0),
          rows: Math.max(1, msg.rows | 0),
          cwd: msg.cwd,
          env: msg.env,
          useConpty: msg.useConpty !== false
        })
      } catch (err) {
        say('error', `spawn failed for ${msg.file}: ${err.message}`)
        reply({ ok: false, error: err.message })
        return
      }
      const entry = {
        child,
        meta: msg.meta || {},
        screen: makeScreen(msg.cols, msg.rows),
        exited: false,
        exitCode: null,
        signal: null
      }
      ptys.set(msg.id, entry)
      child.onData((data) => {
        entry.screen.vt.write(data)
        broadcast({ op: 'data', id: msg.id, data })
      })
      child.onExit(({ exitCode, signal }) => {
        entry.exited = true
        entry.exitCode = exitCode
        entry.signal = signal
        entry.child = null
        broadcast({ op: 'exit', id: msg.id, exitCode, signal, pid: child.pid })
        checkIdle()
      })
      reply({ ok: true, pid: child.pid })
      checkIdle()
      return
    }
    case 'attach': {
      const p = ptys.get(msg.id)
      if (!p) {
        reply({ ok: false, error: 'not found' })
        return
      }
      snapshot(p).then((buffer) => reply({ ok: true, ...describePty(msg.id, p), buffer }))
      return
    }
    case 'write': {
      const p = ptys.get(msg.id)
      if (p && p.child) {
        try {
          p.child.write(msg.data)
        } catch {
          /* gone */
        }
      }
      return
    }
    case 'resize': {
      const p = ptys.get(msg.id)
      if (p && p.child && msg.cols > 0 && msg.rows > 0) {
        try {
          p.child.resize(msg.cols | 0, msg.rows | 0)
          p.screen.vt.resize(msg.cols | 0, msg.rows | 0)
        } catch {
          /* resize race */
        }
      }
      return
    }
    case 'kill':
      terminate(msg.id)
      checkIdle()
      reply({ ok: true })
      return
    case 'dump':
      // Screen + scrollback of every terminal (saved by the app when it quits).
      Promise.all([...ptys].map(async ([id, p]) => [id, await snapshot(p)])).then((pairs) =>
        reply({ ok: true, buffers: Object.fromEntries(pairs) })
      )
      return
    case 'shutdown':
      say('info', `shutdown requested: closing ${ptys.size} terminal(s)`)
      for (const id of [...ptys.keys()]) terminate(id, 300)
      reply({ ok: true })
      setTimeout(() => process.exit(0), 800)
      return
    default:
      reply({ ok: false, error: `unknown op ${msg.op}` })
  }
}

const server = net.createServer((sock) => {
  sock.setEncoding('utf8')
  sock.authed = false
  clients.add(sock)
  checkIdle()
  let pending = ''
  sock.on('data', (chunk) => {
    pending += chunk
    let nl
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl)
      pending = pending.slice(nl + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      handle(sock, msg)
    }
  })
  const drop = () => {
    clients.delete(sock)
    checkIdle()
  }
  sock.on('close', drop)
  sock.on('error', drop)
})

server.on('error', (err) => {
  say('error', `pipe error: ${err.message}`)
  process.exit(3)
})

server.listen(PIPE, () => {
  say('info', `terminal host started (pid ${process.pid})`)
  checkIdle()
})

process.on('uncaughtException', (err) => say('error', `uncaught: ${err.stack || err.message}`))
