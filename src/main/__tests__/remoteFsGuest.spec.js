// A Live Share guest's requests on a shared SSH project (remoteFs.js guest),
// end to end on a fake host (Git for Windows' sh on a temporary folder): on
// the guest's own lane, never the host's session; each path checked on the
// host in the same request (no link, no nested repository); what git ignores
// asked of git for the request's own paths (check-ignore), failing closed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRemoteFs } from '../remoteFs'
import { hashOf } from '../editorFiles'
import { remoteRoot } from '../../shared/remotePath'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

const HOST = 'ssh-guest1'
function stubHosts() {
  return {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
    get: () => ({ id: HOST, label: 'Box' }),
    sharedConnected: () => true,
    paneStarted() {},
    paneConnected() {},
    paneClosing() {},
    paneExited() {}
  }
}
// A link or junction removed itself (never what it points to).
const unlink = (p) => {
  try {
    fs.unlinkSync(p)
  } catch {
    fs.rmdirSync(p)
  }
}
const tryLink = (target, at, type) => {
  try {
    fs.symlinkSync(target, at, type)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!gitSh())('a guest\'s requests on a fake host (real sh, real git)', () => {
  let base
  let proj
  let home
  let root
  let rfs
  const spawned = []
  const ran = { files: new Set(), guest: new Set() }
  const g = (...a) => execFileSync('git', ['-C', proj, ...a], { stdio: 'pipe' }).toString()

  beforeAll(async () => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs-g-'))
    proj = join(base, 'proj')
    home = join(base, 'home')
    fs.mkdirSync(proj)
    fs.mkdirSync(home)
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    g('config', 'core.autocrlf', 'false')
    fs.writeFileSync(join(proj, '.gitignore'), 'build/\n*.log\n!keep.log\nsecret-dir/\n')
    fs.writeFileSync(join(proj, 'a.txt'), 'one\n')
    fs.mkdirSync(join(proj, 'src'))
    fs.writeFileSync(join(proj, 'src', 'main.js'), 'console.log("hello")\n')
    fs.writeFileSync(join(proj, 'src', 'debug.log'), 'hello log\n')
    fs.writeFileSync(join(proj, 'src', 'keep.log'), 'hello kept\n')
    fs.mkdirSync(join(proj, 'build', 'out'), { recursive: true })
    fs.writeFileSync(join(proj, 'build', 'out', 'x.js'), 'hello built\n')
    // FiveM folder names: brackets (glob characters for the shell).
    fs.mkdirSync(join(proj, '[dev]', 'res'), { recursive: true })
    fs.writeFileSync(join(proj, '[dev]', 'res', 'fx.lua'), 'print("hello")\n')
    fs.mkdirSync(join(proj, 'secret-dir'))
    fs.writeFileSync(join(proj, 'secret-dir', 'k.txt'), 'hello secret\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    // A nested repository.
    fs.mkdirSync(join(proj, 'nested'))
    execFileSync('git', ['-C', join(proj, 'nested'), 'init', '-q'], { stdio: 'pipe' })
    fs.writeFileSync(join(proj, 'nested', 'n.txt'), 'hello nested\n')
    root = remoteRoot(HOST, posixPath(proj))
    const spawn = fakeSpawn({ home })
    rfs = createRemoteFs({
      hosts: stubHosts(),
      // The first connection is the host's own session (its listing below);
      // the next ones are the guest's lane.
      spawnImpl: (file, args, opts) => {
        const name = spawned.length ? 'guest' : 'files'
        spawned.push(name)
        const child = spawn(file, args, opts)
        const write = child.stdin.write.bind(child.stdin)
        child.stdin.write = (text, ...rest) => {
          for (const m of String(text).matchAll(/__t_q \d+ \d+ \d+ (__t_\w+)/g)) ran[name].add(m[1])
          return write(text, ...rest)
        }
        return child
      }
    })
    rfs.setRoots([root])
    // The host's own window opened its session (a guest's lane on the system
    // ssh opens only while it is up).
    await rfs.listDir({ root })
  }, 60000)
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('runs on a lane of its own (a second connection that may ask nothing), never in the host\'s session', async () => {
    const res = await rfs.guest.list({ root, dirs: [''] })
    expect(res.ok).toBe(true)
    expect(spawned).toEqual(['files', 'guest'])
    expect(rfs.lanesOpen()).toEqual([`${HOST} guest`])
  }, 30000)

  it('lists a folder with what git ignores (the folder\'s own names), links and nested repositories marked', async () => {
    const linked = tryLink(join(proj, 'a.txt'), join(proj, 'link.txt'), 'file')
    const res = await rfs.guest.list({ root, dirs: ['', 'src'] })
    expect(res.ok).toBe(true)
    const [top, src] = res.results
    expect(top.ok).toBe(true)
    const kinds = Object.fromEntries(top.entries.map((e) => [e.name, e.kind]))
    expect(kinds).toMatchObject({ 'a.txt': 'f', src: 'd', build: 'd', '[dev]': 'd', nested: 'r', '.git': 'd' })
    if (linked) expect(kinds['link.txt']).toBe('l')
    expect([...top.ignored].sort()).toEqual(['build', 'secret-dir'])
    expect([...src.ignored]).toEqual(['debug.log'])
    if (linked) fs.rmSync(join(proj, 'link.txt'))
  }, 30000)

  it('a folder inside an ignored one is hidden itself; a nested repository or a missing folder is refused', async () => {
    const res = await rfs.guest.list({ root, dirs: ['build/out', 'nested', 'nope', '[dev]/res'] })
    const by = Object.fromEntries(res.results.map((r) => [r.rel, r]))
    expect(by['build/out']).toMatchObject({ ok: false, code: 'missing' })
    expect(by.nested).toMatchObject({ ok: false, code: 'refused' })
    expect(by.nope.ok).toBe(false)
    expect(by['[dev]/res']).toMatchObject({ ok: true })
    expect(by['[dev]/res'].entries.map((e) => e.name)).toEqual(['fx.lua'])
  }, 30000)

  it('without the setting, what git ignores is not asked', async () => {
    const res = await rfs.guest.list({ root, dirs: ['src'], ignore: false })
    expect(res.results[0]).toMatchObject({ ok: true, ignored: null })
  }, 30000)

  it('reads a file, cut at the size asked; an ignored one, or one below an ignored folder, is missing', async () => {
    const read = await rfs.guest.read({ root, rel: 'src/main.js', max: 1024 })
    expect(read.ok).toBe(true)
    expect(read.buf.toString()).toBe('console.log("hello")\n')
    expect(read.hostHash).toMatch(/^sha256:|^cksum:/)
    expect(await rfs.guest.read({ root, rel: 'src/debug.log', max: 1024 })).toEqual({ ok: false, code: 'missing' })
    expect(await rfs.guest.read({ root, rel: 'build/out/x.js', max: 1024 })).toEqual({ ok: false, code: 'missing' })
    expect((await rfs.guest.read({ root, rel: 'src/debug.log', max: 1024, ignore: false })).ok).toBe(true)
    expect(await rfs.guest.read({ root, rel: 'src/main.js', max: 5 })).toEqual({ ok: false, code: 'too-large' })
    expect(await rfs.guest.read({ root, rel: 'nested/n.txt', max: 1024 })).toEqual({ ok: false, code: 'refused' })
    expect(await rfs.guest.read({ root, rel: 'src', max: 1024 })).toEqual({ ok: false, code: 'is-folder' })
    expect(await rfs.guest.read({ root, rel: '../outside.txt', max: 1024 })).toEqual({ ok: false, code: 'refused' })
  }, 30000)

  it('never follows a link, even one made after the folder was listed', async () => {
    fs.mkdirSync(join(proj, 'docs'))
    fs.writeFileSync(join(proj, 'docs', 'r.md'), 'readme\n')
    expect((await rfs.guest.read({ root, rel: 'docs/r.md', max: 1024 })).ok).toBe(true)
    // The folder becomes a link to the ignored one.
    fs.rmSync(join(proj, 'docs'), { recursive: true })
    if (!tryLink(join(proj, 'secret-dir'), join(proj, 'docs'), 'junction')) return
    const res = await rfs.guest.read({ root, rel: 'docs/k.txt', max: 1024, ignore: false })
    expect(res.ok).toBe(false)
    expect(['refused', 'missing']).toContain(res.code)
    unlink(join(proj, 'docs'))
  }, 30000)

  it('stats a file; a folder or an ignored file is not one', async () => {
    const st = await rfs.guest.stat({ root, rel: 'a.txt' })
    expect(st).toMatchObject({ ok: true, exists: true, size: 4 })
    expect(await rfs.guest.stat({ root, rel: 'src' })).toEqual({ ok: true, exists: false })
    expect(await rfs.guest.stat({ root, rel: 'src/debug.log' })).toEqual({ ok: false, code: 'missing' })
  }, 30000)

  it('saves only the version read (the host\'s hash), makes a new file only if nothing is there, never in an ignored place', async () => {
    const read = await rfs.guest.read({ root, rel: 'a.txt', max: 1024 })
    const saved = await rfs.guest.write({ root, rel: 'a.txt', data: Buffer.from('two\n'), expectHash: read.hostHash })
    expect(saved.ok).toBe(true)
    expect(fs.readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('two\n')
    // The guest's own hash is the host's sha256 of the same bytes.
    if (read.hostHash.startsWith('sha256:')) expect(saved.hostHash).toBe(`sha256:${hashOf(Buffer.from('two\n'))}`)
    // Changed meanwhile: a conflict, nothing written.
    const stale = await rfs.guest.write({ root, rel: 'a.txt', data: Buffer.from('three\n'), expectHash: read.hostHash })
    expect(stale).toEqual({ ok: false, code: 'conflict' })
    expect(fs.readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('two\n')
    const made = await rfs.guest.write({ root, rel: 'src/new.js', data: Buffer.from('x\n'), createOnly: true })
    expect(made.ok).toBe(true)
    const again = await rfs.guest.write({ root, rel: 'src/new.js', data: Buffer.from('y\n'), createOnly: true })
    expect(again).toEqual({ ok: false, code: 'conflict' })
    expect(await rfs.guest.write({ root, rel: 'src/other.log', data: Buffer.from('x'), createOnly: true })).toEqual({ ok: false, code: 'missing' })
    expect(fs.existsSync(join(proj, 'src', 'other.log'))).toBe(false)
    expect(await rfs.guest.write({ root, rel: 'nested/n2.txt', data: Buffer.from('x'), createOnly: true })).toEqual({ ok: false, code: 'refused' })
    // A folder in the way: nothing is put inside it.
    fs.mkdirSync(join(proj, 'dirhere'))
    expect((await rfs.guest.write({ root, rel: 'dirhere', data: Buffer.from('c'), createOnly: true })).ok).toBe(false)
    expect(fs.readdirSync(join(proj, 'dirhere'))).toEqual([])
    // Neither a version nor "only if nothing is there": refused before the host.
    expect(await rfs.guest.write({ root, rel: 'a.txt', data: Buffer.from('x') })).toEqual({ ok: false, code: 'refused' })
    expect(fs.readdirSync(join(proj, 'src')).filter((n) => n.includes('tessel'))).toEqual([])
  }, 30000)

  it('checks search results: links, nested repositories and ignored paths left out', async () => {
    const res = await rfs.guest.check({ root, rels: ['a.txt', 'src/debug.log', 'src/keep.log', 'build/out/x.js', 'nested/n.txt', '[dev]/res/fx.lua', 'bad\nname'] })
    expect(res.ok).toBe(true)
    expect([...res.good].sort()).toEqual(['[dev]/res/fx.lua', 'a.txt', 'src/keep.log'])
    const loose = await rfs.guest.check({ root, rels: ['src/debug.log', 'nested/n.txt'], ignore: false })
    expect([...loose.good]).toEqual(['src/debug.log'])
  }, 30000)

  it('searches names and text on its lane', async () => {
    const names = await rfs.guest.searchNames({ root, query: 'fx' })
    expect(names.ok).toBe(true)
    expect(names.results).toContainEqual({ rel: '[dev]/res/fx.lua', dir: false })
    const text = await rfs.guest.searchContent({ root, query: 'hello' })
    expect(text.ok).toBe(true)
    const rels = text.results.map((r) => r.rel)
    expect(rels).toContain('src/main.js')
    // git grep does not search what git ignores.
    expect(rels).not.toContain('build/out/x.js')
    expect(rels).not.toContain('src/debug.log')
  }, 30000)

  it('gives the real path and the hooks folder, lexical and real, and "" for the project itself', async () => {
    let info = await rfs.guest.info({ root })
    expect(info.ok).toBe(true)
    expect(info.real.toLowerCase()).toContain('proj')
    expect(info.hooks).toEqual([])
    g('config', 'core.hooksPath', 'scripts/../scripts/./hooks/')
    fs.mkdirSync(join(proj, 'scripts', 'hooks'), { recursive: true })
    info = await rfs.guest.info({ root })
    expect(info.hooks).toEqual(['scripts/hooks'])
    g('config', 'core.hooksPath', '.')
    expect((await rfs.guest.info({ root })).hooks).toEqual([''])
    g('config', 'core.hooksPath', '~/hooks')
    expect((await rfs.guest.info({ root })).hooks).toBe(null)
    g('config', 'core.hooksPath', '../elsewhere')
    expect((await rfs.guest.info({ root })).hooks).toEqual([])
    // A hooks folder that is a link to another folder of the project: both.
    if (tryLink(join(proj, 'scripts', 'hooks'), join(proj, 'hk'), 'junction')) {
      g('config', 'core.hooksPath', 'hk')
      const linked = (await rfs.guest.info({ root })).hooks
      expect(linked).toContain('hk')
      unlink(join(proj, 'hk'))
    }
    g('config', '--unset', 'core.hooksPath')
  }, 60000)

  it('fails closed when git cannot tell what it ignores', async () => {
    // A broken repository: git refuses it, a .git is there.
    fs.renameSync(join(proj, '.git', 'HEAD'), join(proj, '.git', 'HEAD.away'))
    try {
      const res = await rfs.guest.list({ root, dirs: ['src'] })
      expect(res.results[0]).toMatchObject({ ok: false, code: 'unknown' })
      expect(await rfs.guest.read({ root, rel: 'src/main.js', max: 1024 })).toEqual({ ok: false, code: 'unknown' })
      expect((await rfs.guest.check({ root, rels: ['a.txt'] })).ok).toBe(false)
    } finally {
      fs.renameSync(join(proj, '.git', 'HEAD.away'), join(proj, '.git', 'HEAD'))
    }
  }, 30000)

  it('the guest\'s lane stays one connection while it is used; the host\'s own session carried nothing of it', async () => {
    expect(spawned).toEqual(['files', 'guest'])
    expect([...ran.files]).toEqual(['__t_ls'])
    expect([...ran.guest].every((fn) => /^__t_g[a-z]+$/.test(fn))).toBe(true)
  })
})

describe.skipIf(!gitSh())('a Codex conversation found by its day folder first (real sh)', () => {
  const ID = '01a16f50-626f-7a13-9795-0e1e34414ed7'
  const OLD = '01a00000-0000-7000-8000-000000000001'
  let base
  let rfs
  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs-cx-'))
    const home = join(base, 'home')
    const day = join(home, '.codex', 'sessions', '2026', '10', '24')
    fs.mkdirSync(day, { recursive: true })
    fs.writeFileSync(join(day, `rollout-2026-10-24T19-08-21-${ID}.jsonl`), '{"a":1}\n')
    // One whose id names another day: found by the search of the whole folder.
    const other = join(home, '.codex', 'sessions', '2025', '01', '02')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(join(other, `rollout-2025-01-02T00-00-00-${OLD}.jsonl`), '{"b":2}\n')
    rfs = createRemoteFs({ hosts: stubHosts(), spawnImpl: fakeSpawn({ home }) })
    rfs.allow(HOST)
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })
  it('reads it, and one in another folder too', async () => {
    const res = await rfs.readAgentFile(HOST, { agent: 'codex', id: ID })
    expect(res.ok).toBe(true)
    expect(res.data.toString()).toBe('{"a":1}\n')
    const old = await rfs.readAgentFile(HOST, { agent: 'codex', id: OLD })
    expect(old.ok).toBe(true)
    expect(old.data.toString()).toBe('{"b":2}\n')
    expect((await rfs.readAgentFile(HOST, { agent: 'codex', id: '01a16f50-626f-7a13-9795-000000000000' })).missing).toBe(true)
  }, 30000)
})

describe('a guest\'s lane: never a sign-in, never the host\'s session', () => {
  const root = remoteRoot(HOST, '/srv/app')
  it('the system ssh with no session of the host\'s: not connected, nothing started', async () => {
    const calls = []
    const rfs = createRemoteFs({ hosts: { ...stubHosts(), sharedConnected: () => false }, spawnImpl: (...a) => calls.push(a) })
    rfs.setRoots([root])
    rfs.allow(HOST)
    for (const res of [
      await rfs.guest.list({ root, dirs: [''] }),
      await rfs.guest.read({ root, rel: 'a.txt', max: 10 }),
      await rfs.guest.stat({ root, rel: 'a.txt' }),
      await rfs.guest.write({ root, rel: 'a.txt', data: Buffer.from('x'), createOnly: true }),
      await rfs.guest.check({ root, rels: ['a.txt'] }),
      await rfs.guest.info({ root }),
      await rfs.guest.searchNames({ root, query: 'a' }),
      await rfs.guest.searchContent({ root, query: 'a' })
    ])
      expect(res).toEqual({ ok: false, code: 'not-connected' })
    expect(calls).toHaveLength(0)
    rfs.close()
  })

  it('on ssh2: only over a connection signed in already (re-checked once the mode is known), with onlyLive', async () => {
    let connected = true
    const asked = []
    const ssh = {
      modeFor: async () => {
        connected = false // dropped while the mode was looked up
        return { mode: 'ssh2', spec: {} }
      },
      spawnFor: (...a) => {
        asked.push(a)
        throw new Error('must not be reached')
      }
    }
    const rfs = createRemoteFs({ hosts: { ...stubHosts(), sharedConnected: () => connected }, ssh })
    rfs.setRoots([root])
    expect(await rfs.guest.stat({ root, rel: 'a.txt' })).toEqual({ ok: false, code: 'not-connected' })
    expect(asked).toHaveLength(0)
    rfs.close()
  })

  it('paths that are not the project\'s are refused before anything is sent', async () => {
    const rfs = createRemoteFs({ hosts: stubHosts(), spawnImpl: () => { throw new Error('no') } })
    rfs.setRoots([root])
    for (const rel of ['../x', '/etc/passwd', 'a//b', 'a\\b', 'a/./b', '']) {
      const res = await rfs.guest.read({ root, rel, max: 10 })
      expect(res).toEqual({ ok: false, code: 'refused' })
    }
    expect(await rfs.guest.list({ root: remoteRoot(HOST, '/srv/other'), dirs: [''] })).toEqual({ ok: false, code: 'refused' })
    expect((await rfs.guest.list({ root, dirs: ['../up'] })).results).toEqual([{ rel: '../up', ok: false, code: 'refused' }])
    rfs.close()
  })
})
