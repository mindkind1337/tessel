// Add a project, main side: the clone's URL checks and argv (no shell, "--"
// before the URL), progress, cancel and errors; Create new project (folder +
// git init + first commit); the nested repository scan (bounded, stoppable).
// Real git runs only on local fixtures in a throwaway folder: nothing is
// fetched from the network, the user's git config is not read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  validateCloneUrl,
  deriveCloneRepoName,
  deriveClonePath,
  cloneArgs,
  nonInteractiveGitEnv,
  stripCredentials,
  parseCloneProgress,
  cloneFailureMessage,
  isValidFolderName,
  defaultProjectsParent,
  createAddProject
} from '../addProject'
import { scanNestedRepos, normalizeScanOptions, parseGitignoreRules, isIgnoredDirectory } from '../nestedRepoScan'

let tmp
let gitEnv
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { windowsHide: true })
    return true
  } catch {
    return false
  }
})()

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-addproject-'))
  const home = join(tmp, 'home')
  fs.mkdirSync(home)
  // A throwaway HOME: git reads no user config; an identity for the commit.
  gitEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com'
  }
})
afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* a git process may still hold a file on Windows */
  }
})

describe('clone URL', () => {
  it('accepts https, ssh, git@host:path, file:// and a local repository path', () => {
    for (const url of [
      'https://github.com/user/repo.git',
      'http://intranet/repo.git',
      'ssh://git@github.com/user/repo.git',
      'git://example.org/repo',
      'git@github.com:user/repo.git',
      'deploy@[::1]:srv/repo.git',
      'file:///C:/fixtures/repo.git',
      'C:\\fixtures\\repo.git',
      '\\\\server\\share\\repo.git'
    ])
      expect(validateCloneUrl(url), url).toEqual({ url })
  })

  it('refuses anything git could read as an option or a command transport', () => {
    expect(validateCloneUrl('--upload-pack=calc.exe').error).toBe('url-option')
    expect(validateCloneUrl('-oProxyCommand=calc').error).toBe('url-option')
    expect(validateCloneUrl('ext::sh -c touch% /tmp/pwned').error).toBe('url-invalid')
    expect(validateCloneUrl('ext::calc').error).toBe('url-scheme')
    expect(validateCloneUrl('fd::17').error).toBe('url-scheme')
    expect(validateCloneUrl('ssh://-oProxyCommand=calc/x').error).toBe('url-invalid')
    expect(validateCloneUrl('-x@host:repo').error).toBe('url-option')
    expect(validateCloneUrl('git@-host:repo').error).toBe('url-invalid')
    expect(validateCloneUrl('ftp://host/repo').error).toBe('url-scheme')
    expect(validateCloneUrl('javascript://x').error).toBe('url-scheme')
    expect(validateCloneUrl('https://host/a b').error).toBe('url-invalid')
    expect(validateCloneUrl('https://host/a\nb').error).toBe('url-invalid')
    expect(validateCloneUrl('relative/repo').error).toBe('url-scheme')
    expect(validateCloneUrl('').error).toBe('url-required')
    expect(validateCloneUrl(undefined).error).toBe('url-required')
  })

  it('names the folder like git clone, refusing ".", ".." and names Windows cannot hold', () => {
    expect(deriveCloneRepoName('https://github.com/user/repo.git')).toBe('repo')
    expect(deriveCloneRepoName('git@github.com:user/tool.git')).toBe('tool')
    expect(deriveCloneRepoName('git@host:solo.git')).toBe('solo')
    expect(deriveCloneRepoName('C:\\fixtures\\bare.git')).toBe('bare')
    expect(deriveCloneRepoName('file:///C:/x/lib.git/')).toBe('lib')
    expect(deriveCloneRepoName('https://host/..')).toBe(null)
    expect(deriveCloneRepoName('https://host/con')).toBe(null)
    expect(isValidFolderName('a:b')).toBe(false)
    expect(isValidFolderName('ok-name')).toBe(true)
  })

  it('the clone lands inside the chosen parent folder', () => {
    expect(deriveClonePath({ url: 'https://h/r.git', destination: 'C:\\work' })).toEqual({ clonePath: 'C:\\work\\r', name: 'r' })
    expect(deriveClonePath({ url: 'https://h/r.git', destination: 'relative' }).error).toBe('destination-invalid')
    expect(deriveClonePath({ url: 'https://h/..', destination: 'C:\\work' }).error).toBe('name-invalid')
  })

  it('argv: no shell, "--" ends the options before the URL', () => {
    const args = cloneArgs('https://h/r.git', 'C:\\work\\r')
    expect(args.slice(-4)).toEqual(['--progress', '--', 'https://h/r.git', 'C:\\work\\r'])
    expect(args).toContain('protocol.ext.allow=never')
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('https://h/r.git'))
  })

  it('git never prompts; tokens never come back in messages', () => {
    const env = nonInteractiveGitEnv({ PATH: 'x' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
    expect(nonInteractiveGitEnv({ GIT_SSH_COMMAND: 'plink' }).GIT_SSH_COMMAND).toBe('plink')
    expect(stripCredentials("fatal: could not read from 'https://me:ghp_secret@github.com/x'")).toBe(
      "fatal: could not read from 'https://***@github.com/x'"
    )
  })

  it('progress lines, in any language', () => {
    expect(parseCloneProgress('Receiving objects:  45% (9/20)\rReceiving objects: 100% (20/20), done.\n')).toEqual([
      { phase: 'Receiving objects', percent: 45 },
      { phase: 'Receiving objects', percent: 100 }
    ])
    expect(parseCloneProgress("remote: Compressing objects:  10% (1/10)")).toEqual([{ phase: 'Compressing objects', percent: 10 }])
    expect(parseCloneProgress("Réception d'objets:  50% (1/2)")[0]).toEqual({ phase: "Réception d'objets", percent: 50 })
    expect(parseCloneProgress('Cloning into x...')).toEqual([])
  })

  it('the error is the fatal line; an existing folder gets advice', () => {
    expect(cloneFailureMessage("Cloning into 'x'...\nfatal: repository 'https://***@h/x' not found\n")).toBe(
      "fatal: repository 'https://***@h/x' not found"
    )
    expect(cloneFailureMessage("fatal: destination path 'x' already exists and is not an empty directory.", 'C:\\w\\x')).toMatch(
      /^Destination already exists and is not empty: C:\\w\\x\./
    )
  })
})

// A fake git process for the clone service.
function fakeSpawn(calls, script) {
  return (file, args, options) => {
    const proc = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = () => {
      proc.killed = true
      setTimeout(() => proc.emit('close', null, 'SIGTERM'), 5)
    }
    calls.push({ file, args, options, proc })
    setTimeout(() => script(proc, args), 5)
    return proc
  }
}

describe('clone service', () => {
  it('spawns git with the argv, reports progress, returns the new folder', async () => {
    const calls = []
    const sent = []
    const dest = join(tmp, 'dest-ok')
    const svc = createAddProject({
      spawnFn: fakeSpawn(calls, (proc, args) => {
        fs.writeFileSync(join(args[args.length - 1], 'README'), 'x')
        proc.stderr.emit('data', Buffer.from('Receiving objects:  50% (1/2)\r'))
        proc.emit('close', 0, null)
      }),
      send: (ch, p) => sent.push([ch, p]),
      home: tmp
    })
    const res = await svc.clone({ url: 'https://example.invalid/team/app.git', destination: dest })
    expect(res).toEqual({ ok: true, path: join(dest, 'app'), name: 'app' })
    expect(calls[0].file).toBe('git')
    expect(calls[0].options.shell).toBe(false)
    expect(calls[0].options.cwd).toBe(dest)
    expect(calls[0].args.slice(-3)).toEqual(['--', 'https://example.invalid/team/app.git', join(dest, 'app')])
    expect(calls[0].options.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(sent).toEqual([['addProject:cloneProgress', { phase: 'Receiving objects', percent: 50 }]])
  })

  it('refuses a bad URL without spawning anything', async () => {
    const calls = []
    const svc = createAddProject({ spawnFn: fakeSpawn(calls, () => {}), home: tmp })
    const res = await svc.clone({ url: '--upload-pack=calc', destination: join(tmp, 'never') })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('url-option')
    expect(calls).toEqual([])
    expect(fs.existsSync(join(tmp, 'never'))).toBe(false)
  })

  it('a failed clone removes only the folder it created, and says why', async () => {
    const calls = []
    const dest = join(tmp, 'dest-fail')
    const svc = createAddProject({
      spawnFn: fakeSpawn(calls, (proc) => {
        proc.stderr.emit('data', Buffer.from("fatal: repository 'https://u:tok@example.invalid/x' not found\n"))
        proc.emit('close', 128, null)
      }),
      home: tmp
    })
    const res = await svc.clone({ url: 'https://example.invalid/x.git', destination: dest })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("fatal: repository 'https://***@example.invalid/x' not found")
    expect(res.error).not.toContain('tok')
    expect(fs.existsSync(join(dest, 'x'))).toBe(false)
    expect(fs.existsSync(dest)).toBe(true)
  })

  it('keeps a folder that was already there', async () => {
    const dest = join(tmp, 'dest-keep')
    fs.mkdirSync(join(dest, 'keep'), { recursive: true })
    fs.writeFileSync(join(dest, 'keep', 'mine.txt'), 'mine')
    const svc = createAddProject({ spawnFn: fakeSpawn([], (proc) => proc.emit('close', 128, null)), home: tmp })
    const res = await svc.clone({ url: 'https://example.invalid/keep.git', destination: dest })
    expect(res.ok).toBe(false)
    expect(fs.readFileSync(join(dest, 'keep', 'mine.txt'), 'utf8')).toBe('mine')
  })

  it('cancel kills git, cleans up and says it was aborted; one clone at a time', async () => {
    const calls = []
    const dest = join(tmp, 'dest-abort')
    const svc = createAddProject({ spawnFn: fakeSpawn(calls, () => {}), home: tmp })
    const running = svc.clone({ url: 'https://example.invalid/slow.git', destination: dest })
    await new Promise((r) => setTimeout(r, 20))
    expect((await svc.clone({ url: 'https://example.invalid/b.git', destination: dest })).ok).toBe(false)
    expect(svc.cloneAbort()).toEqual({ ok: true, aborted: true })
    const res = await running
    expect(calls[0].proc.killed).toBe(true)
    expect(res).toMatchObject({ ok: false, aborted: true })
    expect(fs.existsSync(join(dest, 'slow'))).toBe(false)
    expect(svc.cloneAbort()).toEqual({ ok: true, aborted: false })
  })

  it.runIf(hasGit)('clones a local bare repository for real (no network)', async () => {
    const src = join(tmp, 'src-repo')
    fs.mkdirSync(src)
    execFileSync('git', ['init', '-q'], { cwd: src, env: gitEnv })
    fs.writeFileSync(join(src, 'hello.txt'), 'hi')
    execFileSync('git', ['add', '.'], { cwd: src, env: gitEnv })
    execFileSync('git', ['commit', '-q', '-m', 'one'], { cwd: src, env: gitEnv })
    const bare = join(tmp, 'fixture.git')
    execFileSync('git', ['clone', '-q', '--bare', src, bare], { env: gitEnv })
    const svc = createAddProject({ env: () => gitEnv, home: tmp })
    const res = await svc.clone({ url: bare, destination: join(tmp, 'cloned') })
    expect(res).toEqual({ ok: true, path: join(tmp, 'cloned', 'fixture'), name: 'fixture' })
    expect(fs.readFileSync(join(tmp, 'cloned', 'fixture', 'hello.txt'), 'utf8')).toBe('hi')
    // Again: the folder exists and is not empty.
    const again = await svc.clone({ url: bare, destination: join(tmp, 'cloned') })
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already exists and is not empty/)
    expect(fs.existsSync(join(tmp, 'cloned', 'fixture', 'hello.txt'))).toBe(true)
  })
})

describe('create new project', () => {
  it('checks the name and the parent folder', async () => {
    const svc = createAddProject({ env: () => gitEnv, home: tmp })
    expect((await svc.create({ name: '', parentPath: tmp })).ok).toBe(false)
    expect((await svc.create({ name: 'a/b', parentPath: tmp })).ok).toBe(false)
    expect((await svc.create({ name: '..', parentPath: tmp })).ok).toBe(false)
    expect((await svc.create({ name: 'a:b', parentPath: tmp })).ok).toBe(false)
    expect((await svc.create({ name: 'ok', parentPath: 'relative' })).ok).toBe(false)
    expect((await svc.create({ name: 'ok', parentPath: '' })).ok).toBe(false)
  })

  it.runIf(hasGit)('makes the folder, git init and an empty first commit', async () => {
    const svc = createAddProject({ env: () => gitEnv, home: tmp })
    const parent = join(tmp, 'projects')
    const res = await svc.create({ name: 'my-project', parentPath: parent })
    expect(res).toEqual({ ok: true, path: join(parent, 'my-project'), name: 'my-project' })
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: res.path, env: gitEnv, encoding: 'utf8' })
    expect(log.trim()).toBe('Initial commit')
    // Not empty now: refused, left alone.
    fs.writeFileSync(join(res.path, 'a.txt'), 'x')
    const again = await svc.create({ name: 'my-project', parentPath: parent })
    expect(again.ok).toBe(false)
    expect(again.error).toContain('my-project')
    expect(fs.existsSync(join(res.path, 'a.txt'))).toBe(true)
  })

  it.runIf(hasGit)('no git identity: the folder it made is removed, the advice given', async () => {
    const noId = { ...gitEnv }
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete noId[k]
    // No user.useConfigOnly fallback guessing: force the question.
    fs.writeFileSync(noId.GIT_CONFIG_GLOBAL, '[user]\n\tuseConfigOnly = true\n')
    try {
      const svc = createAddProject({ env: () => noId, home: tmp })
      const res = await svc.create({ name: 'no-id', parentPath: join(tmp, 'projects2') })
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/identity/i)
      expect(fs.existsSync(join(tmp, 'projects2', 'no-id'))).toBe(false)
    } finally {
      fs.rmSync(noId.GIT_CONFIG_GLOBAL, { force: true })
    }
  })

  it('the default parent is ~/tessel/projects', () => {
    expect(defaultProjectsParent('C:\\Users\\me')).toBe('C:\\Users\\me\\tessel\\projects')
  })
})

