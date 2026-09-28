// Remote hosts (remoteHosts.js): the host store, ~/.ssh/config sync, the
// ssh.exe argv and its checks, Test connection and the live state. Fixtures
// only: a throwaway HOME and user data folder; ssh is never really run.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteHosts, registerRemoteHosts, sanitizeTarget, sshArgsFor, configHostsToTargets, findSshExe } from '../remoteHosts'
import { formFromTarget, buildSavePayload } from '../../renderer/src/remoteHosts'

let root
let home
let dir
function writeConfig(text) {
  writeFileSync(join(home, '.ssh', 'config'), text)
}
function service(extra = {}) {
  return createRemoteHosts({ dir, home, sshExe: () => 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', ...extra })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tessel-remote-'))
  home = join(root, 'home')
  dir = join(root, 'userData')
  mkdirSync(join(home, '.ssh'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('sanitizeTarget / sshArgsFor', () => {
  it('builds an argv array for a hand-made host', () => {
    const { target } = sanitizeTarget({ host: 'srv.example.com', port: 2222, username: 'deploy', identityFile: 'C:\\keys\\id', jumpHost: 'bastion', proxyCommand: 'nc %h %p' })
    expect(sshArgsFor(target)).toEqual([
      '-p', '2222', '-l', 'deploy', '-i', 'C:\\keys\\id', '-J', 'bastion', '-o', 'ProxyCommand=nc %h %p', 'srv.example.com'
    ])
  })

  it('reaches a host from ~/.ssh/config by its alias only', () => {
    const { target } = sanitizeTarget({ configHost: 'prod', host: 'prod.example.com', port: 2222, username: 'x', source: 'ssh-config' })
    expect(sshArgsFor(target)).toEqual(['prod'])
  })

  it('Test connection: batch mode (no prompts), a timeout, then exit; host keys left to ssh', () => {
    const { target } = sanitizeTarget({ host: 'box' })
    const args = sshArgsFor(target, { test: true })
    expect(args).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'box', 'exit'])
    expect(args.join(' ')).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile/)
  })

  it('refuses values that ssh would read as options or that carry control characters', () => {
    expect(sanitizeTarget({ host: '-oProxyCommand=calc' }).error).toBe('host-invalid')
    expect(sanitizeTarget({ host: 'a b' }).error).toBe('host-invalid')
    expect(sanitizeTarget({ host: 'a;calc' }).error).toBe('host-invalid')
    expect(sanitizeTarget({ host: 'a', username: '-oX' }).error).toBe('user-invalid')
    expect(sanitizeTarget({ host: 'a', username: 'a b' }).error).toBe('user-invalid')
    expect(sanitizeTarget({ host: 'a', identityFile: '-F x' }).error).toBe('identity-invalid')
    expect(sanitizeTarget({ host: 'a', jumpHost: '-x' }).error).toBe('jump-invalid')
    expect(sanitizeTarget({ host: 'a', proxyCommand: 'nc\nevil' }).error).toBe('proxy-invalid')
    expect(sanitizeTarget({ host: 'a', port: 70000 }).error).toBe('port-invalid')
    expect(sanitizeTarget({ host: '' }).error).toBe('host-required')
    expect(() => sshArgsFor({ host: '-x' })).toThrow()
  })

  it('accepts IPv6 and user@domain style names', () => {
    expect(sanitizeTarget({ host: 'fe80::1%eth0', username: 'me@corp' }).target).toBeTruthy()
  })

  it('config entries with unsafe values are not offered', () => {
    const out = configHostsToTargets([{ host: 'ok' }, { host: '-bad' }, { host: 'ok' }, { host: 'u', user: '-x' }])
    expect(out.map((x) => x.configHost)).toEqual(['ok'])
  })

  it('finds ssh.exe in System32\\OpenSSH, then on the PATH', () => {
    const exists = (p) => p === 'C:\\Win\\System32\\OpenSSH\\ssh.exe'
    expect(findSshExe({ env: { SystemRoot: 'C:\\Win', PATH: '' }, exists })).toBe('C:\\Win\\System32\\OpenSSH\\ssh.exe')
    expect(findSshExe({ env: { SystemRoot: 'C:\\Win', PATH: 'C:\\Git\\usr\\bin' }, exists: (p) => p.startsWith('C:\\Git') })).toBe(
      'C:\\Git\\usr\\bin\\ssh.exe'
    )
    expect(findSshExe({ env: { SystemRoot: 'C:\\Win', PATH: '' }, exists: () => false })).toBe(null)
  })
})

