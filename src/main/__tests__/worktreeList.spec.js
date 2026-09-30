// @vitest-environment node
// The sidebar's "other branches": `git worktree list --porcelain` parsed,
// asked only for an open project's folder, read-only and bounded.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { parseWorktreeList, localRootsOfLayout, createWorktreeList, MAX_WORKTREES } from '../worktreeList'

const ROOT = resolve('/repo')
const OTHER = resolve('/elsewhere')
const PORCELAIN = [
  'worktree C:/repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree C:/repo-fix',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/claude/fix-login',
  'locked being used',
  '',
  'worktree C:/repo-detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree C:/repo-gone',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/old',
  'prunable gitdir file points to non-existent location',
  ''
].join('\r\n')

describe('git worktree list --porcelain', () => {
  it('gives each checkout its path, short branch, commit and flags; the first is the main one', () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: 'C:/repo', branch: 'main', head: '1'.repeat(40), isMain: true, locked: false, prunable: false },
      { path: 'C:/repo-fix', branch: 'claude/fix-login', head: '2'.repeat(40), isMain: false, locked: true, prunable: false },
      { path: 'C:/repo-detached', branch: '', head: '3'.repeat(40), isMain: false, locked: false, prunable: false },
      { path: 'C:/repo-gone', branch: 'old', head: '4'.repeat(40), isMain: false, locked: false, prunable: true }
    ])
  })
  it('a bare repository is no checkout; nothing listed gives nothing', () => {
    const out = parseWorktreeList('worktree C:/bare.git\nbare\n\nworktree C:/wt\nHEAD abc\nbranch refs/heads/x\n')
    expect(out).toEqual([{ path: 'C:/wt', branch: 'x', head: 'abc', isMain: false, locked: false, prunable: false }])
    expect(parseWorktreeList('')).toEqual([])
    expect(parseWorktreeList(null)).toEqual([])
  })
  it('stops at 200', () => {
    const many = Array.from({ length: 300 }, (_, i) => `worktree C:/w${i}\nHEAD a\nbranch refs/heads/b${i}\n`).join('\n')
    expect(MAX_WORKTREES).toBe(200)
    expect(parseWorktreeList(many)).toHaveLength(200)
  })
})

describe('the folders it may be asked for', () => {
  it('the local project folders of the layout, never a remote project or a relative path', () => {
    const roots = localRootsOfLayout({
      workspaces: [
        { id: 'a', cwd: ROOT },
        { id: 'b', cwd: ROOT },
        { id: 'c', cwd: null, remote: { hostId: 'h', path: '/srv/x' } },
        { id: 'd', cwd: OTHER, remote: { hostId: 'h', path: '/srv/y' } },
        { id: 'e', cwd: 'relative/folder' },
        { id: 'f', cwd: 42 },
        null
      ]
    })
    expect(roots).toHaveLength(1)
    expect(localRootsOfLayout(null)).toEqual([])
    expect(localRootsOfLayout({ workspaces: 'x' })).toEqual([])
  })
})

describe('listing', () => {
  function service(overrides = {}) {
    const run = vi.fn(async (_file, args) => {
      if (args.includes('rev-parse')) return { ok: true, stdout: `${ROOT}\n` }
      return { ok: true, stdout: PORCELAIN }
    })
    const gitArgs = vi.fn(async () => ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/none'])
    const made = { run, gitArgs, exists: () => true, ...overrides }
    const s = createWorktreeList(made)
    s.setRoots(localRootsOfLayout({ workspaces: [{ cwd: ROOT }] }))
    return { s, run: made.run, gitArgs }
  }

  it('lists the worktrees of an open project with one read-only git call, the settings of the repository off and never asked about', async () => {
    const { s, run, gitArgs } = service()
    const res = await s.list(ROOT)
    expect(res.ok).toBe(true)
    expect(res.worktrees.map((w) => w.branch)).toEqual(['main', 'claude/fix-login', '', 'old'])
    expect(gitArgs).toHaveBeenCalledWith(ROOT, { ask: false })
    const calls = run.mock.calls.map((c) => c[1])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(['-C', ROOT, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/none', 'worktree', 'list', '--porcelain'])
    // Nothing that changes the repository.
    for (const args of calls) for (const word of ['add', 'remove', 'prune', 'move', 'lock', 'unlock', 'repair']) expect(args).not.toContain(word)
  })

  it('refuses a folder that is not an open project, without running git', async () => {
    const { s, run } = service()
    expect(await s.list(OTHER)).toEqual({ ok: false, error: 'unknown-folder' })
    expect(await s.list(join(ROOT, 'sub'))).toEqual({ ok: false, error: 'unknown-folder' })
    for (const bad of [null, undefined, '', 42, {}, ['x'], 'relative', `${ROOT}\0x`, ROOT + 'x'.repeat(2000)])
      expect(await s.list(bad)).toEqual({ ok: false, error: 'invalid' })
    s.setRoots([])
    expect(await s.list(ROOT)).toEqual({ ok: false, error: 'unknown-folder' })
    expect(run).not.toHaveBeenCalled()
  })

  it('not a repository, a missing folder, a git failure', async () => {
    const notRepo = service({ run: vi.fn(async () => ({ ok: false, stdout: '' })) })
    expect(await notRepo.s.list(ROOT)).toEqual({ ok: false, error: 'not-repo' })
    const gone = service({ exists: () => false })
    expect(await gone.s.list(ROOT)).toEqual({ ok: false, error: 'not-repo' })
    expect(gone.run).not.toHaveBeenCalled()
    const failing = service({
      run: vi.fn(async (_f, args) => (args.includes('rev-parse') ? { ok: true, stdout: ROOT } : { ok: false, stdout: '' }))
    })
    expect(await failing.s.list(ROOT)).toEqual({ ok: false, error: 'failed' })
  })
})

describe('wiring', () => {
  const main = readFileSync(join(__dirname, '..', 'index.js'), 'utf8')
  const preload = readFileSync(join(__dirname, '..', '..', 'preload', 'index.js'), 'utf8')
  it('the channel is registered after the IPC guard, fed by the saved layout, and in the preload', () => {
    expect(main.indexOf("'git:worktrees'")).toBeGreaterThan(main.indexOf('guardIpc(ipcMain'))
    expect(main).toContain('worktreeList.setRoots(localRootsOfLayout(data))')
    expect(main).toContain('worktreeList.setRoots(localRootsOfLayout(saved && saved.data))')
    expect(preload).toContain("gitWorktrees: (cwd) => ipcRenderer.invoke('git:worktrees', cwd)")
  })
})
