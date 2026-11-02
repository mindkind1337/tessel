// @vitest-environment node
// "Where you're signed in" in main (signedInPlaces.js, wslAccounts.js): this
// PC, its WSL distros and the saved SSH hosts, each place on its own (a slow
// or broken one never holds the others), identity fields only, removal
// offered only for the folders Tessel made on a host.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createSignedInPlaces, hostRows, pcAccountRows, copilotRows } from '../signedInPlaces'
import { createWslAccounts, distroNames } from '../wslAccounts'

const accountsList = {
  ok: true,
  providers: [
    { provider: 'claude', selectedId: null, system: { id: null, label: 'System default', email: 'coreine13@gmail.com', organization: 'Org', plan: 'pro', status: 'ready' }, accounts: [{ id: 'uuid-1', label: 'work', email: 'work@corp.example', plan: 'max', status: 'missing', lastLoginAt: '2026-10-01T10:00:00.000Z' }] },
    { provider: 'codex', selectedId: null, system: { id: null, label: 'System default', status: 'missing', email: null }, accounts: [] },
    { provider: 'codex', error: 'unreadable' }
  ]
}
const hostEntries = [
  { agent: 'claude', scope: 'default', id: null, dir: '/home/u/.claude', email: 'coreine13@gmail.com', plan: 'pro', cred: 'file', mtimeMs: 1000 },
  { agent: 'claude', scope: 'tessel', id: 'abc123', dir: '/home/u/.tessel-server/accounts/claude/abc123', email: 'work@corp.example', cred: 'file', mtimeMs: 2000 },
  { agent: 'codex', scope: 'default', id: null, dir: '/home/u/.codex', email: 'dev@example.com' },
  { agent: 'gemini', scope: 'default', id: null, dir: '/home/u/.gemini', email: 'g@example.com', cred: 'file' }
]

