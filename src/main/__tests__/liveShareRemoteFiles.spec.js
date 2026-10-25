// Live Share: the files of a shared SSH project (src/main/liveShare/
// shareRemoteFiles.js), served through remoteFs's guest requests (a lane of
// the guests' own, every path checked on the host), on a fake holding a
// small tree with the host's semantics: a link or a nested repository on the
// way is refused, what git ignores is told per request (a folder's names,
// a file, search results), a read is cut at its size, a save compares the
// host's hash. The rules of a local shared project on top: secret names,
// .git and .tessel hidden; rights per op, protected files and the hooks
// folder; sizes; a few requests at once per host; host-offline; no host path
// or host words in any answer.
import { describe, it, expect, beforeEach } from 'vitest'
import { createRemoteShareFiles, MAX_ACTIVE, MAX_WAITING, MAX_PER_PERSON, INFO_TTL_MS } from '../liveShare/shareRemoteFiles'
import { hashOf } from '../editorFiles'
import { LSHARE_CODES, LSHARE_LIMITS as L } from '../../shared/liveSharePath'
import { createGuestFs } from '../liveShare/guestFs'
import { cleanRemoteRoot } from '../liveShare'

const ROOT = 'ssh://ssh-a1/home/me/app'
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const sha = (b) => `sha256:${hashOf(b)}`

