// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createGithubService, tailRunner, cleanUntrusted } from '../githubService'

let cwd
const repo = {
  nameWithOwner: 'owner/project',
  defaultBranchRef: { name: 'main' },
  url: 'https://github.com/owner/project'
}
const sha = 'a'.repeat(40)
const issue = (number = 1, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `${repo.url}/issues/${number}`,
  state: 'OPEN',
  author: { login: 'octo' },
  labels: [{ name: 'bug', color: 'abcdef' }],
  ...extra
})
const pr = (number = 1, extra = {}) => ({
  ...issue(number),
  url: `${repo.url}/pull/${number}`,
  headRefOid: sha,
  headRefName: 'feature/example',
  baseRefName: 'main',
  ...extra
})
const response = (value, code = 0) => ({ code, stdout: JSON.stringify(value), stderr: '' })
const check = (extra = {}) => ({
  name: 'CI',
  bucket: 'pass',
  state: 'SUCCESS',
  link: `${repo.url}/actions/runs/123/job/456`,
  ...extra
})
function fixture(handle = () => response([]), options = {}) {
  const calls = []
  const runner = vi.fn(async (file, args, execOptions) => {
    calls.push({ file, args, options: execOptions })
    if (args[0] === 'repo') return response(repo)
    return handle(file, args, execOptions)
  })
  return {
    service: createGithubService({
      runner,
      ghPath: 'gh',
      gitPath: 'git',
      env: {},
      tempDir: cwd,
      ...options
    }),
    calls,
    runner
  }
}
beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-github-service-'))
})
afterAll(async () => {
  // Only the fresh fixture owned by this file; service body folders must already
  // be empty/removed (checked below), so cleanup never traverses directories.
  await fs.rmdir(cwd)
})

