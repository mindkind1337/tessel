// The app's connection to the terminal host (see ptyHost.js): starts the host
// if it isn't running, authenticates, sends requests and relays output.
import net from 'net'
import { PROTOCOL } from './ptyProtocol'

export function createPtyClient({ pipe, token, startHost, log, onData, onExit, onLost }) {
  let sock = null
  let connecting = null
  let seq = 0
  const waiting = new Map() // req -> { resolve, reject, timer }

  function connectOnce() {
    return new Promise((resolve, reject) => {
      const s = net.connect(pipe)
      s.setEncoding('utf8')
      const fail = (err) => {
        s.destroy()
        reject(err)
      }
      s.once('error', fail)
      s.once('connect', () => {
        s.off('error', fail)
        resolve(s)
      })
    })
  }

  function wire(s) {
    let buf = ''
    s.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.req !== undefined && waiting.has(msg.req)) {
          const w = waiting.get(msg.req)
          waiting.delete(msg.req)
          clearTimeout(w.timer)
          w.resolve(msg)
        } else if (msg.op === 'data') onData(msg.id, msg.data)
        else if (msg.op === 'exit') onExit(msg.id, msg.exitCode, msg.signal, msg.pid)
      }
    })
    const lost = () => {
      if (sock !== s) return
      sock = null
      for (const [, w] of waiting) {
        clearTimeout(w.timer)
        w.reject(new Error('terminal host disconnected'))
      }
      waiting.clear()
      if (onLost) onLost()
    }
    s.on('close', lost)
    s.on('error', lost)
  }

  function rawRequest(s, body, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const req = ++seq
      const timer = setTimeout(() => {
        waiting.delete(req)
        reject(new Error(`terminal host did not answer ${body.op}`))
      }, timeout)
      waiting.set(req, { resolve, reject, timer })
      s.write(JSON.stringify({ ...body, req }) + '\n')
    })
  }

  async function connectAndHello(allowStart) {
    let s = null
    try {
      s = await connectOnce()
    } catch {
      if (!allowStart) throw new Error('terminal host not running')
      startHost()
      const until = Date.now() + 10000
      while (!s && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 150))
        try {
          s = await connectOnce()
        } catch {
          /* not up yet */
        }
      }
      if (!s) throw new Error('could not start the terminal host')
    }
    wire(s)
    const hello = await rawRequest(s, { op: 'hello', token }, 5000)
    if (!hello.ok) throw new Error('terminal host refused the connection')
    if (hello.protocol !== PROTOCOL) {
      // An older/newer host from a different version: replace it.
      log.warn(
        'pty',
        `terminal host speaks protocol ${hello.protocol}, need ${PROTOCOL}: restarting it`
      )
      try {
        await rawRequest(s, { op: 'shutdown' }, 5000)
      } catch {
        /* it's going away anyway */
      }
      s.destroy()
      await new Promise((r) => setTimeout(r, 1200))
      return connectAndHello(true)
    }
    return { s, hello }
  }

  // Connect (starting the host if needed). Returns the host's hello, which
  // lists the terminals it already has.
  async function ensure() {
    if (sock) return { reused: true }
    if (!connecting) {
      connecting = connectAndHello(true)
        .then(({ s, hello }) => {
          sock = s
          log.info(
            'pty',
            `connected to terminal host pid ${hello.pid} (${hello.ptys.length} terminal(s) running)`
          )
          return hello
        })
        .finally(() => {
          connecting = null
        })
    }
    return connecting
  }

  async function request(op, body = {}, timeout) {
    await ensure()
    return rawRequest(sock, { op, ...body }, timeout)
  }

  function send(op, body = {}) {
    if (sock) sock.write(JSON.stringify({ op, ...body }) + '\n')
  }

  // Connect only if a host is already running (never starts one).
  async function connectIfRunning() {
    if (sock) return true
    try {
      const { s, hello } = await connectAndHello(false)
      sock = s
      log.info('pty', `connected to terminal host pid ${hello.pid}`)
      return true
    } catch {
      return false
    }
  }

  return {
    ensure,
    request,
    send,
    connectIfRunning,
    get connected() {
      return !!sock
    }
  }
}