// tree: rel -> { dir } | { link, dir? } | { nested } (a folder holding a .git)
// | { text, bom? } | { buf }.
function fakeRemote(tree) {
  const state = {
    connected: true,
    laneDown: false,
    calls: [],
    inflight: 0,
    maxInflight: 0,
    delay: 0,
    ignored: new Set(),
    ignoreFails: false,
    real: '/home/me/app',
    hooks: [],
    hashKind: 'sha256',
    written: null,
    tree
  }
  const bytes = (v) => Buffer.concat([v.bom ? BOM : Buffer.alloc(0), v.buf || Buffer.from(v.text || '', 'utf8')])
  const hostHash = (b) => (state.hashKind === 'sha256' ? sha(b) : `cksum:${b.length}:1`)
  const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
  const kids = (dir) =>
    Object.entries(state.tree).filter(([k]) => k !== dir && parentOf(k) === dir).map(([k, v]) => [k.slice(dir ? dir.length + 1 : 0), v])
  // The host's guard: every part on the way a real folder.
  const guard = (rel) => {
    const segs = rel ? rel.split('/') : []
    for (let i = 0; i < segs.length; i++) {
      const v = state.tree[segs.slice(0, i + 1).join('/')]
      if (v && (v.link || v.nested)) return 'refused'
      if (i < segs.length - 1 && !(v && v.dir)) return 'missing'
    }
    return null
  }
  const ignoredRel = (rel) => {
    for (let r = rel; r; r = parentOf(r)) if (state.ignored.has(r)) return true
    return false
  }
  // A path checked: refused / missing (ignored too) / unknown, or null.
  const check = (rel, ignore) => guard(rel) || (ignore && state.ignoreFails ? 'unknown' : ignore && ignoredRel(rel) ? 'missing' : null)
  const run = async (name, fn) => {
    state.calls.push(name)
    state.inflight++
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    try {
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay))
      if (state.laneDown || !state.connected) return { ok: false, code: 'not-connected' }
      return fn()
    } finally {
      state.inflight--
    }
  }
  const guest = {
    list: ({ root, dirs, ignore }) =>
      run('list', () => {
        if (root !== ROOT) return { ok: false, code: 'refused' }
        return {
          ok: true,
          results: dirs.map((rel) => {
            const bad = check(rel, ignore)
            if (bad) return { rel, ok: false, code: bad }
            if (rel && !(state.tree[rel] && state.tree[rel].dir)) return { rel, ok: false, code: 'not-file' }
            const entries = kids(rel).map(([name, v]) => ({ name, kind: v.link ? 'l' : v.nested ? 'r' : v.dir ? 'd' : 'f' }))
            const ignored = ignore ? new Set(entries.filter((e) => ignoredRel(rel ? `${rel}/${e.name}` : e.name)).map((e) => e.name)) : null
            return { rel, ok: true, entries, truncated: false, ignored }
          })
        }
      }),
    stat: ({ rel, ignore }) =>
      run('stat', () => {
        const bad = check(rel, ignore)
        if (bad) return { ok: false, code: bad }
        const v = state.tree[rel]
        return v && !v.dir ? { ok: true, exists: true, size: bytes(v).length, mtimeMs: 7000, sig: 'r:1:7:9' } : { ok: true, exists: false }
      }),
    read: ({ rel, max, ignore }) =>
      run('read', () => {
        const bad = check(rel, ignore)
        if (bad) return { ok: false, code: bad }
        const v = state.tree[rel]
        if (!v) return { ok: false, code: 'missing' }
        if (v.dir) return { ok: false, code: 'is-folder' }
        const b = bytes(v)
        if (b.length > max) return { ok: false, code: 'too-large' }
        return { ok: true, buf: b, size: b.length, mtimeMs: 7000, sig: 'r:1:7:9', hostHash: hostHash(b) }
      }),
    write: ({ rel, data, expectHash, createOnly, ignore }) =>
      run('write', () => {
        const bad = check(rel, ignore)
        if (bad) return { ok: false, code: bad }
        const cur = state.tree[rel]
        if (cur && cur.dir) return { ok: false, code: 'is-folder' }
        if (createOnly && cur) return { ok: false, code: 'conflict' }
        if (!createOnly && cur && expectHash !== hostHash(bytes(cur))) return { ok: false, code: 'conflict' }
        state.tree[rel] = { buf: data }
        state.written = { rel, data, expectHash, createOnly: !!createOnly }
        return { ok: true, size: data.length, mtimeMs: 9000, sig: 'r:1:9:9', hostHash: hostHash(data) }
      }),
    check: ({ rels, ignore }) =>
      run('check', () => {
        if (ignore && state.ignoreFails) return { ok: false, code: 'unknown' }
        return { ok: true, good: new Set(rels.filter((r) => !check(r, ignore))) }
      }),
    info: () => run('info', () => ({ ok: true, real: state.real, hooks: state.hooks })),
    searchNames: ({ query }) =>
      run('names', () => ({
        ok: true,
        truncated: false,
        results: Object.entries(state.tree)
          .filter(([k, v]) => !v.link && k.toLowerCase().includes(String(query).toLowerCase()))
          .map(([k, v]) => ({ rel: k, dir: !!v.dir }))
      })),
    searchContent: ({ query }) =>
      run('content', () => ({
        ok: true,
        truncated: false,
        results: Object.entries(state.tree)
          .filter(([, v]) => typeof v.text === 'string' && v.text.includes(query))
          .map(([k, v]) => ({ rel: k, line: 1, text: v.text }))
      }))
  }
  const svc = { hasRoot: (v) => v === ROOT, connectedQuietly: () => state.connected, guest }
  return { svc, state }
}

