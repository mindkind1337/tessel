// The sidebar's branch and worktrees of a project on an SSH host
// (remoteFs.js gitWorktrees, remoteShell.js __t_wtl): parsing of the host's
// answer from fixtures, and a fake host (fake-ssh.cjs: Git for Windows' sh on
// a temporary folder). Nothing connects anywhere.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRemoteFs, parseRemoteWorktrees, WORKTREES_OUTPUT } from '../remoteFs'
import { FUNCTIONS, prelude } from '../remoteShell'
import { remoteRoot } from '../../shared/remotePath'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

const HOST = 'ssh-test1'
const SHA1 = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)
const SHA3 = 'c'.repeat(40)

function header({ root = '/srv/app', top = '/srv/app', branch = 'main', head = SHA1 } = {}) {
  return `tessel-wtl 1\nroot ${root}\ntop ${top}\nbranch ${branch}\nhead ${head}\n\n`
}
const PORCELAIN = [
  `worktree /srv/app\nHEAD ${SHA1}\nbranch refs/heads/main\n`,
  `worktree /srv/app-feature\nHEAD ${SHA2}\nbranch refs/heads/feature/login\nlocked reason here\n`,
  `worktree /srv/app-detached\nHEAD ${SHA3}\ndetached\n`,
  `worktree /srv/app-gone\nHEAD ${SHA3}\nbranch refs/heads/gone\nprunable gitdir file points to non-existent location\n`
].join('\n')

function stubHosts(events = []) {
  return {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
    get: () => ({ id: HOST, label: 'Box' }),
    // Signed in already (remoteFs.js opens no session nobody asked for).
    sharedConnected: () => true,
    paneStarted: (id) => events.push(['started', id]),
    paneConnected: (id) => events.push(['connected', id]),
    paneClosing: (id) => events.push(['closing', id]),
    paneExited: (id) => events.push(['exited', id])
  }
}

describe('parseRemoteWorktrees (fixtures)', () => {
  it('reads the header and the porcelain list: branch, main first, locked, prunable', () => {
    const res = parseRemoteWorktrees(Buffer.from(header() + PORCELAIN))
    expect(res).toMatchObject({ root: '/srv/app', top: '/srv/app', branch: 'main', head: SHA1 })
    expect(res.worktrees.map((w) => [w.path, w.branch, w.isMain, w.locked, w.prunable])).toEqual([
      ['/srv/app', 'main', true, false, false],
      ['/srv/app-feature', 'feature/login', false, true, false],
      ['/srv/app-detached', '', false, false, false],
      ['/srv/app-gone', 'gone', false, false, true]
    ])
  })

  it('a detached HEAD: no branch, its commit kept', () => {
    const res = parseRemoteWorktrees(header({ branch: '', head: SHA3 }) + `worktree /srv/app\nHEAD ${SHA3}\ndetached\n`)
    expect(res.branch).toBe('')
    expect(res.head).toBe(SHA3)
    expect(res.worktrees).toEqual([{ path: '/srv/app', branch: '', head: SHA3, isMain: true, locked: false, prunable: false }])
  })

  it('a repository with no commit yet: no head', () => {
    const res = parseRemoteWorktrees(header({ head: '' }) + 'worktree /srv/app\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/main\n')
    expect(res.head).toBe('')
    expect(res.branch).toBe('main')
  })

  it('anything without the header (not a repo, banner noise, garbage) is refused', () => {
    expect(parseRemoteWorktrees('')).toBe(null)
    expect(parseRemoteWorktrees('Welcome to the host\n' + header() + PORCELAIN)).toBe(null)
    expect(parseRemoteWorktrees('tessel-wtl 1\nroot relative\ntop /x\n\n')).toBe(null)
    expect(parseRemoteWorktrees('tessel-wtl 1\nroot /x\n\n')).toBe(null)
  })

  it('odd paths (control characters, backslash, relative) are left out', () => {
    const res = parseRemoteWorktrees(
      header() + `worktree /srv/app\nHEAD ${SHA1}\nbranch refs/heads/main\n\nworktree /srv/a\\b\nHEAD ${SHA2}\n\nworktree rel/x\nHEAD ${SHA2}\n\nworktree /srv/t\tab\nHEAD ${SHA2}\n`
    )
    expect(res.worktrees.map((w) => w.path)).toEqual(['/srv/app'])
  })

  it('a huge list cut at its cap: only whole worktrees, at most MAX_WORKTREES', () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => `worktree /srv/wt-${i}\nHEAD ${SHA2}\nbranch refs/heads/b${i}\n`).join('\n')
    const full = Buffer.from(header() + blocks)
    const cut = full.subarray(0, WORKTREES_OUTPUT)
    expect(full.length).toBeGreaterThan(WORKTREES_OUTPUT)
    const res = parseRemoteWorktrees(cut, { truncated: true })
    expect(res.worktrees.length).toBeLessThanOrEqual(200)
    expect(res.worktrees.length).toBeGreaterThan(0)
    expect(res.worktrees.every((w) => /^\/srv\/wt-\d+$/.test(w.path) && w.branch === `b${w.path.split('-').pop()}`)).toBe(true)
    // A cut in the middle of a path never becomes a worktree of its own.
    const small = parseRemoteWorktrees(Buffer.from(header() + 'worktree /srv/wt-1\nHEAD x\n\nworktree /srv/wt-2'), { truncated: true, max: 10 })
    expect(small.worktrees.map((w) => w.path)).toEqual(['/srv/wt-1'])
  })

  it('the host function is on the allow list and in the prelude, read-only and bounded', () => {
    expect(FUNCTIONS.has('__t_wtl')).toBe(true)
    const text = prelude('0'.repeat(32))
    const fn = text.slice(text.indexOf('__t_wtl() {'), text.indexOf('__t_dir() {'))
    expect(fn).toMatch(/__t_root "\$1"/)
    expect(fn).toMatch(/worktree list --porcelain/)
    expect(fn).toMatch(/core\.hooksPath=\/nonexistent-tessel-no-hooks/)
    // Nothing that writes.
    expect(fn).not.toMatch(/\b(rm|mv|add|prune|commit|checkout|reset)\b/)
  })
})

