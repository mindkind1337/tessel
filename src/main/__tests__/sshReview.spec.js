// @vitest-environment node
// The security review's fixes, each against the local fake SSH server or
// the module alone: input typed while a terminal reconnects, an unchecked
// host key pinned (and the kept password never sent to an unchecked key),
// re-key with the same key, Disconnect while the pipe is down, credentials
// that expire, ssh -G failures, server text without control characters,
// the algorithms offered and PasswordAuthentication no.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { connectSsh, effectiveAlgorithms } from '../ssh/sshConnection'
import { createSshHostBridge } from '../ssh/sshHostBridge'
import { createSshManager } from '../ssh/sshManager'
import { createSshRemote } from '../ssh/sshRemote'
import { createSshResolver, configMentionsHost, parseSshG, specFromSshG } from '../ssh/sshResolve'
import { sshTemplates, formatSshError } from '../ssh/sshMessages'
import { startSshServer, makeKey } from './fixtures/sshServer'

const PASSWORD = 'review-pass'
const t = (_k, english, vars) => String(english).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m))

function until(fn, ms = 10000, label = '') {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      let v
      try {
        v = fn()
      } catch {
        v = null
      }
      if (v) return resolve(v)
      if (Date.now() - start > ms) return reject(new Error(`timed out waiting ${label || fn}`)) // i18n-ignore test
      setTimeout(tick, 15)
    }
    tick()
  })
}