describe('GitHub service read contracts', () => {
  it('reports install/auth/repository status without returning credential output', async () => {
    const { service, calls } = fixture((_file, args) => ({
      code: 0,
      stdout: args[0] === 'auth' ? 'masked token fixture-secret' : 'gh version fixture'
    }))
    expect(await service.status({ cwd })).toEqual({
      ok: true,
      available: true,
      authenticated: true,
      repo: { nameWithOwner: repo.nameWithOwner, url: repo.url, defaultBranch: 'main' }
    })
    expect(calls.at(-1).args).toEqual(['auth', 'status', '--active', '--hostname', 'github.com'])
    expect(JSON.stringify(await service.status({ cwd }))).not.toContain('fixture-secret')
  })
  it('distinguishes a missing executable from unauthenticated gh', async () => {
    const missing = fixture(() => ({ code: 'ENOENT', stderr: 'secret' }))
    expect(await missing.service.status({ cwd })).toEqual({
      ok: true,
      available: false,
      authenticated: false
    })
    const signedOut = fixture((_file, args) => ({ code: args[0] === 'auth' ? 1 : 0, stdout: '' }))
    expect(await signedOut.service.status({ cwd })).toMatchObject({
      ok: true,
      available: true,
      authenticated: false
    })
  })
  it('lists only current-repository open items and bounds results', async () => {
    const { service, calls } = fixture(() =>
      response(Array.from({ length: 101 }, (_, i) => issue(i + 1)))
    )
    const result = await service.list({ cwd, kind: 'issues', preset: 'mine', query: 'label:bug' })
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.items).toHaveLength(100)
    expect(result.items[0]).toMatchObject({
      kind: 'issues',
      author: { login: 'octo' },
      labels: [{ name: 'bug', color: 'abcdef' }]
    })
    expect(calls.at(-1).args).toEqual([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '101',
      '--json',
      expect.any(String),
      '--assignee',
      '@me',
      '--search',
      'label:bug',
      '--repo',
      'github.com/owner/project'
    ])
  })
  it('uses author and requested-review filters for PR presets', async () => {
    const { service, calls } = fixture(() => response([pr()]))
    expect((await service.list({ cwd, kind: 'prs', preset: 'mine' })).ok).toBe(true)
    expect(calls.at(-1).args).toContain('--author')
    expect(
      (await service.list({ cwd, kind: 'prs', preset: 'review', query: 'draft:false' })).ok
    ).toBe(true)
    expect(calls.at(-1).args).toContain('draft:false review-requested:@me')
  })
  it.each([0, 1, 8])('accepts JSON check results with exit %s', async (code) => {
    const { service } = fixture(() =>
      response([check({ state: 'PENDING', bucket: 'pending' })], code)
    )
    expect(await service.checks({ cwd, number: 1 })).toMatchObject({
      ok: true,
      checks: [
        { state: 'PENDING', bucket: 'pending', url: expect.stringContaining('/actions/runs/123') }
      ]
    })
  })
  it('does not treat an auth error with check exit 1 as an empty success', async () => {
    const { service } = fixture(() => ({
      code: 1,
      stdout: '',
      stderr: 'ghp_fixture_private_token'
    }))
    const result = await service.checks({ cwd, number: 1 })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('ghp_fixture')
  })
  it('returns a bounded PR detail with comments/files and explicit unavailable checks', async () => {
    const { service } = fixture((_file, args) =>
      args[1] === 'checks'
        ? { code: 1, stderr: 'fixture secret' }
        : response(
            pr(1, {
              body: 'Description',
              comments: [
                {
                  body: 'Comment',
                  author: { login: 'reviewer' },
                  createdAt: '2026-09-28',
                  privateField: 'hidden'
                }
              ],
              files: [{ path: 'src/app.js', additions: 2, deletions: 1, privateField: 'hidden' }]
            })
          )
    )
    const result = await service.detail({ cwd, kind: 'prs', number: 1 })
    expect(result).toMatchObject({
      ok: true,
      item: {
        body: 'Description',
        comments: [{ author: { login: 'reviewer' }, body: 'Comment' }],
        files: [{ path: 'src/app.js', additions: 2, deletions: 1 }],
        checks: [],
        checksError: expect.any(String)
      }
    })
    expect(JSON.stringify(result)).not.toContain('privateField')
    expect(JSON.stringify(result)).not.toContain('fixture secret')
  })
  it('all read methods remain reads, including failed reads', async () => {
    const { service, calls } = fixture((_file, args) => {
      if (args[1] === 'list') return response([issue()])
      if (args[1] === 'view') return response(issue())
      if (args[1] === 'checks') return response([])
      return { code: 0, stdout: '' }
    })
    await service.status({ cwd })
    await service.list({ cwd, kind: 'issues' })
    await service.detail({ cwd, kind: 'issues', number: 1 })
    await service.checks({ cwd, number: 1 })
    expect(
      calls.every(
        ({ file, args }) =>
          file === 'gh' && ['--version', 'repo', 'auth', 'issue', 'pr'].includes(args[0])
      )
    ).toBe(true)
    expect(
      calls.some(({ args }) =>
        args.some((v) =>
          [
            'create',
            'comment',
            'close',
            'reopen',
            'merge',
            'rerun',
            'fetch',
            'push',
            'checkout'
          ].includes(v)
        )
      )
    ).toBe(false)
  })
  it.each([
    [{}, 'list'],
    [{ kind: '--repo' }, 'list'],
    [{ kind: 'issues', preset: 'review' }, 'list'],
    [{ kind: 'prs', query: 'repo:other/repo' }, 'list'],
    [{ kind: 'issues', query: '"ORG:other"' }, 'list'],
    [{ kind: 'prs', number: '--admin' }, 'detail'],
    [{ number: 0 }, 'checks'],
    [{ number: Number.MAX_SAFE_INTEGER + 1 }, 'startPoint'],
    [{ title: '', body: '' }, 'createIssue'],
    [{ title: 'PR', base: '-main', head: 'feature' }, 'createPr'],
    [{ title: 'PR', base: 'main', head: 'a..b' }, 'createPr'],
    [{ title: 'PR', base: 'main', head: 'refs/x.lock' }, 'createPr'],
    [{ title: 'PR', base: 'main', head: 'okay', draft: '--admin' }, 'createPr'],
    [{ kind: 'issues', number: 1, action: 'merge' }, 'action'],
    [{ kind: 'prs', number: 1, action: 'merge', method: '--admin' }, 'action'],
    [{ kind: 'issues', number: 1, action: 'close', reason: '--delete-branch' }, 'action'],
    [{ kind: 'issues', number: 1, action: 'comment', body: '' }, 'action'],
    [{ kind: 'prs', number: 1, action: 'delete' }, 'action']
  ])('rejects invalid input before executing any command (%j / %s)', async (input, method) => {
    const { service, runner } = fixture()
    expect(await service[method]({ cwd, ...input })).toMatchObject({
      ok: false,
      code: 'validation'
    })
    expect(runner).not.toHaveBeenCalled()
  })
  it('rejects a relative cwd and an item from a different repo', async () => {
    const { service, runner } = fixture(() =>
      response([issue(1, { url: 'https://github.com/other/repo/issues/1' })])
    )
    expect(await service.list({ cwd: '.', kind: 'issues' })).toMatchObject({
      ok: false,
      code: 'validation'
    })
    expect(runner).not.toHaveBeenCalled()
    expect(await service.list({ cwd, kind: 'issues' })).toMatchObject({
      ok: false,
      code: 'repository'
    })
  })
})

