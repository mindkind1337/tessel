// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { execFileSync } from 'child_process'
import { createWorktree, run } from '../agentTools'
import { copyWorktreeEnv, runWorktreeSetupProcess, setupWorktree } from '../worktreeCreate'

let sandbox
let repo

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim()
}

function write(path, content) {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, content)
}

function commit(message = 'fixture') {
  git('add', '--all')
  git('commit', '--quiet', '-m', message)
  return git('rev-parse', 'HEAD')
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(join(os.tmpdir(), 'tessel-worktree-test-'))
  // No developer-wide Git configuration, hooks, signing or credentials.
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(sandbox, 'absent-global-config'))
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0')
  repo = join(sandbox, 'repo space & literal')
  fs.mkdirSync(repo)
  git('-c', 'init.templateDir=', 'init', '--quiet', '--initial-branch=main')
  git('config', 'user.name', 'Worktree fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  git('config', 'core.hooksPath', join(sandbox, 'empty-hooks'))
  write(join(repo, '.gitignore'), '.env\n.env.*\nnode_modules/\n.cache/\n')
  write(join(repo, 'README.md'), 'fixture\n')
  commit()
})

afterEach(() => {
  vi.unstubAllEnvs()
  // Recursive cleanup is restricted to the fixture root created above.
  const target = resolve(sandbox)
  const location = relative(resolve(os.tmpdir()), target)
  if (
    isAbsolute(location) ||
    location.startsWith('..') ||
    !basename(target).startsWith('tessel-worktree-test-')
  ) {
    throw new Error('Refusing cleanup outside the disposable fixture')
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// Real git commands: slow on Windows under a full parallel run.
describe('advanced worktree creation', { timeout: 30000 }, () => {
  it('preserves old HEAD calls and leaves initialization disabled', async () => {
    write(
      join(repo, '.tessel', 'setup.ps1'),
      "Set-Content -LiteralPath 'unexpected.txt' -Value 'fixture'\n"
    )
    const head = commit()
    write(join(repo, '.env'), 'FIXTURE_ONLY=not-real\n')
    const result = await createWorktree(repo, 'Code review')
    expect(result).toMatchObject({
      ok: true,
      branch: 'agent/code-review',
      baseBranch: 'main',
      baseCommit: head
    })
    expect(resolve(result.root)).toBe(repo)
    expect(result).not.toHaveProperty('copyEnvResult')
    expect(result).not.toHaveProperty('setup')
    expect(fs.existsSync(join(result.path, '.env'))).toBe(false)
    expect(fs.existsSync(join(result.path, 'unexpected.txt'))).toBe(false)
    expect(git('rev-parse', 'agent/code-review')).toBe(head)
    expect(git('branch', '--show-current')).toBe('main')
  })

  it('uses an immutable selected local or remote commit and keeps branch metadata', async () => {
    const release = git('rev-parse', 'HEAD')
    git('branch', 'release;literal')
    git('update-ref', 'refs/remotes/origin/release', release)
    write(join(repo, 'README.md'), 'later main\n')
    commit('main moved')
    const local = await createWorktree(repo, 'work', { baseBranch: 'release;literal' })
    const remote = await createWorktree(repo, 'work', { baseBranch: 'origin/release' })
    expect(local).toMatchObject({
      ok: true,
      baseBranch: 'release;literal',
      baseCommit: release,
      branch: 'agent/work'
    })
    expect(remote).toMatchObject({
      ok: true,
      baseBranch: 'origin/release',
      baseCommit: release,
      branch: 'agent/work-2'
    })
    expect(fs.readFileSync(join(local.path, 'README.md'), 'utf8')).toBe('fixture\n')
    expect(git('rev-parse', remote.branch)).toBe(release)
  })

  it('creates a worktree at a full pinned PR commit while the current branch moves', async () => {
    const pinned = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/tessel/pr/41', pinned)
    write(join(repo, 'README.md'), 'later main\n')
    const current = commit('main moved after PR discovery')
    const result = await createWorktree(repo, 'pinned PR', { baseBranch: pinned })
    expect(result).toMatchObject({ ok: true, baseBranch: pinned, baseCommit: pinned })
    expect(git('-C', result.path, 'rev-parse', 'HEAD')).toBe(pinned)
    expect(fs.readFileSync(join(result.path, 'README.md'), 'utf8')).toBe('fixture\n')
    expect(git('rev-parse', 'HEAD')).toBe(current)
    expect(git('branch', '--show-current')).toBe('main')
  })

  it('accepts full SHA-256 commits but rejects abbreviated identities', async () => {
    repo = join(sandbox, 'sha256 repo')
    fs.mkdirSync(repo)
    git(
      '-c',
      'init.templateDir=',
      'init',
      '--quiet',
      '--initial-branch=main',
      '--object-format=sha256'
    )
    git('config', 'user.name', 'Worktree fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.autocrlf', 'false')
    git('config', 'core.hooksPath', join(sandbox, 'empty-hooks'))
    write(join(repo, 'README.md'), 'SHA-256 fixture\n')
    const pinned = commit()
    expect(pinned).toHaveLength(64)
    expect(
      (await createWorktree(repo, 'abbreviated', { baseBranch: pinned.slice(0, 40) })).ok
    ).toBe(false)
    const result = await createWorktree(repo, 'full SHA-256', { baseBranch: pinned.toUpperCase() })
    expect(result).toMatchObject({ ok: true, baseBranch: pinned.toUpperCase(), baseCommit: pinned })
    expect(git('-C', result.path, 'rev-parse', 'HEAD')).toBe(pinned)
  })

  it('refuses missing objects, noncommit objects and expressions without creating branches', async () => {
    const pinned = git('rev-parse', 'HEAD')
    const blob = git('rev-parse', 'HEAD:README.md')
    const tree = git('rev-parse', 'HEAD^{tree}')
    git('tag', '-a', 'annotated-fixture', '-m', 'Fixture annotated tag')
    const tagObject = git('rev-parse', 'annotated-fixture')
    git('update-ref', 'refs/tessel/pr/42', pinned)
    for (const baseBranch of [
      '0'.repeat(40),
      '0'.repeat(64),
      blob,
      tree,
      tagObject,
      pinned.slice(0, 12),
      `${pinned}~0`,
      `${pinned}^{commit}`,
      'refs/tessel/pr/42'
    ]) {
      const result = await createWorktree(repo, 'invalid object', { baseBranch })
      expect(result.ok, baseBranch).toBe(false)
      expect(result).not.toHaveProperty('path')
    }
    expect(git('branch', '--list', 'agent/*')).toBe('')
    expect(fs.existsSync(`${repo}.worktrees`)).toBe(false)
  })

  it('does not let a full hex branch name substitute for a missing object', async () => {
    const missing = '1'.repeat(40)
    git('branch', missing)
    const result = await createWorktree(repo, 'shadowed object', { baseBranch: missing })
    expect(result.ok).toBe(false)
    expect(git('branch', '--list', 'agent/*')).toBe('')
    expect(fs.existsSync(`${repo}.worktrees`)).toBe(false)
  })

  it('rejects unknown refs, revision expressions, tags and options before creating anything', async () => {
    git('tag', 'tag-only')
    for (const baseBranch of ['missing', 'main~0', 'tag-only', '--help', 'main\nother', 42]) {
      const result = await createWorktree(repo, 'invalid', { baseBranch })
      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('path')
    }
    expect(git('branch', '--list', 'agent/*')).toBe('')
    expect(fs.existsSync(`${repo}.worktrees`)).toBe(false)
  })

  it('copies only ignored regular env files and excludes dependency/cache trees', async () => {
    write(join(repo, '.env.example'), 'TRACKED_FIXTURE=template\n')
    git('add', '-f', '.env.example')
    commit()
    write(join(repo, '.env'), 'ROOT_FIXTURE=not-real\n')
    write(join(repo, 'services', 'api', '.env.local'), 'NESTED_FIXTURE=not-real\n')
    write(join(repo, '.env-public'), 'UNIGNORED_FIXTURE=not-real\n')
    write(join(repo, 'node_modules', 'package', '.env'), 'DEPENDENCY_FIXTURE=not-real\n')
    write(join(repo, '.cache', '.env'), 'CACHE_FIXTURE=not-real\n')
    write(join(repo, '.env.too-large'), Buffer.alloc(1024 * 1024 + 1, 65))
    const result = await createWorktree(repo, 'env', { copyEnv: true })
    expect(result.copyEnvResult).toEqual({ ok: true, copied: 2, skipped: 1, truncated: false })
    expect(fs.readFileSync(join(result.path, '.env'), 'utf8')).toBe('ROOT_FIXTURE=not-real\n')
    expect(fs.readFileSync(join(result.path, 'services', 'api', '.env.local'), 'utf8')).toBe(
      'NESTED_FIXTURE=not-real\n'
    )
    expect(fs.readFileSync(join(result.path, '.env.example'), 'utf8')).toBe(
      'TRACKED_FIXTURE=template\n'
    )
    for (const name of ['.env-public', '.env.too-large', 'node_modules', '.cache'])
      expect(fs.existsSync(join(result.path, name))).toBe(false)
    expect(JSON.stringify(result)).not.toContain('not-real')
  })

  it('refuses env copies that are not ignored in the selected destination branch', async () => {
    write(join(repo, '.gitignore'), '')
    commit()
    git('branch', 'without-ignores')
    write(join(repo, '.gitignore'), '.env*\n')
    commit()
    write(join(repo, '.env.local'), 'FIXTURE_ONLY=not-real\n')
    const result = await createWorktree(repo, 'no-leak', {
      baseBranch: 'without-ignores',
      copyEnv: true
    })
    expect(result.copyEnvResult).toMatchObject({ ok: true, copied: 0, skipped: 1 })
    expect(fs.existsSync(join(result.path, '.env.local'))).toBe(false)
    expect(git('-C', result.path, 'status', '--porcelain')).toBe('')
  })

  it('never replaces destination tracked files, even if removed, or existing untracked files', async () => {
    write(join(repo, '.env.production'), 'BASE_FIXTURE=tracked\n')
    git('add', '-f', '.env.production')
    commit()
    git('branch', 'tracked-env')
    git('rm', '.env.production')
    commit()
    write(join(repo, '.env.production'), 'SOURCE_FIXTURE=not-real\n')
    write(join(repo, '.env.local'), 'SOURCE_FIXTURE=local\n')
    const result = await createWorktree(repo, 'keep-env', {
      baseBranch: 'tracked-env',
      copyEnv: true
    })
    expect(result.copyEnvResult).toMatchObject({ ok: true, copied: 1, skipped: 1 })
    expect(fs.readFileSync(join(result.path, '.env.production'), 'utf8')).toBe(
      'BASE_FIXTURE=tracked\n'
    )
    fs.unlinkSync(join(result.path, '.env.production'))
    write(join(result.path, '.env.local'), 'DESTINATION_FIXTURE=keep\n')
    const repeated = await copyWorktreeEnv(repo, result.path, run)
    expect(repeated).toMatchObject({ ok: true, copied: 0, skipped: 2 })
    expect(fs.existsSync(join(result.path, '.env.production'))).toBe(false)
    expect(fs.readFileSync(join(result.path, '.env.local'), 'utf8')).toBe(
      'DESTINATION_FIXTURE=keep\n'
    )
  })

  it('does not traverse source or destination directory links', async () => {
    const outside = join(sandbox, 'outside-fixture')
    write(join(outside, '.env'), 'OUTSIDE_FIXTURE=unchanged\n')
    fs.symlinkSync(
      outside,
      join(repo, 'source-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    write(join(repo, 'config', '.env'), 'INSIDE_FIXTURE=not-real\n')
    const result = await createWorktree(repo, 'links')
    fs.symlinkSync(
      outside,
      join(result.path, 'config'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const copied = await copyWorktreeEnv(repo, result.path, run)
    expect(copied).toMatchObject({ ok: false, copied: 0, skipped: 1 })
    expect(fs.existsSync(join(result.path, 'source-link'))).toBe(false)
    expect(fs.readFileSync(join(outside, '.env'), 'utf8')).toBe('OUTSIDE_FIXTURE=unchanged\n')
  })

  it('bounds discovery and individual file sizes', async () => {
    write(join(repo, '.env.too-large'), Buffer.alloc(1024 * 1024 + 1, 65))
    for (let i = 0; i < 132; i++) write(join(repo, `.env.fixture-${i}`), 'FIXTURE_ONLY=not-real\n')
    const result = await createWorktree(repo, 'bounded', { copyEnv: true })
    expect(result.copyEnvResult.ok).toBe(true)
    expect(result.copyEnvResult.copied).toBeLessThanOrEqual(128)
    expect(result.copyEnvResult.truncated).toBe(true)
    expect(fs.existsSync(join(result.path, '.env.too-large'))).toBe(false)
  })

  it('only treats literal true as permission to initialize', async () => {
    write(join(repo, '.env'), 'FIXTURE_ONLY=not-real\n')
    const result = await createWorktree(repo, 'strict', { copyEnv: 'true', runSetup: 1 })
    expect(result.ok).toBe(true)
    expect(result).not.toHaveProperty('copyEnvResult')
    expect(result).not.toHaveProperty('setup')
  })

  it('reports an absent setup hook without running an uncommitted source hook', async () => {
    write(join(repo, '.tessel', 'setup.ps1'), "throw 'UNCOMMITTED_FIXTURE'\n")
    const result = await createWorktree(repo, 'missing-hook', { runSetup: true })
    expect(result.setup).toEqual({ ok: true, ran: false, skipped: 'missing' })
  })

  it('refuses a setup hook stored as a symlink in the chosen commit', async () => {
    git('config', 'core.symlinks', 'false')
    const object = execFileSync('git', ['-C', repo, 'hash-object', '-w', '--stdin'], {
      input: '../../outside-fixture.ps1\n',
      encoding: 'utf8',
      windowsHide: true
    }).trim()
    git('update-index', '--add', '--cacheinfo', '120000', object, '.tessel/setup.ps1')
    git('commit', '--quiet', '-m', 'fixture symlink')
    const result = await createWorktree(repo, 'linked-hook', { runSetup: true })
    expect(result).toMatchObject({ ok: true, setup: { ok: false, ran: false } })
    expect(result.setup.error).toMatch(/regular tracked file/)
  })

  it('stops excessive setup output without retaining its contents', async () => {
    const result = await runWorktreeSetupProcess(
      process.execPath,
      ['-e', 'process.stdout.write("FIXTURE_SECRET".repeat(1024)); setInterval(() => {}, 1000)'],
      { cwd: sandbox, timeout: 5000, maxBuffer: 4096 }
    )
    expect(result).toEqual({ ok: false })
    expect(JSON.stringify(result)).not.toContain('FIXTURE_SECRET')
  }, 10000)

  it.runIf(process.platform === 'win32')(
    'runs only the chosen base hook in the new worktree',
    async () => {
      write(
        join(repo, '.tessel', 'setup.ps1'),
        "Set-Content -LiteralPath 'setup-marker.txt' -Value 'chosen-base'\nexit 0\n"
      )
      const base = commit()
      git('branch', 'setup-base')
      write(join(repo, '.tessel', 'setup.ps1'), "throw 'WRONG_COMMITTED_FIXTURE'\n")
      commit()
      write(join(repo, '.tessel', 'setup.ps1'), "throw 'WRONG_UNCOMMITTED_FIXTURE'\n")
      const result = await createWorktree(repo, 'setup success', {
        baseBranch: 'setup-base',
        runSetup: true
      })
      expect(result).toMatchObject({ ok: true, baseCommit: base, setup: { ok: true, ran: true } })
      expect(fs.readFileSync(join(result.path, 'setup-marker.txt'), 'utf8').trim()).toBe(
        'chosen-base'
      )
      expect(fs.existsSync(join(repo, 'setup-marker.txt'))).toBe(false)
    },
    15000
  )

  it.runIf(process.platform === 'win32')(
    'keeps the created worktree on setup failure and never returns logs',
    async () => {
      write(
        join(repo, '.tessel', 'setup.ps1'),
        "Write-Output 'OUTPUT_FIXTURE_SECRET'\n[Console]::Error.WriteLine('ERROR_FIXTURE_SECRET')\nexit 7\n"
      )
      commit()
      const result = await createWorktree(repo, 'setup failure', { runSetup: true })
      expect(result).toMatchObject({ ok: true, setup: { ok: false, ran: true } })
      expect(fs.existsSync(result.path)).toBe(true)
      expect(git('worktree', 'list', '--porcelain').replaceAll('\\', '/')).toContain(
        result.path.replaceAll('\\', '/')
      )
      expect(JSON.stringify(result)).not.toContain('FIXTURE_SECRET')
      expect(result.setup.error).toMatch(/failed/)
    },
    15000
  )

  it('passes bounded direct execution options and hides an injected runner failure', async () => {
    write(join(repo, '.tessel', 'setup.ps1'), 'exit 0\n')
    const head = commit()
    const created = await createWorktree(repo, 'runner')
    const execute = vi.fn(async () => ({
      ok: false,
      stdout: 'FIXTURE_SECRET',
      stderr: 'FIXTURE_SECRET'
    }))
    const result = await setupWorktree(created.path, head, run, execute)
    expect(execute).toHaveBeenCalledWith(
      expect.any(String),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(created.path, '.tessel', 'setup.ps1')
      ],
      { cwd: created.path, timeout: 60000, maxBuffer: 256 * 1024 }
    )
    expect(JSON.stringify(result)).not.toContain('FIXTURE_SECRET')
    expect(result).toMatchObject({ ok: false, ran: true })
  })

  it.runIf(process.platform === 'win32')(
    'terminates fixture shell descendants when the setup deadline expires',
    async () => {
      const childScript = join(sandbox, 'child.cjs')
      write(childScript, 'setInterval(() => {}, 1000)\n')
      const quote = (text) => `'${text.replaceAll("'", "''")}'`
      const hook = join(sandbox, 'timeout.ps1')
      const pidFile = join(sandbox, 'child-pid.txt')
      write(
        hook,
        `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(`"${childScript}"`)} -WindowStyle Hidden -PassThru\nSet-Content -LiteralPath ${quote(pidFile)} -Value $p.Id\nStart-Sleep -Seconds 60\n`
      )
      let childPid
      try {
        const result = await runWorktreeSetupProcess(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-File', hook],
          {
            cwd: sandbox,
            timeout: 3000,
            maxBuffer: 4096
          }
        )
        expect(result).toEqual({ ok: false })
        childPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
        expect(Number.isInteger(childPid) && childPid > 0).toBe(true)
        expect(() => process.kill(childPid, 0)).toThrow()
      } finally {
        if (!childPid && fs.existsSync(pidFile))
          childPid = Number(fs.readFileSync(pidFile, 'utf8').trim())
        if (Number.isInteger(childPid) && childPid > 0) {
          try {
            process.kill(childPid, 0)
            execFileSync('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore'
            })
          } catch {
            /* already stopped */
          }
        }
      }
    },
    15000
  )
})
