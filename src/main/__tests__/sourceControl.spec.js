// Source control helpers (src/main/sourceControl.js) on throwaway repositories:
// status groups, stage / unstage / discard (untracked files to a fake
// Recycle Bin), commit, the two sides of a diff, paths with spaces, renames,
// and paths that try to leave the repository.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {

  scmStatus,
  scmStage,
  scmUnstage,
  scmDiscard,
  scmCommit,
  scmPush,
  scmPull,
  scmFileVersions,
  scmStagedDiff,
  parseStatusV2,
  parseNumstatZ,
  relIn,
  cleanGeneratedMessage,
  truncateDiff,
  commitPrompt,
  collectUntrackedAdditions,
  MAX_UNTRACKED_LINE_COUNT_BYTES,
  scmBranchCompare,
  scmHistory,
  scmCommitFiles,
  parseHistoryLog,
  parseNameStatusZ,
  compareUrl,
  githubRepoOf,
  branchFileList
} from '../sourceControl'

// Real git in temp repos (publish, push, pull): slow on a busy Windows PC.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
let dir
let repo
const write = (rel, text) => {
  const p = join(repo, ...rel.split('/'))
  fs.mkdirSync(join(p, '..'), { recursive: true })
  fs.writeFileSync(p, text)
}
const read = (rel) => fs.readFileSync(join(repo, ...rel.split('/')), 'utf8')
const find = (st, path, area) => st.entries.find((e) => e.path === path && e.area === area)

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-scm-'))
  repo = join(dir, 'my repo')
  fs.mkdirSync(repo)
  g(repo, 'init', '-q', '-b', 'main')
  g(repo, 'config', 'user.email', 't@example.com')
  g(repo, 'config', 'user.name', 'T')
  g(repo, 'config', 'core.autocrlf', 'false')
  write('a.txt', 'one\ntwo\n')
  write('dir with space/b c.txt', 'bee\n')
  write('old name.txt', 'rename me\n')
  g(repo, 'add', '-A')
  g(repo, 'commit', '-q', '-m', 'first')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('parsers', () => {
  it('reads porcelain v2 with branch, renames, conflicts and spaces', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 MM N... 100644 100644 100644 aaa bbb src/a b.js',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.js',
      'old name.js',
      'u UU N... 100644 100644 100644 100644 a b c conflicted.js',
      '? new file.txt',
      ''
    ].join('\0')
    const s = parseStatusV2(out)
    expect(s).toMatchObject({ branch: 'feature/x', upstream: 'origin/feature/x', ahead: 2, behind: 1 })
    expect(s.entries).toEqual([
      { path: 'src/a b.js', area: 'staged', status: 'modified' },
      { path: 'src/a b.js', area: 'unstaged', status: 'modified' },
      { path: 'new name.js', oldPath: 'old name.js', area: 'staged', status: 'renamed' },
      { path: 'conflicted.js', area: 'unstaged', status: 'modified', conflict: true, conflictStatus: 'unresolved', conflictKind: 'both_modified' },
      { path: 'new file.txt', area: 'untracked', status: 'untracked' }
    ])
  })
  it('reads a detached head and no commit yet', () => {
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head (detached)\0')).toMatchObject({ branch: null, oid: null })
  })
  it('reads numstat -z, renames and binaries', () => {
    const m = parseNumstatZ('3\t1\ta b.js\0' + '1\t0\t\0old.js\0new.js\0' + '-\t-\timg.png\0')
    expect(m['a b.js']).toEqual({ added: 3, removed: 1, binary: false })
    expect(m['new.js']).toEqual({ added: 1, removed: 0, binary: false })
    expect(m['img.png'].binary).toBe(true)
  })
  it('keeps paths inside the repository', () => {
    const top = join(os.tmpdir(), 'r')
    expect(relIn(top, 'a/b.txt')).toBe('a/b.txt')
    expect(relIn(top, join(top, 'x y', 'z.txt'))).toBe('x y/z.txt')
    expect(relIn(top, '../escape.txt')).toBeNull()
    expect(relIn(top, top)).toBeNull()
    expect(relIn(top, '')).toBeNull()
    expect(relIn(top, '.git/config')).toBeNull()
    expect(relIn(top, 'a\0b')).toBeNull()
    expect(relIn(top, join(os.tmpdir(), 'other', 'f.txt'))).toBeNull()
  })
  it('cleans a generated message and builds Orca\'s prompt', () => {
    expect(cleanGeneratedMessage('```\nFix the bug\n\nBecause.\nCo-authored-by: X <x@y>\n```')).toBe('Fix the bug\n\nBecause.')
    expect(cleanGeneratedMessage('"Add tests"')).toBe('Add tests')
    expect(commitPrompt('DIFF')).toContain('```diff\nDIFF\n```')
    const big = `diff --git a/x b/x\n${'+line\n'.repeat(50000)}diff --git a/y b/y\n+small\n`
    const t = truncateDiff(big, 10000)
    expect(t.length).toBeLessThan(13000)
    expect(t).toContain('diff --git a/y b/y\n+small')
    expect(t).toContain('diff truncated')
  })
})