describe('gitWorktrees without a signed-in session', () => {
  it('never starts a session (no password question): a host not connected is "offline"', async () => {
    let spawned = 0
    const rfs = createRemoteFs({
      hosts: stubHosts(),
      spawnImpl: () => {
        spawned++
        throw new Error('no')
      }
    })
    rfs.setRoots([remoteRoot(HOST, '/srv/app')])
    expect(await rfs.gitWorktrees(remoteRoot(HOST, '/srv/app'))).toEqual({ ok: false, error: 'offline' })
    expect(spawned).toBe(0)
    rfs.close()
  })

  it('only a saved remote project folder; anything else is refused', async () => {
    const rfs = createRemoteFs({ hosts: stubHosts() })
    rfs.setRoots([remoteRoot(HOST, '/srv/app')])
    expect(await rfs.gitWorktrees(remoteRoot(HOST, '/srv/other'))).toEqual({ ok: false, error: 'unknown-folder' })
    expect(await rfs.gitWorktrees('C:\\repo')).toEqual({ ok: false, error: 'invalid' })
    expect(await rfs.gitWorktrees(null)).toEqual({ ok: false, error: 'invalid' })
    rfs.close()
  })
})

describe.skipIf(!gitSh())('gitWorktrees over a fake ssh (Git for Windows sh)', () => {
  let base
  let home
  let rfs
  const events = []
  const g = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' })
  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rwt-'))
    home = join(base, 'home')
    const app = join(home, 'app')
    fs.mkdirSync(app, { recursive: true })
    g(app, 'init', '-q', '-b', 'main')
    g(app, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'first')
    g(app, 'worktree', 'add', '-q', '-b', 'feature/x', join(home, 'app-x'))
    g(app, 'worktree', 'add', '-q', '--detach', join(home, 'app-detached'))
    // A hook that would leave a mark if it ever ran.
    fs.writeFileSync(join(app, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch "$HOME/hook-ran"\n', { mode: 0o755 })
    fs.mkdirSync(join(home, 'plain'))
    rfs = createRemoteFs({ hosts: stubHosts(events), spawnImpl: fakeSpawn({ home }) })
    rfs.setRoots([
      remoteRoot(HOST, `${posixPath(home)}/app`),
      remoteRoot(HOST, `${posixPath(home)}/app-detached`),
      remoteRoot(HOST, `${posixPath(home)}/plain`),
      remoteRoot(HOST, `${posixPath(home)}/missing`)
    ])
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('offline until the host is signed in, then its branch and worktrees', async () => {
    const root = remoteRoot(HOST, `${posixPath(home)}/app`)
    expect(await rfs.gitWorktrees(root)).toEqual({ ok: false, error: 'offline' })
    expect(events).toEqual([])
    expect(await rfs.connect(HOST)).toEqual({ ok: true })
    const res = await rfs.gitWorktrees(root)
    expect(res).toMatchObject({ ok: true, repo: true, branch: 'main' })
    expect(res.head).toMatch(/^[0-9a-f]{40}$/)
    const byPath = Object.fromEntries(res.worktrees.map((w) => [w.path.slice(root.length - 4), w]))
    expect(Object.keys(byPath).sort()).toEqual(['/app', '/app-detached', '/app-x'])
    expect(byPath['/app']).toMatchObject({ branch: 'main', isMain: true, self: true })
    expect(byPath['/app-x']).toMatchObject({ branch: 'feature/x', isMain: false })
    expect(byPath['/app-x'].self).toBeUndefined()
    expect(byPath['/app-detached']).toMatchObject({ branch: '', isMain: false })
    expect(res.worktrees.every((w) => w.path.startsWith(`ssh://${HOST}/`))).toBe(true)
    expect(fs.existsSync(join(home, 'hook-ran'))).toBe(false)
    // One sign-in only.
    expect(events.filter((e) => e[0] === 'started')).toHaveLength(1)
  }, 60000)

  it('a detached checkout: no branch, itself marked', async () => {
    const res = await rfs.gitWorktrees(remoteRoot(HOST, `${posixPath(home)}/app-detached`))
    expect(res).toMatchObject({ ok: true, repo: true, branch: '' })
    expect(res.worktrees.find((w) => w.self).path).toMatch(/\/app-detached$/)
  }, 30000)

  it('a folder that is not a repository, or is gone: no branch, no worktrees', async () => {
    expect(await rfs.gitWorktrees(remoteRoot(HOST, `${posixPath(home)}/plain`))).toEqual({ ok: true, repo: false, branch: '', head: '', worktrees: [] })
    expect(await rfs.gitWorktrees(remoteRoot(HOST, `${posixPath(home)}/missing`))).toEqual({ ok: true, repo: false, branch: '', head: '', worktrees: [] })
  }, 30000)

  it('after the session ends: offline again, never a new sign-in', async () => {
    rfs.closeHost(HOST)
    const started = events.filter((e) => e[0] === 'started').length
    expect(await rfs.gitWorktrees(remoteRoot(HOST, `${posixPath(home)}/app`))).toEqual({ ok: false, error: 'offline' })
    expect(events.filter((e) => e[0] === 'started')).toHaveLength(started)
  }, 30000)
})
