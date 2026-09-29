import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { worktreeProjectRoot } from '../worktreeTrust'

// git hides the .git file on Windows: a plain write of a hidden file fails.
function overwrite(file, text) {
  const fd = fs.openSync(file, 'r+')
  try {
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, text, 0)
  } finally {
    fs.closeSync(fd)
  }
}
const same = (a, b) => a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '')

describe('worktreeProjectRoot', () => {
  let root, project, copy
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'tessel-wt-')))
    project = join(root, 'project')
    copy = join(root, 'copy')
    fs.mkdirSync(project)
    const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe' })
    git('init', '-q')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    git('worktree', 'add', '-q', copy)
  })

  it('a real git worktree: its project', () => {
    const roots = worktreeProjectRoot(copy)
    expect(roots.length).toBe(1)
    expect(same(roots[0], project)).toBe(true)
  })

  it('the project itself, a plain folder, a missing one: nothing', () => {
    expect(worktreeProjectRoot(project)).toEqual([])
    const plain = join(root, 'plain')
    fs.mkdirSync(plain)
    expect(worktreeProjectRoot(plain)).toEqual([])
    expect(worktreeProjectRoot(join(root, 'nope'))).toEqual([])
  })

  it('a relative back-link resolves against the gitdir file folder, never Tessel\'s current folder', () => {
    const rel = join(root, 'rel-copy')
    execFileSync('git', ['worktree', 'add', '-q', rel], { cwd: project, stdio: 'pipe' })
    const entry = join(project, '.git', 'worktrees', 'rel-copy')
    // As git writes it with worktree.useRelativePaths: relative to the entry.
    fs.writeFileSync(join(entry, 'gitdir'), '../../../../rel-copy/.git\n')
    overwrite(join(rel, '.git'), 'gitdir: ../project/.git/worktrees/rel-copy\n')
    const roots = worktreeProjectRoot(rel)
    expect(roots.length).toBe(1)
    expect(same(roots[0], project)).toBe(true)
    // Relative to the process folder it would name something else: refused.
    fs.writeFileSync(join(entry, 'gitdir'), 'rel-copy/.git\n')
    const cwd = process.cwd()
    try {
      process.chdir(root)
      expect(worktreeProjectRoot(rel)).toEqual([])
    } finally {
      process.chdir(cwd)
    }
  })

  it('a UNC project keeps its leading backslashes', () => {
    if (process.platform !== 'win32') return
    // The admin share of this drive: \\localhost\C$\...
    const unc = (p) => '\\\\localhost\\' + p[0] + '$' + p.slice(2)
    const uncCopy = unc(copy)
    try {
      fs.statSync(join(uncCopy, '.git'))
    } catch {
      return // no admin share here
    }
    const entry = fs.readdirSync(join(project, '.git', 'worktrees')).find((e) => e.toLowerCase() === 'copy')
    const gitdirFile = join(project, '.git', 'worktrees', entry, 'gitdir')
    const dotGit = join(copy, '.git')
    const before = [fs.readFileSync(dotGit, 'utf8'), fs.readFileSync(gitdirFile, 'utf8')]
    try {
      overwrite(dotGit, 'gitdir: ' + unc(join(project, '.git', 'worktrees', entry)) + '\n')
      fs.writeFileSync(gitdirFile, join(uncCopy, '.git') + '\n')
      const roots = worktreeProjectRoot(uncCopy)
      expect(roots).toHaveLength(1)
      expect(roots[0].startsWith('\\\\localhost\\')).toBe(true)
      expect(same(roots[0], unc(project))).toBe(true)
    } finally {
      overwrite(dotGit, before[0])
      fs.writeFileSync(gitdirFile, before[1])
    }
  })

  it('a hand-written .git file naming a trusted project: refused (the project does not name it back)', () => {
    const fake = join(root, 'fake')
    fs.mkdirSync(fake)
    const entry = fs.readdirSync(join(project, '.git', 'worktrees'))[0]
    fs.writeFileSync(join(fake, '.git'), `gitdir: ${join(project, '.git', 'worktrees', entry)}\n`)
    expect(worktreeProjectRoot(fake)).toEqual([])
    // Not a worktrees entry at all.
    fs.writeFileSync(join(fake, '.git'), `gitdir: ${join(project, '.git')}\n`)
    expect(worktreeProjectRoot(fake)).toEqual([])
  })
})