let dir
let servers
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sshr-'))
  servers = []
})
afterEach(async () => {
  for (const s of servers) await s.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
async function server(opts) {
  const s = await startSshServer(opts)
  servers.push(s)
  return s
}
const spec = (port, extra = {}) => ({ host: '127.0.0.1', port, username: 'me', identityFiles: [], knownHostsFiles: [join(dir, 'known_hosts')], strictHostKeyChecking: 'ask', ...extra })

describe('1. input typed while a terminal reconnects', () => {
  it('is dropped with a notice, never replayed into the new shell; input before the first shell is kept', async () => {
    const s = await server({ auth: { password: PASSWORD, methods: ['password'] } })
    const answers = { hostkey: ['yes'], password: [PASSWORD] }
    const bridge = createSshHostBridge({
      hostKeyFile: join(dir, 'hk.json'),
      reconnectDelays: [300, 300, 300],
      broadcast: (m) => {
        if (m.op === 'ssh-prompt') setTimeout(() => bridge.handle({}, { op: 'ssh-answer', promptId: m.promptId, value: (answers[m.kind] || []).shift() ?? null }, () => {}), 5)
      }
    })
    const pty = bridge.createPty({ hostId: 'h', spec: spec(s.port), cols: 80, rows: 24, texts: { label: 'box', lost: 'LOST', reconnected: 'BACK', notConnected: 'NOTCONN {{host}}', codes: {} } })
    let text = ''
    pty.onData((d) => (text += d))
    pty.write('early\n') // before the first shell: kept
    await until(() => text.includes('echo:early'))
    s.dropClients()
    await until(() => text.includes('LOST'))
    pty.write('sudo-password-typed-blind\n')
    pty.write('more\n')
    await until(() => text.includes('BACK'))
    await until(() => text.split('welcome').length === 3)
    await new Promise((r) => setTimeout(r, 200))
    expect(text).toContain('NOTCONN box')
    expect(text.split('NOTCONN').length).toBe(2)
    expect(text).not.toContain('echo:sudo-password')
    expect(text).not.toContain('echo:more')
    pty.kill()
    bridge.shutdown()
  }, 30000)
})

describe('2. StrictHostKeyChecking no: the first key is pinned, a kept password goes to checked keys only', () => {
  it('asks the password for an unchecked key, then pins it; another key on reconnect is refused', async () => {
    const hostKey = makeKey()
    const s = await server({ hostKey: hostKey.private, auth: { password: PASSWORD, methods: ['password'] } })
    const creds = { password: PASSWORD, passphrases: new Map() } // kept from before
    const asked = []
    const ask = async (p) => (asked.push(p.kind), p.kind === 'password' ? PASSWORD : null)
    const lax = spec(s.port, { strictHostKeyChecking: 'false' })
    ;(await connectSsh({ spec: lax, creds, ask, agent: null })).end()
    // Unchecked key: the kept password was NOT sent by itself.
    expect(asked).toEqual(['password'])
    expect(creds.pinnedKey).toBeTruthy()
    // The same key again: pinned, the kept password is used.
    ;(await connectSsh({ spec: lax, creds, ask, agent: null })).end()
    expect(asked).toEqual(['password'])
    // Another key at the same endpoint: refused, nothing asked or sent.
    const port = s.port
    await s.close()
    servers = []
    const other = new ssh2.Server({ hostKeys: [makeKey().private] }, (c) => {
      c.on('error', () => {})
      c.on('authentication', (ctx) => {
        asked.push(`server-saw-${ctx.method}`)
        ctx.reject(['password'])
      })
    })
    await new Promise((r) => other.listen(port, '127.0.0.1', r))
    servers.push({ close: () => new Promise((r) => other.close(() => r())) })
    await expect(connectSsh({ spec: lax, creds, ask, agent: null })).rejects.toMatchObject({ code: 'hostkey-changed-pinned' })
    expect(asked).toEqual(['password'])
  }, 30000)
})

describe('3. re-key', () => {
  it('a later key exchange with the same host key keeps the connection and its channels', async () => {
    const s = await server({ auth: { password: PASSWORD, methods: ['password'] } })
    const client = await connectSsh({ spec: spec(s.port), creds: { password: null, passphrases: new Map() }, ask: async (p) => (p.kind === 'hostkey' ? 'yes' : PASSWORD), agent: null })
    let closed = false
    client.on('close', () => (closed = true))
    await s.rekeyClients()
    const out = await new Promise((resolve, reject) =>
      client.exec('after-rekey', (err, st) => {
        if (err) return reject(err)
        let o = ''
        st.on('data', (d) => (o += d))
        st.on('close', () => resolve(o))
      })
    )
    expect(out).toContain('ran:after-rekey')
    expect(closed).toBe(false)
    client.end()
  }, 30000)
})

describe('4. Disconnect while the terminal host pipe is down', () => {
  it('is sent once the pipe is back', async () => {
    const requests = []
    const host = { connected: false, features: { ssh: true }, request: async (op, body) => (requests.push([op, body]), { ok: true }), send: () => {} }
    const ssh = createSshRemote({ host, hosts: { get: () => null }, t })
    ssh.disconnect('h1')
    expect(requests).toEqual([])
    host.connected = true
    await ssh.onConnected()
    expect(requests[0]).toEqual(['ssh-disconnect', { hostId: 'h1' }])
  })
})

describe('5. kept credentials expire', () => {
  it('when the last connection closes with no terminal left, and after 8 hours', async () => {
    const s = await server({ auth: { password: PASSWORD, methods: ['password'] } })
    let clock = 1_000_000
    const m = createSshManager({ ask: async (_h, p) => (p.kind === 'hostkey' ? 'yes' : PASSWORD), now: () => clock, idleCloseMs: 50 })
    await m.connectHost('h', spec(s.port))
    expect(m.hasKeptPassword('h')).toBe(true)
    clock += 8 * 60 * 60 * 1000 + 1
    expect(m.hasKeptPassword('h')).toBe(false)
    clock = 1_000_000
    // Idle close (no channel, no terminal): forgotten.
    await until(() => m.connectionCount('h') === 0)
    await until(() => !m.hasKeptPassword('h'), 5000, 'forgotten')
    m.closeAll()
  }, 30000)
})

describe('6. ssh -G failures', () => {
  const target = { id: 'ssh-1', label: 'box', host: 'box.example', configHost: 'box.example', port: 22, username: 'me', source: 'manual' }
  it('ssh.exe there but -G failing: the system ssh, not guessed settings', async () => {
    const r = createSshResolver({ sshExe: () => 'ssh.exe', runFile: (_e, _a, _o, cb) => cb(new Error('timeout'), '') })
    expect(await r.resolve(target)).toMatchObject({ ok: false, system: true, reason: 'ssh-g-failed' })
  })
  it('no ssh.exe: the saved fields only when ~/.ssh/config says nothing about the host', async () => {
    const quiet = createSshResolver({ sshExe: () => null, readConfig: () => 'Host other\n  User x\n' })
    expect((await quiet.resolve(target)).ok).toBe(true)
    const mentions = createSshResolver({ sshExe: () => null, readConfig: () => 'Host *.example\n  ProxyJump b\n' })
    expect(await mentions.resolve(target)).toMatchObject({ ok: false, system: true })
    expect(configMentionsHost('Include ~/.ssh/more', ['x'])).toBe(true)
    expect(configMentionsHost('Host !box.example *', ['box.example'])).toBe(false)
  })
  it('KnownHostsCommand keeps the system ssh; algorithms and PasswordAuthentication come from -G', () => {
    expect(specFromSshG(parseSshG('hostname h\nknownhostscommand /x %H'), { host: 'h' }, { exists: () => false })).toMatchObject({ ok: false, system: true })
    const r = specFromSshG(parseSshG('hostname h\npasswordauthentication no\nmacs hmac-sha2-256,umac-64@openssh.com\nciphers aes256-ctr'), { host: 'h' }, { exists: () => false })
    expect(r.spec.passwordAuthentication).toBe(false)
    expect(r.spec.algorithms.hmac).toEqual(['hmac-sha2-256', 'umac-64@openssh.com'])
    expect(r.spec.algorithms.cipher).toEqual(['aes256-ctr'])
  })
})

describe('7. server text in the pane and the status', () => {
  it('control characters are removed', () => {
    const text = formatSshError(sshTemplates(t), 'failed', { host: 'box', detail: 'bye\u001b]0;pwned\u0007\u001b[2J' })
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})

describe('8. algorithms and sign-in methods', () => {
  it('no SHA-1 by default; the configuration’s lists honoured; nothing usable is an error', () => {
    const def = effectiveAlgorithms(null)
    expect(def.serverHostKey).not.toContain('ssh-rsa')
    expect(def.hmac).not.toContain('hmac-sha1')
    expect(def.hmac).not.toContain('hmac-sha1-etm@openssh.com')
    expect(effectiveAlgorithms({ hmac: ['umac-64@openssh.com', 'hmac-sha2-512'] }).hmac).toEqual(['hmac-sha2-512'])
    expect(effectiveAlgorithms({ cipher: ['made-up'] })).toEqual({ error: 'cipher' })
  })
  it('PasswordAuthentication no: the password is never asked or sent', async () => {
    const s = await server({ auth: { password: PASSWORD, methods: ['password'] } })
    const asked = []
    await expect(
      connectSsh({ spec: spec(s.port, { passwordAuthentication: false }), creds: { password: null, passphrases: new Map() }, ask: async (p) => (asked.push(p.kind), p.kind === 'hostkey' ? 'yes' : PASSWORD), agent: null })
    ).rejects.toMatchObject({ code: 'auth-failed' })
    expect(asked).toEqual(['hostkey'])
    expect(s.events.auth.map((a) => a.method)).toEqual(['none'])
  }, 30000)
})
