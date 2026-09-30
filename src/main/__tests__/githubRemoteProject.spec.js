// @vitest-environment node
// Create PR (and the GitHub form) for a project on an SSH host: gh runs on
// this computer, in the home folder, on the repository named from the host's
// remote URL (remoteFs.js githubContext); nothing of the host runs here.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGithubService, githubRepoSpec } from '../githubService'
import { createRemoteFs } from '../remoteFs'
import { remoteRoot } from '../../shared/remotePath'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

const ROOT = 'ssh://ssh-box1/srv/app'
const repo = { nameWithOwner: 'owner/project', defaultBranchRef: { name: 'main' }, url: 'https://github.com/owner/project' }
const response = (value, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: '' })

describe('githubRepoSpec', () => {
  it.each([
    ['https://github.com/owner/project.git', 'github.com/owner/project'],
    ['https://github.com/owner/project', 'github.com/owner/project'],
    ['https://user:ghp_secret@GitHub.com/owner/project.git/', 'github.com/owner/project'],
    ['git@github.com:owner/project.git', 'github.com/owner/project'],
    ['ssh://git@github.com:22/owner/project.git', 'github.com/owner/project'],
    ['ssh://git@ghe.example.com/org/my.repo', 'ghe.example.com/org/my.repo']
  ])('%s -> %s', (url, spec) => {
    expect(githubRepoSpec(url)).toBe(spec)
  })
  it.each([
    ['/srv/git/project.git'],
    ['file:///srv/git/project'],
    ['ext::sh -c touch% /tmp/x'],
    ['https://github.com/owner'],
    ['https://github.com/owner/project/extra'],
    ['https://github.com/-owner/project'],
    ['git@github.com:owner/--repo'],
    ['https://github.com/owner/pro ject'],
    [''],
    [null]
  ])('refuses %s', (url) => {
    expect(githubRepoSpec(url)).toBe(null)
  })
})

