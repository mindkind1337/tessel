// Add a project on an SSH host (remoteFs.js connect / browse / cloneProject /
// createProject). The host is a fake: fake-ssh.cjs runs Git for Windows' sh
// on a temporary folder; nothing connects anywhere.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRemoteFs, cleanBrowsePath, parseBrowse } from '../remoteFs'
import { FUNCTIONS } from '../remoteShell'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

const HOST = 'ssh-test1'
function stubHosts(events) {
  return {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
    get: () => ({ id: HOST, label: 'Box' }),
    // Signed in already (remoteFs.js opens no session nobody asked for).
    sharedConnected: () => true,
    paneStarted: (id, hostId, o) => events.push(['started', id, hostId, o]),
    paneConnected: (id) => events.push(['connected', id]),
    paneClosing: (id) => events.push(['closing', id]),
    paneExited: (id) => events.push(['exited', id])
  }
}

describe('Add a project on a host: helpers', () => {
  it('cleanBrowsePath takes ~, ~/..., absolute POSIX; refuses the rest', () => {
    expect(cleanBrowsePath('~')).toBe('~')
    expect(cleanBrowsePath('~/src/')).toBe('~/src')
    expect(cleanBrowsePath('//home//me/')).toBe('/home/me')
    expect(cleanBrowsePath('/')).toBe('/')
    expect(cleanBrowsePath('/srv/../etc')).toBe('/srv/../etc')
    for (const bad of ['', 'relative', 'C:\\x', '/a\\b', '/a\nb', '/a\u0000', 42, null, '/' + 'x'.repeat(5000)]) expect(cleanBrowsePath(bad)).toBe(null)
  })

  it('parseBrowse: real path first, folders first, odd names dropped, bounded', () => {
    const buf = Buffer.from(['/home/me', 'f b.txt', 'd src', 'L linked', 'l dangling', 'd .hidden', 'f bad\\name', 'f a\u0001b', 'x junk', ''].join('\0'))
    const res = parseBrowse(buf)
    expect(res.path).toBe('/home/me')
    expect(res.entries.map((e) => [e.name, e.dir, !!e.link])).toEqual([
      ['.hidden', true, false],
      ['linked', true, true],
      ['src', true, false],
      ['b.txt', false, false],
      ['dangling', false, true]
    ])
    expect(res.truncated).toBe(false)
    const many = Buffer.from(['/x', ...Array.from({ length: 12 }, (_, i) => `f n${i}`)].join('\0'))
    const cut = parseBrowse(many, 10)
    expect(cut.entries).toHaveLength(10)
    expect(cut.truncated).toBe(true)
  })

  it('the host functions are on the allow list', () => {
    for (const fn of ['__t_browse', '__t_clone', '__t_newproj']) expect(FUNCTIONS.has(fn)).toBe(true)
  })

  it('refuses bad input before anything reaches the host', async () => {
    let spawned = 0
    const rfs = createRemoteFs({
      hosts: stubHosts([]),
      spawnImpl: () => {
        spawned++
        throw new Error('no')
      }
    })
    expect((await rfs.browse({ hostId: HOST, path: 'relative/x' })).ok).toBe(false)
    expect((await rfs.browse({ hostId: HOST, path: '/a\nb' })).ok).toBe(false)
    expect((await rfs.browse({ hostId: 'bad id; rm', path: '~' })).ok).toBe(false)
    expect((await rfs.cloneProject({ hostId: HOST, url: '--upload-pack=touch /tmp/x', parent: '~' })).ok).toBe(false)
    expect((await rfs.cloneProject({ hostId: HOST, url: 'ext::sh -c touch% /tmp/x', parent: '~' })).ok).toBe(false)
    expect((await rfs.cloneProject({ hostId: HOST, url: 'C:\\repos\\app', parent: '~' })).ok).toBe(false)
    expect((await rfs.cloneProject({ hostId: HOST, url: 'https://example.com/a/b.git', parent: 'rel' })).ok).toBe(false)
    expect((await rfs.createProject({ hostId: HOST, parent: '~', name: '../up' })).ok).toBe(false)
    expect((await rfs.createProject({ hostId: HOST, parent: '~', name: 'a/b' })).ok).toBe(false)
    expect((await rfs.createProject({ hostId: HOST, parent: '~', name: '' })).ok).toBe(false)
    expect((await rfs.createProject({ hostId: HOST, parent: 'C:\\x', name: 'ok' })).ok).toBe(false)
    expect(spawned).toBe(0)
    rfs.close()
  })
})