const baseTree = () => ({
  'a.txt': { text: 'hello' },
  'bom.txt': { text: 'héllo', bom: true },
  '.env': { text: 'SECRET=1' },
  '.git': { dir: true },
  '.git/config': { text: 'x' },
  '.tessel': { dir: true },
  '.tessel/notes.md': { text: 'n' },
  src: { dir: true },
  'src/main.js': { text: 'main' },
  'src/key.pem': { text: 'KEY' },
  build: { dir: true },
  'build/out.js': { text: 'built' },
  'ignored.log': { text: 'log' },
  'link-env': { link: true },
  linkdir: { link: true, dir: true },
  'linkdir/inner.txt': { text: 'inside the link' },
  nested: { nested: true, dir: true },
  'nested/n.txt': { text: 'nested main' },
  'pic.png': { buf: Buffer.from([1, 2, 3]) },
  'blob.bin': { buf: Buffer.from([0, 1, 2, 0]) },
  'latin.txt': { buf: Buffer.from([0x68, 0xe9, 0x6c]) },
  'big.txt': { text: 'x'.repeat(L.textBytes + 10) },
  '.vscode': { dir: true },
  '.vscode/tasks.json': { text: '{}' },
  'scripts': { dir: true },
  'scripts/hooks': { dir: true },
  'scripts/hooks/pre-commit': { text: '#!/bin/sh' },
  deep: { dir: true },
  'deep/a': { dir: true },
  'deep/a/b': { dir: true },
  'deep/a/b/c.txt': { text: 'deep main' }
})

let rig
let remote
const READ = { edit: false, git: false, type: false }
const EDIT = { edit: true, type: false }
const OK = { recheck: async () => true }
const ask = (op, args, extra = {}) =>
  rig.handle({ op, project: 'p1', args }, { remoteRoots: new Map([['p1', ROOT]]), rights: READ, settings: {}, ...extra })

beforeEach(() => {
  remote = fakeRemote(baseTree())
  remote.state.ignored = new Set(['build', 'ignored.log'])
  rig = createRemoteShareFiles({ remote: remote.svc })
})

describe('listing', () => {
  it('lists what a guest may see: hidden ones counted, never named; links and nested repositories left out', async () => {
    const res = await ask('fs.list', {})
    expect(res.ok).toBe(true)
    const names = res.data.entries.map((e) => e.name)
    // .vscode is shown (write-protected, not hidden).
    expect(names.sort()).toEqual(['.vscode', 'a.txt', 'big.txt', 'blob.bin', 'bom.txt', 'deep', 'latin.txt', 'pic.png', 'scripts', 'src'].sort())
    // .env .git .tessel build ignored.log link-env linkdir nested
    expect(res.data.hidden).toBe(8)
    expect(JSON.stringify(res)).not.toContain('/home/me')
  })

  it('never lists a folder that is hidden, ignored, a link or a nested repository', async () => {
    expect((await ask('fs.list', { dir: 'src' })).data.entries.map((e) => e.name)).toEqual(['main.js'])
    for (const dir of ['build', '.git', '.tessel', 'linkdir', 'nested']) expect((await ask('fs.list', { dir })).code, dir).toBe('not-found')
  })

  it('with the setting off: ignored and secret files show, git is not asked; .git, .tessel, links and nested repositories stay hidden', async () => {
    remote.state.ignoreFails = true // would fail closed if asked
    const res = await ask('fs.list', {}, { settings: { hideIgnored: false } })
    const names = res.data.entries.map((e) => e.name)
    for (const n of ['.env', 'build', 'ignored.log']) expect(names).toContain(n)
    for (const n of ['.git', '.tessel', 'link-env', 'linkdir', 'nested']) expect(names).not.toContain(n)
    expect((await ask('fs.read', { path: '.git/config' }, { settings: { hideIgnored: false } })).code).toBe('not-found')
  })

  it('without dotfiles, they are left out (and not counted)', async () => {
    const res = await ask('fs.list', { dotfiles: false })
    expect(res.data.entries.map((e) => e.name).some((n) => n.startsWith('.'))).toBe(false)
  })

  it('fails closed when git cannot tell what it ignores', async () => {
    remote.state.ignoreFails = true
    expect((await ask('fs.list', {})).code).toBe('failed')
    expect((await ask('fs.read', { path: 'a.txt' })).code).toBe('failed')
    expect((await ask('fs.searchNames', { query: 'a' })).code).toBe('failed')
  })

  it('lists many folders in one request, each checked; compact folders follow sole sub-folders', async () => {
    const res = await ask('fs.listMany', { dirs: ['', 'src', 'build', 'linkdir', '.env'] })
    const by = Object.fromEntries(res.data.results.map((r) => [r.dir, r]))
    expect(by[''].ok).toBe(true)
    expect(by.src.entries.map((e) => e.name)).toEqual(['main.js'])
    for (const d of ['build', 'linkdir', '.env']) expect(by[d]).toMatchObject({ ok: false, code: 'not-found' })
    expect(remote.state.calls.filter((c) => c === 'list')).toHaveLength(1)
    const chained = await ask('fs.listMany', { dirs: ['deep'], chain: true })
    expect(chained.data.results.map((r) => r.dir)).toEqual(['deep', 'deep/a', 'deep/a/b'])
  })
})