describe('status', () => {
  it('groups staged, unstaged and untracked, with line counts and branch', async () => {
    write('a.txt', 'one\nTWO\nthree\n')
    g(repo, 'add', 'a.txt')
    write('a.txt', 'one\nTWO\nthree\nfour\n')
    write('dir with space/b c.txt', 'changed\n')
    write('new folder/n e w.txt', 'new\n')
    const st = await scmStatus({ root: repo })
    expect(st).toMatchObject({ ok: true, repo: true, branch: 'main', hasUpstream: false, hasCommits: true, operation: null })
    expect(find(st, 'a.txt', 'staged')).toMatchObject({ status: 'modified', added: 2, removed: 1 })
    expect(find(st, 'a.txt', 'unstaged')).toMatchObject({ status: 'modified', added: 1, removed: 0 })
    expect(find(st, 'dir with space/b c.txt', 'unstaged')).toMatchObject({ status: 'modified' })
    expect(find(st, 'new folder/n e w.txt', 'untracked')).toMatchObject({ status: 'untracked' })
  })
  it('from a sub-folder, and says when a folder is not a repository', async () => {
    const st = await scmStatus({ root: join(repo, 'dir with space') })
    expect(st.ok && st.repo).toBe(true)
    const plain = join(dir, 'plain')
    fs.mkdirSync(plain)
    // A temp folder may sit inside another repository on some machines: only
    // check the answer is well formed then.
    const res = await scmStatus({ root: plain })
    expect(res.ok).toBe(true)
    expect(await scmStatus({ root: 'relative/path' })).toMatchObject({ ok: false })
  })
  it('shows a staged rename with its old name', async () => {
    g(repo, 'mv', 'old name.txt', 'new name.txt')
    const st = await scmStatus({ root: repo })
    expect(find(st, 'new name.txt', 'staged')).toMatchObject({ status: 'renamed', oldPath: 'old name.txt' })
  })
})