describe.skipIf(!gitSh())('Add a project on a host over a fake ssh (Git for Windows sh)', () => {
  let base
  let home
  let rfs
  const events = []
  const oddName = "it's $(touch pwned) `touch pwned2`"
  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfb-'))
    home = join(base, 'home')
    fs.mkdirSync(join(home, 'projects', 'app'), { recursive: true })
    fs.mkdirSync(join(home, '.config'))
    fs.writeFileSync(join(home, 'notes.txt'), 'x')
    fs.writeFileSync(join(home, 'data.json'), '{}')
    // A name that would run something if it ever reached a shell unquoted.
    fs.mkdirSync(join(home, oddName))
    rfs = createRemoteFs({ hosts: stubHosts(events), spawnImpl: fakeSpawn({ home }) })
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('connects once, then lists the home folder (hidden entries included, folders first)', async () => {
    expect(await rfs.connect(HOST)).toEqual({ ok: true })
    expect(events.filter((e) => e[0] === 'started')).toHaveLength(1)
    const res = await rfs.browse({ hostId: HOST, path: '~' })
    expect(res.ok).toBe(true)
    expect(res.path).toBe(posixPath(home))
    expect(res.entries.map((e) => [e.name, e.dir])).toEqual([
      ['.config', true],
      [oddName, true],
      ['projects', true],
      ['data.json', false],
      ['notes.txt', false]
    ])
    // Same session: no second sign-in.
    expect(events.filter((e) => e[0] === 'started')).toHaveLength(1)
  }, 30000)

  it('goes into folders, the path quoted as data (a name with $(...) runs nothing)', async () => {
    const odd = await rfs.browse({ hostId: HOST, path: `${posixPath(home)}/${oddName}` })
    expect(odd.ok).toBe(true)
    expect(odd.entries).toEqual([])
    expect(fs.existsSync(join(home, 'pwned'))).toBe(false)
    expect(fs.existsSync(join(home, 'pwned2'))).toBe(false)
    const sub = await rfs.browse({ hostId: HOST, path: '~/projects' })
    expect(sub).toMatchObject({ ok: true, path: `${posixPath(home)}/projects`, entries: [{ name: 'app', dir: true }] })
    const up = await rfs.browse({ hostId: HOST, path: `${posixPath(home)}/projects/..` })
    expect(up.path).toBe(posixPath(home))
  }, 30000)

  it('a missing folder or a file is an error, not an empty list', async () => {
    const gone = await rfs.browse({ hostId: HOST, path: '~/nope' })
    expect(gone.ok).toBe(false)
    expect(gone.error).toMatch(/does not exist/)
    expect((await rfs.browse({ hostId: HOST, path: '~/notes.txt' })).ok).toBe(false)
  }, 30000)

  it('creates a new project (git init) in a chosen folder, never over a non-empty one', async () => {
    const res = await rfs.createProject({ hostId: HOST, parent: '~/projects', name: 'fresh' })
    expect(res).toMatchObject({ ok: true, name: 'fresh', path: `${posixPath(home)}/projects/fresh` })
    expect(fs.existsSync(join(home, 'projects', 'fresh', '.git'))).toBe(true)
    fs.writeFileSync(join(home, 'projects', 'app', 'x'), 'x')
    const again = await rfs.createProject({ hostId: HOST, parent: '~/projects', name: 'app' })
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already exists/)
  }, 60000)

  it('clones a repository into a chosen folder, once', async () => {
    const src = join(base, 'src-repo')
    fs.mkdirSync(src)
    const g = (...a) => execFileSync('git', ['-C', src, ...a], { stdio: 'pipe' })
    g('init', '-q')
    g('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'first')
    const url = `file:///${src.replace(/\\/g, '/')}`
    const res = await rfs.cloneProject({ hostId: HOST, url, parent: '~/projects' })
    expect(res).toMatchObject({ ok: true, name: 'src-repo', path: `${posixPath(home)}/projects/src-repo` })
    expect(fs.existsSync(join(home, 'projects', 'src-repo', '.git'))).toBe(true)
    const twice = await rfs.cloneProject({ hostId: HOST, url, parent: '~/projects' })
    expect(twice.ok).toBe(false)
    expect(twice.error).toMatch(/already exists/)
  }, 120000)
})

describe.skipIf(!gitSh())('Add a project on a host: sign-in failure', () => {
  it('connect says why and the listing is not tried', async () => {
    const rfs = createRemoteFs({ hosts: stubHosts([]), spawnImpl: fakeSpawn({ exit: true }) })
    const res = await rfs.connect(HOST)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Permission denied/)
    rfs.close()
  }, 30000)
})
