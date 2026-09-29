import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRemoteFs } from '../remoteFs'
import { createRemotePromptWriter } from '../automationRemotePrompt'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'
import { remoteRoot } from '../../shared/remotePath'

const HOST = 'ssh-test2'
const hosts = {
  launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
  get: () => ({ id: HOST, label: 'Box' }),
  paneStarted: () => {},
  paneConnected: () => {},
  paneClosing: () => {},
  paneExited: () => {}
}
const FILE = '.tessel/automations/auto-1234-abcd.md'

// A remoteFs stand-in: a folder tree in memory.
function memoryFs(tree, { connected = true } = {}) {
  const calls = []
  const key = (v) => v.replace(/^ssh:\/\/[^/\\]+/, '').replace(/\\/g, '/')
  return {
    calls,
    listDir: async ({ dir }) => {
      calls.push(['list', key(dir)])
      const entries = Object.entries(tree)
        .filter(([p]) => p.slice(0, p.lastIndexOf('/')) === key(dir))
        .map(([p, e]) => ({ name: p.slice(p.lastIndexOf('/') + 1), dir: e === 'dir' || e === 'dirlink', ...(e.endsWith('link') ? { link: true } : {}) }))
      return { ok: true, entries }
    },
    create: async ({ dir, name, folder }) => {
      calls.push(['create', `${key(dir)}/${name}`])
      tree[`${key(dir)}/${name}`] = folder ? 'dir' : 'file'
      return { ok: true }
    },
    writeForEdit: async (q) => {
      calls.push(['write', key(q.file), q.text, !!q.privateNew])
      tree[key(q.file)] = 'file'
      return { ok: true }
    },
    snapshot: () => (connected ? { [HOST]: { state: 'ready' } } : {})
  }
}

describe("a remote project's automation prompt", () => {
  it('only its own file shape is written', async () => {
    const m = memoryFs({})
    const w = createRemotePromptWriter(m)
    expect((await w.write({ hostId: HOST, path: '/srv/app', file: '../../etc/passwd', text: 'x' })).ok).toBe(false)
    expect((await w.write({ hostId: HOST, path: '/srv/app', file: '.tessel/automations/x;rm.md', text: 'x' })).ok).toBe(false)
    expect(m.calls).toEqual([])
  })

  it('creates the folders and a .gitignore when missing; the prompt readable by its owner only', async () => {
    const m = memoryFs({})
    const w = createRemotePromptWriter(m)
    expect(await w.write({ hostId: HOST, path: '/srv/app', file: FILE, text: 'Do it.\n' })).toEqual({ ok: true })
    expect(m.calls.filter((c) => c[0] === 'write')).toEqual([
      ['write', '/srv/app/.tessel/automations/.gitignore', '*\n', false],
      ['write', '/srv/app/.tessel/automations/auto-1234-abcd.md', 'Do it.\n', true]
    ])
  })

  // Recheck C2: yours stays yours.
  it('never overwrites an existing .gitignore', async () => {
    const m = memoryFs({ '/srv/app/.tessel': 'dir', '/srv/app/.tessel/automations': 'dir', '/srv/app/.tessel/automations/.gitignore': 'file' })
    const w = createRemotePromptWriter(m)
    expect((await w.write({ hostId: HOST, path: '/srv/app', file: FILE, text: 'x' })).ok).toBe(true)
    expect(m.calls.filter((c) => c[0] === 'write').map((c) => c[1])).toEqual(['/srv/app/.tessel/automations/auto-1234-abcd.md'])
  })

  // Recheck C1: links refused, even inside the project.
  it('refuses a link anywhere on the way', async () => {
    for (const [path, kind] of [
      ['/srv/app/.tessel', 'dirlink'],
      ['/srv/app/.tessel/automations', 'dirlink'],
      ['/srv/app/.tessel/automations/.gitignore', 'filelink'],
      ['/srv/app/.tessel/automations/auto-1234-abcd.md', 'filelink']
    ]) {
      const tree = { '/srv/app/.tessel': 'dir', '/srv/app/.tessel/automations': 'dir', '/srv/app/.tessel/automations/.gitignore': 'file' }
      tree[path] = kind
      const m = memoryFs(tree)
      const w = createRemotePromptWriter(m)
      expect(await w.write({ hostId: HOST, path: '/srv/app', file: FILE, text: 'x' })).toEqual({ ok: false, error: 'link' })
      expect(m.calls.filter((c) => c[0] === 'write')).toEqual([])
    }
  })

  // Recheck C3: never a new connection (or password question) for it.
  it('empties the prompt only through a session already open', async () => {
    const tree = { '/srv/app/.tessel': 'dir', '/srv/app/.tessel/automations': 'dir', '/srv/app/.tessel/automations/auto-1234-abcd.md': 'file' }
    let m = memoryFs(tree, { connected: false })
    let w = createRemotePromptWriter(m)
    expect(await w.clear({ hostId: HOST, path: '/srv/app', file: FILE })).toEqual({ ok: false, later: true })
    expect(m.calls).toEqual([])
    m = memoryFs(tree)
    w = createRemotePromptWriter(m)
    expect(await w.clear({ hostId: HOST, path: '/srv/app', file: FILE })).toEqual({ ok: true })
    expect(m.calls.filter((c) => c[0] === 'write')).toEqual([['write', '/srv/app/.tessel/automations/auto-1234-abcd.md', '', false]])
    m = memoryFs({ ...tree, '/srv/app/.tessel/automations/auto-1234-abcd.md': 'filelink' })
    w = createRemotePromptWriter(m)
    expect((await w.clear({ hostId: HOST, path: '/srv/app', file: FILE })).ok).toBe(false)
    expect(m.calls.filter((c) => c[0] === 'write')).toEqual([])
  })
})