describe('stage and unstage', () => {
  it('stages and unstages paths with spaces, relative or absolute', async () => {
    write('dir with space/b c.txt', 'changed\n')
    write('fresh file.txt', 'x\n')
    expect(await scmStage({ root: repo, paths: ['dir with space/b c.txt', join(repo, 'fresh file.txt')] })).toEqual({ ok: true })
    let st = await scmStatus({ root: repo })
    expect(find(st, 'dir with space/b c.txt', 'staged')).toBeTruthy()
    expect(find(st, 'fresh file.txt', 'staged')).toMatchObject({ status: 'added' })
    expect(await scmUnstage({ root: repo, paths: ['dir with space/b c.txt', 'fresh file.txt'] })).toEqual({ ok: true })
    st = await scmStatus({ root: repo })
    expect(find(st, 'dir with space/b c.txt', 'unstaged')).toBeTruthy()
    expect(find(st, 'dir with space/b c.txt', 'staged')).toBeFalsy()
    expect(find(st, 'fresh file.txt', 'untracked')).toBeTruthy()
  })
  it('stages a deletion', async () => {
    fs.unlinkSync(join(repo, 'a.txt'))
    await scmStage({ root: repo, paths: ['a.txt'] })
    expect(find(await scmStatus({ root: repo }), 'a.txt', 'staged')).toMatchObject({ status: 'deleted' })
  })
  it('takes a glob character literally', async () => {
    // As a glob, "[a].txt" would also match a.txt.
    write('[a].txt', 'x\n')
    write('a.txt', 'changed\n')
    await scmStage({ root: repo, paths: ['[a].txt'] })
    const st = await scmStatus({ root: repo })
    expect(find(st, '[a].txt', 'staged')).toBeTruthy()
    expect(find(st, 'a.txt', 'unstaged')).toBeTruthy()
    expect(find(st, 'a.txt', 'staged')).toBeFalsy()
  })
  it('unstages in a repository with no commit yet', async () => {
    const fresh = join(dir, 'fresh')
    fs.mkdirSync(fresh)
    g(fresh, 'init', '-q')
    fs.writeFileSync(join(fresh, 'x.txt'), 'x')
    await scmStage({ root: fresh, paths: ['x.txt'] })
    expect(await scmUnstage({ root: fresh, paths: ['x.txt'] })).toEqual({ ok: true })
    expect(find(await scmStatus({ root: fresh }), 'x.txt', 'untracked')).toBeTruthy()
  })
  it('refuses paths outside the repository', async () => {
    fs.writeFileSync(join(dir, 'outside.txt'), 'o')
    expect(await scmStage({ root: repo, paths: ['../outside.txt'] })).toMatchObject({ ok: false })
    expect(await scmStage({ root: repo, paths: [join(dir, 'outside.txt')] })).toMatchObject({ ok: false })
    expect(await scmStage({ root: repo, paths: [] })).toMatchObject({ ok: false })
  })
})

describe('discard', () => {
  it('restores a tracked file from the index, keeping what was staged', async () => {
    write('a.txt', 'staged\n')
    g(repo, 'add', 'a.txt')
    write('a.txt', 'staged\nand more\n')
    const trashed = []
    expect(await scmDiscard({ root: repo, paths: ['a.txt'] }, async (p) => trashed.push(p))).toMatchObject({ ok: true, restored: 1, trashed: 0 })
    expect(read('a.txt')).toBe('staged\n')
    expect(trashed).toEqual([])
    const st = await scmStatus({ root: repo })
    expect(find(st, 'a.txt', 'staged')).toBeTruthy()
    expect(find(st, 'a.txt', 'unstaged')).toBeFalsy()
  })
  it('brings back a file deleted on disk', async () => {
    fs.unlinkSync(join(repo, 'dir with space', 'b c.txt'))
    await scmDiscard({ root: repo, paths: ['dir with space/b c.txt'] }, async () => {})
    expect(read('dir with space/b c.txt')).toBe('bee\n')
  })
  it('sends an untracked file to the Recycle Bin (trashItem), never deletes it itself', async () => {
    write('junk dir/untracked file.txt', 'u\n')
    const trashed = []
    const res = await scmDiscard({ root: repo, paths: ['junk dir/untracked file.txt'] }, async (p) => trashed.push(p))
    expect(res).toMatchObject({ ok: true, trashed: 1 })
    expect(trashed).toEqual([join(repo, 'junk dir', 'untracked file.txt')])
    // The fake bin did not delete it: nothing else did either.
    expect(fs.existsSync(join(repo, 'junk dir', 'untracked file.txt'))).toBe(true)
  })
  it('refuses without a Recycle Bin, outside the repository, and on a conflict', async () => {
    write('u.txt', 'u')
    expect(await scmDiscard({ root: repo, paths: ['u.txt'] })).toMatchObject({ ok: false })
    expect(fs.existsSync(join(repo, 'u.txt'))).toBe(true)
    expect(await scmDiscard({ root: repo, paths: ['../x'] }, async () => {})).toMatchObject({ ok: false })
    // A conflict: two branches change the same line.
    g(repo, 'checkout', '-q', '-b', 'other')
    write('a.txt', 'other\n')
    g(repo, 'commit', '-q', '-am', 'other')
    g(repo, 'checkout', '-q', 'main')
    write('a.txt', 'mine\n')
    g(repo, 'commit', '-q', '-am', 'mine')
    try {
      g(repo, 'merge', 'other')
    } catch {
      /* conflict expected */
    }
    const st = await scmStatus({ root: repo })
    expect(st.operation).toBe('merge')
    expect(find(st, 'a.txt', 'unstaged')).toMatchObject({ conflict: true, conflictKind: 'both_modified' })
    const trashed = []
    expect(await scmDiscard({ root: repo, paths: ['a.txt'] }, async (p) => trashed.push(p))).toMatchObject({ ok: false })
    expect(read('a.txt')).toContain('<<<<<<<')
  })
})

