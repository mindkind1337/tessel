// @vitest-environment node
// Tessel's own tmux put on an SSH host without one (ssh/remoteTmux.js): the
// system's tmux wins, the copy goes once per host per app run, a host it
// cannot run on is remembered, the pane never waits long, and the pane's
// "no tmux" line says what happened (sshMessages.js tmuxMissingText).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTmuxInstaller, parseTmuxQuery, TMUX_WAIT_MS } from '../ssh/remoteTmux'
import { sshTemplates, tmuxMissingText } from '../ssh/sshMessages'

const t = (_k, en, vars) => (vars ? en.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, n) => (vars[n] == null ? m : String(vars[n]))) : en)
const BIN = Buffer.from('ELF x64')
const SHA = 'a'.repeat(64)
const fakeBundle = { version: '3.5a', file: (a) => (a === 'linux-x64' ? '/res/linux-x64/tmux' : null), sha256: (a) => (a === 'linux-x64' ? SHA : null), read: (a) => (a === 'linux-x64' ? BIN : null) }

function setup({ bundle = fakeBundle, query = '@arch x86_64\n', installRc = 0, connected = true, waitMs = TMUX_WAIT_MS } = {}) {
  const calls = []
  const logs = []
  let clock = 1000
  const installer = createTmuxInstaller({
    bundle,
    connected: () => connected,
    query: async (hostId) => {
      calls.push(['query', hostId])
      return typeof query === 'function' ? query() : { rc: 0, out: Buffer.from(query), err: '' }
    },
    install: async (hostId, copy) => {
      calls.push(['install', hostId, copy.version, copy.sha256, copy.binary])
      return typeof installRc === 'function' ? installRc() : { rc: installRc, out: installRc === 0 ? 'tmux 3.5a\n' : '', err: '' }
    },
    log: (m) => logs.push(m),
    now: () => clock,
    waitMs
  })
  return { installer, calls, logs, tick: (ms) => (clock += ms) }
}

afterEach(() => vi.useRealTimers())

describe('what the host said', () => {
  it('parses the system tmux, Tessel’s copy and uname -m', () => {
    expect(parseTmuxQuery('@sys tmux 3.4\n')).toEqual({ system: 'tmux 3.4', own: null, arch: null })
    expect(parseTmuxQuery('@own tmux 3.5a\r\n@arch aarch64\n')).toEqual({ system: null, own: 'tmux 3.5a', arch: 'aarch64' })
    expect(parseTmuxQuery(Buffer.from('@arch x86_64\n'))).toEqual({ system: null, own: null, arch: 'x86_64' })
    expect(parseTmuxQuery('')).toEqual({ system: null, own: null, arch: null })
  })
})