describe.skipIf(!gitSh())("a remote project's automation prompt over a fake ssh (Git for Windows sh)", () => {
  let base
  let proj
  let rfs
  let writer
  const g = (...args) => execFileSync('git', ['-C', proj, ...args], { stdio: 'pipe' }).toString()
  const tryLink = (target, at, type) => {
    try {
      fs.symlinkSync(target, at, type)
      return true
    } catch {
      return false // no right to make this kind of link here
    }
  }

  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-arp-'))
    proj = join(base, 'proj')
    const home = join(base, 'home')
    fs.mkdirSync(proj)
    fs.mkdirSync(home)
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    fs.writeFileSync(join(proj, 'a.txt'), 'one\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    rfs = createRemoteFs({ hosts, send: () => {}, spawnImpl: fakeSpawn({ home }) })
    // The saved layout's remote projects are the only roots (remoteRootsOfLayout).
    rfs.setRoots(['proj', join('other', 'proj2'), 'proj3'].map((p) => remoteRoot(HOST, posixPath(join(base, p)))))
    writer = createRemotePromptWriter(rfs)
  })

  it('a project that is not a saved remote project is refused', async () => {
    const stray = join(base, 'stray')
    fs.mkdirSync(stray, { recursive: true })
    const res = await writer.write({ hostId: HOST, path: posixPath(stray), file: FILE, text: 'x' })
    expect(res.ok).toBe(false)
    expect(fs.existsSync(join(stray, '.tessel'))).toBe(false)
    // Its clearing waits (the project may come back), never writes elsewhere.
    expect((await writer.clear({ hostId: HOST, path: posixPath(stray), file: FILE })).ok).toBe(false)
  }, 60000)
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('is written in .tessel/automations with a .gitignore, so `git add -A` never takes it; emptied at the end', async () => {
    const res = await writer.write({ hostId: HOST, path: posixPath(proj), file: FILE, text: 'Do the audit.\n' })
    expect(res).toEqual({ ok: true })
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', 'auto-1234-abcd.md'), 'utf8')).toBe('Do the audit.\n')
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', '.gitignore'), 'utf8')).toBe('*\n')
    g('add', '-A')
    expect(g('status', '--porcelain')).not.toContain('.tessel')
    expect((await writer.write({ hostId: HOST, path: posixPath(proj), file: FILE, text: 'Again.\n' })).ok).toBe(true)
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', 'auto-1234-abcd.md'), 'utf8')).toBe('Again.\n')
    expect((await writer.clear({ hostId: HOST, path: posixPath(proj), file: FILE })).ok).toBe(true)
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', 'auto-1234-abcd.md'), 'utf8')).toBe('')
  }, 60000)

  it('a .tessel that is a link out of the project (a cloned repo) is refused', async () => {
    const proj2 = join(base, 'other', 'proj2')
    fs.mkdirSync(proj2, { recursive: true })
    const outside = join(base, 'outside')
    fs.mkdirSync(join(outside, 'automations'), { recursive: true })
    if (!tryLink(outside, join(proj2, '.tessel'), 'junction')) return
    const res = await writer.write({ hostId: HOST, path: posixPath(proj2), file: FILE, text: 'secret prompt\n' })
    expect(res.ok).toBe(false)
    expect(fs.existsSync(join(outside, 'automations', 'auto-1234-abcd.md'))).toBe(false)
    expect(fs.existsSync(join(outside, 'automations', '.gitignore'))).toBe(false)
  }, 60000)

  // Recheck C1: a link that stays inside the project is refused too.
  it('.tessel/automations linked to src/ inside the project is refused: src/.gitignore untouched', async () => {
    const proj3 = join(base, 'proj3')
    fs.mkdirSync(join(proj3, 'src'), { recursive: true })
    fs.mkdirSync(join(proj3, '.tessel'))
    fs.writeFileSync(join(proj3, 'src', '.gitignore'), 'node_modules\n')
    if (!tryLink(join(proj3, 'src'), join(proj3, '.tessel', 'automations'), 'junction')) return
    const res = await writer.write({ hostId: HOST, path: posixPath(proj3), file: FILE, text: 'secret prompt\n' })
    expect(res).toEqual({ ok: false, error: 'link' })
    expect(fs.readFileSync(join(proj3, 'src', '.gitignore'), 'utf8')).toBe('node_modules\n')
    expect(fs.existsSync(join(proj3, 'src', 'auto-1234-abcd.md'))).toBe(false)
  }, 60000)
})