describe('commit', () => {
  it('commits only what is staged', async () => {
    write('a.txt', 'staged\n')
    write('dir with space/b c.txt', 'not staged\n')
    await scmStage({ root: repo, paths: ['a.txt'] })
    const res = await scmCommit({ root: repo, message: '  Update a\r\n\r\nWhy.  ' })
    expect(res.ok).toBe(true)
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(g(repo, 'log', '-1', '--format=%B').trim()).toBe('Update a\n\nWhy.')
    const st = await scmStatus({ root: repo })
    expect(find(st, 'dir with space/b c.txt', 'unstaged')).toBeTruthy()
    expect(find(st, 'a.txt', 'staged')).toBeFalsy()
  })
  it('needs a message and something staged', async () => {
    expect(await scmCommit({ root: repo, message: '  ' })).toMatchObject({ ok: false, error: 'Enter a commit message to commit.' })
    write('a.txt', 'x\n')
    expect(await scmCommit({ root: repo, message: 'x' })).toMatchObject({ ok: false, error: 'Stage at least one file to commit.' })
  })
  it('a message starting with a dash is a message, not an option', async () => {
    write('a.txt', 'x\n')
    await scmStage({ root: repo, paths: ['a.txt'] })
    expect((await scmCommit({ root: repo, message: '--amend' })).ok).toBe(true)
    expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('--amend')
    expect(g(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
  })
})

describe('diff sides', () => {
  it('staged: HEAD against the index; unstaged: the index against the disk; untracked: nothing', async () => {
    write('a.txt', 'index\n')
    g(repo, 'add', 'a.txt')
    write('a.txt', 'disk\n')
    expect(await scmFileVersions({ root: repo, path: 'a.txt', area: 'staged' })).toMatchObject({ ok: true, original: 'one\ntwo\n', modified: 'index\n' })
    expect(await scmFileVersions({ root: repo, path: 'a.txt', area: 'unstaged' })).toMatchObject({ ok: true, original: 'index\n', modified: 'disk\n', exists: true })
    write('n e w.txt', 'new\n')
    expect(await scmFileVersions({ root: repo, path: 'n e w.txt', area: 'untracked' })).toMatchObject({ ok: true, original: '', modified: 'new\n' })
  })
  it('a staged rename compares with its old name; a deleted file has an empty side', async () => {
    g(repo, 'mv', 'old name.txt', 'new name.txt')
    expect(await scmFileVersions({ root: repo, path: 'new name.txt', oldPath: 'old name.txt', area: 'staged' })).toMatchObject({
      original: 'rename me\n',
      modified: 'rename me\n'
    })
    fs.unlinkSync(join(repo, 'a.txt'))
    expect(await scmFileVersions({ root: repo, path: 'a.txt', area: 'unstaged' })).toMatchObject({ ok: true, original: 'one\ntwo\n', modified: '', exists: false })
  })
  it('says binary, and refuses a path outside', async () => {
    fs.writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    expect(await scmFileVersions({ root: repo, path: 'bin.dat', area: 'untracked' })).toMatchObject({ ok: true, binary: true })
    expect(await scmFileVersions({ root: repo, path: '../x', area: 'untracked' })).toMatchObject({ ok: false })
    expect(await scmFileVersions({ root: repo, path: 'a.txt', area: 'nope' })).toMatchObject({ ok: false })
  })
  it('the staged diff for Generate', async () => {
    expect(await scmStagedDiff({ root: repo })).toMatchObject({ ok: false })
    write('a.txt', 'changed\n')
    await scmStage({ root: repo, paths: ['a.txt'] })
    const d = await scmStagedDiff({ root: repo })
    expect(d.ok).toBe(true)
    expect(d.diff).toContain('+changed')
  })
})

describe('push and pull', () => {
  it('publishes a branch, then pushes and pulls with its upstream', async () => {
    const remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    g(repo, 'remote', 'add', 'origin', remote)
    expect(await scmPull({ root: repo })).toMatchObject({ ok: false, error: 'Publish the branch first to pull commits.' })
    expect(await scmPush({ root: repo })).toMatchObject({ ok: true, remote: 'origin', branch: 'main' })
    let st = await scmStatus({ root: repo })
    expect(st).toMatchObject({ hasUpstream: true, upstream: 'origin/main', ahead: 0, behind: 0 })
    write('a.txt', 'ahead\n')
    await scmStage({ root: repo, paths: ['a.txt'] })
    await scmCommit({ root: repo, message: 'ahead' })
    st = await scmStatus({ root: repo })
    expect(st.ahead).toBe(1)
    expect((await scmPush({ root: repo })).ok).toBe(true)
    // Another clone pushes: this one is behind, then pulls.
    const other = join(dir, 'other')
    execFileSync('git', ['clone', '-q', '-b', 'main', remote, other])
    g(other, 'config', 'user.email', 'o@example.com')
    g(other, 'config', 'user.name', 'O')
    fs.writeFileSync(join(other, 'theirs.txt'), 't\n')
    g(other, 'add', '-A')
    g(other, 'commit', '-q', '-m', 'theirs')
    g(other, 'push', '-q')
    g(repo, 'fetch', '-q')
    expect((await scmStatus({ root: repo })).behind).toBe(1)
    expect((await scmPull({ root: repo })).ok).toBe(true)
    expect(fs.existsSync(join(repo, 'theirs.txt'))).toBe(true)
  })
  it('refuses to push without a remote or on a detached head', async () => {
    expect(await scmPush({ root: repo })).toMatchObject({ ok: false })
    g(repo, 'checkout', '-q', '--detach')
    expect(await scmPush({ root: repo })).toMatchObject({ ok: false, error: 'Check out a branch before pushing commits.' })
  })
})

describe('a task copy (git worktree)', () => {
  it('status, stage, discard and commit work in the copy, not in the project', async () => {
    const copy = join(dir, 'my repo.worktrees', 'task one')
    fs.mkdirSync(join(dir, 'my repo.worktrees'))
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/task-one', copy)
    fs.writeFileSync(join(copy, 'a.txt'), 'copy change\n')
    fs.writeFileSync(join(copy, 'extra.txt'), 'x\n')
    const st = await scmStatus({ root: copy })
    expect(st).toMatchObject({ branch: 'agent/task-one', top: fs.realpathSync(copy) })
    expect(find(st, 'a.txt', 'unstaged')).toBeTruthy()
    expect(find(await scmStatus({ root: repo }), 'a.txt', 'unstaged')).toBeFalsy()
    await scmStage({ root: copy, paths: ['a.txt'] })
    const trashed = []
    await scmDiscard({ root: copy, paths: ['extra.txt'] }, async (p) => trashed.push(p))
    expect(trashed).toEqual([join(copy, 'extra.txt')])
    expect((await scmCommit({ root: copy, message: 'In the copy' })).ok).toBe(true)
    expect(g(copy, 'log', '-1', '--format=%s').trim()).toBe('In the copy')
    expect(g(repo, 'log', '-1', '--format=%s').trim()).toBe('first')
  })
})

describe('untracked line counts (bounded)', () => {
  it('counts lines of new text files; binaries and files over 2 MB get no count', async () => {
    write('new/a.txt', 'one\ntwo\nthree\n')
    write('new/no newline.txt', 'x\ny')
    write('new/empty.txt', '')
    fs.writeFileSync(join(repo, 'new', 'bin.dat'), Buffer.from([1, 0, 2, 10, 3]))
    fs.writeFileSync(join(repo, 'new', 'big.txt'), Buffer.alloc(MAX_UNTRACKED_LINE_COUNT_BYTES + 10, 10))
    const counts = await collectUntrackedAdditions(repo, ['new/a.txt', 'new/no newline.txt', 'new/empty.txt', 'new/bin.dat', 'new/big.txt', 'new/gone.txt'])
    expect(counts.get('new/a.txt')).toEqual({ added: 3 })
    expect(counts.get('new/no newline.txt')).toEqual({ added: 2 })
    expect(counts.get('new/empty.txt')).toEqual({ added: 0 })
    expect(counts.get('new/bin.dat')).toEqual({})
    expect(counts.get('new/big.txt')).toEqual({})
    expect(counts.get('new/gone.txt')).toEqual({})
  })

  it('a changed file is counted again (the cache follows size and time)', async () => {
    write('c.txt', 'a\n')
    expect((await collectUntrackedAdditions(repo, ['c.txt'])).get('c.txt')).toEqual({ added: 1 })
    write('c.txt', 'a\nb\nc\n')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(join(repo, 'c.txt'), later, later)
    expect((await collectUntrackedAdditions(repo, ['c.txt'])).get('c.txt')).toEqual({ added: 3 })
  })

  it('status gives untracked files their +N', async () => {
    write('folder/new.js', 'a\nb\n')
    const st = await scmStatus({ root: repo })
    expect(find(st, 'folder/new.js', 'untracked')).toMatchObject({ added: 2, removed: 0 })
  })
})

describe('branch compare, commits and commit files', () => {
  let remote
  beforeEach(() => {
    remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    g(repo, 'remote', 'add', 'origin', remote)
    g(repo, 'push', '-q', '-u', 'origin', 'main')
    g(repo, 'remote', 'set-head', 'origin', 'main')
  })

  it('compares HEAD with origin/main: commits ahead, and every line of the work (committed, staged, unstaged, untracked)', async () => {
    g(repo, 'checkout', '-q', '-b', 'feature')
    write('feat.txt', '1\n2\n')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-q', '-m', 'feat')
    write('a.txt', 'one\n') // one line removed, unstaged
    write('untracked.txt', 'u1\nu2\nu3\n')
    const c = await scmBranchCompare({ root: repo })
    expect(c).toMatchObject({ ok: true, base: 'origin/main', ahead: 1, behind: 0, added: 5, removed: 1 })
    expect(c.mergeBase).toMatch(/^[0-9a-f]{40}$/)
    expect(c.reviewUrl).toBe(null) // not a GitHub remote
  })

  it('lists the files committed on the branch (merge base -> HEAD), not the uncommitted ones, and opens each one base -> HEAD', async () => {
    g(repo, 'checkout', '-q', '-b', 'feature')
    write('feat.txt', '1\n2\n')
    write('a.txt', 'one\ntwo\nthree\n')
    g(repo, 'mv', 'old name.txt', 'new name.txt')
    g(repo, 'rm', '-q', 'dir with space/b c.txt')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-q', '-m', 'feat')
    write('a.txt', 'changed on disk\n') // uncommitted: not in the list
    write('untracked.txt', 'u\n')
    const c = await scmBranchCompare({ root: repo })
    expect(c).toMatchObject({ ok: true, base: 'origin/main', onBase: false, filesTruncated: false })
    expect(c.head).toBe(g(repo, 'rev-parse', 'HEAD').trim())
    const byPath = Object.fromEntries(c.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'dir with space/b c.txt', 'feat.txt', 'new name.txt'])
    expect(byPath['feat.txt']).toMatchObject({ status: 'added', added: 2, removed: 0 })
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', added: 1, removed: 0 })
    expect(byPath['dir with space/b c.txt']).toMatchObject({ status: 'deleted', added: 0, removed: 1 })
    expect(byPath['new name.txt']).toMatchObject({ status: 'renamed', oldPath: 'old name.txt' })
    const v = await scmFileVersions({ root: repo, path: 'a.txt', area: 'branch', base: c.mergeBase, commit: c.head })
    expect(v).toMatchObject({ ok: true, original: 'one\ntwo\n', modified: 'one\ntwo\nthree\n' })
    const r = await scmFileVersions({ root: repo, path: 'new name.txt', oldPath: 'old name.txt', area: 'branch', base: c.mergeBase, commit: c.head })
    expect(r).toMatchObject({ ok: true, original: 'rename me\n', modified: 'rename me\n' })
    const added = await scmFileVersions({ root: repo, path: 'feat.txt', area: 'branch', base: c.mergeBase, commit: c.head })
    expect(added).toMatchObject({ ok: true, original: '', modified: '1\n2\n' })
    // Revisions are commit ids only.
    expect(await scmFileVersions({ root: repo, path: 'a.txt', area: 'branch', base: '--output=x', commit: c.head })).toMatchObject({ ok: false })
    expect(await scmFileVersions({ root: repo, path: 'a.txt', area: 'branch', base: c.mergeBase, commit: 'HEAD' })).toMatchObject({ ok: false })
  })

  it('on the base branch itself: no committed-on-branch files', async () => {
    write('a.txt', 'local\n')
    g(repo, 'commit', '-q', '-am', 'unpushed')
    const c = await scmBranchCompare({ root: repo })
    expect(c).toMatchObject({ ok: true, base: 'origin/main', onBase: true, files: [], head: null })
  })

  it('caps the committed-on-branch list and says so', () => {
    const ns = 'M\0a.js\0A\0b.js\0D\0c.js\0'
    const num = '1\t2\ta.js\0' + '3\t0\tb.js\0' + '-\t-\tc.js\0'
    expect(branchFileList(ns, num)).toEqual({
      files: [
        { path: 'a.js', status: 'modified', added: 1, removed: 2, binary: false },
        { path: 'b.js', status: 'added', added: 3, removed: 0, binary: false },
        { path: 'c.js', status: 'deleted', added: null, removed: null, binary: true }
      ],
      truncated: false
    })
    const capped = branchFileList(ns, num, 2)
    expect(capped.files.map((f) => f.path)).toEqual(['a.js', 'b.js'])
    expect(capped.truncated).toBe(true)
    expect(branchFileList('', '')).toEqual({ files: [], truncated: false })
  })

  it('no remote: nothing to compare with', async () => {
    g(repo, 'remote', 'remove', 'origin')
    expect(await scmBranchCompare({ root: repo })).toEqual({ ok: true, base: null })
  })

  it('the GitHub compare page of the pushed branch', () => {
    expect(githubRepoOf('git@github.com:me/my-repo.git')).toEqual({ owner: 'me', repo: 'my-repo' })
    expect(githubRepoOf('https://github.com/me/r')).toEqual({ owner: 'me', repo: 'r' })
    expect(githubRepoOf('https://gitlab.com/me/r')).toBe(null)
    expect(compareUrl({ remoteUrl: 'https://github.com/me/r.git', base: 'origin/main', upstream: 'origin/feat/x' })).toBe(
      'https://github.com/me/r/compare/main...feat/x'
    )
    expect(compareUrl({ remoteUrl: 'https://github.com/me/r.git', base: 'origin/main', upstream: '' })).toBe(null)
  })

  it('reads the commits with their refs, then the files of one commit and its two sides', async () => {
    write('a.txt', 'one\ntwo\nthree\n')
    g(repo, 'mv', 'old name.txt', 'new name.txt')
    g(repo, 'add', '-A')
    g(repo, 'commit', '-q', '-m', 'second\n\nbody line')
    const h = await scmHistory({ root: repo })
    expect(h.ok).toBe(true)
    expect(h.items.map((i) => i.subject)).toEqual(['second', 'first'])
    expect(h.items[0].message).toBe('second\n\nbody line')
    expect(h.currentRef).toMatchObject({ id: 'refs/heads/main', name: 'main' })
    expect(h.remoteRef).toMatchObject({ id: 'refs/remotes/origin/main', name: 'origin/main' })
    expect(h.items[1].references.map((r) => r.name)).toContain('origin/main')
    expect(h.items[0].references.map((r) => r.name)).toEqual(['main'])
    const files = await scmCommitFiles({ root: repo, commit: h.items[0].id })
    expect(files.ok).toBe(true)
    expect(files.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'a.txt', status: 'modified', added: 1, removed: 0 }),
        expect.objectContaining({ path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' })
      ])
    )
    const first = await scmCommitFiles({ root: repo, commit: h.items[1].id })
    expect(first.entries.map((e) => e.status)).toEqual(['added', 'added', 'added'])
    const v = await scmFileVersions({ root: repo, path: 'a.txt', area: 'commit', commit: h.items[0].id })
    expect(v).toMatchObject({ ok: true, original: 'one\ntwo\n', modified: 'one\ntwo\nthree\n' })
    const r = await scmFileVersions({ root: repo, path: 'new name.txt', oldPath: 'old name.txt', area: 'commit', commit: h.items[0].id })
    expect(r).toMatchObject({ ok: true, original: 'rename me\n', modified: 'rename me\n' })
    expect(await scmFileVersions({ root: repo, path: 'a.txt', area: 'commit', commit: '--output=x' })).toMatchObject({ ok: false })
    expect(await scmCommitFiles({ root: repo, commit: 'HEAD' })).toMatchObject({ ok: false })
  })

  it('parses log records, legacy decorations and name-status', () => {
    const hash = 'a'.repeat(40)
    const rec = [hash, 'Ann', 'a@x', '1700000000', '1700000000', 'b'.repeat(40), 'HEAD -> refs/heads/main\x1frefs/remotes/origin/main\x1ftag: refs/tags/v1', '', 'Subject\n\nBody\n'].join('\n')
    const [item] = parseHistoryLog(`${rec}\0`)
    expect(item).toMatchObject({ id: hash, displayId: 'aaaaaaa', subject: 'Subject', author: 'Ann', timestamp: 1700000000000, parentIds: ['b'.repeat(40)] })
    expect(item.references.map((r) => [r.name, r.category])).toEqual([
      ['main', 'branches'],
      ['origin/main', 'remote branches'],
      ['v1', 'tags']
    ])
    expect(parseNameStatusZ('M\0a b.js\0R087\0old.js\0new.js\0D\0gone.js\0')).toEqual([
      { path: 'a b.js', status: 'modified' },
      { path: 'new.js', oldPath: 'old.js', status: 'renamed' },
      { path: 'gone.js', status: 'deleted' }
    ])
  })
})