describe('the install', () => {
  it('a host with its own tmux: nothing sent, remembered for the run', async () => {
    const { installer, calls } = setup({ query: '@sys tmux 3.4\n@arch x86_64\n' })
    expect(await installer.ensure('h1')).toEqual({ ok: true, source: 'system', version: 'tmux 3.4' })
    expect(await installer.ensure('h1')).toEqual({ ok: true, source: 'system', version: 'tmux 3.4' })
    expect(calls).toEqual([['query', 'h1']])
  })

  it('a Linux x86_64 host without tmux: the bundled copy goes there with its version and sha256, once; the pane waiting gets the answer', async () => {
    const { installer, calls, logs } = setup()
    const r = await installer.forPane('h1')
    expect(r).toMatchObject({ ok: true, source: 'bundled', installed: true, version: 'tmux 3.5a' })
    expect(calls).toEqual([
      ['query', 'h1'],
      ['install', 'h1', '3.5a', SHA, BIN]
    ])
    expect(await installer.forPane('h1')).toMatchObject({ ok: true, source: 'bundled' })
    expect(await installer.ensure('h2')).toMatchObject({ ok: true, source: 'bundled' })
    expect(calls).toHaveLength(4)
    expect(logs.some((m) => m.includes('put on h1'))).toBe(true)
  })

  it('Tessel’s copy already there at the bundled version is reused; an older copy is replaced', async () => {
    const same = setup({ query: '@own tmux 3.5a\n@arch x86_64\n' })
    expect(await same.installer.ensure('h1')).toEqual({ ok: true, source: 'bundled', version: 'tmux 3.5a' })
    expect(same.calls.map((c) => c[0])).toEqual(['query'])
    const older = setup({ query: '@own tmux 3.4\n@arch x86_64\n' })
    expect(await older.installer.ensure('h1')).toMatchObject({ ok: true, source: 'bundled', installed: true })
    expect(older.calls.map((c) => c[0])).toEqual(['query', 'install'])
  })

  it('no copy for the host’s kind of machine: said with uname -m, remembered, nothing sent', async () => {
    const { installer, calls } = setup({ query: '@arch armv7l\n' })
    expect(await installer.ensure('h1')).toEqual({ ok: false, reason: 'no-arch', arch: 'armv7l' })
    expect(await installer.ensure('h1')).toEqual({ ok: false, reason: 'no-arch', arch: 'armv7l' })
    expect(calls).toEqual([['query', 'h1']])
    const arm = setup({ query: '@arch aarch64\n' })
    // The bundle here has no arm64 binary.
    expect(await arm.installer.ensure('h1')).toEqual({ ok: false, reason: 'no-arch', arch: 'aarch64' })
    const none = setup({ query: '\n' })
    expect(await none.installer.ensure('h1')).toEqual({ ok: false, reason: 'no-arch', arch: '?' })
  })

  it('this build ships no copy: no-bundle, without asking the host (the pane keeps the plain "no tmux" line)', async () => {
    const { installer, calls } = setup({ bundle: null })
    expect(await installer.forPane('h1')).toEqual({ ok: false, reason: 'no-bundle' })
    expect(calls).toEqual([])
    expect(installer.bundled).toBe(false)
  })

  it('the host’s exit codes: 83 checksum, 84 noexec (remembered), 98/124 upload, others failed; a failure is tried again after a minute', async () => {
    const checksum = setup({ installRc: 83 })
    expect(await checksum.installer.ensure('h1')).toMatchObject({ ok: false, reason: 'checksum' })
    expect(await checksum.installer.ensure('h1')).toMatchObject({ ok: false, reason: 'checksum' })
    expect(checksum.calls.filter((c) => c[0] === 'install')).toHaveLength(1)
    checksum.tick(61_000)
    expect(await checksum.installer.ensure('h1')).toMatchObject({ ok: false, reason: 'checksum' })
    expect(checksum.calls.filter((c) => c[0] === 'install')).toHaveLength(2)
    const noexec = setup({ installRc: 84 })
    expect(await noexec.installer.ensure('h1')).toMatchObject({ ok: false, reason: 'noexec' })
    noexec.tick(10 * 60_000)
    expect(await noexec.installer.ensure('h1')).toMatchObject({ ok: false, reason: 'noexec' })
    expect(noexec.calls.filter((c) => c[0] === 'install')).toHaveLength(1)
    expect((await setup({ installRc: 98 }).installer.ensure('h1')).reason).toBe('upload')
    expect((await setup({ installRc: 124 }).installer.ensure('h1')).reason).toBe('upload')
    expect((await setup({ installRc: 90 }).installer.ensure('h1')).reason).toBe('failed')
    expect((await setup({ installRc: () => ({ error: 'lane closed' }) }).installer.ensure('h1')).reason).toBe('upload')
    expect((await setup({ query: () => ({ error: 'not connected' }) }).installer.ensure('h1')).reason).toBe('failed')
    expect((await setup({ query: () => ({ rc: 97, out: '' }) }).installer.ensure('h1')).reason).toBe('failed')
    expect((await setup({ query: () => Promise.reject(new Error('boom')) }).installer.ensure('h1')).reason).toBe('failed')
  })

  it('a pane on a host not connected yet opens plain (nothing started); the install goes on when asked for later', async () => {
    const { installer, calls } = setup({ connected: false })
    expect(await installer.forPane('h1')).toEqual({ ok: false, reason: 'not-connected' })
    expect(calls).toEqual([])
    expect(await installer.ensure('h1')).toMatchObject({ ok: true, source: 'bundled' })
    expect(await installer.forPane('h1')).toMatchObject({ ok: true, source: 'bundled' })
  })

  it('a pane waits for a running install at most waitMs, then opens plain while the install goes on', async () => {
    vi.useFakeTimers()
    let finish
    const { installer } = setup({ installRc: () => new Promise((resolve) => (finish = resolve)), waitMs: 5000 })
    const pane = installer.forPane('h1')
    await vi.advanceTimersByTimeAsync(5001)
    expect(await pane).toEqual({ ok: false, reason: 'slow' })
    finish({ rc: 0, out: 'tmux 3.5a', err: '' })
    await vi.advanceTimersByTimeAsync(1)
    expect(await installer.forPane('h1')).toMatchObject({ ok: true, source: 'bundled' })
  })

  it('one install at a time per host: two panes opening together share it', async () => {
    let finish
    const { installer, calls } = setup({ installRc: () => new Promise((resolve) => (finish = resolve)) })
    const a = installer.forPane('h1')
    const b = installer.forPane('h1')
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    finish({ rc: 0, out: 'tmux 3.5a', err: '' })
    expect(await a).toMatchObject({ ok: true })
    expect(await b).toMatchObject({ ok: true })
    expect(calls.filter((c) => c[0] === 'install')).toHaveLength(1)
  })
})

describe('the pane’s "no tmux" line', () => {
  const templates = sshTemplates(t)
  it('says why Tessel’s copy could not be put there, with {{host}} left for the terminal host', () => {
    expect(tmuxMissingText(templates, { ok: false, reason: 'no-arch', arch: 'armv7l' })).toBe('tmux is not installed on {{host}} and Tessel’s own copy could not be put there (no copy for this kind of machine, armv7l): this session will not survive a lost connection.')
    expect(tmuxMissingText(templates, { ok: false, reason: 'noexec' })).toContain('(the home folder there refuses to run programs)')
    expect(tmuxMissingText(templates, { ok: false, reason: 'checksum' })).toContain('(the copy did not arrive intact)')
    expect(tmuxMissingText(templates, { ok: false, reason: 'upload' })).toContain('(the upload failed)')
    expect(tmuxMissingText(templates, { ok: false, reason: 'failed' })).toContain('(it could not be set up)')
  })
  it('says the next session will have it while the copy is on its way (a first terminal, a slow install)', () => {
    expect(tmuxMissingText(templates, { ok: false, reason: 'not-connected' })).toBe('tmux is not installed on {{host}}: this session will not survive a lost connection. Tessel is putting its own copy there for the next sessions.')
    expect(tmuxMissingText(templates, { ok: false, reason: 'slow' })).toContain('next sessions')
  })
  it('keeps the plain line when tmux is there, when this build has no copy, or when nothing is known', () => {
    expect(tmuxMissingText(templates, { ok: true, source: 'system' })).toBe(null)
    expect(tmuxMissingText(templates, { ok: false, reason: 'no-bundle' })).toBe(null)
    expect(tmuxMissingText(templates, null)).toBe(null)
    expect(tmuxMissingText(templates, { ok: false, reason: 'something-else' })).toBe(null)
  })
})
