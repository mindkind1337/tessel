// The askpass pipe, served by the helper itself ("tessel-askpass.exe --serve
// <name>", src/main/askpass/TesselAskpass.cs) so the pipe gets an explicit
// DACL: full control for the current Windows user only, network logons
// denied. A pipe made by Node (net.createServer) cannot be given one, and its
// default DACL (read on Windows 11 with a .NET probe) is
//   Everyone: read, ANONYMOUS LOGON: read, SYSTEM / Administrators / owner: full
// so any account could open it for reading.
//
// To sshAskpass.js this looks like net: createServer(onConnection) gives a
// server with listen({ path }, cb), close() and 'error'; each question
// arrives as a socket-like object (on 'data' / 'close', end(text),
// destroy()). The helper and Tessel talk over the child's private stdio:
//   helper -> Tessel: READY | Q <id> <question line> | C <id>
//   Tessel -> helper: A <id> <base64 reply> | D <id>
import { EventEmitter } from 'events'
import { spawn } from 'child_process'

const PIPE_PREFIX = /^\\\\\.\\pipe\\/
const MAX_STDOUT_LINE = 300 * 1024

export function createAskpassPipeHost({ exePath, spawnImpl = spawn, env = process.env } = {}) {
  return {
    createServer(onConnection) {
      const srv = new EventEmitter()
      const socks = new Map() // id -> socket-like
      let child = null
      let ready = false
      let closed = false

      function send(line) {
        try {
          if (child && child.stdin && !child.stdin.destroyed) child.stdin.write(line + '\n')
        } catch {
          /* the helper is gone */
        }
      }

      function fakeSocket(id) {
        const sock = new EventEmitter()
        let ended = false
        const finish = (line) => {
          if (ended) return
          ended = true
          socks.delete(id)
          send(line)
          sock.emit('close')
        }
        sock.setEncoding = () => sock
        sock.end = (text) => finish(`A ${id} ${Buffer.from(String(text || ''), 'utf8').toString('base64')}`)
        sock.destroy = () => finish(`D ${id}`)
        sock.gone = () => {
          if (ended) return
          ended = true
          socks.delete(id)
          sock.emit('close')
        }
        return sock
      }

      function onLine(line) {
        if (line === 'READY') {
          if (!ready) {
            ready = true
            srv.emit('listening')
          }
          return
        }
        const m = /^([QC]) (\d{1,15})(?: (.*))?$/.exec(line)
        if (!m) return
        const id = m[2]
        if (m[1] === 'Q') {
          if (socks.has(id) || typeof m[3] !== 'string') return
          const sock = fakeSocket(id)
          socks.set(id, sock)
          onConnection(sock)
          sock.emit('data', Buffer.from(m[3] + '\n', 'ascii'))
        } else {
          const sock = socks.get(id)
          if (sock) sock.gone()
        }
      }

      srv.listen = (opts, cb) => {
        const path = String((opts && opts.path) || '')
        const name = path.replace(PIPE_PREFIX, '')
        const exe = exePath()
        const fail = (code) => {
          const err = new Error(`askpass pipe host: ${code}`)
          err.code = code
          srv.emit('error', err)
        }
        if (!exe || !PIPE_PREFIX.test(path) || !/^tessel-askpass-[0-9a-f]{32}$/.test(name)) {
          setImmediate(() => fail('ENOHELPER'))
          return srv
        }
        srv.once('listening', () => cb && cb())
        try {
          child = spawnImpl(exe, ['--serve', name], {
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
            // The helper needs nothing from Tessel's environment.
            env: { SystemRoot: env.SystemRoot || env.windir || 'C:\\Windows' }
          })
        } catch {
          setImmediate(() => fail('ESPAWN'))
          return srv
        }
        let buf = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          buf += chunk
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '')
            buf = buf.slice(nl + 1)
            onLine(line)
          }
          if (buf.length > MAX_STDOUT_LINE) buf = ''
        })
        child.on('error', () => {})
        child.on('exit', () => {
          const wasReady = ready
          child = null
          for (const sock of [...socks.values()]) sock.gone()
          if (!closed) fail(wasReady ? 'EEXITED' : 'ESTART')
        })
        if (child.stdin) child.stdin.on('error', () => {})
        return srv
      }

      srv.close = () => {
        closed = true
        for (const sock of [...socks.values()]) sock.gone()
        if (child) {
          try {
            child.stdin.end()
          } catch {
            /* ending anyway */
          }
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        }
      }
      return srv
    }
  }
}