describe('GitHub service for a remote project', () => {
  let home
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-gh-remote-'))
  })
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

  function fixture(context, handle = () => ({ code: 0, stdout: `${repo.url}/pull/7\n` })) {
    const calls = []
    const runner = vi.fn(async (file, args, options) => {
      calls.push({ file, args, options })
      if (args[0] === 'repo') return response(repo)
      return handle(file, args, options)
    })
    const ctx = vi.fn(async () => context)
    const service = createGithubService({ runner, ghPath: 'gh', gitPath: 'git', env: {}, home, tempDir: home, remote: { isRemote: (c) => String(c).startsWith('ssh://'), context: ctx } })
    return { service, calls, ctx }
  }

  it('Create PR: the repository from the host remote, the head from the host branch, gh in the home folder, no local git', async () => {
    const { service, calls, ctx } = fixture({ ok: true, remoteUrl: 'git@github.com:owner/project.git', branch: 'feature/remote' })
    expect(await service.createPr({ cwd: ROOT, title: 'Feature', body: 'Done', base: 'main' })).toEqual({ ok: true, url: `${repo.url}/pull/7` })
    expect(ctx).toHaveBeenCalledWith(ROOT)
    expect(calls[0].args).toEqual(['repo', 'view', 'github.com/owner/project', '--json', 'nameWithOwner,defaultBranchRef,url'])
    expect(calls.some((c) => c.file === 'git')).toBe(false)
    expect(calls.at(-1).args).toEqual(['pr', 'create', '--base', 'main', '--head', 'feature/remote', '--title', 'Feature', '--body-file', expect.any(String), '--repo', 'github.com/owner/project'])
    expect(calls.every((c) => c.options.cwd === home)).toBe(true)
  })

  it('a detached HEAD on the host: no head branch, nothing created', async () => {
    const { service, calls } = fixture({ ok: true, remoteUrl: 'https://github.com/owner/project', branch: '' })
    expect(await service.createPr({ cwd: ROOT, title: 'Feature', base: 'main' })).toMatchObject({ ok: false, code: 'validation' })
    expect(calls.some((c) => c.args[1] === 'create')).toBe(false)
  })

  it('a host that cannot be read or a remote that is not GitHub-shaped: a repository error, gh never runs', async () => {
    for (const context of [{ ok: false, error: 'The connection to Box was lost.' }, { ok: true, remoteUrl: '/srv/git/app.git', branch: 'main' }]) {
      const { service, calls } = fixture(context)
      const res = await service.createPr({ cwd: ROOT, title: 'Feature', base: 'main' })
      expect(res).toMatchObject({ ok: false, code: 'repository' })
      expect(calls).toEqual([])
    }
    const { service } = fixture({ ok: false, error: 'The connection to Box was lost.' })
    expect((await service.list({ cwd: ROOT, kind: 'issues' })).error).toMatch(/connection to Box/)
  })

  it('the GitHub form lists the remote repository items', async () => {
    const { service, calls } = fixture({ ok: true, remoteUrl: 'https://github.com/owner/project.git', branch: 'main' }, () => response([]))
    expect(await service.list({ cwd: ROOT, kind: 'issues' })).toEqual({ ok: true, items: [], truncated: false })
    expect(calls.at(-1).args.slice(-2)).toEqual(['--repo', 'github.com/owner/project'])
  })

  it('starting a PR worktree (a local fetch) is refused for a remote project', async () => {
    const { service, calls } = fixture({ ok: true, remoteUrl: 'https://github.com/owner/project.git', branch: 'main' })
    expect(await service.startPoint({ cwd: ROOT, number: 3 })).toMatchObject({ ok: false, code: 'validation' })
    expect(calls).toEqual([])
  })

  it('without the remote hook, a virtual path is not a local folder', async () => {
    const service = createGithubService({ runner: vi.fn(), ghPath: 'gh', gitPath: 'git', env: {}, home })
    expect(await service.createPr({ cwd: ROOT, title: 'x', base: 'main' })).toMatchObject({ ok: false, code: 'validation' })
  })
})

const HOST = 'ssh-test1'
function stubHosts() {
  return {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
    get: () => ({ id: HOST, label: 'Box' }),
    paneStarted: () => {},
    paneConnected: () => {},
    paneClosing: () => {},
    paneExited: () => {}
  }
}

describe.skipIf(!gitSh())('remoteFs.githubContext over a fake ssh', () => {
  let base
  let home
  let rfs
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-rgh-'))
    home = path.join(base, 'home')
    const app = path.join(home, 'app')
    fs.mkdirSync(app, { recursive: true })
    g(app, 'init', '-q', '-b', 'work')
    g(app, 'remote', 'add', 'origin', 'https://user:secret@github.com/fork/project.git')
    g(app, 'remote', 'add', 'upstream', 'git@github.com:owner/project.git')
    fs.mkdirSync(path.join(home, 'plain'))
    rfs = createRemoteFs({ hosts: stubHosts(), spawnImpl: fakeSpawn({ home }), trust: () => ({ decide: async () => false }) })
    rfs.setRoots([remoteRoot(HOST, `${posixPath(home)}/app`), remoteRoot(HOST, `${posixPath(home)}/plain`)])
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('upstream first (gh order), the branch as on the host', async () => {
    const res = await rfs.githubContext(remoteRoot(HOST, `${posixPath(home)}/app`))
    expect(res).toEqual({ ok: true, remoteUrl: 'git@github.com:owner/project.git', branch: 'work' })
  }, 60000)

  it('a folder that is not a repository, or not a saved project: an error', async () => {
    expect((await rfs.githubContext(remoteRoot(HOST, `${posixPath(home)}/plain`))).ok).toBe(false)
    expect((await rfs.githubContext(remoteRoot(HOST, `${posixPath(home)}`))).ok).toBe(false)
  }, 30000)
})