describe('the host store', () => {
  it('imports ~/.ssh/config hosts, skipping wildcards, and saves them', async () => {
    writeConfig('Host *\n  User all\nHost prod\n  HostName prod.example.com\n  User deploy\nHost box\n')
    const s = service()
    const res = await s.importConfig()
    expect(res.targets.map((x) => x.configHost)).toEqual(['prod', 'box'])
    expect(s.list()[0]).toMatchObject({ label: 'prod', host: 'prod.example.com', username: 'deploy', port: 22, source: 'ssh-config' })
    const saved = JSON.parse(readFileSync(join(dir, 'remote-hosts.json'), 'utf8'))
    expect(saved.targets).toHaveLength(2)
    // A second sync adds nothing.
    expect((await service().importConfig()).targets).toEqual([])
  })

  it('refreshes config hosts, leaves edited ones alone, and keeps removed ones removed until Import', async () => {
    writeConfig('Host prod\n  HostName one\nHost box\n')
    const s = service()
    await s.importConfig()
    const prod = s.list().find((x) => x.configHost === 'prod')
    const box = s.list().find((x) => x.configHost === 'box')
    writeConfig('Host prod\n  HostName two\nHost box\n  HostName changed\n')
    expect(s.update(box.id, { label: 'Mine' }).ok).toBe(true)
    await s.importConfig()
    expect(s.get(prod.id).host).toBe('two')
    expect(s.get(box.id)).toMatchObject({ label: 'Mine', host: 'box', source: 'manual' })

    expect(s.remove(prod.id).ok).toBe(true)
    expect((await s.importConfig()).targets).toEqual([])
    expect(s.list().some((x) => x.configHost === 'prod')).toBe(false)
    expect((await s.importConfig({ reAdopt: true })).targets.map((x) => x.configHost)).toEqual(['prod'])
  })

  it('adds, updates and removes hand-made hosts with validation', () => {
    const s = service()
    expect(s.add({ host: 'a;b' })).toEqual({ ok: false, error: 'host-invalid' })
    const res = s.add({ host: 'srv', username: 'me', port: 2200, identityFile: '~/.ssh/k' })
    expect(res.ok).toBe(true)
    expect(res.target).toMatchObject({ label: 'me@srv', configHost: 'srv', source: 'manual' })
    expect(s.update(res.target.id, { identityFile: '' }).target.identityFile).toBeUndefined()
    expect(s.update('nope', {})).toEqual({ ok: false, error: 'not-found' })
    expect(s.remove(res.target.id).ok).toBe(true)
    expect(service().list()).toEqual([])
  })

  it('never stores a password field', () => {
    const s = service()
    const res = s.add({ host: 'srv', password: 'hunter2', passphrase: 'x' })
    expect(JSON.stringify(res.target)).not.toMatch(/hunter2|password|passphrase/)
    expect(readFileSync(join(dir, 'remote-hosts.json'), 'utf8')).not.toMatch(/hunter2/)
  })

  it('launchFor gives ssh.exe and the argv; errors without ssh or host', () => {
    const s = service()
    const { target } = s.add({ host: 'srv', port: 2222 })
    expect(s.launchFor(target.id)).toMatchObject({ ok: true, file: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', args: ['-p', '2222', 'srv'], name: 'srv' })
    expect(s.launchFor('ssh-missing').ok).toBe(false)
    expect(service({ sshExe: () => null }).launchFor(target.id).ok).toBe(false)
  })
})

describe('an imported host whose Host is edited (Codex review, defect 1)', () => {
  it('form -> service -> argv: connects to the host shown, not to the old alias', async () => {
    writeConfig('Host prod\n  HostName old.example.invalid\n  User deploy\n')
    const s = service()
    await s.importConfig()
    const old = s.list()[0]
    expect(s.launchFor(old.id).args).toEqual(['prod'])
    const form = formFromTarget(old)
    form.host = 'new.example.invalid'
    const payload = buildSavePayload(form)
    expect(payload.ok).toBe(true)
    expect(s.update(old.id, payload.target).ok).toBe(true)
    const launch = s.launchFor(old.id)
    expect(launch.target.host).toBe('new.example.invalid')
    expect(launch.args).toEqual(['-l', 'deploy', 'new.example.invalid'])
    expect(launch.args).not.toContain('prod')
    // The old alias is not brought back by the next passive sync...
    expect((await s.importConfig()).targets).toEqual([])
    expect(s.list()).toHaveLength(1)
    // ...only by Import, on request.
    expect((await s.importConfig({ reAdopt: true })).targets.map((x) => x.configHost)).toEqual(['prod'])
  })

  it('the service drops the alias even when the renderer sends it back unchanged', async () => {
    writeConfig('Host prod\n  HostName old.example.invalid\n  User deploy\n')
    const s = service()
    await s.importConfig()
    const old = s.list()[0]
    const res = s.update(old.id, { configHost: 'prod', host: 'new.example.invalid' })
    expect(res.target).toMatchObject({ configHost: 'new.example.invalid', host: 'new.example.invalid', source: 'manual' })
    expect(s.launchFor(old.id).args).toEqual(['-l', 'deploy', 'new.example.invalid'])
  })

  it('an alias kept (only the label edited) still dials the host and port shown', async () => {
    writeConfig('Host prod\n  HostName old.example.invalid\n  User deploy\n')
    const s = service()
    await s.importConfig()
    const old = s.list()[0]
    const form = formFromTarget(old)
    form.label = 'Production'
    s.update(old.id, buildSavePayload(form).target)
    expect(s.get(old.id)).toMatchObject({ configHost: 'prod', host: 'old.example.invalid', source: 'manual' })
    expect(s.launchFor(old.id).args).toEqual(['-o', 'HostName=old.example.invalid', '-p', '22', '-l', 'deploy', 'prod'])
  })

  it('a % in a stated HostName is escaped (no token expansion)', () => {
    const { target } = sanitizeTarget({ configHost: 'lab', host: 'fe80::1%eth0', source: 'manual' })
    expect(sshArgsFor(target)).toEqual(['-o', 'HostName=fe80::1%%eth0', '-p', '22', 'lab'])
  })

  it('an untouched config host still goes by its alias alone', async () => {
    writeConfig('Host prod\n  HostName old.example.invalid\n  User deploy\n  Port 2200\n')
    const s = service()
    await s.importConfig()
    expect(s.launchFor(s.list()[0].id).args).toEqual(['prod'])
  })
})

describe('Test connection', () => {
  it('runs ssh with execFile (no shell) and reports success', async () => {
    const runFile = vi.fn((file, args, opts, cb) => cb(null, '', ''))
    const s = service({ runFile })
    const { target } = s.add({ host: 'srv' })
    await expect(s.test(target.id)).resolves.toEqual({ success: true })
    const [file, args, opts] = runFile.mock.calls[0]
    expect(file).toMatch(/ssh\.exe$/)
    expect(Array.isArray(args)).toBe(true)
    expect(opts.shell).toBe(false)
  })

  it('reports ssh\'s last error line, or a timeout', async () => {
    const s = service({ runFile: (f, a, o, cb) => cb(Object.assign(new Error('x'), { code: 255 }), '', 'debug\nHost key verification failed.\n') })
    const { target } = s.add({ host: 'srv' })
    await expect(s.test(target.id)).resolves.toEqual({ success: false, error: 'Host key verification failed.' })
    const s2 = service({ runFile: (f, a, o, cb) => cb(Object.assign(new Error('x'), { killed: true }), '', '') })
    expect((await s2.test(target.id)).error).toMatch(/timed out/)
  })
})

describe('live state', () => {
  it('connected while an ssh pane runs; error when ssh fails with 255; disconnected otherwise', () => {
    const changes = []
    const s = service({ onChange: (st) => changes.push(st) })
    const { target } = s.add({ host: 'srv' })
    s.paneStarted('pane-1', target.id)
    s.paneStarted('pane-2', target.id)
    expect(s.snapshot()[target.id]).toMatchObject({ status: 'connected', panes: ['pane-1', 'pane-2'] })
    s.paneExited('pane-1', 0)
    expect(s.snapshot()[target.id].status).toBe('connected')
    s.paneExited('pane-2', 255)
    expect(s.snapshot()[target.id].status).toBe('error')
    s.paneStarted('pane-3', target.id)
    s.markDisconnecting(target.id)
    s.paneExited('pane-3', 255)
    expect(s.snapshot()[target.id].status).toBe('disconnected')
    s.paneExited('pane-unknown', 0)
    expect(changes.length).toBeGreaterThan(3)
  })

  it('closing its pane is not an error, whatever ssh returns', () => {
    const s = service()
    const { target } = s.add({ host: 'srv' })
    s.paneStarted('pane-1', target.id)
    s.paneClosing('pane-1')
    s.paneExited('pane-1', 255)
    expect(s.snapshot()[target.id].status).toBe('disconnected')
  })
})

describe('connecting state', () => {
  it('a new ssh pane is connecting until it gets through; ssh exiting with 255 is an error', () => {
    const s = service()
    const { target } = s.add({ host: 'srv' })
    s.paneStarted('pane-1', target.id, { connected: false })
    expect(s.snapshot()[target.id]).toMatchObject({ status: 'connecting', panes: ['pane-1'] })
    s.paneConnected('pane-1')
    expect(s.snapshot()[target.id].status).toBe('connected')
    s.paneStarted('pane-2', target.id, { connected: false })
    expect(s.snapshot()[target.id].status).toBe('connected') // one of them got through
    s.paneExited('pane-1', 0)
    expect(s.snapshot()[target.id].status).toBe('connecting')
    s.paneExited('pane-2', 255)
    expect(s.snapshot()[target.id].status).toBe('error')
    // Cancelled from the password dialog: disconnected, not an error.
    s.paneStarted('pane-3', target.id, { connected: false })
    s.markDisconnecting(target.id)
    s.paneExited('pane-3', 255)
    expect(s.snapshot()[target.id].status).toBe('disconnected')
  })

  it('ssh asking again after it counted as connected goes back to connecting', () => {
    const s = service()
    const { target } = s.add({ host: 'srv' })
    s.paneStarted('pane-1', target.id, { connected: false })
    s.paneConnected('pane-1')
    s.paneConnecting('pane-1')
    expect(s.snapshot()[target.id].status).toBe('connecting')
    s.paneConnected('pane-1')
    expect(s.snapshot()[target.id].status).toBe('connected')
    s.paneConnecting('pane-unknown')
  })
})

describe('IPC', () => {
  it('registers remoteHosts:* and disconnect ends the host\'s panes', async () => {
    const handlers = {}
    const ipcMain = { handle: (ch, fn) => (handlers[ch] = fn) }
    const killed = []
    const s = service()
    registerRemoteHosts({ ipcMain, service: s, killPane: (id) => killed.push(id) })
    expect(Object.keys(handlers).sort()).toEqual([
      'remoteHosts:add', 'remoteHosts:disconnect', 'remoteHosts:importConfig', 'remoteHosts:list', 'remoteHosts:remove', 'remoteHosts:test', 'remoteHosts:update'
    ])
    const added = await handlers['remoteHosts:add'](null, { target: { host: 'srv' } })
    s.paneStarted('pane-9', added.target.id)
    expect((await handlers['remoteHosts:list'](null)).targets).toHaveLength(1)
    expect(await handlers['remoteHosts:disconnect'](null, { id: added.target.id })).toEqual({ ok: true, closed: 1 })
    expect(killed).toEqual(['pane-9'])
    expect((await handlers['remoteHosts:add'](null, { target: { host: '-x' } })).ok).toBe(false)
  })
})
