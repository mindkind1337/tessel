import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createWorktreeCleanup, defaultBranchOf, parseLeftRight, countStatus, worktreeEvidence } from '../worktreeCleanup'
import { parseWorktreeList } from '../worktreeList'
import { removeLeftover } from '../worktreeLeftover'

// Real repositories in a temp folder only.
let dir
let repo
const g = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
const native = (p) => (process.platform === 'win32' ? p.replace(/\//g, '\\') : p)
const list = async () => ({
  ok: true,
  worktrees: parseWorktreeList(g(repo, 'worktree', 'list', '--porcelain')).map((w) => ({ ...w, path: native(w.path) }))
})
const wt = (name) => join(dir, 'repo.worktrees', name)

beforeAll(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-cleanup-'))
  repo = join(dir, 'repo')
  fs.mkdirSync(repo)
  g(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(join(repo, 'a.txt'), 'a')
  g(repo, 'add', '.')
  g(repo, 'commit', '-q', '-m', 'first')
  // merged: a branch with no commit of its own.
  g(repo, 'worktree', 'add', '-q', '-b', 'agent/merged', wt('merged'))
  // ahead: one commit not on main.
  g(repo, 'worktree', 'add', '-q', '-b', 'agent/ahead', wt('ahead'))
  fs.writeFileSync(join(wt('ahead'), 'b.txt'), 'b')
  g(wt('ahead'), 'add', '.')
  g(wt('ahead'), 'commit', '-q', '-m', 'work in progress')
  // dirty: merged, but an untracked file.
  g(repo, 'worktree', 'add', '-q', '-b', 'agent/dirty', wt('dirty'))
  fs.writeFileSync(join(wt('dirty'), 'new.txt'), 'x')
  // detached
  g(repo, 'worktree', 'add', '-q', '--detach', wt('detached'))
  // gone: its folder deleted behind git's back.
  g(repo, 'worktree', 'add', '-q', '-b', 'agent/gone', wt('gone'))
  // main moves on: merged ones are now behind.
  fs.writeFileSync(join(repo, 'c.txt'), 'c')
  g(repo, 'add', '.')
  g(repo, 'commit', '-q', '-m', 'second')
})
afterAll(async () => {
  await removeLeftover(dir, { attempts: 3, delay: 300 })
})

describe('parsers', () => {
  it('reads left-right counts', () => {
    expect(parseLeftRight('3\t1\n')).toEqual({ behind: 3, ahead: 1 })
    expect(parseLeftRight('')).toEqual({ behind: null, ahead: null })
  })
  it('counts status lines', () => {
    expect(countStatus(' M a\n?? b\n')).toBe(2)
    expect(countStatus('')).toBe(0)
  })
})

describe('defaultBranchOf', () => {
  const fake = (refs, originHead) => async (args) => {
    if (args[0] === 'symbolic-ref') return originHead ? { ok: true, code: 0, stdout: originHead } : { ok: false, code: 1, stdout: '' }
    const ref = args.at(-1).replace('refs/heads/', '')
    return { ok: refs.includes(ref), code: refs.includes(ref) ? 0 : 1, stdout: '' }
  }
  it("prefers origin's HEAD when the branch exists here", async () => {
    expect(await defaultBranchOf(fake(['develop', 'main'], 'origin/develop\n'), 'x')).toBe('develop')
  })
  it('falls back to main, master, then the main checkout branch', async () => {
    expect(await defaultBranchOf(fake(['main'], 'origin/trunk'), 'x')).toBe('main')
    expect(await defaultBranchOf(fake(['master']), 'x')).toBe('master')
    expect(await defaultBranchOf(fake([]), 'feature')).toBe('feature')
    expect(await defaultBranchOf(fake([]), '')).toBe(null)
  })
})

describe('scan (real repository)', () => {
  let res
  const item = (name) => res.items.find((i) => i.path.toLowerCase() === wt(name).toLowerCase())
  beforeAll(async () => {
    await removeLeftover(wt('gone'), { attempts: 2, delay: 10 })
    const cleanup = createWorktreeCleanup({ list, gitArgs: async () => [] })
    res = await cleanup.scan(repo)
  }, 30000)

  it('lists the other worktrees, never the main checkout', () => {
    expect(res.ok).toBe(true)
    expect(res.defaultBranch).toBe('main')
    expect(res.items).toHaveLength(5)
    expect(res.items.some((i) => i.path.toLowerCase() === repo.toLowerCase())).toBe(false)
  })

  it('a clean merged branch', () => {
    const m = item('merged')
    expect(m).toMatchObject({ branch: 'agent/merged', dirty: false, changes: 0, merged: true, ahead: 0, behind: 1, missing: false, detached: false })
    expect(m.lastCommitSubject).toBe('first')
    expect(m.lastCommitAt).toBeGreaterThan(0)
    expect(m.activityAt).toBeGreaterThanOrEqual(m.lastCommitAt)
  })

  it('a branch with its own commit is not merged', () => {
    expect(item('ahead')).toMatchObject({ merged: false, ahead: 1, behind: 1, dirty: false, lastCommitSubject: 'work in progress' })
  })

  it('untracked files make it dirty', () => {
    expect(item('dirty')).toMatchObject({ dirty: true, changes: 1, merged: true })
  })

  it('a detached checkout has no branch', () => {
    expect(item('detached')).toMatchObject({ detached: true, branch: '', merged: true })
  })

  it('a folder deleted behind git is missing, its branch still read', () => {
    expect(item('gone')).toMatchObject({ missing: true, dirty: null, merged: true, branch: 'agent/gone' })
  })

  it('passes errors from the folder check through', async () => {
    const cleanup = createWorktreeCleanup({ list: async () => ({ ok: false, error: 'unknown-folder' }) })
    expect(await cleanup.scan('C:\\nope')).toEqual({ ok: false, error: 'unknown-folder' })
  })
})

describe('worktreeEvidence with a fake git', () => {
  it('unknown when git fails: dirty and merged stay null', async () => {
    const git = async () => ({ ok: false, code: 128, stdout: '', stderr: 'fatal' })
    const ev = await worktreeEvidence({ path: 'C:\\x', branch: 'b', head: 'h' }, { git, defaultBranch: 'main', exists: () => true, stat: () => ({ mtimeMs: 0 }) })
    expect(ev).toMatchObject({ dirty: null, merged: null, ahead: null, behind: null, missing: false })
  })
  it('runs git with argument arrays (a branch name is never parsed by a shell)', async () => {
    const calls = []
    const git = async (where, args) => {
      calls.push(args)
      return { ok: true, code: 0, stdout: '' }
    }
    await worktreeEvidence({ path: 'C:\\x', branch: 'a b;rm', head: 'h' }, { git, defaultBranch: 'main', exists: () => true, stat: () => ({ mtimeMs: 0 }) })
    expect(calls.every((a) => Array.isArray(a))).toBe(true)
    expect(calls[0]).toEqual(['merge-base', '--is-ancestor', 'refs/heads/a b;rm', 'refs/heads/main'])
  })
})

describe('reviewRemove for the cleanup (real repository)', () => {
  let r2
  const w2 = (name) => join(dir, 'r2.worktrees', name)
  beforeAll(() => {
    r2 = join(dir, 'r2')
    fs.mkdirSync(r2)
    g(r2, 'init', '-q', '-b', 'main')
    fs.writeFileSync(join(r2, 'a.txt'), 'a')
    g(r2, 'add', '.')
    g(r2, 'commit', '-q', '-m', 'first')
  })

  it('a worktree whose folder is gone: git forgets it and its branch goes', async () => {
    const { reviewRemove } = await import('../review')
    g(r2, 'worktree', 'add', '-q', '-b', 'feature/gone', w2('gone'))
    await removeLeftover(w2('gone'), { attempts: 2, delay: 10 })
    const res = await reviewRemove({ root: r2, path: w2('gone'), branch: 'feature/gone', target: 'main' })
    expect(res).toEqual({ ok: true })
    expect(g(r2, 'worktree', 'list', '--porcelain')).not.toMatch(/gone/)
    expect(g(r2, 'branch', '--list', 'feature/gone').trim()).toBe('')
  })

  it('a branch merged into the target is deleted without force, whatever the main checkout is on', async () => {
    const { reviewRemove } = await import('../review')
    g(r2, 'branch', 'other')
    g(r2, 'worktree', 'add', '-q', '-b', 'feature/done', w2('done'))
    fs.writeFileSync(join(w2('done'), 'd.txt'), 'd')
    g(w2('done'), 'add', '.')
    g(w2('done'), 'commit', '-q', '-m', 'done')
    g(r2, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature/done')
    // The main checkout on a branch without the work: git branch -d would refuse.
    g(r2, 'checkout', '-q', 'other')
    const res = await reviewRemove({ root: r2, path: w2('done'), branch: 'feature/done', target: 'main' })
    expect(res).toEqual({ ok: true })
    expect(fs.existsSync(w2('done'))).toBe(false)
    expect(g(r2, 'branch', '--list', 'feature/done').trim()).toBe('')
    g(r2, 'checkout', '-q', 'main')
  })

  it('an unmerged branch without force: the copy goes, the branch is kept and said', async () => {
    const { reviewRemove } = await import('../review')
    g(r2, 'worktree', 'add', '-q', '-b', 'feature/wip', w2('wip'))
    fs.writeFileSync(join(w2('wip'), 'w.txt'), 'w')
    g(w2('wip'), 'add', '.')
    g(w2('wip'), 'commit', '-q', '-m', 'wip')
    const res = await reviewRemove({ root: r2, path: w2('wip'), branch: 'feature/wip', target: 'main' })
    expect(res.ok).toBe(false)
    expect(res.copyRemoved).toBe(true)
    expect(g(r2, 'branch', '--list', 'feature/wip').trim()).toMatch(/feature\/wip/)
  })
})
