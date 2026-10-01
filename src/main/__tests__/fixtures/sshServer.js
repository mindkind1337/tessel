// A local SSH server for tests (ssh2's Server): 127.0.0.1, a random port, a
// throwaway host key. Nothing connects to a real host and nothing reads the
// user's ~/.ssh. Records what clients did (auth attempts, channels) so a
// test can check that one connection carried them all.
import ssh2 from 'ssh2'
import { timingSafeEqual } from 'crypto'
import { spawn } from 'child_process'
import { dirname, join, resolve as pathResolve } from 'path'

const { Server, utils } = ssh2

// ssh2's generator now and then writes an OpenSSH key its own parser calls
// malformed (about 1 in 300 ed25519 keys): such a key is made again.
export function makeKey(type = 'ed25519', opts = {}) {
  for (let i = 0; i < 20; i++) {
    const k = utils.generateKeyPairSync(type, opts)
    if (!(utils.parseKey(k.private, opts.passphrase) instanceof Error) && !(utils.parseKey(k.public) instanceof Error)) return k
  }
  throw new Error('could not make a test key') // i18n-ignore test
}

function same(a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// auth: { password?, publicKeys?: [openssh public key text], kbd?: true,
//         methods?: ['publickey', 'password', 'keyboard-interactive'] }
// onExec(command, stream, info): optional; default writes "ran:<command>".
export function startSshServer({ hostKey = makeKey().private, auth = {}, onExec, onShell, maxSessions = 0 } = {}) {
  const events = { connections: 0, auth: [], channels: [], windowChanges: [], sessions: 0 }
  const clients = new Set()
  const allowed = (auth.publicKeys || []).map((k) => utils.parseKey(k))
  const methods = auth.methods || ['publickey', 'password', 'keyboard-interactive']
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    events.connections++
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      events.auth.push({ method: ctx.method, user: ctx.username })
      if (ctx.method === 'password' && methods.includes('password')) {
        return auth.password != null && same(ctx.password, auth.password) ? ctx.accept() : ctx.reject(methods)
      }
      if (ctx.method === 'publickey' && methods.includes('publickey')) {
        const match = allowed.find((k) => k.type === ctx.key.algo && same(k.getPublicSSH(), ctx.key.data))
        if (!match) return ctx.reject(methods)
        if (!ctx.signature) return ctx.accept()
        return match.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(methods)
      }
      if (ctx.method === 'keyboard-interactive' && methods.includes('keyboard-interactive') && auth.kbd) {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], 'Sign in', (answers) => {
          if (auth.password != null && answers && same(answers[0] || '', auth.password)) ctx.accept()
          else ctx.reject(methods)
        })
      }
      ctx.reject(methods)
    })
    let open = 0
    client.on('ready', () => {
      client.on('session', (accept, reject) => {
        // Like OpenSSH's MaxSessions: a busy connection refuses another one.
        if (maxSessions && open >= maxSessions) return reject()
        open++
        events.sessions++
        const session = accept()
        session.on('close', () => open--)
        let ptyInfo = null
        session.on('pty', (ok, _no, info) => {
          ptyInfo = info
          ok && ok()
        })
        session.on('window-change', (ok, _no, info) => {
          events.windowChanges.push({ cols: info.cols, rows: info.rows })
          ok && ok()
        })
        session.on('env', (ok) => ok && ok())
        session.on('shell', (ok) => {
          const stream = ok()
          events.channels.push({ kind: 'shell', pty: ptyInfo, connection: events.connections })
          if (onShell) return onShell(stream, { pty: ptyInfo })
          stream.write('welcome\r\n')
          stream.on('data', (d) => {
            const s = d.toString()
            if (s.includes('exit')) {
              stream.exit(7)
              stream.end()
            } else stream.write(`echo:${s}`)
          })
        })
        session.on('exec', (ok, _no, info) => {
          const stream = ok()
          events.channels.push({ kind: 'exec', command: info.command, pty: ptyInfo, connection: events.connections })
          if (onExec) return onExec(info.command, stream, { pty: ptyInfo })
          stream.write(`ran:${info.command}\n`)
          stream.exit(0)
          stream.end()
        })
        session.on('sftp', (ok) => {
          const sftp = ok()
          events.channels.push({ kind: 'sftp', connection: events.connections })
          sftp.on('REALPATH', (id, path) => {
            sftp.name(id, [{ filename: path === '.' ? '/home/test' : path, longname: '', attrs: {} }])
          })
        })
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        events,
        // A new key exchange on every connection (the server asks it).
        rekeyClients() {
          return Promise.all([...clients].map((c) => new Promise((r) => c.rekey(() => r()))))
        },
        // Drops every client connection (the network going away).
        dropClients() {
          for (const c of clients) {
            try {
              c.end()
            } catch {
              /* gone */
            }
          }
        },
        close() {
          for (const c of clients) {
            try {
              c.end()
            } catch {
              /* gone */
            }
          }
          return new Promise((r) => server.close(() => r()))
        }
      })
    })
  })
}

// An exec handler that runs the command with a POSIX sh on this machine
// (Git for Windows' sh, like fake-ssh.cjs): the "remote host" is a local
// temporary folder. home: $HOME there (a POSIX path).
export function shExec(sh, { home } = {}) {
  return (command, stream) => {
    const env = { ...process.env }
    if (home) env.HOME = home
    if (process.platform === 'win32') {
      const root = pathResolve(dirname(sh), '..', '..')
      const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
      env[key] = [join(root, 'usr', 'bin'), join(root, 'mingw64', 'bin'), env[key] || ''].join(';')
    }
    delete env.TMPDIR
    const child = spawn(sh, ['-c', command], { env, windowsHide: true })
    stream.on('data', (d) => child.stdin.write(d))
    stream.on('end', () => child.stdin.end())
    stream.on('close', () => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
    })
    child.stdin.on('error', () => {})
    child.stdout.on('data', (d) => stream.write(d))
    child.stderr.on('data', (d) => stream.stderr.write(d))
    child.on('exit', (code) => {
      try {
        stream.exit(code === null ? 255 : code)
        stream.end()
      } catch {
        /* closed */
      }
    })
  }
}

// A stand-in for the Windows OpenSSH agent: holds one private key.
export function fakeAgent(privateKeyText) {
  const key = utils.parseKey(privateKeyText)
  const k = Array.isArray(key) ? key[0] : key
  const agent = new ssh2.BaseAgent()
  agent.calls = { identities: 0, sign: 0 }
  agent.getIdentities = (cb) => {
    agent.calls.identities++
    cb(null, [k])
  }
  agent.sign = (_pub, data, options, cb) => {
    if (typeof options === 'function') {
      cb = options
      options = {}
    }
    agent.calls.sign++
    cb(null, k.sign(data, options && options.hash))
  }
  return agent
}
