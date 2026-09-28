// @vitest-environment node
// Settings > Git (Branch Prefix) and > General (Workspace Directory) on real
// task copies: where createWorktree puts them, their branch name, and that
// Review still accepts and deletes them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { execFileSync } from 'child_process'
import { createWorktree, expandHome, normalizeGitUsername } from '../agentTools'
import { reviewInfo, reviewRemove } from '../review'

let sandbox
let repo

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(join(os.tmpdir(), 'tessel-wtsettings-test-'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(sandbox, 'absent-global-config'))
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0')
  repo = join(sandbox, 'proj')
  fs.mkdirSync(repo)
  git('-c', 'init.templateDir=', 'init', '--quiet', '--initial-branch=main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  git('config', 'core.hooksPath', join(sandbox, 'empty-hooks'))
  fs.writeFileSync(join(repo, 'README.md'), 'fixture\n')
  git('add', '--all')
  git('commit', '--quiet', '-m', 'init')
})

afterEach(() => {
  vi.unstubAllEnvs()
  const target = resolve(sandbox)
  const location = relative(resolve(os.tmpdir()), target)
  if (isAbsolute(location) || location.startsWith('..') || !basename(target).startsWith('tessel-wtsettings-test-'))
    throw new Error('Refusing cleanup outside the disposable fixture')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('task copies follow Branch Prefix and Workspace Directory', { timeout: 30000 }, () => {
  it("keeps Tessel's agent/ branch next to the project by default", async () => {
    const r = await createWorktree(repo, 'Fix it', { branchPrefix: 'custom', branchPrefixCustom: 'agent', workspaceDir: '' })
    expect(r).toMatchObject({ ok: true, branch: 'agent/fix-it' })
    expect(resolve(r.path)).toBe(join(sandbox, 'proj.worktrees', 'fix-it'))
    // Callers from before these settings (no options) get the same.
    const old = await createWorktree(repo, 'Old call')
    expect(old).toMatchObject({ ok: true, branch: 'agent/old-call' })
  })

  it('a custom prefix and a shared folder (one folder per project)', async () => {
    const shared = join(sandbox, 'all-copies')
    const r = await createWorktree(repo, 'New thing', { branchPrefix: 'custom', branchPrefixCustom: 'team/', workspaceDir: shared })
    expect(r).toMatchObject({ ok: true, branch: 'team/new-thing' })
    expect(resolve(r.path)).toBe(join(shared, 'proj', 'new-thing'))
    expect(git('rev-parse', '--abbrev-ref', 'team/new-thing')).toBe('team/new-thing')

    // Review accepts it while git lists its copy, and deletes both.
    const args = { root: repo, path: r.path, branch: r.branch, target: 'main' }
    expect((await reviewInfo(args)).ok).toBe(true)
    // Never another branch through that copy, nor the project folder itself.
    expect((await reviewInfo({ ...args, branch: 'main' })).ok).toBe(false)
    expect((await reviewRemove({ ...args, path: repo, branch: 'main', force: true })).ok).toBe(false)
    expect((await reviewRemove({ ...args, force: true })).ok).toBe(true)
    expect(fs.existsSync(r.path)).toBe(false)
    expect(git('branch', '--list', 'team/new-thing')).toBe('')
    // Gone from git's list: a branch outside agent/ is no longer a task branch.
    git('branch', 'team/other')
    expect((await reviewRemove({ ...args, branch: 'team/other', force: true })).ok).toBe(false)
    expect(git('branch', '--list', 'team/other')).not.toBe('')
  })

  it('no prefix, a folder inside the project, and the git username', async () => {
    const none = await createWorktree(repo, 'plain', { branchPrefix: 'none', workspaceDir: '.copies' })
    expect(none).toMatchObject({ ok: true, branch: 'plain' })
    expect(resolve(none.path)).toBe(join(repo, '.copies', 'proj', 'plain'))
    git('config', 'user.username', 'octo')
    const mine = await createWorktree(repo, 'mine', { branchPrefix: 'git-username', workspaceDir: '' })
    expect(mine).toMatchObject({ ok: true, branch: 'octo/mine' })
  })

  it('a prefix git would reject is refused with a hint', async () => {
    const r = await createWorktree(repo, 'x', { branchPrefix: 'custom', branchPrefixCustom: 'bad:prefix' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Branch prefix/)
  })
})

describe('helpers', () => {
  it('expands ~ and reads a git username', () => {
    expect(expandHome('~')).toBe(os.homedir())
    expect(expandHome('~/wt')).toBe(join(os.homedir(), 'wt'))
    expect(expandHome(' D:\\wt ')).toBe('D:\\wt')
    expect(expandHome(null)).toBe('')
    expect(normalizeGitUsername('12345+octo@users.noreply.github.com\n')).toBe('octo')
    expect(normalizeGitUsername('two words')).toBe('')
  })
})
