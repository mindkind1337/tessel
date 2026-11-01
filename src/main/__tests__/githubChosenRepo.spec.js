// @vitest-environment node
// A local folder that is no Git clone with a GitHub remote (an installed app,
// a plain folder): the GitHub dialog names its repository once, and gh is told
// which one (--repo) instead of guessing it from the folder.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chosenRepoSpec, createChosenRepos, createGithubService } from '../githubService'

const repo = { nameWithOwner: 'owner/project', defaultBranchRef: { name: 'main' }, url: 'https://github.com/owner/project' }
const response = (value, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: '' })
const NOT_GIT = { code: 1, stdout: '', stderr: 'failed to run git: fatal: not a git repository (or any of the parent directories): .git\n' }

let root, cwd, file
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-gh-chosen-'))
  cwd = path.join(root, 'App')
  fs.mkdirSync(cwd)
  file = path.join(root, 'data', 'github-repos.json')
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

// gh without --repo in a folder that is no clone fails; with a repository
// named (repo view <spec> / --repo) it answers.
function fixture(handle = () => response([]), store = createChosenRepos({ file })) {
  const calls = []
  const runner = vi.fn(async (file, args, options) => {
    calls.push({ file, args, options })
    if (args[0] === 'repo') return args[2] && !args[2].startsWith('--') ? response(repo) : NOT_GIT
    if (args[0] === 'auth') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === '--version') return { code: 0, stdout: 'gh version 2', stderr: '' }
    return handle(file, args, options)
  })
  const service = createGithubService({ runner, ghPath: 'gh', gitPath: 'git', env: {}, tempDir: root, chosen: store })
  return { service, calls, runner, store }
}

describe('chosenRepoSpec', () => {
  it.each([
    ['owner/project', 'github.com/owner/project'],
    [' owner/project.git ', 'github.com/owner/project'],
    ['GitHub.com/owner/project', 'github.com/owner/project'],
    ['ghe.example.com/org/my.repo', 'ghe.example.com/org/my.repo'],
    ['https://github.com/owner/project', 'github.com/owner/project'],
    ['git@github.com:owner/project.git', 'github.com/owner/project']
  ])('%s -> %s', (value, spec) => {
    expect(chosenRepoSpec(value)).toBe(spec)
  })
  it.each([['project'], ['--repo/x'], ['owner/-x'], ['a/b/c/d'], ['owner/pro ject'], [''], [null]])('refuses %s', (value) => {
    expect(chosenRepoSpec(value)).toBe(null)
  })
})

describe('createChosenRepos', () => {
  it('keeps one repository per folder, case-insensitive on Windows, and forgets it', async () => {
    const store = createChosenRepos({ file, platform: 'win32' })
    expect(store.get(cwd)).toBe(null)
    await store.set(cwd, 'github.com/owner/project')
    expect(store.get(cwd.toUpperCase())).toBe('github.com/owner/project')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1)
    await store.set(cwd, null)
    expect(store.get(cwd)).toBe(null)
  })
  it('ignores an unreadable file and an invalid stored value', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json')
    expect(createChosenRepos({ file }).get(cwd)).toBe(null)
    fs.writeFileSync(file, JSON.stringify({ version: 1, repos: { [path.resolve(cwd)]: '--repo x' } }))
    expect(createChosenRepos({ file, platform: 'linux' }).get(cwd)).toBe(null)
    fs.rmSync(file)
  })
})

describe('GitHub service for a folder with a chosen repository', () => {
  it('says a folder that is no Git clone has no repository, not that the request failed', async () => {
    const { service } = fixture()
    const status = await service.status({ cwd })
    expect(status).toEqual({ ok: true, available: true, authenticated: true })
    const list = await service.list({ cwd, kind: 'issues' })
    expect(list).toMatchObject({ ok: false, code: 'repository' })
  })

  it('checks the repository with gh, keeps it, and then names it to every request', async () => {
    const { service, calls, runner } = fixture((_file, args) => (args[0] === 'issue' ? response([]) : response([])))
    expect(await service.chooseRepo({ cwd, repo: 'https://github.com/owner/project.git' })).toEqual({
      ok: true,
      repo: { nameWithOwner: 'owner/project', defaultBranch: 'main', url: 'https://github.com/owner/project', chosen: true }
    })
    expect(calls.at(-1).args.slice(0, 3)).toEqual(['repo', 'view', 'github.com/owner/project'])
    const status = await service.status({ cwd })
    expect(status.repo).toEqual({ nameWithOwner: 'owner/project', defaultBranch: 'main', url: 'https://github.com/owner/project', chosen: true })
    runner.mockClear()
    calls.length = 0
    expect((await service.list({ cwd, kind: 'issues' })).ok).toBe(true)
    expect(calls.at(-1).args.slice(-2)).toEqual(['--repo', 'github.com/owner/project'])
    expect(calls.at(-1).options.cwd).toBe(cwd)
    expect(await service.chooseRepo({ cwd, repo: '' })).toEqual({ ok: true })
    expect((await service.status({ cwd })).repo).toBeUndefined()
  })

  it('refuses an invalid repository before running gh, and keeps nothing gh cannot read', async () => {
    const { service, runner, store } = fixture()
    expect(await service.chooseRepo({ cwd, repo: '--repo=x' })).toMatchObject({ ok: false, code: 'validation' })
    expect(runner).not.toHaveBeenCalled()
    runner.mockImplementationOnce(async () => ({ code: 1, stdout: '', stderr: 'Could not resolve to a Repository' }))
    expect(await service.chooseRepo({ cwd, repo: 'owner/missing' })).toMatchObject({ ok: false, code: 'command' })
    expect(store.get(cwd)).toBe(null)
  })

  it('refuses what needs a Git clone: a PR worktree, a PR from the current branch', async () => {
    const { service, runner } = fixture()
    await service.chooseRepo({ cwd, repo: 'owner/project' })
    runner.mockClear()
    expect(await service.startPoint({ cwd, number: 1 })).toMatchObject({ ok: false, code: 'validation' })
    expect(await service.createPr({ cwd, title: 'T', base: 'main' })).toMatchObject({ ok: false, code: 'validation' })
    expect(runner.mock.calls.every(([file]) => file !== 'git')).toBe(true)
    await service.chooseRepo({ cwd, repo: '' })
  })

  it('cannot choose a repository for a remote project', async () => {
    const remote = { isRemote: () => true, context: async () => ({ ok: false }) }
    const service = createGithubService({ runner: vi.fn(), ghPath: 'gh', env: {}, remote, chosen: createChosenRepos({ file }) })
    expect(await service.chooseRepo({ cwd: 'ssh://box/srv/app', repo: 'owner/project' })).toMatchObject({ ok: false, code: 'validation' })
  })
})
