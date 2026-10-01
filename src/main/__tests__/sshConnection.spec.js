// @vitest-environment node
// The ssh2 sign-in and host key check against a local fake SSH server
// (fixtures/sshServer.js: 127.0.0.1, random port, throwaway keys). Nothing
// here reads the user's ~/.ssh or reaches a real host.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import ssh2 from 'ssh2'
import { connectSsh, isPasswordPrompt } from '../ssh/sshConnection'
import { createHostKeyStore } from '../ssh/hostKeyStore'
import { hostKeyFingerprint } from '../ssh/knownHosts'
import { startSshServer, makeKey, fakeAgent } from './fixtures/sshServer'

const { utils } = ssh2

let dir
let servers = []
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-ssh-'))
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

function hostPublic(privateText) {
  const k = utils.parseKey(privateText)
  return (Array.isArray(k) ? k[0] : k).getPublicSSH()
}

// A prompt answerer that records every question (and never a secret).
function answers(map) {
  const asked = []
  const ask = async (p) => {
    asked.push({ kind: p.kind, retry: !!p.retry, detail: p.detail })
    const list = map[p.kind]
    if (typeof list === 'function') return list(p)
    if (Array.isArray(list)) return list.length ? list.shift() : null
    return list === undefined ? null : list
  }
  return { ask, asked }
}

function baseSpec(port, extra = {}) {
  return { host: '127.0.0.1', port, username: 'me', identityFiles: [], knownHostsFiles: [join(dir, 'known_hosts')], strictHostKeyChecking: 'ask', ...extra }
}

const newCreds = () => ({ password: null, passphrases: new Map() })