describe('nested repository scan', () => {
  let root
  const repo = (...parts) => fs.mkdirSync(join(root, ...parts, '.git'), { recursive: true })
  const dir = (...parts) => fs.mkdirSync(join(root, ...parts), { recursive: true })
  beforeAll(() => {
    root = join(tmp, 'scan-root')
    repo('alpha')
    repo('beta')
    repo('group', 'gamma')
    repo('group', 'gamma', 'inner') // nested in a repo: hidden
    repo('.nvm') // hidden, first level: looked into, found (as Orca)
    repo('tools', '.hidden-repo') // hidden below the first level: skipped
    repo('node_modules', 'dep') // skipped
    repo('deep', 'a', 'b', 'c', 'toodeep') // beyond 3 levels
    repo('ignored', 'secret')
    fs.writeFileSync(join(root, '.gitignore'), 'ignored/\n')
    dir('empty')
  })

  it('finds sibling repositories breadth-first, with Orca\'s skips and depth', async () => {
    const scan = await scanNestedRepos({ path: root })
    expect(scan.selectedPathKind).toBe('non_git_folder')
    const names = scan.repos.map((r) => r.displayName).sort()
    expect(names).toEqual(['.nvm', 'alpha', 'beta', 'gamma'])
    expect(scan.repos.find((r) => r.displayName === 'gamma').depth).toBe(2)
    expect(scan).toMatchObject({ truncated: false, timedOut: false, stopped: false, maxDepth: 3, maxRepos: 100, timeoutMs: 30000 })
  })

  it('a repository itself is not scanned', async () => {
    const scan = await scanNestedRepos({ path: join(root, 'alpha') })
    expect(scan.selectedPathKind).toBe('git_repo')
    expect(scan.repos).toEqual([])
  })

  it('stops at the repository limit and says the results are partial', async () => {
    const progress = []
    const scan = await scanNestedRepos({ path: root, options: { maxRepos: 2 }, onProgress: (s) => progress.push(s.repos.length) })
    expect(scan.repos.length).toBe(2)
    expect(scan.truncated).toBe(true)
    expect(progress).toEqual([1, 2])
  })

  it('stops when asked (partial results kept)', async () => {
    const controller = new AbortController()
    const scan = await scanNestedRepos({
      path: root,
      signal: controller.signal,
      onProgress: () => controller.abort()
    })
    expect(scan.stopped).toBe(true)
    expect(scan.repos.length).toBe(1)
  })

  it('stops at the time limit', async () => {
    let clock = 0
    const scan = await scanNestedRepos({ path: root, now: () => (clock += 400), options: { timeoutMs: 500 } })
    expect(scan.timedOut).toBe(true)
  })

  it('limits are clamped', () => {
    expect(normalizeScanOptions({ maxDepth: 99, maxRepos: 0, timeoutMs: 10 })).toEqual({ maxDepth: 8, maxRepos: 1, timeoutMs: 500 })
    expect(normalizeScanOptions(null)).toEqual({ maxDepth: 3, maxRepos: 100, timeoutMs: 30000 })
  })

  it('gitignore rules: globs, anchors, negation', () => {
    const rules = parseGitignoreRules('build*\n/top\n!buildkeep\n# c\nsub/**/x\n', [])
    expect(isIgnoredDirectory('build-out', ['build-out'], rules)).toBe(true)
    expect(isIgnoredDirectory('buildkeep', ['buildkeep'], rules)).toBe(false)
    expect(isIgnoredDirectory('top', ['top'], rules)).toBe(true)
    expect(isIgnoredDirectory('top', ['a', 'top'], rules)).toBe(false)
    expect(isIgnoredDirectory('x', ['sub', 'a', 'b', 'x'], rules)).toBe(true)
    expect(isIgnoredDirectory('keep', ['keep'], rules)).toBe(false)
  })

  it('the service: absolute folders only, progress sent with the scan id, stop', async () => {
    const sent = []
    const svc = createAddProject({ send: (ch, p) => sent.push([ch, p]), env: () => gitEnv, home: tmp })
    expect((await svc.scan({ path: 'relative' })).ok).toBe(false)
    expect((await svc.scan({ path: join(root, 'nope') })).ok).toBe(false)
    const res = await svc.scan({ path: root, scanId: 'scan-1' })
    expect(res.ok).toBe(true)
    expect(res.scan.repos.length).toBe(4)
    expect(sent.every(([ch, p]) => ch === 'addProject:scanProgress' && p.scanId === 'scan-1')).toBe(true)
    expect(sent.length).toBe(4)
    expect(svc.scanStop('scan-unknown')).toEqual({ ok: true, stopped: false })
  })
})