describe('reading', () => {
  it('reads a file with its hash, signature and read-only flag; a BOM is reported', async () => {
    const res = await ask('fs.read', { path: 'bom.txt' })
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ text: 'héllo', bom: true, hash: hashOf(Buffer.concat([BOM, Buffer.from('héllo')])), readOnly: true })
    expect(res.data.sig).toMatch(/^\d+:\d+$/)
    expect((await ask('fs.read', { path: 'a.txt' }, { rights: EDIT })).data.readOnly).toBe(false)
  })

  it('refuses the hidden, ignored, secret and special files, links and nested repositories as not found', async () => {
    for (const path of ['.env', 'src/key.pem', 'build/out.js', 'ignored.log', '.git/config', '.tessel/notes.md', 'link-env', 'linkdir/inner.txt', 'nested/n.txt', 'nope.txt'])
      expect((await ask('fs.read', { path })).code, path).toBe('not-found')
    // The names hidden by themselves never reach the host.
    remote.state.calls.length = 0
    await ask('fs.read', { path: '.env' })
    await ask('fs.read', { path: '.git/config' })
    expect(remote.state.calls).toEqual([])
  })

  it('a binary, a non-UTF-8 file, a folder; nothing over the limit comes over (the host cuts it)', async () => {
    expect((await ask('fs.read', { path: 'blob.bin' })).code).toBe('binary')
    expect((await ask('fs.read', { path: 'latin.txt' })).code).toBe('encoding')
    expect((await ask('fs.read', { path: 'src' })).code).toBe('not-file')
    expect((await ask('fs.read', { path: 'big.txt' })).code).toBe('too-large')
  })

  it('stats a file (hidden or ignored: not there) and serves an image within the limit', async () => {
    expect((await ask('fs.stat', { path: 'a.txt' })).data).toMatchObject({ exists: true, size: 5 })
    for (const path of ['link-env', 'ignored.log', '.env', 'src']) expect((await ask('fs.stat', { path })).data, path).toEqual({ exists: false, sig: null })
    const img = await ask('fs.image', { path: 'pic.png' })
    expect(img.data.dataUrl).toBe(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)
    expect((await ask('fs.image', { path: 'a.txt' })).code).toBe('not-file')
  })

  it('a file that names a host path keeps its text; a search snippet does not', async () => {
    remote.state.tree['paths.txt'] = { text: 'see /home/me/app/src for it' }
    const read = await ask('fs.read', { path: 'paths.txt' })
    expect(read.data.text).toContain('/home/me/app')
    const found = await ask('fs.searchContent', { query: 'see' })
    expect(JSON.stringify(found)).not.toContain('/home/me/app')
  })
})

describe('searching', () => {
  it('by name and by text, without hidden, ignored, linked or nested files, and no hidden count', async () => {
    expect((await ask('fs.searchNames', { query: 'main' })).data.results.map((r) => r.rel)).toEqual(['src/main.js'])
    const names = (await ask('fs.searchNames', { query: 'e' })).data.results.map((r) => r.rel)
    for (const bad of ['.env', 'src/key.pem', 'build/out.js', '.git/config', 'nested/n.txt', 'linkdir/inner.txt']) expect(names).not.toContain(bad)
    expect((await ask('fs.searchNames', { query: 'main', dir: 'deep' })).data.results).toEqual([])
    const content = await ask('fs.searchContent', { query: 'main' })
    expect(content.data.results.map((r) => r.rel).sort()).toEqual(['deep/a/b/c.txt', 'src/main.js'])
    expect(content.data.hidden).toBe(0)
    expect((await ask('fs.searchContent', { query: 'SECRET' })).data.results).toEqual([])
  })
})