describe('explicit GitHub writes', () => {
  it('writes literal UTF-8 bodies to a private temporary file and cleans it', async () => {
    const body = 'Bonjour é 👋\n`literal` $(not-a-command)\nsecond line'
    let bodyPath
    const { service, calls } = fixture(async (_file, args) => {
      bodyPath = args[args.indexOf('--body-file') + 1]
      expect(await fs.readFile(bodyPath, 'utf8')).toBe(body)
      expect(args).not.toContain(body)
      return { code: 0, stdout: `${repo.url}/issues/9\n` }
    })
    expect(await service.createIssue({ cwd, title: '--literal title', body })).toEqual({
      ok: true,
      url: `${repo.url}/issues/9`
    })
    expect(calls.at(-1).options).toMatchObject({
      cwd,
      shell: false,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 4194304
    })
    await expect(fs.stat(bodyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(cwd)).toEqual([])
  })
  it('cleans the body file on failure without exposing CLI errors', async () => {
    let bodyPath
    const { service } = fixture((_file, args) => {
      bodyPath = args[args.indexOf('--body-file') + 1]
      throw Object.assign(new Error('ghp_fixture_token'), {
        code: 1,
        stderr: 'Bearer fixture_secret'
      })
    })
    const result = await service.action({
      cwd,
      kind: 'issues',
      number: 1,
      action: 'comment',
      body: 'Hello\nWorld'
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/fixture_token|fixture_secret|Bearer/)
    await expect(fs.stat(bodyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(cwd)).toEqual([])
  })
  it('uses the worktree cwd and always sets --head, without pushing', async () => {
    const { service, calls } = fixture((file) =>
      file === 'git'
        ? { code: 0, stdout: 'task/my-work\n' }
        : { code: 0, stdout: `${repo.url}/pull/12\n` }
    )
    expect(
      await service.createPr({ cwd, title: 'Feature', body: 'Done', base: 'main', draft: true })
    ).toEqual({ ok: true, url: `${repo.url}/pull/12` })
    expect(calls.find((v) => v.file === 'git').args).toEqual([
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD'
    ])
    expect(calls.at(-1).args).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'task/my-work',
      '--title',
      'Feature',
      '--draft',
      '--body-file',
      expect.any(String),
      '--repo',
      'github.com/owner/project'
    ])
    expect(calls.every((v) => v.options.cwd === cwd)).toBe(true)
    expect(calls.flatMap((v) => v.args)).not.toContain('push')
  })
  it('honors explicit fork head and rejects identical base/head', async () => {
    const { service, calls } = fixture(() => ({ code: 0, stdout: `${repo.url}/pull/3` }))
    expect(
      (await service.createPr({ cwd, title: 'Feature', base: 'main', head: 'contributor:feature' }))
        .ok
    ).toBe(true)
    expect(calls.some((v) => v.file === 'git')).toBe(false)
    const before = calls.length
    expect(
      await service.createPr({ cwd, title: 'Feature', base: 'main', head: 'main' })
    ).toMatchObject({ ok: false, code: 'validation' })
    expect(calls.slice(before).some((v) => v.args[1] === 'create')).toBe(false)
  })
  it('does not encourage duplicate creation after uncertain CLI completion', async () => {
    const { service } = fixture(() => ({ code: 0, stdout: 'Created successfully' }))
    expect(await service.createIssue({ cwd, title: 'Once' })).toMatchObject({
      ok: false,
      code: 'unknown_completion',
      error: expect.stringContaining('Refresh before retrying')
    })
  })
  it.each(['close', 'reopen'])(
    'performs only explicit %s without deleting branches',
    async (action) => {
      const { service, calls } = fixture(() => ({ code: 0 }))
      expect(await service.action({ cwd, kind: 'prs', number: 7, action })).toEqual({ ok: true })
      expect(calls.at(-1).args).toEqual(['pr', action, '7', '--repo', 'github.com/owner/project'])
    }
  )
  it('passes an allowlisted issue closing reason', async () => {
    const { service, calls } = fixture(() => ({ code: 0 }))
    await service.action({ cwd, kind: 'issues', number: 7, action: 'close', reason: 'not planned' })
    expect(calls.at(-1).args).toContain('not planned')
  })
  it.each(['merge', 'autoMerge'])('pins %s to the observed PR head', async (action) => {
    const { service, calls } = fixture((_file, args) =>
      args[1] === 'view' ? response(pr(7)) : { code: 0 }
    )
    expect(await service.action({ cwd, kind: 'prs', number: 7, action, method: 'rebase' })).toEqual(
      { ok: true }
    )
    expect(calls.at(-1).args).toEqual([
      'pr',
      'merge',
      '7',
      '--rebase',
      '--match-head-commit',
      sha,
      ...(action === 'autoMerge' ? ['--auto'] : []),
      '--repo',
      'github.com/owner/project'
    ])
  })
  it('reruns deduplicated failed PR check runs from this repo only', async () => {
    const { service, calls } = fixture((_file, args) =>
      args[1] === 'checks'
        ? response(
            [
              check({ bucket: 'fail' }),
              check({ bucket: 'fail' }),
              check({ bucket: 'fail', link: `${repo.url}/actions/runs/234/job/5` }),
              check({ bucket: 'pass', link: `${repo.url}/actions/runs/345/job/5` }),
              check({
                bucket: 'fail',
                link: 'https://github.com/other/repo/actions/runs/999/job/5'
              }),
              check({ bucket: 'fail', link: 'https://external.example/status/555' })
            ],
            1
          )
        : { code: 0 }
    )
    expect(await service.action({ cwd, kind: 'prs', number: 7, action: 'rerunFailed' })).toEqual({
      ok: true,
      completed: 2
    })
    expect(calls.filter((v) => v.args[0] === 'run').map((v) => v.args)).toEqual([
      ['run', 'rerun', '123', '--failed', '--repo', 'github.com/owner/project'],
      ['run', 'rerun', '234', '--failed', '--repo', 'github.com/owner/project']
    ])
  })
  it('reports partial rerun success and refuses unresolvable external checks', async () => {
    const { service } = fixture((_file, args) =>
      args[1] === 'checks'
        ? response([check(), check({ link: `${repo.url}/actions/runs/234` })])
        : { code: args[2] === '234' ? 1 : 0 }
    )
    expect(await service.action({ cwd, kind: 'prs', number: 1, action: 'rerunAll' })).toMatchObject(
      { ok: false, code: 'partial', completed: 1 }
    )
    const external = fixture(() =>
      response([check({ link: 'https://external.example/builds/123' })])
    )
    expect(
      await external.service.action({ cwd, kind: 'prs', number: 1, action: 'rerunAll' })
    ).toMatchObject({ ok: false, code: 'no_runs' })
    expect(external.calls.some((v) => v.args[0] === 'run')).toBe(false)
  })
})

describe('PR worktree start point', () => {
  it('fetches a PR ref and returns the pinned commit without changing checkout', async () => {
    const { service, calls } = fixture((file, args) =>
      file === 'gh'
        ? response(pr(12))
        : { code: 0, stdout: args[0] === 'rev-parse' ? `${sha}\n` : '' }
    )
    expect(await service.startPoint({ cwd, number: 12 })).toMatchObject({
      ok: true,
      baseBranch: sha,
      headSha: sha,
      headRefName: 'feature/example',
      baseRefName: 'main'
    })
    const fetch = calls.find((v) => v.args.includes('fetch'))
    expect(fetch.args.slice(-3)).toEqual([
      '--',
      `${repo.url}.git`,
      '+refs/pull/12/head:refs/tessel/pr/12'
    ])
    expect(fetch.args).toEqual(
      expect.arrayContaining(['--no-write-fetch-head', '--no-tags', '--no-recurse-submodules'])
    )
    expect(calls.flatMap((v) => v.args)).not.toEqual(
      expect.arrayContaining(['checkout', 'push', 'pull'])
    )
  })
  it('refuses a PR head changed during fetch and malformed head identities', async () => {
    const raced = fixture((file) =>
      file === 'gh' ? response(pr()) : { code: 0, stdout: 'b'.repeat(40) }
    )
    expect(await raced.service.startPoint({ cwd, number: 1 })).toMatchObject({
      ok: false,
      code: 'changed'
    })
    const invalid = fixture(() => response(pr(1, { headRefOid: '--upload-pack=bad' })))
    expect(await invalid.service.startPoint({ cwd, number: 1 })).toMatchObject({
      ok: false,
      code: 'response'
    })
    expect(invalid.calls.some((v) => v.file === 'git')).toBe(false)
  })
  it.each([
    'git@github.com:owner/project.git',
    'ssh://git@github.com:443/owner/project.git',
    'https://github.com/owner/project.git'
  ])('preserves a matching remote transport: %s', async (remoteUrl) => {
    const { service, calls } = fixture((file, args) =>
      file === 'gh'
        ? response(pr())
        : {
            code: 0,
            stdout:
              args[0] === 'remote'
                ? `origin\t${remoteUrl} (fetch)\n`
                : args[0] === 'rev-parse'
                  ? sha
                  : ''
          }
    )
    expect((await service.startPoint({ cwd, number: 1 })).ok).toBe(true)
    expect(calls.find((v) => v.args.includes('fetch')).args.slice(-2)).toEqual([
      remoteUrl,
      '+refs/pull/1/head:refs/tessel/pr/1'
    ])
  })
  it('never fetches from unrelated, executable, or credential-bearing remotes', async () => {
    const remotes =
      'a\text::danger (fetch)\nb\tgit@github.com:other/repo.git (fetch)\nc\thttps://token:secret@github.com/owner/project.git (fetch)\nd\tfile:///tmp/repo (fetch)\n'
    const { service, calls } = fixture((file, args) =>
      file === 'gh'
        ? response(pr())
        : { code: 0, stdout: args[0] === 'remote' ? remotes : args[0] === 'rev-parse' ? sha : '' }
    )
    expect((await service.startPoint({ cwd, number: 1 })).ok).toBe(true)
    const fetch = calls.find((v) => v.args.includes('fetch'))
    expect(fetch.args.slice(-2)).toEqual([`${repo.url}.git`, '+refs/pull/1/head:refs/tessel/pr/1'])
    expect(fetch.args).toContain('protocol.allow=never')
  })
})

describe('process safety', () => {
  it('limits all CLI children to four simultaneous commands', async () => {
    let active = 0
    let maxActive = 0
    const service = createGithubService({
      env: {},
      runner: async (_file, args) => {
        active++
        maxActive = Math.max(active, maxActive)
        await new Promise((resolve) => setTimeout(resolve, 3))
        active--
        return response(args[0] === 'repo' ? repo : [issue()])
      }
    })
    const results = await Promise.all(
      Array.from({ length: 15 }, () => service.list({ cwd, kind: 'issues' }))
    )
    expect(results.every((v) => v.ok)).toBe(true)
    expect(maxActive).toBe(4)
  })
  it('scrubs inherited repository/debug overrides but retains internal authentication', async () => {
    const { service, calls } = fixture(() => response([]), {
      env: {
        GH_REPO: 'bad/repo',
        GIT_DIR: 'elsewhere',
        GIT_WORK_TREE: 'elsewhere',
        GIT_CONFIG_COUNT: '1',
        GH_DEBUG: 'api',
        DEBUG: '1',
        GH_TOKEN: 'fixture-secret'
      }
    })
    await service.list({ cwd, kind: 'issues' })
    const environment = calls.at(-1).options.env
    expect(environment.GH_REPO).toBeUndefined()
    expect(environment.GIT_DIR).toBeUndefined()
    expect(environment.GIT_WORK_TREE).toBeUndefined()
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined()
    expect(environment.GH_DEBUG).toBeUndefined()
    expect(environment.DEBUG).toBeUndefined()
    expect(environment.GH_TOKEN).toBe('fixture-secret')
    expect(environment.GH_PROMPT_DISABLED).toBe('1')
  })
  it('sanitizes timeouts and oversized output, including write uncertainty', async () => {
    const timed = fixture(() => ({ code: 1, killed: true, stderr: 'fixture secret' }))
    expect(await timed.service.createIssue({ cwd, title: 'Once' })).toMatchObject({
      ok: false,
      code: 'timeout',
      error: expect.stringContaining('may have completed')
    })
    const huge = fixture(() => ({ code: 0, stdout: 'x'.repeat(4194305) }))
    expect(await huge.service.list({ cwd, kind: 'issues' })).toMatchObject({
      ok: false,
      code: 'output_limit'
    })
    expect(await fs.readdir(cwd)).toEqual([])
  })
  it('finds the native Windows gh executable after tool directory augmentation', async () => {
    const install = path.join(cwd, 'GitHub CLI')
    const native = path.join(install, 'gh.exe')
    await fs.mkdir(install)
    await fs.writeFile(native, 'fixture only, never executed')
    try {
      const { service, calls } = fixture(() => ({ code: 0 }), {
        platform: 'win32',
        ghPath: undefined,
        env: { ProgramFiles: cwd }
      })
      expect((await service.status({ cwd })).available).toBe(true)
      expect(calls.every((v) => v.file === native)).toBe(true)
      expect(calls[0].options.env.PATH).toContain(install)
    } finally {
      await fs.unlink(native)
      await fs.rmdir(install)
    }
  })
})

describe('GitHub reads for agent prompts', () => {
  const thread = (extra = {}) => ({
    id: 'T1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.js',
    line: 12,
    startLine: null,
    comments: {
      totalCount: 1,
      nodes: [{ author: { login: 'rev' }, body: 'Rename this', url: `${repo.url}/pull/1#r1` }]
    },
    ...extra
  })
  const threadsResponse = (nodes, hasNextPage = false) =>
    response({
      data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage }, nodes } } } }
    })

  it('reads the failed log tail of each failing Actions check with argument arrays only', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `\x1b[31mline ${i}\x1b[0m\r`).join('\n')
    const { service, calls } = fixture((_file, args) => {
      if (args[1] === 'checks')
        return response([
          check({ name: 'unit', bucket: 'fail', state: 'FAILURE' }),
          check({ name: 'lint', bucket: 'pass' }),
          check({ name: 'external', bucket: 'fail', link: 'https://ci.example.com/1' }),
          check({ name: 'cancelled', bucket: 'cancel', link: `${repo.url}/actions/runs/124/job/457` })
        ])
      if (args[0] === 'run') return { code: 0, stdout: args.includes('456') ? big : 'short failure' }
      return response([])
    })
    const result = await service.failingLogs({ cwd, number: 1 })
    expect(result.ok).toBe(true)
    expect(result.checks.map((c) => [c.name, c.logStatus])).toEqual([
      ['unit', 'ok'],
      ['external', 'none'],
      ['cancelled', 'ok']
    ])
    const unit = result.checks[0]
    expect(Buffer.byteLength(unit.logTail)).toBeLessThanOrEqual(12 * 1024)
    expect(unit.logTruncated).toBe(true)
    expect(unit.logTail).toContain('line 3999')
    expect(unit.logTail.startsWith('line ')).toBe(true)
    expect(unit.logTail).not.toMatch(/[\x1b\r]/)
    const runCalls = calls.filter((c) => c.args[0] === 'run')
    expect(runCalls.map((c) => c.args)).toEqual([
      ['run', 'view', '123', '--job', '456', '--log-failed', '--repo', 'github.com/owner/project'],
      ['run', 'view', '124', '--job', '457', '--log-failed', '--repo', 'github.com/owner/project']
    ])
    expect(runCalls.every((c) => c.options.shell === false && c.options.tailBytes > 0)).toBe(true)
  })

  it('caps the number of logs read and the total log size', async () => {
    const checks = Array.from({ length: 12 }, (_, i) =>
      check({ name: `job${i}`, bucket: 'fail', link: `${repo.url}/actions/runs/9${i}/job/8${i}` })
    )
    const { service, calls } = fixture((_file, args) => {
      if (args[1] === 'checks') return response(checks)
      if (args[0] === 'run') return { code: 0, stdout: 'y'.repeat(30000) }
      return response([])
    })
    const result = await service.failingLogs({ cwd, number: 1 })
    expect(calls.filter((c) => c.args[0] === 'run').length).toBeLessThanOrEqual(8)
    const total = result.checks.reduce((sum, c) => sum + Buffer.byteLength(c.logTail), 0)
    expect(total).toBeLessThanOrEqual(48 * 1024)
    expect(result.checks).toHaveLength(12)
    expect(result.checks.some((c) => c.logStatus === 'skipped')).toBe(true)
  })

  it('keeps a failing check when its log cannot be read', async () => {
    const { service } = fixture((_file, args) => {
      if (args[1] === 'checks') return response([check({ bucket: 'fail' })])
      if (args[0] === 'run') return { code: 1, stderr: 'secret' }
      return response([])
    })
    const result = await service.failingLogs({ cwd, number: 1 })
    expect(result).toMatchObject({
      ok: true,
      checks: [{ name: 'CI', logStatus: 'unavailable', logTail: '' }]
    })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('reads only unresolved review threads through gh api graphql with variables', async () => {
    const { service, calls } = fixture((_file, args) =>
      args[0] === 'api'
        ? threadsResponse([
            thread(),
            thread({ id: 'T2', isResolved: true }),
            thread({ id: 'T3', line: null, originalLine: 7, isOutdated: true, path: 'a‮b.js' })
          ])
        : response([])
    )
    const result = await service.reviewThreads({ cwd, number: 1 })
    expect(result.ok).toBe(true)
    expect(result.threads.map((t) => [t.id, t.path, t.line, t.isOutdated])).toEqual([
      ['T1', 'src/app.js', 12, false],
      ['T3', 'ab.js', 7, true]
    ])
    expect(result.threads[0].comments).toEqual([
      expect.objectContaining({ author: 'rev', body: 'Rename this' })
    ])
    const api = calls.find((c) => c.args[0] === 'api')
    expect(api.args.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com'])
    expect(api.args).toContain('owner=owner')
    expect(api.args).toContain('name=project')
    expect(api.args).toContain('number=1')
    expect(api.args.find((a) => a.startsWith('query='))).toContain('reviewThreads')
    expect(api.options.shell).toBe(false)
  })

  it('caps comment bodies, comments and threads', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      thread({
        id: `T${i}`,
        comments: {
          totalCount: 12,
          nodes: Array.from({ length: 12 }, () => ({ author: { login: 'r' }, body: 'z'.repeat(4500) }))
        }
      })
    )
    const { service } = fixture((_file, args) =>
      args[0] === 'api' ? threadsResponse(many, true) : response([])
    )
    const result = await service.reviewThreads({ cwd, number: 1 })
    expect(result.threads.length).toBe(50)
    expect(result.truncated).toBe(true)
    const bodies = result.threads.flatMap((t) => t.comments.map((c) => c.body))
    expect(bodies.every((b) => b.length <= 4000)).toBe(true)
    expect(bodies.join('').length).toBeLessThanOrEqual(48 * 1024)
    expect(result.threads.every((t) => t.comments.length <= 10)).toBe(true)
  })

  it('adds unresolved threads to a PR detail, and an error when they cannot be read', async () => {
    const ok = fixture((_file, args) =>
      args[0] === 'api'
        ? threadsResponse([thread()])
        : args[1] === 'checks'
          ? response([])
          : response(pr(1))
    )
    const detail = await ok.service.detail({ cwd, kind: 'prs', number: 1 })
    expect(detail.item.reviewThreads).toHaveLength(1)
    const bad = fixture((_file, args) =>
      args[0] === 'api'
        ? { code: 1, stderr: 'x' }
        : args[1] === 'checks'
          ? response([])
          : response(pr(1))
    )
    const failed = await bad.service.detail({ cwd, kind: 'prs', number: 1 })
    expect(failed.ok).toBe(true)
    expect(failed.item.reviewThreads).toEqual([])
    expect(failed.item.reviewThreadsError).toEqual(expect.any(String))
  })

  it('keeps only the tail of a large real child output, and cleans escapes', async () => {
    const result = await tailRunner(
      process.execPath,
      ['-e', 'for (let i = 0; i < 20000; i++) process.stdout.write("row " + i + "\\n")'],
      { cwd, env: process.env, timeout: 20000, tailBytes: 1000 }
    )
    expect(result.code).toBe(0)
    expect(result.tailed).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1000)
    expect(result.stdout).toContain('row 19999')
    expect(cleanUntrusted('a\x1b]8;;http://x\x07b\x1b[1mc\u0000d\r\ne⁦f')).toBe('abcd\nef')
  })

  it('rejects invalid numbers before running gh', async () => {
    const { service, runner } = fixture()
    expect((await service.failingLogs({ cwd, number: '--x' })).ok).toBe(false)
    expect((await service.reviewThreads({ cwd, number: 0 })).ok).toBe(false)
    expect(runner).not.toHaveBeenCalled()
  })
})
