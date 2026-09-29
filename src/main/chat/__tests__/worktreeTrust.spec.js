import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { worktreeProjectRoot } from '../worktreeTrust'

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
