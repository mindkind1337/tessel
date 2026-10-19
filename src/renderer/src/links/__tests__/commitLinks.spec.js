import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cachedCommit, clearCommitCache, commitRootOf, commitTarget, commitTip, paneCommitRoot, resolveCommit, setCommitRoots } from '../commitLinks.js'

const FULL = '1f6ccc70' + 'a'.repeat(32)
const found = { ok: true, id: FULL, subject: 'Fix the link router', author: 'Ann', timestamp: Date.UTC(2026, 9, 6, 21, 12) }
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => setCommitRoots(['C:\\p', 'C:\\q'], { api: () => null }))
afterEach(() => {
  clearCommitCache()
  vi.useRealTimers()
})

describe('resolveCommit', () => {
  it('asks once per repository and hash, even while a question is on its way', async () => {
    const scm = { resolveCommit: vi.fn(async () => found) }
    const api = () => scm
    const [a, b] = await Promise.all([resolveCommit('C:\\p', '1f6ccc70', { api }), resolveCommit('C:\\p', '1f6ccc70', { api })])
    expect(a).toEqual({ id: FULL, subject: 'Fix the link router', author: 'Ann', timestamp: found.timestamp })
    expect(b).toEqual(a)
    expect(await resolveCommit('C:\\p', '1f6ccc70', { api })).toEqual(a)
    expect(scm.resolveCommit).toHaveBeenCalledTimes(1)
    expect(scm.resolveCommit).toHaveBeenCalledWith({ root: 'C:\\p', commit: '1f6ccc70' })
    expect(cachedCommit('C:\\p', '1f6ccc70')).toEqual(a)
    // Another repository is asked on its own.
    await resolveCommit('C:\\q', '1f6ccc70', { api })
    expect(scm.resolveCommit).toHaveBeenCalledTimes(2)
  })

  it('"not a commit" is kept a minute; a failed call 10 seconds', async () => {
    vi.useFakeTimers()
    const scm = { resolveCommit: vi.fn(async () => ({ ok: false })) }
    const api = () => scm
    expect(await resolveCommit('C:\\p', 'abc1234', { api })).toBeNull()
    expect(cachedCommit('C:\\p', 'abc1234')).toBeNull()
    await resolveCommit('C:\\p', 'abc1234', { api })
    expect(scm.resolveCommit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(61 * 1000)
    expect(cachedCommit('C:\\p', 'abc1234')).toBeUndefined()
    await resolveCommit('C:\\p', 'abc1234', { api })
    expect(scm.resolveCommit).toHaveBeenCalledTimes(2)

    const broken = { resolveCommit: vi.fn(async () => Promise.reject(new Error('ipc'))) }
    expect(await resolveCommit('C:\\p', 'def5678', { api: () => broken })).toBeNull()
    expect(cachedCommit('C:\\p', 'def5678')).toBeNull()
    await resolveCommit('C:\\p', 'def5678', { api: () => broken })
    expect(broken.resolveCommit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(11 * 1000)
    expect(cachedCommit('C:\\p', 'def5678')).toBeUndefined()
  })

  it('never takes an answer for another commit, and never asks for a non-hash', async () => {
    const scm = { resolveCommit: vi.fn(async () => ({ ok: true, id: 'b'.repeat(40), subject: 'x' })) }
    expect(await resolveCommit('C:\\p', 'abc1234', { api: () => scm })).toBeNull()
    for (const bad of ['--all', 'HEAD', 'abc1234^{commit}', 'abc12', '']) expect(await resolveCommit('C:\\p', bad, { api: () => scm })).toBeNull()
    expect(await resolveCommit(null, 'abc1234', { api: () => scm })).toBeNull()
    expect(scm.resolveCommit).toHaveBeenCalledTimes(1)
  })

  it('only for a folder inside one the window has open; never a network share', async () => {
    const scm = { resolveCommit: vi.fn(async () => found), setCommitRoots: vi.fn() }
    setCommitRoots(['C:\\p', '\\\\evil\\share', 'C:\\p\\..\\..'], { api: () => scm })
    expect(scm.setCommitRoots).toHaveBeenCalledWith(['C:\\p'])
    for (const root of ['D:\\elsewhere', '\\\\evil\\share\\repo', '//evil/share', 'C:\\p\\..\\x', 'C:\\pp'])
      expect(await resolveCommit(root, '1f6ccc70', { api: () => scm }), root).toBeNull()
    expect(scm.resolveCommit).not.toHaveBeenCalled()
    expect(await resolveCommit('c:/P/sub', '1f6ccc70', { api: () => scm })).not.toBeNull()
  })

  it('four questions at a time', async () => {
    const waiting = []
    const scm = { resolveCommit: vi.fn(() => new Promise((resolve) => waiting.push(resolve))) }
    const jobs = Array.from({ length: 10 }, (_, i) => resolveCommit('C:\\p', `abc${1000 + i}`, { api: () => scm }))
    await tick()
    expect(scm.resolveCommit).toHaveBeenCalledTimes(4)
    waiting.shift()({ ok: false })
    await tick()
    expect(scm.resolveCommit).toHaveBeenCalledTimes(5)
    for (let i = 0; i < 50 && (waiting.length || scm.resolveCommit.mock.calls.length < 10); i++) {
      if (waiting.length) waiting.shift()({ ok: false })
      await tick()
    }
    expect(await Promise.all(jobs)).toEqual(Array(10).fill(null))
  })
})

describe('commitRootOf / paneCommitRoot', () => {
  it("a message's repository: its SSH host's folder, its worktree copy, else none", () => {
    expect(commitRootOf({ worktreePath: 'C:\\copy', roots: ['C:\\copy', 'C:\\p'] })).toBe('C:\\copy')
    expect(commitRootOf({ worktreePath: 'ssh://h1/~/app', remoteRoot: 'ssh://h1/~/app' })).toBe('ssh://h1/~/app')
    expect(commitRootOf(null)).toBeNull()
    expect(commitRootOf({ worktreePath: 'C:\\a\u0000b' })).toBeNull()
    expect(commitRootOf({ worktreePath: '\\\\evil\\share' })).toBeNull()
  })

  it("a terminal's: where it started, the shell's folder only inside it; a host's on that host", () => {
    expect(paneCommitRoot({ mode: 'local', cwd: '/c/start/sub', gitbash: true, startDir: 'C:\\start' })).toBe('C:\\start\\sub')
    expect(paneCommitRoot({ mode: 'local', cwd: null, startDir: 'C:\\start' })).toBe('C:\\start')
    // What a shell reports outside the pane's folder is only a hint: not taken.
    expect(paneCommitRoot({ mode: 'local', cwd: '/c/proj', gitbash: true, startDir: 'C:\\start' })).toBe('C:\\start')
    expect(paneCommitRoot({ mode: 'local', cwd: '\\\\evil\\share', startDir: 'C:\\start' })).toBe('C:\\start')
    expect(paneCommitRoot({ mode: 'local', cwd: null, startDir: '\\\\evil\\share' })).toBeNull()
    expect(paneCommitRoot({ mode: 'local', cwd: 'C:\\wt\\x', startDir: 'C:\\start' }, { worktree: { path: 'C:\\wt' } })).toBe('C:\\wt\\x')
    expect(paneCommitRoot({ mode: 'ssh', cwd: '/srv/app/sub', remotePath: '/srv/app', hostId: 'ssh-h1' })).toBe('ssh://ssh-h1/srv/app/sub')
    expect(paneCommitRoot({ mode: 'ssh', cwd: '/etc', remotePath: '/srv/app', hostId: 'ssh-h1' })).toBe('ssh://ssh-h1/srv/app')
    expect(paneCommitRoot({ mode: 'ssh', cwd: null, remotePath: null, hostId: 'ssh-h1' })).toBeNull()
    expect(paneCommitRoot({ mode: 'wsl', cwd: '/mnt/c/proj/a', distro: 'Ubuntu', startDir: 'C:\\proj' })).toBe('C:\\proj\\a')
    expect(paneCommitRoot({ mode: 'wsl', cwd: '/mnt/c/proj', distro: 'Ubuntu' })).toBeNull()
    expect(paneCommitRoot(null, { backend: 'liveshare', liveShare: { project: 'ws-1' } })).toMatch(/^lshare:\/\//)
    expect(paneCommitRoot(null, { backend: 'liveshare' })).toBeNull()
  })
})

describe('commitTarget / commitTip', () => {
  it("the router's target and the hover", () => {
    const info = { id: FULL, subject: 'Fix the link router', author: 'Ann', timestamp: found.timestamp }
    expect(commitTarget('C:\\p', info)).toEqual({ kind: 'commit', commit: FULL, root: 'C:\\p' })
    const tip = commitTip(info).split('\n')
    expect(tip[0]).toBe('1f6ccc7 Fix the link router')
    expect(tip[1]).toMatch(/^Ann · .*2026/)
    expect(tip[2]).toMatch(/Source Control/)
    expect(commitTip({ id: FULL, subject: '', author: '', timestamp: null }).split('\n')[0]).toBe('1f6ccc7')
  })
})