describe('the project and its arguments', () => {
  it('refuses absolute and traversing paths and unknown shapes; unshared ops say remote-project', async () => {
    for (const path of ['/etc/passwd', '../x', 'a/../../x', 'C:\\x', '\\\\h\\s', 'ssh://ssh-a1/etc']) expect((await ask('fs.read', { path })).code, path).toBe('bad-args')
    expect((await ask('fs.list', { dir: 5 })).code).toBe('bad-args')
    for (const op of ['fs.nope', 'scm.status', 'notes.load', 'fs.create', 'fs.trash', 'fs.rename', 'review.info'])
      expect((await ask(op, { path: 'a.txt', name: 'b', task: 'x' }, { rights: { edit: true, git: true } })).code, op).toBe('remote-project')
    expect((await ask('fs.status', {})).data).toEqual({ repo: false, files: {}, hidden: 0 })
    expect((await ask('fs.sparse', {})).data).toEqual({ sparse: false, dirs: [] })
  })

  it('only the host\'s own saved project; a broad root, or one whose real path is broad or in a git folder, shares nothing', async () => {
    const other = await rig.handle({ op: 'fs.list', project: 'p9', args: {} }, { remoteRoots: new Map([['p1', ROOT]]), rights: READ, settings: {} })
    expect(other.code).toBe('remote-project')
    const unsaved = await rig.handle({ op: 'fs.list', project: 'p1', args: {} }, { remoteRoots: new Map([['p1', 'ssh://ssh-zz/srv/other']]), rights: READ, settings: {} })
    expect(unsaved.code).toBe('remote-project')
    const broad = await rig.handle({ op: 'fs.list', project: 'p1', args: {} }, { remoteRoots: new Map([['p1', 'ssh://ssh-a1/home/me']]), rights: READ, settings: {} })
    expect(broad.code).toBe('remote-project')
    expect(remote.state.calls).toEqual([])
    for (const real of ['/home/me', '/etc/app', '/srv/repo/.git/objects']) {
      rig.reset()
      remote.state.real = real
      expect((await ask('fs.list', {})).code, real).toBe('remote-project')
      expect(remote.state.calls.at(-1)).toBe('info')
    }
  })

  it('the real path is read again after a while; not known: nothing is given', async () => {
    let clock = 1000
    rig = createRemoteShareFiles({ remote: remote.svc, now: () => clock })
    await ask('fs.list', {})
    await ask('fs.read', { path: 'a.txt' })
    expect(remote.state.calls.filter((c) => c === 'info')).toHaveLength(1)
    clock += INFO_TTL_MS + 1
    remote.state.laneDown = true
    expect((await ask('fs.list', {})).code).toBe('busy')
    remote.state.laneDown = false
    expect((await ask('fs.list', {})).ok).toBe(true)
  })

  it('cleans the root the window gives', () => {
    expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: '/home/me/app' })).toBe(ROOT)
    expect(cleanRemoteRoot({ hostId: 'evil', path: '/x' })).toBeNull()
    expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: 'relative' })).toBeNull()
    expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: '/home/me' })).toBeNull()
    expect(cleanRemoteRoot(null)).toBeNull()
  })
})

