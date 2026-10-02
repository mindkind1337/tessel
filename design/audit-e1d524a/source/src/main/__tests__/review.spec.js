import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { reviewInfo, reviewDiff, reviewMerge, reviewRemove, parseWorktrees } from '../review'
import {
  parseChangedFiles,
  parseCommits,
  parseMergeTree,
  parseStatusPaths,
  parseUnifiedDiff,
  mergeBlocker
} from '../../shared/diff'

describe('diff parsers', () => {
  it('joins name-status and numstat', () => {
    const files = parseChangedFiles('M\tsrc/a.js\nA\tnew.txt\nD\told.md\n', '3\t1\tsrc/a.js\n5\t0\tnew.txt\n0\t9\told.md\n')
    expect(files).toEqual([
      { path: 'new.txt', status: 'A', added: 5, removed: 0, binary: false, blob: '' },
      { path: 'old.md', status: 'D', added: 0, removed: 9, binary: false, blob: '' },
      { path: 'src/a.js', status: 'M', added: 3, removed: 1, binary: false, blob: '' }
    ])
  })
  it('keeps each file content id from --raw', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const z = '0'.repeat(40)
    const raw = `:100644 100644 ${a} ${b} M\tsrc/a.js\n:100644 000000 ${a} ${z} D\told.md\n`
    const files = parseChangedFiles('M\tsrc/a.js\nD\told.md\n', '1\t1\tsrc/a.js\n0\t9\told.md\n', raw)
    expect(files.find((f) => f.path === 'src/a.js').blob).toBe(b)
    expect(files.find((f) => f.path === 'old.md').blob).toBe(a)
  })
  it('reads worktree records with their branch', () => {
    const text = 'worktree C:/p\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/p.worktrees/x\nHEAD def\nbranch refs/heads/agent/x\n\nworktree C:/p.worktrees/d\nHEAD 123\ndetached\n'
    expect(parseWorktrees(text)).toEqual([
      { path: 'C:/p', branch: 'refs/heads/main' },
      { path: 'C:/p.worktrees/x', branch: 'refs/heads/agent/x' },
      { path: 'C:/p.worktrees/d', branch: null }
    ])
  })
  it('marks binary files', () => {
    expect(parseChangedFiles('A\tlogo.png', '-\t-\tlogo.png')[0]).toMatchObject({ binary: true, status: 'A' })
  })
  it('reads commits', () => {
    const text = `${'a'.repeat(40)}\x1fBot\x1f1700000000\x1fFix it\x1fTests: 3 passed\n\x1e\n${'b'.repeat(40)}\x1fBot\x1f1700000100\x1fFirst\x1f\x1e\n`
    const c = parseCommits(text)
    expect(c).toHaveLength(2)
    expect(c[0]).toMatchObject({ subject: 'Fix it', body: 'Tests: 3 passed', time: 1700000000000 })
    expect(c[1].body).toBe('')
  })
  it('reads conflicted files from merge-tree', () => {
    expect(parseMergeTree('abc123\nsrc/a.js\nsrc/a.js\nREADME.md\n\nmessages')).toEqual(['src/a.js', 'README.md'])
    expect(parseMergeTree('abc123\n')).toEqual([])
  })
  it('reads status paths', () => {
    expect(parseStatusPaths(' M a.js\n?? dir/b.txt\nR  old -> new.js\n')).toEqual(['a.js', 'dir/b.txt', 'new.js'])
  })
  it('numbers diff lines', () => {
    const d = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n\\ No newline at end of file\n')
    expect(d.binary).toBe(false)
    expect(d.hunks[0].lines).toEqual([
      { kind: 'ctx', text: 'one', old: 1, new: 1 },
      { kind: 'del', text: 'two', old: 2, new: '' },
      { kind: 'add', text: 'TWO', old: '', new: 2 },
      { kind: 'ctx', text: 'three', old: 3, new: 3 },
      { kind: 'note', text: 'No newline at end of file', old: '', new: '' }
    ])
  })
  it('explains why a merge is blocked', () => {
    const ok = { ok: true, files: [{}], uncommitted: [], conflicts: [], dirtyOverlap: [], rootBranch: 'main', target: 'main' }
    expect(mergeBlocker(ok)).toBe('')
    expect(mergeBlocker({ ...ok, uncommitted: ['a'] })).toMatch(/not committed/)
    expect(mergeBlocker({ ...ok, files: [] })).toMatch(/no changes/)
    expect(mergeBlocker({ ...ok, rootBranch: 'dev' })).toMatch(/on branch dev/)
    expect(mergeBlocker({ ...ok, conflicts: ['a'] })).toMatch(/Conflicts/)
    expect(mergeBlocker({ ...ok, dirtyOverlap: ['a.js'] })).toMatch(/a\.js/)
  })
})

