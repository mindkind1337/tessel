// @vitest-environment node
// Which worktrees count as their project for a worker's chat (workerCopies.js).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createWorkerCopies } from '../workerCopies'

const same = (a, b) => a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '')

describe('worker copies', { timeout: 30000 }, () => {
  let root, project, file
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe', encoding: 'utf8' }).trim()
  const addCopy = (name, ...base) => {
    const path = join(root, name)
    git('worktree', 'add', '-q', '-b', `agent/${name}`, path, ...base)
    return path
  }
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'tessel-copies-')))
    project = join(root, 'project')
    fs.mkdirSync(project)
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    file = join(root, 'worker-copies.json')
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

  it('a copy made from HEAD or a local branch: its project, for a worker only', () => {
    const copies = createWorkerCopies({ file })
    const fromHead = addCopy('from-head')
    const fromLocal = addCopy('from-local')
    expect(copies.created({ path: fromHead, project, baseKind: 'head' })).toBe(true)
    expect(copies.created({ path: fromLocal, project, baseKind: 'local' })).toBe(true)
    for (const copy of [fromHead, fromLocal]) {
      const roots = copies.trustRoots(copy, { worker: true })
      expect(roots).toHaveLength(1)
      expect(same(roots[0], project)).toBe(true)
      // Not a worker: asked like any folder.
      expect(copies.trustRoots(copy, { worker: false })).toEqual([])
      expect(copies.trustRoots(copy)).toEqual([])
    }
    // Saved: a restarted Tessel still knows them.
    const again = createWorkerCopies({ file })
    expect(again.trustRoots(fromHead, { worker: true })).toHaveLength(1)
  })

  it('a pull request copy (a pinned commit) or a remote branch copy: never inherits, even for a worker', () => {
    const copies = createWorkerCopies({ file })
    const head = git('rev-parse', 'HEAD')
    const pr = addCopy('pr-copy', head)
    const remote = addCopy('remote-copy', head)
    expect(copies.created({ path: pr, project, baseKind: 'commit' })).toBe(false)
    expect(copies.created({ path: remote, project, baseKind: 'remote' })).toBe(false)
    expect(copies.created({ path: pr, project })).toBe(false)
    expect(copies.trustRoots(pr, { worker: true })).toEqual([])
    expect(copies.trustRoots(remote, { worker: true })).toEqual([])
    // An unrecorded worktree of the project (made outside Tessel): nothing either.
    const outside = addCopy('outside')
    expect(copies.trustRoots(outside, { worker: true })).toEqual([])
    // The project itself, a plain folder: nothing from here.
    expect(copies.trustRoots(project, { worker: true })).toEqual([])
  })

  it('a later PR copy at a recorded folder replaces the record; forget removes it', () => {
    const copies = createWorkerCopies({ file })
    const reused = addCopy('reused')
    copies.created({ path: reused, project, baseKind: 'head' })
    expect(copies.trustRoots(reused, { worker: true })).toHaveLength(1)
    copies.created({ path: reused, project, baseKind: 'commit' })
    expect(copies.trustRoots(reused, { worker: true })).toEqual([])
    copies.created({ path: reused, project, baseKind: 'local' })
    expect(copies.forget(reused)).toBe(true)
    expect(copies.trustRoots(reused, { worker: true })).toEqual([])
    expect(createWorkerCopies({ file }).trustRoots(reused, { worker: true })).toEqual([])
    // Forgetting a folder that is already gone.
    const gone = addCopy('gone')
    copies.created({ path: gone, project, baseKind: 'head' })
    git('worktree', 'remove', '--force', gone)
    expect(copies.forget(gone)).toBe(true)
    expect(copies.list()).not.toHaveProperty(gone.toLowerCase())
  })

  it('a recorded folder that is no longer a worktree of its project: nothing', () => {
    const copies = createWorkerCopies({ file })
    const moved = addCopy('moved')
    copies.created({ path: moved, project, baseKind: 'head' })
    // Its .git file now names another project (hand-written): refused.
    const other = join(root, 'other')
    fs.mkdirSync(other)
    execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'pipe' })
    const dotGit = join(moved, '.git')
    const fd = fs.openSync(dotGit, 'r+')
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, `gitdir: ${join(other, '.git', 'worktrees', 'moved')}\n`, 0)
    fs.closeSync(fd)
    expect(copies.trustRoots(moved, { worker: true })).toEqual([])
  })

  it('a copy made from another worktree of the project counts as that worktree', () => {
    const copies = createWorkerCopies({ file })
    const base = addCopy('base-wt')
    const nested = join(root, 'nested')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'agent/nested', nested], { cwd: base, stdio: 'pipe' })
    copies.created({ path: nested, project: base, baseKind: 'head' })
    const roots = copies.trustRoots(nested, { worker: true })
    expect(roots).toHaveLength(1)
    expect(same(roots[0], base)).toBe(true)
  })

  it('a damaged or missing file: no copy inherits, nothing throws', () => {
    const bad = join(root, 'bad.json')
    fs.writeFileSync(bad, '{"version":1,"copies":{"relative\\\\x":{"project":"C:\\\\p","at":1}}}')
    const copies = createWorkerCopies({ file: bad })
    expect(copies.list()).toEqual({})
    expect(createWorkerCopies({ file: join(root, 'none.json') }).trustRoots(root, { worker: true })).toEqual([])
    expect(copies.created({ path: 'relative', project, baseKind: 'head' })).toBe(false)
  })
})