describe('saving', () => {
  const read = async (path) => (await ask('fs.read', { path }, { rights: EDIT })).data

  it('needs the edit right', async () => {
    const cur = await read('a.txt')
    expect((await ask('fs.write', { path: 'a.txt', text: 'new', expectHash: cur.hash })).code).toBe('forbidden')
    expect(remote.state.calls).not.toContain('write')
  })

  it('saves over the version the guest read, the host comparing its own hash at the rename', async () => {
    const cur = await read('a.txt')
    const res = await ask('fs.write', { path: 'a.txt', text: 'new', expectHash: cur.hash }, { rights: EDIT, ...OK })
    expect(res.ok).toBe(true)
    expect(res.data.hash).toBe(hashOf(Buffer.from('new')))
    expect(remote.state.written).toMatchObject({ rel: 'a.txt', expectHash: sha(Buffer.from('hello')), createOnly: false })
    // Old now: a conflict, nothing written again.
    remote.state.written = null
    expect((await ask('fs.write', { path: 'a.txt', text: 'other', expectHash: cur.hash }, { rights: EDIT, ...OK })).code).toBe('conflict')
    expect(remote.state.written).toBeNull()
  })

  it('a file there is replaced only with a version; a new one only if nothing is there', async () => {
    expect((await ask('fs.write', { path: 'a.txt', text: 'x' }, { rights: EDIT, ...OK })).code).toBe('conflict')
    const made = await ask('fs.write', { path: 'src/new.js', text: 'ok' }, { rights: EDIT, ...OK })
    expect(made.ok).toBe(true)
    expect(remote.state.written).toMatchObject({ rel: 'src/new.js', createOnly: true })
  })

  it('a host without sha256 (cksum): the file is compared here first, then by the host with its own hash', async () => {
    remote.state.hashKind = 'other'
    const cur = await read('a.txt')
    const res = await ask('fs.write', { path: 'a.txt', text: 'new', expectHash: cur.hash }, { rights: EDIT, ...OK })
    expect(res.ok).toBe(true)
    expect(remote.state.written.expectHash).toBe('cksum:5:1')
    expect((await ask('fs.write', { path: 'a.txt', text: 'x', expectHash: cur.hash }, { rights: EDIT, ...OK })).code).toBe('conflict')
  })

  it('never writes .git, .tessel, secrets, links, nested repositories, ignored files, the protected files or the hooks folder without the type right', async () => {
    remote.state.hooks = ['scripts/hooks']
    for (const path of ['.git/hooks/pre-commit', '.tessel/notes.md', '.env', 'link-env', 'build/out.js', 'ignored.log', 'linkdir/inner.txt', 'nested/n.txt', '.vscode/tasks.json', 'scripts/hooks/pre-commit', 'CLAUDE.md', '.gitignore']) {
      const res = await ask('fs.write', { path, text: 'x', expectHash: hashOf(Buffer.from('x')) }, { rights: EDIT, ...OK })
      expect(res.code, path).toBe('not-allowed')
    }
    expect(remote.state.written).toBeNull()
    const ok = await ask('fs.write', { path: '.vscode/launch.json', text: 'x' }, { rights: { edit: true, type: true }, ...OK })
    expect(ok.ok).toBe(true)
  })

  it('the project folder as hooks folder protects its top-level hook names; an unknown hooks folder: nothing is written', async () => {
    remote.state.hooks = ['']
    expect((await ask('fs.write', { path: 'pre-commit', text: 'x' }, { rights: EDIT, ...OK })).code).toBe('not-allowed')
    expect((await ask('fs.write', { path: 'src/pre-commit', text: 'x' }, { rights: EDIT, ...OK })).ok).toBe(true)
    rig.reset()
    remote.state.hooks = null
    expect((await ask('fs.write', { path: 'src/other.js', text: 'x' }, { rights: EDIT, ...OK })).code).toBe('not-allowed')
    expect((await ask('fs.read', { path: 'a.txt' }, { rights: EDIT })).data.readOnly).toBe(true)
  })

  it('refuses a save over the limit and one the guest lost the right for (asked right before the write)', async () => {
    expect((await ask('fs.write', { path: 'src/n.js', text: 'x'.repeat(L.writeBytes + 1) }, { rights: EDIT })).code).toBe('bad-args')
    expect((await ask('fs.write', { path: 'src/n.js', text: 'x'.repeat(L.writeBytes - 1), bom: true }, { rights: EDIT, ...OK })).code).toBe('too-large')
    expect((await ask('fs.write', { path: 'src/n.js', text: 'ok' }, { rights: EDIT, recheck: async () => false })).code).toBe('revoked')
    expect((await ask('fs.write', { path: 'src/n.js', text: 'ok' }, { rights: EDIT, recheck: async () => { throw new Error('x') } })).code).toBe('revoked')
    expect(remote.state.calls).not.toContain('write')
  })
})