// A real repo with a task copy, as createWorktree makes it.
describe('review against git', () => {
  let dir, repo, copy
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
  const base = () => ({ root: repo, path: copy, branch: 'agent/fix', target: 'main' })

  beforeAll(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-review-'))
    repo = join(dir, 'proj')
    copy = join(dir, 'proj.worktrees', 'fix')
    fs.mkdirSync(repo)
    g(repo, 'init', '-q', '-b', 'main')
    g(repo, 'config', 'user.email', 't@example.com')
    g(repo, 'config', 'user.name', 'T')
    g(repo, 'config', 'core.autocrlf', 'false')
    fs.writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
    fs.writeFileSync(join(repo, 'b.txt'), 'b\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'init')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/fix', copy, 'HEAD')
    fs.writeFileSync(join(copy, 'a.txt'), 'one\nTWO\nthree\n')
    fs.writeFileSync(join(copy, 'c.txt'), 'new\n')
    g(copy, 'add', '.')
    g(copy, 'commit', '-q', '-m', 'Fix two', '-m', 'Tests: all pass')
  })
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may hold a file for a moment; the temp folder is cleaned later.
    }
  })

  it('refuses paths and branches that are not a task copy', async () => {
    expect((await reviewInfo({ ...base(), branch: 'main' })).ok).toBe(false)
    expect((await reviewInfo({ ...base(), target: '--help' })).ok).toBe(false)
    expect((await reviewRemove({ ...base(), path: join(dir, 'elsewhere') })).ok).toBe(false)
    expect((await reviewDiff({ ...base(), file: '--output=x' })).ok).toBe(false)
  })

  it('lists files, commits and no conflict', async () => {
    const info = await reviewInfo(base())
    expect(info.ok).toBe(true)
    expect(info.files.map((f) => `${f.status} ${f.path}`)).toEqual(['M a.txt', 'A c.txt'])
    expect(info.commits.map((c) => c.subject)).toEqual(['Fix two'])
    expect(info.commits[0].body).toBe('Tests: all pass')
    expect(info.conflicts).toEqual([])
    expect(info.blocker).toBe('')
  })

  it('shows a file diff', async () => {
    const d = await reviewDiff({ ...base(), file: 'a.txt' })
    expect(parseUnifiedDiff(d.text).hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => l.text)).toEqual(['two', 'TWO'])
  })

  it('blocks on uncommitted work, then on a conflict', async () => {
    fs.writeFileSync(join(copy, 'b.txt'), 'dirty\n')
    expect((await reviewInfo(base())).blocker).toMatch(/not committed/)
    g(copy, 'checkout', '--', 'b.txt')

    fs.writeFileSync(join(repo, 'a.txt'), 'one\nDEUX\nthree\n')
    g(repo, 'commit', '-q', '-am', 'main edits a')
    const info = await reviewInfo(base())
    expect(info.conflicts).toEqual(['a.txt'])
    expect(info.blocker).toMatch(/Conflicts with main/)
    expect((await reviewMerge(base())).ok).toBe(false)
    g(repo, 'reset', '-q', '--hard', 'HEAD~1')
  })

  it('blocks when unsaved changes in the project touch the same file', async () => {
    fs.writeFileSync(join(repo, 'c.txt'), 'mine\n')
    expect((await reviewInfo(base())).blocker).toMatch(/c\.txt/)
    fs.rmSync(join(repo, 'c.txt'))
  })

  it('refuses a merge when the agent committed after the check', async () => {
    const res = await reviewMerge({ ...base(), expectHead: 'f'.repeat(40) })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/committed again/)
  })

  it('merges, keeping unrelated unsaved changes, then removes the copy', async () => {
    fs.writeFileSync(join(repo, 'b.txt'), 'unsaved but unrelated\n')
    const info = await reviewInfo(base())
    const res = await reviewMerge({ ...base(), title: 'Fix two', expectHead: info.head })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(fs.readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('unsaved but unrelated\n')
    expect(g(repo, 'log', '-1', '--format=%s')).toMatch(/Merge task "Fix two" \(agent\/fix\)/)

    const rm = await reviewRemove(base())
    expect(rm.ok).toBe(true)
    expect(fs.existsSync(copy)).toBe(false)
    expect(g(repo, 'branch', '--list', 'agent/fix').trim()).toBe('')
  })

  it('never pairs one task copy with another task branch', async () => {
    const copyA = join(dir, 'proj.worktrees', 'ta')
    const copyB = join(dir, 'proj.worktrees', 'tb')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/ta', copyA, 'HEAD')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/tb', copyB, 'HEAD')
    const crossed = { root: repo, path: copyA, branch: 'agent/tb', target: 'main', force: true }
    const res = await reviewRemove(crossed)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not on branch agent\/tb/)
    expect((await reviewInfo(crossed)).ok).toBe(false)
    expect((await reviewMerge(crossed)).ok).toBe(false)
    expect(fs.existsSync(copyA)).toBe(true)
    expect(g(repo, 'branch', '--list', 'agent/tb').trim()).not.toBe('')
    expect((await reviewRemove({ ...crossed, path: copyA, branch: 'agent/ta' })).ok).toBe(true)
    expect((await reviewRemove({ ...crossed, path: copyB, branch: 'agent/tb' })).ok).toBe(true)
  })

  it('a new commit with the same line counts changes the file id', async () => {
    const copy2 = join(dir, 'proj.worktrees', 'same')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/same', copy2, 'HEAD')
    const args = { root: repo, path: copy2, branch: 'agent/same', target: 'main' }
    fs.writeFileSync(join(copy2, 'b.txt'), 'first\n')
    g(copy2, 'commit', '-q', '-am', 'one')
    const before = (await reviewInfo(args)).files[0]
    fs.writeFileSync(join(copy2, 'b.txt'), 'second\n')
    g(copy2, 'commit', '-q', '-am', 'two')
    const after = (await reviewInfo(args)).files[0]
    expect([before.added, before.removed]).toEqual([after.added, after.removed])
    expect(before.blob).toMatch(/^[0-9a-f]{40}$/)
    expect(after.blob).not.toBe(before.blob)
    await reviewRemove({ ...args, force: true })
  })

  it('discard needs force for an unmerged branch', async () => {
    const other = join(dir, 'proj.worktrees', 'nope')
    g(repo, 'worktree', 'add', '-q', '-b', 'agent/nope', other, 'HEAD')
    fs.writeFileSync(join(other, 'x.txt'), 'x\n')
    g(other, 'add', '.')
    g(other, 'commit', '-q', '-m', 'x')
    const args = { root: repo, path: other, branch: 'agent/nope', target: 'main' }
    const soft = await reviewRemove(args)
    expect(soft.ok).toBe(false)
    const hard = await reviewRemove({ ...args, force: true })
    expect(hard.ok).toBe(true)
    expect(g(repo, 'branch', '--list', 'agent/nope').trim()).toBe('')
  })
})