describe('sign-in ladder', () => {
  it('signs in with the agent first, asking nothing but the new host key', async () => {
    const user = makeKey()
    const s = await server({ auth: { publicKeys: [user.public], methods: ['publickey', 'password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const agent = fakeAgent(user.private)
    const { ask, asked } = answers({ hostkey: 'yes' })
    const client = await connectSsh({ spec: baseSpec(s.port), creds: newCreds(), ask, hostKeys: store, agent })
    client.end()
    expect(asked.map((a) => a.kind)).toEqual(['hostkey'])
    expect(agent.calls.sign).toBe(1)
  })

  it('asks a key passphrase, keeps it, and does not ask it again', async () => {
    const user = makeKey('ed25519', { passphrase: 'open sesame', cipher: 'aes256-ctr' })
    const keyFile = join(dir, 'id_ed25519')
    fs.writeFileSync(keyFile, user.private)
    const s = await server({ auth: { publicKeys: [user.public], methods: ['publickey'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const creds = newCreds()
    const first = answers({ hostkey: 'yes', passphrase: ['wrong', 'open sesame'] })
    // On a failure, what was asked and tried (never a secret: kinds and methods).
    const explain = (asked) => (e) => {
      throw new Error(`${e.code} asked=${JSON.stringify(asked.map((a) => a.kind))} auth=${JSON.stringify(s.events.auth.map((a) => a.method))}`) // i18n-ignore test
    }
    const c1 = await connectSsh({ spec: baseSpec(s.port, { identityFiles: [keyFile] }), creds, ask: first.ask, hostKeys: store, agent: null }).catch(explain(first.asked))
    c1.end()
    expect(first.asked.map((a) => [a.kind, a.retry])).toEqual([
      ['hostkey', false],
      ['passphrase', false],
      ['passphrase', true]
    ])
    expect(first.asked[1].detail).toBe(keyFile)
    const second = answers({})
    const c2 = await connectSsh({ spec: baseSpec(s.port, { identityFiles: [keyFile] }), creds, ask: second.ask, hostKeys: store, agent: null }).catch(explain(second.asked))
    c2.end()
    expect(second.asked).toEqual([])
  })

  it('asks the password, asks again after a wrong one, keeps the right one', async () => {
    const s = await server({ auth: { password: 'hunter2', methods: ['password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const creds = newCreds()
    const { ask, asked } = answers({ hostkey: 'yes', password: ['nope', 'hunter2'] })
    const client = await connectSsh({ spec: baseSpec(s.port), creds, ask, hostKeys: store, agent: null })
    client.end()
    expect(asked.map((a) => [a.kind, a.retry])).toEqual([
      ['hostkey', false],
      ['password', false],
      ['password', true]
    ])
    expect(creds.password).toBe('hunter2')
    // A reconnect uses the kept password: nothing asked.
    const again = answers({})
    ;(await connectSsh({ spec: baseSpec(s.port), creds, ask: again.ask, hostKeys: store, agent: null })).end()
    expect(again.asked).toEqual([])
  })

  it('a kept password the server now rejects is forgotten and asked again', async () => {
    const s = await server({ auth: { password: 'new-one', methods: ['password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const creds = { password: 'old-one', passphrases: new Map() }
    const { ask, asked } = answers({ hostkey: 'yes', password: ['new-one'] })
    ;(await connectSsh({ spec: baseSpec(s.port), creds, ask, hostKeys: store, agent: null })).end()
    expect(asked.map((a) => [a.kind, a.retry])).toEqual([
      ['hostkey', false],
      ['password', true]
    ])
    expect(creds.password).toBe('new-one')
  })

  it('answers keyboard-interactive password prompts through the password question', async () => {
    const s = await server({ auth: { password: 'kbd-pass', kbd: true, methods: ['keyboard-interactive'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const creds = newCreds()
    const { ask, asked } = answers({ hostkey: 'yes', password: ['kbd-pass'] })
    ;(await connectSsh({ spec: baseSpec(s.port), creds, ask, hostKeys: store, agent: null })).end()
    expect(asked.map((a) => a.kind)).toEqual(['hostkey', 'password'])
    expect(creds.password).toBe('kbd-pass')
  })

  it('a cancelled password question ends the attempt as cancelled, nothing kept', async () => {
    const s = await server({ auth: { password: 'x', methods: ['password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const creds = newCreds()
    const { ask } = answers({ hostkey: 'yes', password: null })
    await expect(connectSsh({ spec: baseSpec(s.port), creds, ask, hostKeys: store, agent: null })).rejects.toMatchObject({ code: 'auth-cancelled' })
    expect(creds.password).toBe(null)
  })

  it('three wrong passwords fail the sign-in', async () => {
    const s = await server({ auth: { password: 'right', methods: ['password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const { ask } = answers({ hostkey: 'yes', password: ['a', 'b', 'c', 'd'] })
    await expect(connectSsh({ spec: baseSpec(s.port), creds: newCreds(), ask, hostKeys: store, agent: null })).rejects.toMatchObject({ code: 'auth-failed' })
  })
})

describe('host keys', () => {
  it('an unknown key is asked with its fingerprint; Yes remembers it, the next connection asks nothing', async () => {
    const hostKey = makeKey()
    const s = await server({ hostKey: hostKey.private, auth: { password: 'p', methods: ['password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const seen = []
    const { ask } = answers({ hostkey: (p) => (seen.push(p.hostKey), 'yes'), password: ['p'] })
    ;(await connectSsh({ spec: baseSpec(s.port), creds: newCreds(), ask, hostKeys: store, agent: null })).end()
    expect(seen).toEqual([{ host: '127.0.0.1', port: s.port, keyType: 'ssh-ed25519', fingerprint: hostKeyFingerprint(hostPublic(hostKey.private)) }])
    expect(store.records()).toHaveLength(1)
    const again = answers({ password: ['p'] })
    ;(await connectSsh({ spec: baseSpec(s.port), creds: newCreds(), ask: again.ask, hostKeys: store, agent: null })).end()
    expect(again.asked.map((a) => a.kind)).toEqual(['password'])
  })

  it('No refuses the connection before any credential is asked', async () => {
    const s = await server({ auth: { password: 'p', methods: ['password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    const { ask, asked } = answers({ hostkey: 'no', password: ['p'] })
    await expect(connectSsh({ spec: baseSpec(s.port), creds: newCreds(), ask, hostKeys: store, agent: null })).rejects.toMatchObject({ code: 'hostkey-declined' })
    expect(asked.map((a) => a.kind)).toEqual(['hostkey'])
    expect(store.records()).toHaveLength(0)
  })

  it('a key matching known_hosts is accepted without a question', async () => {
    const hostKey = makeKey()
    const s = await server({ hostKey: hostKey.private, auth: { password: 'p', methods: ['password'] } })
    const pub = hostPublic(hostKey.private)
    fs.writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${s.port} ssh-ed25519 ${pub.toString('base64')}\n`)
    const { ask, asked } = answers({ password: ['p'] })
    ;(await connectSsh({ spec: baseSpec(s.port), creds: newCreds(), ask, hostKeys: createHostKeyStore({ file: join(dir, 'hk.json') }), agent: null })).end()
    expect(asked.map((a) => a.kind)).toEqual(['password'])
  })

  it('a CHANGED key (known_hosts) is refused, never asked, no credential asked', async () => {
    const real = makeKey()
    const other = makeKey()
    const s = await server({ hostKey: real.private, auth: { password: 'p', methods: ['password'] } })
    fs.writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${s.port} ssh-ed25519 ${hostPublic(other.private).toString('base64')}\n`)
    const { ask, asked } = answers({ hostkey: 'yes', password: ['p'] })
    await expect(connectSsh({ spec: baseSpec(s.port), creds: newCreds(), ask, hostKeys: createHostKeyStore({ file: join(dir, 'hk.json') }), agent: null })).rejects.toMatchObject({
      code: 'hostkey-changed',
      params: { host: '127.0.0.1', port: s.port, keyType: 'ssh-ed25519' }
    })
    expect(asked).toEqual([])
  })

  it('a CHANGED key (Tessel’s own store) is refused, never asked', async () => {
    const first = makeKey()
    const s1 = await server({ hostKey: first.private, auth: { password: 'p', methods: ['password'] } })
    const store = createHostKeyStore({ file: join(dir, 'hk.json') })
    ;(await connectSsh({ spec: baseSpec(s1.port), creds: newCreds(), ask: answers({ hostkey: 'yes', password: ['p'] }).ask, hostKeys: store, agent: null })).end()
    // The same endpoint now answers with another key.
    const port = s1.port
    await s1.close()
    servers = servers.filter((x) => x !== s1)
    const s2 = await startSshServerOnPort(port, makeKey().private)
    const { ask, asked } = answers({ hostkey: 'yes', password: ['p'] })
    await expect(connectSsh({ spec: baseSpec(s2.port), creds: newCreds(), ask, hostKeys: store, agent: null })).rejects.toMatchObject({ code: 'hostkey-changed-store' })
    expect(asked).toEqual([])
  })

  it('StrictHostKeyChecking yes refuses an unknown host without asking', async () => {
    const s = await server({ auth: { password: 'p', methods: ['password'] } })
    const { ask, asked } = answers({ hostkey: 'yes' })
    await expect(
      connectSsh({ spec: baseSpec(s.port, { strictHostKeyChecking: 'true' }), creds: newCreds(), ask, hostKeys: createHostKeyStore({ file: join(dir, 'hk.json') }), agent: null })
    ).rejects.toMatchObject({ code: 'hostkey-unknown-strict' })
    expect(asked).toEqual([])
  })
})

describe('keyboard-interactive prompt classification', () => {
  it('password prompts vs one-time codes', () => {
    expect(isPasswordPrompt({ prompt: 'Password: ', echo: false })).toBe(true)
    expect(isPasswordPrompt({ prompt: 'One-time password: ', echo: false })).toBe(false)
    expect(isPasswordPrompt({ prompt: 'Verification code: ', echo: false })).toBe(false)
    expect(isPasswordPrompt({ prompt: 'Password: ', echo: true })).toBe(false)
  })
})

// A server on a given port (the "same host" presenting another key).
async function startSshServerOnPort(port, hostKey) {
  const { Server } = ssh2
  const srv = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => ctx.reject(['password']))
  })
  await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  const s = { port, close: () => new Promise((r) => srv.close(() => r())) }
  servers.push(s)
  return s
}