describe("the host's session and the guests' load", () => {
  it('a server that is not connected: host-offline, nothing asked; only the guests\' lane down: busy', async () => {
    remote.state.connected = false
    expect((await ask('fs.list', {})).code).toBe('host-offline')
    expect(remote.state.calls).toEqual([])
    remote.state.connected = true
    remote.state.laneDown = true
    expect((await ask('fs.list', {})).code).toBe('busy')
  })

  it('a few requests at once per host, a few waiting, a few per person; the rest busy', async () => {
    remote.state.delay = 20
    const all = []
    for (let i = 0; i < MAX_ACTIVE + MAX_WAITING + 3; i++)
      all.push(rig.handle({ op: 'fs.stat', project: 'p1', args: { path: 'a.txt' } }, { remoteRoots: new Map([['p1', ROOT]]), rights: READ, settings: {}, person: `g${i}` }))
    const res = await Promise.all(all)
    expect(res.filter((r) => r.code === 'busy').length).toBeGreaterThan(0)
    expect(remote.state.maxInflight).toBeLessThanOrEqual(MAX_ACTIVE)
    const one = []
    for (let i = 0; i < MAX_PER_PERSON + 2; i++) one.push(ask('fs.stat', { path: 'a.txt' }, { person: 'same' }))
    expect((await Promise.all(one)).filter((r) => r.code === 'busy')).toHaveLength(2)
  })

  it('every code it answers is a known one', async () => {
    const codes = new Set()
    for (const [op, args, extra] of [
      ['fs.read', { path: 'big.txt' }],
      ['fs.read', { path: 'blob.bin' }],
      ['fs.write', { path: 'a.txt', text: 'x' }, { rights: EDIT, ...OK }],
      ['fs.list', { dir: 'nested' }],
      ['fs.read', { path: 'src' }]
    ])
      codes.add((await ask(op, args, extra)).code)
    for (const c of codes) expect(LSHARE_CODES).toContain(c)
  })
})

describe("the guest's side", () => {
  it('knows the host-offline code, words it and keeps what is shown (transient)', async () => {
    expect(LSHARE_CODES).toContain('host-offline')
    const gfs = createGuestFs({ request: async () => ({ ok: false, code: 'host-offline' }) })
    const res = await gfs.listDir({ root: 'lshare://p1', dir: 'lshare://p1' })
    expect(res).toMatchObject({ ok: false, code: 'host-offline', transient: true })
    expect(res.error).toMatch(/not connected/)
  })

  it('shows the files the host sent for an SSH project like a local one', async () => {
    const gfs = createGuestFs({ request: (op, project, args) => rig.handle({ op, project, args }, { remoteRoots: new Map([[project, ROOT]]), rights: READ, settings: {} }) })
    const list = await gfs.listDir({ root: 'lshare://p1', dir: 'lshare://p1' })
    expect(list.ok).toBe(true)
    expect(list.entries.map((e) => e.name)).toContain('src')
    expect(await gfs.readForEdit('lshare://p1\\src\\main.js')).toMatchObject({ ok: true, text: 'main', readOnly: true })
  })
})