describe('rows', () => {
  it('this PC: the system sign-in and the accounts added in Tessel (Claude Code, Codex), nothing else', () => {
    expect(pcAccountRows(accountsList)).toEqual([
      { agent: 'claude', scope: 'system', id: null, email: 'coreine13@gmail.com', org: 'Org', plan: 'pro', login: null, providers: undefined, state: 'signed-in', lastSeen: null, removable: false, signOut: false },
      { agent: 'claude', scope: 'tessel', id: 'uuid-1', email: 'work@corp.example', org: null, plan: 'max', login: null, providers: undefined, state: 'missing', lastSeen: Date.parse('2026-10-01T10:00:00.000Z'), removable: false, signOut: false }
    ])
    expect(pcAccountRows(null)).toEqual([])
  })

  it('a host: removal only for a folder Tessel made, sign-out only for the agent’s own sign-in file', () => {
    const rows = hostRows(hostEntries, { actions: true })
    expect(rows.map((r) => [r.agent, r.scope, r.removable, r.signOut, r.state])).toEqual([
      ['claude', 'default', false, true, 'signed-in'],
      ['claude', 'tessel', true, false, 'signed-in'],
      ['codex', 'default', false, false, 'profile'],
      ['gemini', 'default', false, false, 'signed-in']
    ])
    // A WSL distro: read only.
    expect(hostRows(hostEntries).some((r) => r.removable || r.signOut)).toBe(false)
  })

  it('Copilot on this PC: its GitHub login only', async () => {
    const home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-copilot-'))
    try {
      expect(await copilotRows({ home })).toEqual([])
      fs.mkdirSync(join(home, '.copilot'))
      fs.writeFileSync(join(home, '.copilot', 'config.json'), JSON.stringify({ last_logged_in_user: { host: 'https://github.com', login: 'octocat' }, token: 'SECRET-COPILOT' }))
      const rows = await copilotRows({ home })
      expect(rows).toMatchObject([{ agent: 'copilot', scope: 'default', login: 'octocat', state: 'signed-in' }])
      expect(JSON.stringify(rows)).not.toContain('SECRET')
      fs.writeFileSync(join(home, '.copilot', 'config.json'), '{ broken')
      expect(await copilotRows({ home })).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('createSignedInPlaces', () => {
  function make({ connected = () => true, detect, cached = () => null, wsl = null, confirmStart = async () => true } = {}) {
    const remoteAccounts = {
      detect: vi.fn(detect || (async (hostId) => ({ ok: true, hostId, at: 5, os: 'Linux', home: '/home/u', entries: hostEntries }))),
      cached: vi.fn(cached)
    }
    const places = createSignedInPlaces({
      accounts: { list: async () => accountsList },
      localSignIn: async (provider) => (provider === 'gemini' ? { signedIn: true, email: 'g@example.com', planType: null } : { signedIn: false }),
      localOthers: async () => [{ agent: 'copilot', scope: 'default', login: 'octocat' }],
      hosts: { list: () => [{ id: 'ssh-a', label: 'alpha' }, { id: 'ssh-b', label: 'beta' }, { id: 'bad id!', label: 'x' }] },
      connected,
      remoteAccounts,
      wsl,
      confirmStart,
      now: () => 100
    })
    return { places, remoteAccounts }
  }

  it('answers at once: this PC read now, hosts from their last check (never scanned here)', async () => {
    const { places, remoteAccounts } = make({ connected: (h) => h === 'ssh-a', cached: (h) => (h === 'ssh-b' ? { ok: true, at: 1, entries: hostEntries } : null) })
    const res = await places.places()
    expect(res.ok).toBe(true)
    expect(remoteAccounts.detect).not.toHaveBeenCalled()
    const [pc, a, b] = res.places
    expect(pc.entries.map((e) => [e.agent, e.scope, e.email || e.login])).toEqual([
      ['claude', 'system', 'coreine13@gmail.com'],
      ['claude', 'tessel', 'work@corp.example'],
      ['gemini', 'default', 'g@example.com'],
      ['copilot', 'default', 'octocat']
    ])
    expect(a).toMatchObject({ id: 'ssh:ssh-a', state: 'unknown', entries: [] })
    expect(b).toMatchObject({ id: 'ssh:ssh-b', state: 'not-connected', stale: true })
    expect(b.entries).toHaveLength(4)
    expect(res.places).toHaveLength(3)
  })

  it('scans one host at a time on request; a host that is not connected is never asked', async () => {
    const { places, remoteAccounts } = make({ connected: (h) => h === 'ssh-a' })
    const a = await places.scan('ssh:ssh-a', { fresh: true })
    expect(remoteAccounts.detect).toHaveBeenCalledWith('ssh-a', { fresh: true, relogin: false })
    expect(a.place).toMatchObject({ state: 'ready', os: 'Linux' })
    expect(a.place.entries.find((e) => e.scope === 'tessel')).toMatchObject({ removable: true, email: 'work@corp.example' })
    const b = await places.scan('ssh:ssh-b')
    expect(b.place.state).toBe('not-connected')
    expect(remoteAccounts.detect).toHaveBeenCalledTimes(1)
    expect(await places.scan('ssh:nope')).toEqual({ ok: false })
    expect(await places.scan('../etc')).toEqual({ ok: false })
  })

  it('one host failing or slow never holds the others', async () => {
    let release
    const slow = new Promise((r) => (release = r))
    const { places } = make({
      detect: async (hostId) => (hostId === 'ssh-a' ? slow : { ok: false, error: 'The accounts on beta could not be read.' })
    })
    const pending = places.scan('ssh:ssh-a')
    const b = await places.scan('ssh:ssh-b')
    expect(b.place).toMatchObject({ state: 'error', error: 'The accounts on beta could not be read.', entries: [] })
    release({ ok: true, hostId: 'ssh-a', at: 1, entries: hostEntries })
    expect((await pending).place.state).toBe('ready')
  })

  it('WSL: running distros listed to check, a stopped one never started unless asked', async () => {
    const wsl = {
      list: vi.fn(async () => ({ ok: true, distros: [{ name: 'Ubuntu', running: true }, { name: 'Debian', running: false }] })),
      scan: vi.fn(async (name, { start }) => (name === 'Debian' && !start ? { ok: false, stopped: true } : { ok: true, os: 'Linux', entries: hostEntries.slice(0, 1) }))
    }
    const { places } = make({ wsl })
    const res = await places.places()
    expect(res.places.filter((p) => p.kind === 'wsl').map((p) => [p.id, p.state])).toEqual([
      ['wsl:Ubuntu', 'unknown'],
      ['wsl:Debian', 'stopped']
    ])
    const u = await places.scan('wsl:Ubuntu')
    expect(u.place).toMatchObject({ state: 'ready', entries: [{ agent: 'claude', removable: false, signOut: false }] })
    expect((await places.scan('wsl:Debian')).place.state).toBe('stopped')
    expect(wsl.scan).toHaveBeenLastCalledWith('Debian', { start: false, dirs: null })
    expect((await places.scan('wsl:Debian', { start: true })).place.state).toBe('ready')
    // The last scan is shown next time.
    expect((await places.places()).places.find((p) => p.id === 'wsl:Ubuntu').state).toBe('ready')
    expect(wsl.list).toHaveBeenCalledTimes(1)
  })

  it('a host: a folder left by a removed account can be removed; what its login shell exports counts for every row of that agent; a refresh asks the login shell again', async () => {
    const entries = [
      { agent: 'claude', scope: 'orphan', id: 'zzz999', dir: '/home/u/.tessel-server/accounts/claude/zzz999', email: 'b@example.com', cred: 'file' },
      { agent: 'claude', scope: 'tessel', id: 'abc123', dir: '/home/u/.tessel-server/accounts/claude/abc123', email: 'w@example.com', cred: 'file', override: ['helper'] }
    ]
    const { places, remoteAccounts } = make({ detect: async (hostId) => ({ ok: true, hostId, at: 1, entries, envOverrides: { claude: ['key'], codex: [] } }) })
    const res = await places.scan('ssh:ssh-a', { fresh: true, relogin: true })
    expect(remoteAccounts.detect).toHaveBeenCalledWith('ssh-a', { fresh: true, relogin: true })
    expect(res.place.entries.map((e) => [e.scope, e.removable, e.override])).toEqual([
      ['orphan', true, ['key']],
      ['tessel', true, ['helper', 'key']]
    ])
  })

  it('WSL: the login shell asked at the first check only (then its folders passed back), again on a refresh; a stopped distro starts only after your yes', async () => {
    const wsl = {
      list: vi.fn(async () => ({ ok: true, distros: [{ name: 'Ubuntu', running: true }, { name: 'Debian', running: false }] })),
      scan: vi.fn(async () => ({ ok: true, os: 'Linux', loginEnv: { claude: '/opt/c', codex: null }, envOverrides: { claude: ['token'], codex: [] }, entries: hostEntries.slice(0, 1) }))
    }
    let yes = false
    const confirmStart = vi.fn(async () => yes)
    const { places } = make({ wsl, confirmStart })
    await places.places()
    const first = await places.scan('wsl:Ubuntu')
    expect(wsl.scan).toHaveBeenLastCalledWith('Ubuntu', { start: false, dirs: null })
    expect(first.place.entries[0].override).toEqual(['token'])
    await places.scan('wsl:Ubuntu', { fresh: true })
    expect(wsl.scan).toHaveBeenLastCalledWith('Ubuntu', { start: false, dirs: { claude: '/opt/c', codex: null, overrides: { claude: ['token'], codex: [] } } })
    await places.scan('wsl:Ubuntu', { fresh: true, relogin: true })
    expect(wsl.scan).toHaveBeenLastCalledWith('Ubuntu', { start: false, dirs: null })
    const calls = wsl.scan.mock.calls.length
    expect((await places.scan('wsl:Debian', { start: true })).place.state).toBe('stopped')
    expect(confirmStart).toHaveBeenCalledWith('Debian')
    expect(wsl.scan.mock.calls.length).toBe(calls)
    yes = true
    expect((await places.scan('wsl:Debian', { start: true })).place.state).toBe('ready')
  })

  it('this PC unreadable: the others still show', async () => {
    const places = createSignedInPlaces({ accounts: { list: async () => { throw new Error('x') } }, hosts: { list: () => [] }, remoteAccounts: { cached: () => null } })
    const res = await places.places()
    expect(res.places).toEqual([{ id: 'pc', kind: 'pc', state: 'ready', at: expect.any(Number), entries: [] }])
  })
})

describe('wslAccounts', () => {
  const utf16 = (s) => Buffer.from('\uFEFF' + s, 'utf16le')
  it('reads wsl.exe’s UTF-16 list, without Docker’s own distros or odd names', () => {
    expect(distroNames(utf16('Ubuntu-22.04\r\ndocker-desktop\r\nDebian\r\n'))).toEqual(['Ubuntu-22.04', 'Debian'])
    expect(distroNames(Buffer.from('Ubuntu\nbad name\n'))).toEqual(['Ubuntu'])
    expect(distroNames(utf16('There are no running distributions.\r\n'))).toEqual([])
  })

  function fakeSpawn(answers) {
    const calls = []
    const spawnImpl = (file, args) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      const input = []
      child.stdin = { on() {}, write: (d) => input.push(String(d)), end() {} }
      child.kill = vi.fn()
      calls.push({ file, args, input, child })
      const a = answers(args)
      setTimeout(() => {
        if (a.hang) return
        if (a.out) child.stdout.emit('data', Buffer.isBuffer(a.out) ? a.out : Buffer.from(a.out))
        child.emit('close', a.code ?? 0)
      }, 1)
      return child
    }
    return { spawnImpl, calls }
  }

  it('runs the script on stdin (never on the command line), in the distro asked for', async () => {
    const { spawnImpl, calls } = fakeSpawn((args) => (args[0] === '-l' ? { out: utf16('Ubuntu\r\n') } : { out: '@h Linux /home/u\n@a claude default - - /home/u/.claude\nv email a@b.co\nv cred file\n' }))
    const wsl = createWslAccounts({ wslExe: 'C:\\Windows\\System32\\wsl.exe', spawnImpl })
    const res = await wsl.scan('Ubuntu')
    expect(res).toMatchObject({ ok: true, home: '/home/u', entries: [{ agent: 'claude', email: 'a@b.co' }] })
    const run = calls.find((c) => c.args[0] === '-d')
    expect(run.args).toEqual(['-d', 'Ubuntu', '-e', 'sh', '-s'])
    expect(run.input.join('')).toContain('__t_accts login')
    expect(await wsl.scan('bad name')).toEqual({ ok: false })
  })

  it('later scans pass back the login shell’s folders (its profile not run again), quoted (a quote in a name too)', async () => {
    const { spawnImpl, calls } = fakeSpawn((args) => (args[0] === '-l' ? { out: utf16('Ubuntu\r\n') } : { out: '@h Linux /home/u\n' }))
    const wsl = createWslAccounts({ wslExe: 'wsl.exe', spawnImpl })
    await wsl.scan('Ubuntu', { dirs: { claude: '/opt/claude alt', codex: "/opt/it's" } })
    const input = calls.find((c) => c.args[0] === '-d').input.join('')
    expect(input).toContain("__t_accts dirs '/opt/claude alt' '/opt/it'\\''s'\n")
    expect(input).not.toContain('__t_accts login')
  })

  it('a stopped distro is not started by a scan; asked (start), it is', async () => {
    const { spawnImpl, calls } = fakeSpawn((args) => (args[1] === '--running' ? { out: utf16('Other\r\n') } : args[0] === '-l' ? { out: utf16('Ubuntu\r\nOther\r\n') } : { out: '@h Linux /root\n' }))
    const wsl = createWslAccounts({ wslExe: 'wsl.exe', spawnImpl })
    expect(await wsl.scan('Ubuntu')).toEqual({ ok: false, stopped: true })
    expect(calls.some((c) => c.args[0] === '-d')).toBe(false)
    expect(await wsl.scan('Ubuntu', { start: true })).toMatchObject({ ok: true })
    expect(await wsl.list()).toEqual({ ok: true, distros: [{ name: 'Ubuntu', running: false }, { name: 'Other', running: true }] })
  })

  it('a distro that does not answer in time is stopped waiting for', async () => {
    const { spawnImpl, calls } = fakeSpawn((args) => (args[0] === '-d' ? { hang: true } : { out: utf16('Ubuntu\r\n') }))
    const wsl = createWslAccounts({ wslExe: 'wsl.exe', spawnImpl, timeoutMs: 30 })
    expect(await wsl.scan('Ubuntu')).toEqual({ ok: false, timeout: true })
    expect(calls.find((c) => c.args[0] === '-d').child.kill).toHaveBeenCalled()
  })

  it('no wsl.exe: no distro, nothing run', async () => {
    const spawnImpl = vi.fn()
    const wsl = createWslAccounts({ wslExe: 'wsl.exe', spawnImpl, exists: () => false })
    expect(await wsl.list()).toEqual({ ok: true, distros: [] })
    expect(await wsl.scan('Ubuntu')).toEqual({ ok: false })
    expect(spawnImpl).not.toHaveBeenCalled()
  })
})

// A Claude account's subscription as Anthropic reports it (this PC:
// claudePlanCheck.js through accounts.list(); a host or a WSL distro: its
// own check), carried on each row, its fields checked again.
describe('the subscription of each Claude sign-in', () => {
  const CANCELED = { organization_type: 'claude_free', rate_limit_tier: 'default_claude_ai', billing_type: 'none', subscription_status: 'canceled', has_claude_max: false, has_claude_pro: false, checkedAt: 5000 }
  it('this PC and a host: kept on the row as checked, nothing else from it; never on another agent', () => {
    const list = structuredClone(accountsList)
    list.providers[0].system.subscription = { ...CANCELED, payment_auth_hosted_invoice_url: 'https://invoice.example.invalid/x', email: 'x@example.invalid' }
    const [system, added] = pcAccountRows(list)
    expect(system.sub).toEqual({ ...CANCELED, plan_display_name: null, seat_tier: null, claude_code_trial_ends_at: null })
    expect(JSON.stringify(system)).not.toMatch(/invoice|example\.invalid/)
    expect(added.sub).toBeUndefined()
    const rows = hostRows([{ ...hostEntries[0], sub: CANCELED }, { ...hostEntries[2], sub: CANCELED }, { ...hostEntries[1], sub: { checkedAt: 5 } }])
    expect(rows[0].sub).toMatchObject({ organization_type: 'claude_free' })
    expect(rows[1].sub).toBeUndefined()
    expect(rows[2].sub).toBeUndefined()
  })

  it('an SSH host: a refresh you ask for starts its subscription check without waiting for it', async () => {
    const remoteAccounts = {
      detect: vi.fn(async (hostId) => ({ ok: true, hostId, at: 5, entries: hostEntries })),
      // Never answers: the scan must not wait for it.
      planCheck: vi.fn(() => new Promise(() => {})),
      cached: vi.fn(() => null)
    }
    const places = createSignedInPlaces({ accounts: { list: async () => accountsList }, hosts: { list: () => [{ id: 'ssh-a', label: 'alpha' }] }, connected: () => true, remoteAccounts, now: () => 100 })
    const plain = await places.scan('ssh:ssh-a')
    expect(remoteAccounts.planCheck).not.toHaveBeenCalled()
    expect(plain.place.state).toBe('ready')
    const asked = await places.scan('ssh:ssh-a', { fresh: true, relogin: true })
    expect(asked.place.state).toBe('ready')
    await vi.waitFor(() => expect(remoteAccounts.planCheck).toHaveBeenCalledWith('ssh-a', { force: true }))
  })

  it('a WSL distro: checked by the distro itself after its check answered (never waited for), one at a time, a refresh at most once a minute; a later failure keeps the result', async () => {
    let clock = 100
    let release
    let answer = { ok: true, entries: [{ scope: 'default', id: null, dir: '/home/u/.claude', check: 'ok', account: null, sub: CANCELED }] }
    const wsl = {
      list: vi.fn(async () => ({ ok: true, distros: [{ name: 'Ubuntu', running: true }] })),
      scan: vi.fn(async () => ({ ok: true, os: 'Linux', loginEnv: { claude: '/opt/c', codex: null }, entries: hostEntries.slice(0, 1) })),
      plans: vi.fn(() => new Promise((r) => (release = () => r(answer))))
    }
    const onPlans = vi.fn()
    const places = createSignedInPlaces({ accounts: { list: async () => accountsList }, hosts: { list: () => [] }, remoteAccounts: { cached: () => null }, wsl, now: () => clock, wslTtlMs: 0, onPlans })
    await places.places()
    const first = await places.scan('wsl:Ubuntu')
    // Answered before the distro's own check is done.
    expect(first.place.entries[0].sub).toBeUndefined()
    await vi.waitFor(() => expect(wsl.plans).toHaveBeenCalledWith('Ubuntu', { claude: '/opt/c' }))
    // A refresh while it runs: no second check.
    await places.scan('wsl:Ubuntu', { fresh: true, relogin: true })
    expect(wsl.plans).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(onPlans).toHaveBeenCalledTimes(1))
    // Its result is shown with the last scan, and with the next ones.
    expect((await places.places()).places.find((p) => p.id === 'wsl:Ubuntu').entries[0].sub).toMatchObject({ organization_type: 'claude_free' })
    expect((await places.scan('wsl:Ubuntu', { fresh: true })).place.entries[0].sub).toMatchObject({ organization_type: 'claude_free' })
    // Refreshes within the minute: not again; after it, again.
    clock += 30_000
    await places.scan('wsl:Ubuntu', { fresh: true, relogin: true })
    expect(wsl.plans).toHaveBeenCalledTimes(1)
    clock += 31_000
    answer = { ok: true, entries: [{ scope: 'default', id: null, dir: '/home/u/.claude', check: 'expired', account: null, sub: null }] }
    await places.scan('wsl:Ubuntu', { fresh: true, relogin: true })
    expect(wsl.plans).toHaveBeenCalledTimes(2)
    release()
    await new Promise((r) => setTimeout(r, 5))
    expect((await places.scan('wsl:Ubuntu', { fresh: true })).place.entries[0].sub).toMatchObject({ organization_type: 'claude_free', checkedAt: 5000 })
  })

  it('wslAccounts.plans: the check runs in the distro, its script on stdin, the login shell’s folder passed back quoted', async () => {
    const calls = []
    const spawnImpl = (file, args) => {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      const input = []
      child.stdin = { on() {}, write: (d) => input.push(String(d)), end() {} }
      child.kill = vi.fn()
      calls.push({ args, input })
      setTimeout(() => {
        child.stdout.emit('data', args[0] === '-l' ? Buffer.from('\uFEFFUbuntu\r\n', 'utf16le') : Buffer.from('@h Linux /home/u\n@a claude default - - /home/u/.claude\nv subcheck ok\nv sub_organization_type claude_max\nv sub_rate_limit_tier default_claude_max_20x\n'))
        child.emit('close', 0)
      }, 1)
      return child
    }
    const wsl = createWslAccounts({ wslExe: 'wsl.exe', spawnImpl })
    const res = await wsl.plans('Ubuntu', { claude: "/opt/it's" })
    expect(res).toMatchObject({ ok: true, entries: [{ scope: 'default', check: 'ok', sub: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } }] })
    const run = calls.find((c) => c.args[0] === '-d')
    expect(run.args).toEqual(['-d', 'Ubuntu', '-e', 'sh', '-s'])
    expect(run.input.join('')).toContain("__t_acctplan dirs '/opt/it'\\''s'\n")
    expect(await wsl.plans('bad name')).toEqual({ ok: false })
  })
})
