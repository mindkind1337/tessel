import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { join, parse, dirname } from 'path'
import { createLeftoverStore, leftoverRefusal, removeLeftover, unlinkFolderLinks } from '../worktreeLeftover'
import { reviewRemove, setLeftoverStore } from '../review'

// Every test works in its own temp folder; links point to an "outside"
// folder there that must survive every delete.
let dir
beforeAll(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-leftover-'))
})
afterAll(async () => {
  // Our own delete: it never goes through the junctions made here.
  await removeLeftover(dir, { attempts: 3, delay: 300 })
})

let n = 0
function sandbox() {
  const box = join(dir, `t${++n}`)
  const outside = join(box, 'outside')
  fs.mkdirSync(join(outside, 'deep'), { recursive: true })
  fs.writeFileSync(join(outside, 'keep.txt'), 'keep')
  fs.writeFileSync(join(outside, 'deep', 'keep2.txt'), 'keep')
  return { box, outside }
}
const link = (target, path) => fs.symlinkSync(target, path, 'junction')
function outsideIntact(outside) {
  expect(fs.readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  expect(fs.readFileSync(join(outside, 'deep', 'keep2.txt'), 'utf8')).toBe('keep')
}

describe('removeLeftover never follows links', () => {
  it('unlinks a junction inside the copy and keeps the folder it points to', async () => {
    const { box, outside } = sandbox()
    const copy = join(box, 'proj.worktrees', 'task')
    fs.mkdirSync(join(copy, 'src', 'a', 'b'), { recursive: true })
    fs.writeFileSync(join(copy, 'src', 'a', 'b', 'f.txt'), 'x')
    link(outside, join(copy, 'node_modules'))
    link(outside, join(copy, 'src', 'a', 'nested-link'))
    expect(fs.lstatSync(join(copy, 'node_modules')).isSymbolicLink()).toBe(true)
    const res = await removeLeftover(copy, { attempts: 2, delay: 10 })
    expect(res).toEqual({ ok: true })
    expect(fs.existsSync(copy)).toBe(false)
    outsideIntact(outside)
  })

  it('deletes read-only files', async () => {
    const { box } = sandbox()
    const copy = join(box, 'ro')
    fs.mkdirSync(join(copy, '.git-objects'), { recursive: true })
    const f = join(copy, '.git-objects', 'obj')
    fs.writeFileSync(f, 'x')
    fs.chmodSync(f, 0o444)
    expect((await removeLeftover(copy, { attempts: 2, delay: 10 })).ok).toBe(true)
    expect(fs.existsSync(copy)).toBe(false)
  })

  it('a copy that is itself a junction: only the link goes', async () => {
    const { box, outside } = sandbox()
    const copy = join(box, 'copy-link')
    link(outside, copy)
    expect((await removeLeftover(copy, { attempts: 2, delay: 10 })).ok).toBe(true)
    expect(fs.existsSync(copy)).toBe(false)
    outsideIntact(outside)
  })

  it('a symbolic link to a file inside the copy: the file it points to stays', async () => {
    const { box, outside } = sandbox()
    const copy = join(box, 'filelink')
    fs.mkdirSync(copy)
    try {
      fs.symlinkSync(join(outside, 'keep.txt'), join(copy, 'k'), 'file')
    } catch {
      return // Windows without the right to make symbolic links
    }
    expect((await removeLeftover(copy, { attempts: 2, delay: 10 })).ok).toBe(true)
    outsideIntact(outside)
  })

  it('a missing folder is already done', async () => {
    expect(await removeLeftover(join(dir, 'nope'), { attempts: 1 })).toEqual({ ok: true })
  })
})

describe('unlinkFolderLinks (before git deletes a copy)', () => {
  it('unlinks junctions at any depth, never enters them, keeps files', async () => {
    const { box, outside } = sandbox()
    const copy = join(box, 'copy')
    fs.mkdirSync(join(copy, 'a', 'b'), { recursive: true })
    fs.writeFileSync(join(copy, 'a', 'b', 'f.txt'), 'x')
    link(outside, join(copy, 'node_modules'))
    link(outside, join(copy, 'a', 'b', 'deep-link'))
    const res = await unlinkFolderLinks(copy)
    expect(res).toEqual({ ok: true, unlinked: 2 })
    expect(fs.existsSync(join(copy, 'node_modules'))).toBe(false)
    expect(fs.existsSync(join(copy, 'a', 'b', 'deep-link'))).toBe(false)
    expect(fs.readFileSync(join(copy, 'a', 'b', 'f.txt'), 'utf8')).toBe('x')
    outsideIntact(outside)
  })
  it('refuses a copy that is itself a link', async () => {
    const { box, outside } = sandbox()
    const copy = join(box, 'copy-link')
    link(outside, copy)
    expect((await unlinkFolderLinks(copy)).ok).toBe(false)
    outsideIntact(outside)
  })
})

describe('leftoverRefusal', () => {
  it('allows a copy beside the project', async () => {
    const { box } = sandbox()
    const repo = join(box, 'proj')
    const copy = join(box, 'proj.worktrees', 'x')
    fs.mkdirSync(repo)
    fs.mkdirSync(copy, { recursive: true })
    expect(await leftoverRefusal(copy, { repo, known: true, home: join(box, 'home') })).toBe(null)
  })
  it('refuses what git does not know, relative paths, roots, the project and home', async () => {
    const { box, outside } = sandbox()
    const repo = join(box, 'proj')
    fs.mkdirSync(repo)
    const home = join(box, 'home')
    fs.mkdirSync(home)
    const opts = { repo, known: true, home }
    expect(await leftoverRefusal(join(box, 'x'), { ...opts, known: false })).toBe('unknown')
    expect(await leftoverRefusal('proj.worktrees/x', opts)).toBe('not-absolute')
    expect(await leftoverRefusal(parse(box).root, opts)).toBe('drive-root')
    expect(await leftoverRefusal(repo, opts)).toBe('project')
    expect(await leftoverRefusal(box, opts)).toBe('project')
    expect(await leftoverRefusal(home, { ...opts, repo: join(outside, 'r') })).toBe('home')
    expect(await leftoverRefusal(dirname(home), { ...opts, repo: join(outside, 'r') })).toBe('project')
    expect(await leftoverRefusal(os.homedir(), { repo: join(parse(box).root, 'nowhere-repo'), known: true })).toBe('home')
  })
  it('refuses a link whose real folder is the project', async () => {
    const { box } = sandbox()
    const repo = join(box, 'proj')
    fs.mkdirSync(repo)
    const copy = join(box, 'sneaky')
    link(repo, copy)
    expect(await leftoverRefusal(copy, { repo, known: true, home: join(box, 'home') })).toBe('project')
  })
})

describe('leftover store', () => {
  it('remembers a leftover across restarts, per project and branch', () => {
    const { box } = sandbox()
    const file = join(box, 'leftovers.json')
    const a = createLeftoverStore({ file })
    a.add(join(box, 'proj'), join(box, 'proj.worktrees', 'x'), 'agent/x')
    const b = createLeftoverStore({ file })
    expect(b.get(join(box, 'proj'), join(box, 'proj.worktrees', 'x'))).toMatchObject({ branch: 'agent/x' })
    expect(b.get(join(box, 'other'), join(box, 'proj.worktrees', 'x'))).toBe(null)
    b.forget(join(box, 'proj.worktrees', 'x'))
    expect(createLeftoverStore({ file }).get(join(box, 'proj'), join(box, 'proj.worktrees', 'x'))).toBe(null)
  })
})

describe('reviewRemove with leftovers', { timeout: 60000 }, () => {
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
  let box, outside, repo
  beforeEach(() => {
    ;({ box, outside } = sandbox())
    repo = join(box, 'proj')
    fs.mkdirSync(repo)
    g(repo, 'init', '-q', '-b', 'main')
    g(repo, 'config', 'user.email', 't@example.com')
    g(repo, 'config', 'user.name', 'T')
    fs.writeFileSync(join(repo, 'a.txt'), 'a\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'init')
    setLeftoverStore(createLeftoverStore())
  })
  const branches = () => g(repo, 'branch', '--list').replace(/[* ]/g, '').split(/\r?\n/).filter(Boolean)

  it('deletes a copy holding a junction (like a linked node_modules) and keeps its target', async () => {
    const copy = join(box, 'proj.worktrees', 'jn')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/jn', copy, 'HEAD')
    link(outside, join(copy, 'node_modules'))
    fs.mkdirSync(join(copy, 'pkg'))
    link(outside, join(copy, 'pkg', 'inner'))
    const res = await reviewRemove({ root: repo, path: copy, branch: 'agent/jn', target: 'main', force: true })
    expect(res).toEqual({ ok: true })
    expect(fs.existsSync(copy)).toBe(false)
    expect(branches()).toEqual(['main'])
    outsideIntact(outside)
  })

  it('a clean copy (node_modules junction ignored by git) deleted without force keeps the junction target', async () => {
    fs.writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
    g(repo, 'add', '.gitignore')
    g(repo, 'commit', '-q', '-m', 'ignore')
    const copy = join(box, 'proj.worktrees', 'soft')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/soft', copy, 'HEAD')
    link(outside, join(copy, 'node_modules'))
    const res = await reviewRemove({ root: repo, path: copy, branch: 'agent/soft', target: 'main' })
    expect(res).toEqual({ ok: true })
    expect(fs.existsSync(copy)).toBe(false)
    outsideIntact(outside)
  })

  it('a copy with untracked files and no force: nothing is touched, its junction stays', async () => {
    const copy = join(box, 'proj.worktrees', 'dirty')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/dirty', copy, 'HEAD')
    link(outside, join(copy, 'node_modules'))
    fs.writeFileSync(join(copy, 'new.txt'), 'n')
    const res = await reviewRemove({ root: repo, path: copy, branch: 'agent/dirty', target: 'main' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/modified or untracked/)
    expect(fs.lstatSync(join(copy, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(join(copy, 'new.txt'))).toBe(true)
    outsideIntact(outside)
  })

  it('a copy git unregistered while its folder stayed: deleted again only when remembered', async () => {
    const copy = join(box, 'elsewhere', 'left')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/left', copy, 'HEAD')
    link(outside, join(copy, 'node_modules'))
    // What a delete that failed partway leaves: git has no record, the folder stays.
    fs.rmSync(join(repo, '.git', 'worktrees', 'left'), { recursive: true, force: true })
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain('elsewhere')
    const args = { root: repo, path: copy, branch: 'agent/left', target: 'main', force: true }

    // Not remembered: nothing is deleted.
    expect((await reviewRemove(args)).ok).toBe(false)
    expect(fs.existsSync(join(copy, 'a.txt'))).toBe(true)

    const store = createLeftoverStore()
    setLeftoverStore(store)
    // Remembered for another branch: refused too.
    store.add(repo, copy, 'agent/other')
    expect((await reviewRemove(args)).ok).toBe(false)
    expect(fs.existsSync(join(copy, 'a.txt'))).toBe(true)

    store.add(repo, copy, 'agent/left')
    expect(await reviewRemove(args)).toEqual({ ok: true })
    expect(fs.existsSync(copy)).toBe(false)
    expect(branches()).toEqual(['main'])
    expect(store.get(repo, copy)).toBe(null)
    outsideIntact(outside)
  })

  it('never deletes the project folder, even when told it is a leftover', async () => {
    const store = createLeftoverStore()
    setLeftoverStore(store)
    store.add(repo, repo, 'agent/x')
    const res = await reviewRemove({ root: repo, path: repo, branch: 'agent/x', target: 'main', force: true })
    expect(res.ok).toBe(false)
    expect(fs.existsSync(join(repo, 'a.txt'))).toBe(true)
  })
})
