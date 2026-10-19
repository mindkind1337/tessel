import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedCommit, clearCommitCache, commitRootOf, commitTarget, commitTip, paneCommitRoot, resolveCommit } from '../commitLinks.js'

const FULL = '1f6ccc70' + 'a'.repeat(32)
const found = { ok: true, id: FULL, subject: 'Fix the link router', author: 'Ann', timestamp: Date.UTC(2026, 9, 6, 21, 12) }

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

  it('"not a commit" is kept a minute; a failed call is not kept', async () => {
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
    expect(cachedCommit('C:\\p', 'def5678')).toBeUndefined()
  })

  it('never takes an answer for another commit, and never asks for a non-hash', async () => {
    const scm = { resolveCommit: vi.fn(async () => ({ ok: true, id: 'b'.repeat(40), subject: 'x' })) }
    expect(await resolveCommit('C:\\p', 'abc1234', { api: () => scm })).toBeNull()
    for (const bad of ['--all', 'HEAD', 'abc1234^{commit}', 'abc12', '']) expect(await resolveCommit('C:\\p', bad, { api: () => scm })).toBeNull()
    expect(await resolveCommit(null, 'abc1234', { api: () => scm })).toBeNull()
    expect(scm.resolveCommit).toHaveBeenCalledTimes(1)
  })
})

describe('commitRootOf / paneCommitRoot', () => {
  it("a message's repository: its SSH host's folder, its worktree copy, else none", () => {
    expect(commitRootOf({ worktreePath: 'C:\\copy', roots: ['C:\\copy', 'C:\\p'] })).toBe('C:\\copy')
    expect(commitRootOf({ worktreePath: 'ssh://h1/~/app', remoteRoot: 'ssh://h1/~/app' })).toBe('ssh://h1/~/app')
    expect(commitRootOf(null)).toBeNull()
    expect(commitRootOf({ worktreePath: 'C:\\a\u0000b' })).toBeNull()
  })

  it("a terminal's: the shell's folder, else where it started; a host's on that host", () => {
    expect(paneCommitRoot({ mode: 'local', cwd: '/c/proj', gitbash: true, startDir: 'C:\\start' })).toBe('C:\\proj')
    expect(paneCommitRoot({ mode: 'local', cwd: null, startDir: 'C:\\start' })).toBe('C:\\start')
    expect(paneCommitRoot({ mode: 'ssh', cwd: '/srv/app', hostId: 'ssh-h1' })).toMatch(/^ssh:\/\/ssh-h1\//)
    expect(paneCommitRoot({ mode: 'ssh', cwd: null, remotePath: null, hostId: 'ssh-h1' })).toBeNull()
    expect(paneCommitRoot({ mode: 'wsl', cwd: '/mnt/c/proj', distro: 'Ubuntu' })).toBe('C:\\proj')
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
