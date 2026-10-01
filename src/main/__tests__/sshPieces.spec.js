// @vitest-environment node
// The pure parts of Tessel's ssh2 client: known_hosts matching, the host key
// policy, Tessel's own host key store, the ssh -G resolution, the error
// words, and the app side's question routing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createHmac, randomBytes } from 'crypto'
import ssh2 from 'ssh2'
import { parseKnownHosts, matchKnownHosts, hostKeyFingerprint, readHostKeyType, orderServerHostKeyAlgorithms, loadKnownHostsEvidence } from '../ssh/knownHosts'
import { decideHostKey } from '../ssh/hostKeyDecision'
import { createHostKeyStore } from '../ssh/hostKeyStore'
import { parseSshG, specFromSshG, specFromTarget, splitPathList, createSshResolver } from '../ssh/sshResolve'
import { sshTemplates, formatSshError } from '../ssh/sshMessages'
import { createSshRemote } from '../ssh/sshRemote'
import { resolveAgentSocket, WINDOWS_OPENSSH_AGENT_PIPE } from '../ssh/sshAuth'
import { createRemoteHosts } from '../remoteHosts'
import { makeKey } from './fixtures/sshServer'

const { utils } = ssh2
const t = (_k, english, vars) => String(english).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m))

function pubBlob() {
  const k = utils.parseKey(makeKey().private)
  return (Array.isArray(k) ? k[0] : k).getPublicSSH()
}

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sshp-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('known_hosts', () => {
  const a = pubBlob()
  const b = pubBlob()
  const q = (host, port, key) => ({ host, port, keyType: 'ssh-ed25519', key })

  it('plain, port-qualified, hashed and negated lines', () => {
    const salt = randomBytes(20)
    const hash = createHmac('sha1', salt).update('hashed.example').digest()
    const entries = parseKnownHosts(
      [
        `box.example,10.0.0.1 ssh-ed25519 ${a.toString('base64')}`,
        `[box.example]:2222 ssh-ed25519 ${b.toString('base64')}`,
        `|1|${salt.toString('base64')}|${hash.toString('base64')} ssh-ed25519 ${a.toString('base64')}`,
        `*.corp,!evil.corp ssh-ed25519 ${a.toString('base64')}`,
        '# a comment',
        `bad.example ssh-ed25519 ${a.toString('base64')}!!`
      ].join('\n')
    )
    expect(entries).toHaveLength(4)
    expect(matchKnownHosts(entries, q('box.example', 22, a))).toBe('match')
    expect(matchKnownHosts(entries, q('box.example', 22, b))).toBe('mismatch')
    expect(matchKnownHosts(entries, q('box.example', 2222, b))).toBe('match')
    // The port-qualified line decides for that port: a is a change there.
    expect(matchKnownHosts(entries, q('box.example', 2222, a))).toBe('mismatch')
    expect(matchKnownHosts(entries, q('hashed.example', 22, a))).toBe('match')
    expect(matchKnownHosts(entries, q('web.corp', 22, a))).toBe('match')
    expect(matchKnownHosts(entries, q('evil.corp', 22, a))).toBe('unknown')
    expect(matchKnownHosts(entries, q('bad.example', 22, a))).toBe('unknown')
    expect(matchKnownHosts(entries, q('other', 22, a))).toBe('unknown')
  })

  it('revoked wins; another key type is not first contact', () => {
    const entries = parseKnownHosts(`@revoked box ssh-ed25519 ${a.toString('base64')}\nbox ssh-ed25519 ${a.toString('base64')}`)
    expect(matchKnownHosts(entries, q('box', 22, a))).toBe('revoked')
    const rsa = utils.parseKey(makeKey('rsa', { bits: 2048 }).private)
    const rsaBlob = (Array.isArray(rsa) ? rsa[0] : rsa).getPublicSSH()
    const typed = parseKnownHosts(`box ssh-rsa ${rsaBlob.toString('base64')}`)
    expect(matchKnownHosts(typed, q('box', 22, a))).toBe('unknown-type-known-host')
    expect(orderServerHostKeyAlgorithms(typed, 'box', 22, ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'])).toEqual(['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-ed25519'])
  })

  it('fingerprints like ssh-keygen; unreadable files are told apart from absent ones', async () => {
    expect(hostKeyFingerprint(a)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(readHostKeyType(a)).toBe('ssh-ed25519')
    fs.mkdirSync(join(dir, 'known_hosts_dir'))
    const ev = await loadKnownHostsEvidence([join(dir, 'absent'), join(dir, 'known_hosts_dir')])
    expect(ev.unreadableFileCount).toBe(1)
  })
})

describe('host key policy', () => {
  it('changed keys are refused, unknown ones asked, StrictHostKeyChecking honoured', () => {
    expect(decideHostKey({ knownHostsOutcome: 'mismatch', storeOutcome: 'match' })).toMatchObject({ action: 'reject', code: 'changed' })
    expect(decideHostKey({ knownHostsOutcome: 'match', storeOutcome: 'mismatch' })).toMatchObject({ action: 'accept' })
    expect(decideHostKey({ knownHostsOutcome: 'unknown', storeOutcome: 'mismatch' })).toMatchObject({ action: 'reject', code: 'changed-store' })
    expect(decideHostKey({ knownHostsOutcome: 'unknown', storeOutcome: 'unknown' })).toEqual({ action: 'prompt', remember: true })
    expect(decideHostKey({ knownHostsOutcome: 'unknown', storeOutcome: 'unknown', strictHostKeyChecking: 'true' })).toMatchObject({ action: 'reject', code: 'unknown-strict' })
    expect(decideHostKey({ knownHostsOutcome: 'unknown', storeOutcome: 'unknown', strictHostKeyChecking: 'false' })).toEqual({ action: 'accept', remember: false })
    expect(decideHostKey({ knownHostsOutcome: 'unknown', storeOutcome: 'unknown', strictHostKeyChecking: 'accept-new' })).toEqual({ action: 'accept', remember: true })
    expect(decideHostKey({ knownHostsOutcome: 'unknown', storeOutcome: 'unknown', knownHostsUnreadable: true })).toEqual({ action: 'prompt', remember: false })
    expect(decideHostKey({ knownHostsOutcome: 'revoked', storeOutcome: 'match', strictHostKeyChecking: 'no' })).toMatchObject({ action: 'reject', code: 'revoked' })
    expect(decideHostKey({ knownHostsOutcome: 'unknown-type-known-host', storeOutcome: 'unknown', strictHostKeyChecking: 'no' })).toMatchObject({ action: 'reject' })
  })
})

describe('Tessel’s host key store', () => {
  it('remembers, matches, and drops tampered records', () => {
    const file = join(dir, 'hk.json')
    const store = createHostKeyStore({ file })
    const key = pubBlob()
    expect(store.trust({ host: 'Box', port: 22, keyType: 'ssh-ed25519', key })).toBe(true)
    const recs = store.records()
    expect(store.match(recs, { host: 'box', port: 22, keyType: 'ssh-ed25519', key })).toBe('match')
    expect(store.match(recs, { host: 'box', port: 22, keyType: 'ssh-ed25519', key: pubBlob() })).toBe('mismatch')
    expect(store.match(recs, { host: 'box', port: 2222, keyType: 'ssh-ed25519', key })).toBe('unknown')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    data.hostKeys[0].fingerprint = 'SHA256:forged'
    fs.writeFileSync(file, JSON.stringify(data))
    expect(store.records()).toEqual([])
  })

  it('leaves a newer version alone', () => {
    const file = join(dir, 'hk.json')
    fs.writeFileSync(file, JSON.stringify({ version: 99, hostKeys: [] }))
    const store = createHostKeyStore({ file })
    expect(store.trust({ host: 'box', port: 22, keyType: 'ssh-ed25519', key: pubBlob() })).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(99)
  })
})

describe('ssh -G resolution', () => {
  const G = [
    'user bob',
    'hostname real.example',
    'port 2200',
    'identitiesonly yes',
    'stricthostkeychecking ask',
    'identityfile ~/.ssh/id_work',
    'identityfile ~/.ssh/id_ed25519',
    'globalknownhostsfile __PROGRAMDATA__\\ssh/ssh_known_hosts',
    'userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2',
    'gssapiauthentication no'
  ].join('\n')

  it('takes OpenSSH’s effective settings', () => {
    const r = specFromSshG(parseSshG(G), { host: 'alias', port: 22 }, { home: 'C:\\Users\\me', exists: () => false })
    expect(r.ok).toBe(true)
    expect(r.spec).toMatchObject({ host: 'real.example', port: 2200, username: 'bob', identitiesOnly: true, strictHostKeyChecking: 'ask' })
    expect(r.spec.identityFiles[0]).toMatch(/id_work$/)
    expect(r.spec.knownHostsFiles).toHaveLength(3)
  })

  it('keeps the system ssh for what ssh2 does not do', () => {
    for (const extra of ['proxyjump bastion', 'proxycommand nc %h %p', 'pkcs11provider /x.so', 'certificatefile ~/.ssh/c-cert.pub', 'gssapiauthentication yes']) {
      const r = specFromSshG(parseSshG(`hostname h\n${extra}`), { host: 'h', port: 22 }, { exists: () => false })
      expect(r.ok).toBe(false)
      expect(r.system).toBe(true)
    }
    expect(specFromSshG(parseSshG('hostname h\nproxyjump none'), { host: 'h' }, { exists: () => false }).ok).toBe(true)
    expect(specFromTarget({ host: 'h', jumpHost: 'b' }).ok).toBe(false)
  })

  it('a path with spaces stays one path when it exists', () => {
    const existing = 'C:\\Users\\John Doe\\.ssh\\known_hosts'
    const got = splitPathList('C:\\Users\\John Doe\\.ssh\\known_hosts C:\\x', { exists: (p) => p === existing })
    expect(got[0]).toBe(existing)
    expect(got).toHaveLength(2)
  })

  it('runs ssh -G with the saved host’s argv (never a shell) and falls back without ssh.exe', async () => {
    const calls = []
    const runFile = (exe, args, opts, cb) => {
      calls.push({ exe, args, shell: opts.shell })
      cb(null, 'hostname h.example\nuser me\nport 22\n')
    }
    const r = createSshResolver({ sshExe: () => 'ssh.exe', runFile })
    const res = await r.resolve({ id: 'ssh-1', label: 'x', host: 'h.example', configHost: 'h.example', port: 22, username: 'me', source: 'manual' })
    expect(res.ok).toBe(true)
    expect(calls[0]).toEqual({ exe: 'ssh.exe', args: ['-G', '-l', 'me', 'h.example'], shell: false })
    const none = createSshResolver({ sshExe: () => null })
    const fb = await none.resolve({ id: 'ssh-2', label: 'y', host: 'y.example', configHost: 'y.example', port: 2022, username: '', source: 'manual' })
    expect(fb.ok).toBe(true)
    expect(fb.spec.port).toBe(2022)
  })
})

describe('agent socket', () => {
  it('IdentityAgent none, SSH_AUTH_SOCK, then the Windows OpenSSH pipe', () => {
    expect(resolveAgentSocket('none', {})).toBe(null)
    expect(resolveAgentSocket(null, { SSH_AUTH_SOCK: '/tmp/a' })).toBe('/tmp/a')
    expect(resolveAgentSocket(null, {}, 'win32')).toBe(WINDOWS_OPENSSH_AGENT_PIPE)
    expect(resolveAgentSocket('SSH_AUTH_SOCK', {})).toBe(null)
  })
})

describe('error words', () => {
  it('a changed key says so loudly, with the remedy', () => {
    const text = formatSshError(sshTemplates(t), 'hostkey-changed', { host: 'box', port: 2222, keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' })
    expect(text).toContain('CHANGED')
    expect(text).toContain('SHA256:abc')
    expect(text).toContain("ssh-keygen -R '[box]:2222'")
  })
})

describe('app side: questions and states', () => {
  function setup() {
    const sent = []
    const requests = []
    const host = {
      connected: true,
      features: { ssh: true },
      ensure: async () => ({}),
      request: async (op, body) => {
        requests.push({ op, body })
        return { ok: true }
      },
      send: () => {}
    }
    const hosts = { get: () => ({ id: 'h', label: 'Box' }), connectionState: (...a) => sent.push(['state', ...a]) }
    const ssh = createSshRemote({ host, hosts, send: (c, p) => sent.push([c, p]), t, resolver: { resolve: async () => ({ ok: true, spec: {} }) } })
    return { ssh, sent, requests }
  }

  it('shows a question, sends the answer to the terminal host only, then closes it', async () => {
    const { ssh, sent, requests } = setup()
    ssh.onEvent({ op: 'ssh-prompt', promptId: 'p1', hostId: 'h', kind: 'password', user: 'me', host: 'box' })
    const req = sent.find(([c]) => c === 'ssh:credential-request')[1]
    expect(req).toMatchObject({ paneId: 'ssh2:h', promptId: 'p1', kind: 'password', label: 'Box' })
    expect((await ssh.submit({ paneId: 'ssh2:other', promptId: 'p1', value: 'x' })).error).toBe('stale')
    expect((await ssh.submit({ paneId: 'ssh2:h', promptId: 'p1', value: 'a\nb' })).error).toBe('invalid')
    expect((await ssh.submit({ paneId: 'ssh2:h', promptId: 'p1', value: 'pw' })).ok).toBe(true)
    expect(requests).toEqual([{ op: 'ssh-answer', body: { promptId: 'p1', value: 'pw' } }])
    expect(sent.some(([c, p]) => c === 'ssh:credential-resolved' && p.promptId === 'p1')).toBe(true)
    expect((await ssh.submit({ paneId: 'ssh2:h', promptId: 'p1', value: 'pw' })).error).toBe('stale')
  })

  it('a host key question shows the fingerprint and takes yes / no only', async () => {
    const { ssh, sent } = setup()
    ssh.onEvent({ op: 'ssh-prompt', promptId: 'k1', hostId: 'h', kind: 'hostkey', hostKey: { host: 'box', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:xyz' } })
    const req = sent.find(([c]) => c === 'ssh:credential-request')[1]
    expect(req.detail).toContain('SHA256:xyz')
    expect((await ssh.submit({ paneId: 'ssh2:h', promptId: 'k1', value: 'maybe' })).error).toBe('invalid')
    expect((await ssh.submit({ paneId: 'ssh2:h', promptId: 'k1', value: 'no' })).ok).toBe(true)
  })

  it('states reach the host list with their reason in words', () => {
    const { ssh, sent } = setup()
    ssh.onEvent({ op: 'ssh-state', hostId: 'h', status: 'error', code: 'auth-failed', params: { host: 'box' } })
    expect(sent.find(([c]) => c === 'state')).toEqual(['state', 'h', 'error', 'Sign-in to Box failed (permission denied).'])
  })

  it('a Files channel queues its input until the channel is open, and says why it failed', async () => {
    const msgs = []
    let ch = null
    const host = {
      connected: true,
      features: { ssh: true },
      request: async (op, body) => {
        if (op === 'ssh-exec') ch = body.ch
        return { ok: true }
      },
      send: (op, body) => msgs.push({ op, ...body })
    }
    const ssh = createSshRemote({ host, hosts: { get: () => ({ id: 'h', label: 'Box' }) }, t })
    const child = ssh.spawnFor('h', {})()
    child.stdin.write('prelude\n')
    await new Promise((r) => setTimeout(r, 0))
    expect(msgs).toEqual([])
    ssh.onEvent({ op: 'ssh-open', ch })
    expect(msgs).toEqual([{ op: 'ssh-write', ch, data: Buffer.from('prelude\n').toString('base64') }])
    const out = []
    child.stdout.on('data', (d) => out.push(d.toString()))
    ssh.onEvent({ op: 'ssh-out', ch, data: Buffer.from('hi').toString('base64') })
    expect(out).toEqual(['hi'])
    // A second one that cannot sign in: its reason, as the session's error.
    const other = ssh.spawnFor('h', {})()
    await new Promise((r) => setTimeout(r, 0))
    const err = []
    let exit = null
    other.stderr.on('data', (d) => err.push(d.toString()))
    other.on('exit', (code) => (exit = code))
    ssh.onEvent({ op: 'ssh-exit', ch, code: 255, fail: 'auth-cancelled', params: {} })
    expect(exit).toBe(255)
    expect(other.failCode).toBe('auth-cancelled')
    expect(err.join('')).toContain('Sign-in to Box was cancelled.')
  })
})

describe('host list: the shared connection’s state', () => {
  it('panes follow the connection; an error keeps its reason after the pane ends', () => {
    const changes = []
    const svc = createRemoteHosts({ dir, sshExe: () => null, onChange: (s) => changes.push(s) })
    const { target } = svc.add({ host: 'box.example', username: 'me' })
    svc.paneStarted('p1', target.id, { ssh2: true })
    expect(svc.snapshot()[target.id].status).toBe('connecting')
    svc.connectionState(target.id, 'connected')
    expect(svc.snapshot()[target.id].status).toBe('connected')
    svc.connectionState(target.id, 'error', 'Sign-in failed')
    svc.paneExited('p1', 255)
    expect(svc.snapshot()[target.id]).toMatchObject({ status: 'error', error: 'Sign-in failed' })
  })
})
