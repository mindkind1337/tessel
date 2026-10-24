// Live Share: the files of a shared SSH project, read through the host's own
// remote session (src/main/liveShare/shareRemoteFiles.js), on a fake remoteFs
// holding a small tree. Guests get the Files tab's data with the rules of a
// local shared project: the secret names, what git ignores, .git and .tessel
// hidden; a link never followed; rights per op; sizes and the number of
// requests on the host's one session capped; a server that is not connected
// answers 'host-offline' (and never starts a sign-in); no host path or
// server detail in any answer.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createRemoteShareFiles,
  MAX_ACTIVE,
  MAX_WAITING,
  MAX_PER_PERSON
} from '../liveShare/shareRemoteFiles'
import { hashOf } from '../editorFiles'
import { LSHARE_CODES, LSHARE_LIMITS as L } from '../../shared/liveSharePath'
import { createGuestFs } from '../liveShare/guestFs'
import { cleanRemoteRoot } from '../liveShare'

const ROOT = 'ssh://ssh-a1/home/me/app'
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const sep = (p) => p.replace(/\\/g, '/')

// A tree: path -> { dir } | { link, dir? } | { text, bom? } | { buf }.
function fakeRemote(tree) {
  const state = {
    connected: true,
    calls: [],
    inflight: 0,
    maxInflight: 0,
    ignored: [],
    statusFails: false,
    delay: 0,
    tree
  }
  const rel = (v) => {
    const p = sep(v)
    if (p === ROOT) return ''
    return p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : null
  }
  const kids = (dir) => {
    const pre = dir ? `${dir}/` : ''
    const out = []
    for (const [k, v] of Object.entries(state.tree)) {
      if (!k.startsWith(pre) || k === dir) continue
      const rest = k.slice(pre.length)
      if (rest.includes('/')) continue
      out.push([rest, v])
    }
    return out
  }
  const bytes = (v) =>
    Buffer.concat([v.bom ? BOM : Buffer.alloc(0), v.buf || Buffer.from(v.text || '', 'utf8')])
  const stat = (v) => ({ size: bytes(v).length, mtimeMs: v.mtime || 1000 })
  const track = async (name, fn) => {
    state.calls.push(name)
    state.inflight++
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    try {
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay))
      return fn()
    } finally {
      state.inflight--
    }
  }
  const svc = {
    hasRoot: (v) => v === ROOT,
    connectedQuietly: () => state.connected,
    listDir: ({ root, dir }) =>
      track('listDir', () => {
        if (!state.connected)
          return { ok: false, error: 'ssh me@secret-host:22 down', transient: true }
        const r = rel(dir || root)
        if (r === null) return { ok: false, error: 'Outside the project.' }
        if (r && !(state.tree[r] && state.tree[r].dir))
          return { ok: false, error: 'The folder is gone: /home/me/app/' + r }
        return {
          ok: true,
          truncated: false,
          entries: kids(r).map(([name, v]) => ({
            name,
            path: `${ROOT}\\${name}`,
            dir: !!v.dir,
            ...(v.link ? { link: true } : {})
          }))
        }
      }),
    listMany: ({ dirs }) =>
      track('listMany', () => {
        if (!state.connected) return { ok: false, error: 'down', transient: true }
        return {
          ok: true,
          results: dirs.map((d) => {
            const r = rel(d)
            if (r === null || (r && !(state.tree[r] && state.tree[r].dir)))
              return { dir: d, ok: false, error: 'gone' }
            return {
              dir: d,
              ok: true,
              truncated: false,
              entries: kids(r).map(([name, v]) => ({
                name,
                dir: !!v.dir,
                ...(v.link ? { link: true } : {})
              }))
            }
          })
        }
      }),
    statForEdit: (file) =>
      track('stat', () => {
        const v = state.tree[rel(file)]
        if (!state.connected) return { ok: false, error: 'down' }
        return v && !v.dir
          ? { ok: true, exists: true, ...stat(v), sig: 'r:1:2:3' }
          : { ok: true, exists: false, sig: null }
      }),
    readForEdit: (file) =>
      track('read', () => {
        if (!state.connected) return { ok: false, error: 'down', code: 'error' }
        const v = state.tree[rel(file)]
        if (!v) return { ok: false, error: 'x', code: 'missing' }
        if (v.dir) return { ok: false, error: 'x', code: 'not-file' }
        if (v.buf) return { ok: false, error: 'x', code: 'binary' }
        const b = bytes(v)
        return {
          ok: true,
          text: v.text,
          bom: !!v.bom,
          size: b.length,
          ...stat(v),
          sig: 'r:1:2:3',
          hash: `sha256:${hashOf(b)}`
        }
      }),
    writeForEdit: ({ file, text, bom, expectHash, expectSig }) =>
      track('write', () => {
        if (!state.connected) return { ok: false, error: 'down' }
        const r = rel(file)
        const cur = state.tree[r]
        if (cur && expectHash && expectHash !== `sha256:${hashOf(bytes(cur))}`)
          return { ok: false, conflict: true }
        if (cur && !expectHash && expectSig === undefined) return { ok: false, error: 'no guard' }
        state.tree[r] = { text, bom, mtime: 5000 }
        state.written = { r, text, bom, expectHash, expectSig }
        return { ok: true, ...stat(state.tree[r]) }
      }),
    readImage: (file) =>
      track('image', () => {
        const v = state.tree[rel(file)]
        return v
          ? {
              ok: true,
              kind: 'image',
              size: bytes(v).length,
              dataUrl: `data:image/png;base64,${bytes(v).toString('base64')}`
            }
          : { ok: false, error: 'x' }
      }),
    searchNames: ({ query }) =>
      track('names', () => ({
        ok: true,
        truncated: false,
        results: Object.entries(state.tree)
          .filter(([k]) => k.toLowerCase().includes(String(query).toLowerCase()))
          .map(([k, v]) => ({ name: k.split('/').pop(), rel: k, dir: !!v.dir }))
      })),
    searchContent: ({ query }) =>
      track('content', () => ({
        ok: true,
        truncated: false,
        results: Object.entries(state.tree)
          .filter(([, v]) => typeof v.text === 'string' && v.text.includes(query))
          .map(([k, v]) => ({ rel: k, line: 1, text: v.text }))
      })),
    projectStatus: () =>
      track('status', () => {
        if (state.statusFails) return { ok: false, error: 'git failed at /home/me/app' }
        const files = {}
        for (const p of state.ignored) files[`${ROOT}\\${p.replace(/\//g, '\\')}`] = '!'
        return { ok: true, repo: true, files }
      })
  }
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
  'link-env': { link: true, text: '' },
  linkdir: { link: true, dir: true },
  'linkdir/inner.txt': { text: 'inside the link' },
  'pic.png': { buf: Buffer.from([1, 2, 3]) },
  'blob.bin': { buf: Buffer.from([0, 1, 2, 0]) },
  'big.txt': { text: 'x'.repeat(L.textBytes + 10) },
  CI: { dir: true },
  '.vscode': { dir: true },
  '.vscode/tasks.json': { text: '{}' }
})

let rig
let remote
const READ = { edit: false, git: false, type: false }
const EDIT = { edit: true, type: false }
const ask = (op, args, extra = {}) =>
  rig.handle(
    { op, project: 'p1', args },
    { remoteRoots: new Map([['p1', ROOT]]), rights: READ, settings: {}, ...extra }
  )

beforeEach(() => {
  remote = fakeRemote(baseTree())
  remote.state.ignored = ['build', 'ignored.log']
  rig = createRemoteShareFiles({ remote: remote.svc })
})

describe('listing and reading', () => {
  it('lists the visible entries only, hidden ones counted not named, links left out', async () => {
    const res = await ask('fs.list', {})
    expect(res.ok).toBe(true)
    const names = res.data.entries.map((e) => e.name).sort()
    expect(names).toContain('a.txt')
    expect(names).toContain('src')
    for (const n of ['.env', '.git', '.tessel', 'build', 'ignored.log', 'link-env', 'linkdir'])
      expect(names).not.toContain(n)
    expect(res.data.hidden).toBeGreaterThanOrEqual(5)
    expect(JSON.stringify(res)).not.toContain('/home/me')
  })

  it('hides the secret names inside a folder and never lists a folder that git ignores', async () => {
    const res = await ask('fs.list', { dir: 'src' })
    expect(res.data.entries.map((e) => e.name)).toEqual(['main.js'])
    expect((await ask('fs.list', { dir: 'build' })).code).toBe('not-found')
    expect((await ask('fs.list', { dir: '.git' })).code).toBe('not-found')
  })

  it('with the setting off, ignored and secret files show; .git and .tessel stay hidden', async () => {
    const res = await ask('fs.list', {}, { settings: { hideIgnored: false } })
    const names = res.data.entries.map((e) => e.name)
    expect(names).toContain('.env')
    expect(names).toContain('build')
    expect(names).not.toContain('.git')
    expect(remote.state.calls).not.toContain('status')
    expect(
      (await ask('fs.read', { path: '.git/config' }, { settings: { hideIgnored: false } })).code
    ).toBe('not-found')
  })

  it('reads a file with its hash, signature and read-only flag; a BOM is reported', async () => {
    const res = await ask('fs.read', { path: 'bom.txt' })
    expect(res.ok).toBe(true)
    expect(res.data.text).toBe('héllo')
    expect(res.data.bom).toBe(true)
    expect(res.data.hash).toBe(hashOf(Buffer.concat([BOM, Buffer.from('héllo')])))
    expect(res.data.sig).toMatch(/^\d+:\d+$/)
    expect(res.data.readOnly).toBe(true)
    expect((await ask('fs.read', { path: 'a.txt' }, { rights: EDIT })).data.readOnly).toBe(false)
  })

  it('refuses the hidden, ignored, secret and special files as not found', async () => {
    for (const path of [
      '.env',
      'src/key.pem',
      'build/out.js',
      'ignored.log',
      '.git/config',
      '.tessel/notes.md'
    ]) {
      expect((await ask('fs.read', { path })).code, path).toBe('not-found')
    }
  })

  it('refuses a link, a file below a link, a binary file, a folder and a missing file', async () => {
    expect((await ask('fs.read', { path: 'link-env' })).code).toBe('not-found')
    expect((await ask('fs.read', { path: 'linkdir/inner.txt' })).code).toBe('not-found')
    expect((await ask('fs.list', { dir: 'linkdir' })).code).toBe('not-found')
    expect((await ask('fs.read', { path: 'blob.bin' })).code).toBe('binary')
    expect((await ask('fs.read', { path: 'src' })).code).toBe('not-file')
    expect((await ask('fs.read', { path: 'nope.txt' })).code).toBe('not-found')
    expect((await ask('fs.stat', { path: 'link-env' })).data).toEqual({ exists: false, sig: null })
  })

  it('reads nothing larger than the limit (the size is asked first)', async () => {
    const res = await ask('fs.read', { path: 'big.txt' })
    expect(res.code).toBe('too-large')
    expect(remote.state.calls).not.toContain('read')
  })

  it('fails closed when the ignored files cannot be read', async () => {
    remote.state.statusFails = true
    expect((await ask('fs.list', {})).code).toBe('failed')
    expect((await ask('fs.read', { path: 'a.txt' })).code).toBe('failed')
  })

  it('stats a file and serves an image within the limit', async () => {
    const st = await ask('fs.stat', { path: 'a.txt' })
    expect(st.data).toMatchObject({ exists: true, size: 5 })
    const img = await ask('fs.image', { path: 'pic.png' })
    expect(img.data.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect((await ask('fs.image', { path: 'a.txt' })).code).toBe('not-file')
  })

  it('lists many folders in one answer, each checked', async () => {
    const res = await ask('fs.listMany', { dirs: ['', 'src', 'build', 'linkdir'] })
    const by = Object.fromEntries(res.data.results.map((r) => [r.dir, r]))
    expect(by[''].ok).toBe(true)
    expect(by.src.entries.map((e) => e.name)).toEqual(['main.js'])
    expect(by.build.ok).toBe(false)
    expect(by.linkdir.ok).toBe(false)
  })

  it('searches by name and by content without the hidden files', async () => {
    expect((await ask('fs.searchNames', { query: 'main' })).data.results.map((r) => r.rel)).toEqual(
      ['src/main.js']
    )
    const names = await ask('fs.searchNames', { query: 'e' })
    const found = names.data.results.map((r) => r.rel)
    expect(found.length).toBeGreaterThan(0)
    for (const bad of ['.env', 'src/key.pem', 'build/out.js', '.git/config'])
      expect(found).not.toContain(bad)
    const content = await ask('fs.searchContent', { query: 'SECRET' })
    expect(content.data.results).toEqual([])
    expect(content.data.hidden).toBe(0)
    expect(
      (await ask('fs.searchContent', { query: 'main' })).data.results.map((r) => r.rel)
    ).toEqual(['src/main.js'])
  })

  it('answers the git views with nothing and keeps notes and changes unshared', async () => {
    expect((await ask('fs.status', {})).data).toEqual({ repo: false, files: {}, hidden: 0 })
    expect((await ask('fs.sparse', {})).data).toEqual({ sparse: false, dirs: [] })
    for (const op of [
      'scm.status',
      'notes.load',
      'fs.create',
      'fs.trash',
      'fs.rename',
      'fs.fileList',
      'review.info'
    ]) {
      expect(
        (
          await ask(
            op,
            { path: 'a.txt', name: 'b', task: 'x' },
            { rights: { edit: true, git: true } }
          )
        ).code,
        op
      ).toBe('remote-project')
    }
  })
})

describe('arguments and the project', () => {
  it('refuses absolute and traversing paths and unknown arguments shapes', async () => {
    for (const path of [
      '/etc/passwd',
      '../x',
      'a/../../x',
      'C:\\x',
      '\\\\h\\s',
      'ssh://ssh-a1/etc'
    ]) {
      expect((await ask('fs.read', { path })).code, path).toBe('bad-args')
    }
    expect((await ask('fs.list', { dir: 5 })).code).toBe('bad-args')
    expect((await ask('fs.nope', {})).code).toBe('remote-project')
  })

  it('takes the folder from the host only: a project it has no SSH root for is refused', async () => {
    const res = await rig.handle(
      { op: 'fs.list', project: 'p9', args: {} },
      { remoteRoots: new Map([['p1', ROOT]]), rights: READ, settings: {} }
    )
    expect(res.code).toBe('remote-project')
    const unknown = await rig.handle(
      { op: 'fs.list', project: 'p1', args: { hostId: 'ssh-evil', root: 'ssh://ssh-evil/' } },
      { remoteRoots: new Map([['p1', 'ssh://ssh-zz/other']]), rights: READ, settings: {} }
    )
    expect(unknown.code).toBe('remote-project') // not one of the saved projects
    expect(remote.state.calls).toEqual([])
  })

  it('cleans the root the window gives', () => {
    expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: '/home/me/app' })).toBe(ROOT)
    expect(cleanRemoteRoot({ hostId: 'evil', path: '/x' })).toBeNull()
    expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: 'relative' })).toBeNull()
    expect(cleanRemoteRoot(null)).toBeNull()
  })
})

describe('saving', () => {
  const read = async (path) => (await ask('fs.read', { path }, { rights: EDIT })).data

  it('needs the edit right', async () => {
    const cur = await read('a.txt')
    const res = await ask('fs.write', { path: 'a.txt', text: 'new', expectHash: cur.hash })
    expect(res.code).toBe('forbidden')
    expect(remote.state.calls).not.toContain('write')
  })

  it('saves over the version the guest read, and checks the host did not change it', async () => {
    const cur = await read('a.txt')
    const res = await ask(
      'fs.write',
      { path: 'a.txt', text: 'new', expectHash: cur.hash },
      { rights: EDIT, recheck: async () => true }
    )
    expect(res.ok).toBe(true)
    expect(res.data.hash).toBe(hashOf(Buffer.from('new')))
    expect(remote.state.written.expectHash).toMatch(/^sha256:/) // the host compares again at the write
    // The guest's hash is old now: a conflict, nothing written again.
    remote.state.written = null
    const again = await ask(
      'fs.write',
      { path: 'a.txt', text: 'other', expectHash: cur.hash },
      { rights: EDIT, recheck: async () => true }
    )
    expect(again.code).toBe('conflict')
    expect(remote.state.written).toBeNull()
  })

  it('replaces an existing file only with the hash of what the guest read', async () => {
    const res = await ask(
      'fs.write',
      { path: 'a.txt', text: 'x' },
      { rights: EDIT, recheck: async () => true }
    )
    expect(res.code).toBe('conflict')
  })

  it('creates a new file', async () => {
    const res = await ask(
      'fs.write',
      { path: 'src/new.js', text: 'ok' },
      { rights: EDIT, recheck: async () => true }
    )
    expect(res.ok).toBe(true)
    expect(remote.state.tree['src/new.js'].text).toBe('ok')
  })

  it('never writes .git, .tessel, secrets, links, ignored files or the protected files without the type right', async () => {
    for (const path of [
      '.git/hooks/pre-commit',
      '.tessel/notes.md',
      '.env',
      'link-env',
      'build/out.js',
      'linkdir/inner.txt',
      '.vscode/tasks.json'
    ]) {
      const res = await ask(
        'fs.write',
        { path, text: 'x', expectHash: hashOf(Buffer.from('x')) },
        { rights: EDIT, recheck: async () => true }
      )
      expect(['not-allowed', 'not-found'], `${path}: ${res.code}`).toContain(res.code)
    }
    expect(remote.state.calls).not.toContain('write')
    const ok = await ask(
      'fs.write',
      { path: '.vscode/launch.json', text: 'x' },
      { rights: { edit: true, type: true }, recheck: async () => true }
    )
    expect(ok.ok).toBe(true)
  })

  it('refuses a save over the limit and one the guest lost the right for', async () => {
    const big = 'x'.repeat(L.writeBytes + 1)
    expect((await ask('fs.write', { path: 'src/n.js', text: big }, { rights: EDIT })).code).toBe(
      'bad-args'
    )
    const res = await ask(
      'fs.write',
      { path: 'src/n.js', text: 'ok' },
      { rights: EDIT, recheck: async () => false }
    )
    expect(res.code).toBe('revoked')
    expect(remote.state.calls).not.toContain('write')
  })

  it('turns a changed ignore list into effect after a save', async () => {
    await ask(
      'fs.write',
      { path: 'src/n.js', text: 'ok' },
      { rights: EDIT, recheck: async () => true }
    )
    const before = remote.state.calls.filter((c) => c === 'status').length
    await ask('fs.list', {})
    expect(remote.state.calls.filter((c) => c === 'status').length).toBe(before + 1)
  })
})

describe("the host's server", () => {
  it('answers host-offline when it is not connected, and starts nothing', async () => {
    remote.state.connected = false
    for (const [op, args] of [
      ['fs.list', {}],
      ['fs.read', { path: 'a.txt' }],
      ['fs.searchNames', { query: 'a' }],
      ['fs.status', {}]
    ]) {
      const res = await ask(op, args)
      expect(res, op).toEqual({ ok: false, code: 'host-offline' })
    }
    expect(remote.state.calls).toEqual([])
  })

  it('answers host-offline when the connection drops during a request, never its text', async () => {
    const orig = remote.svc.listDir
    remote.svc.listDir = async (q) => {
      remote.state.connected = false
      return orig(q)
    }
    const res = await ask('fs.list', {})
    expect(res.ok).toBe(false)
    expect(res.code).toBe('host-offline')
    expect(JSON.stringify(res)).not.toMatch(/secret-host|ssh me/)
  })

  it('works again once it is connected (nothing stale is kept)', async () => {
    remote.state.connected = false
    expect((await ask('fs.list', {})).code).toBe('host-offline')
    remote.state.connected = true
    expect((await ask('fs.list', {})).ok).toBe(true)
  })

  it('never lets an error text of the host through (paths, hosts)', async () => {
    const res = await ask('fs.list', { dir: 'src' })
    remote.state.tree.src = { dir: true }
    delete remote.state.tree['src/main.js']
    const gone = await ask('fs.list', { dir: 'gone' })
    expect(res.ok).toBe(true)
    expect(Object.keys(gone).sort()).toEqual(['code', 'ok'])
    expect(JSON.stringify(gone)).not.toContain('/home/me')
  })
})

describe("caps on the host's session", () => {
  it('runs at most MAX_ACTIVE requests at once per host and refuses beyond the queue', async () => {
    remote.state.delay = 5
    const asks = []
    for (let i = 0; i < MAX_ACTIVE + MAX_WAITING + 4; i++)
      asks.push(ask('fs.stat', { path: 'a.txt' }, { person: `p:${i}` }))
    const out = await Promise.all(asks)
    expect(remote.state.maxInflight).toBeLessThanOrEqual(MAX_ACTIVE)
    expect(out.filter((r) => r.code === 'busy').length).toBe(4)
    expect(out.filter((r) => r.ok).length).toBe(MAX_ACTIVE + MAX_WAITING)
  })

  it('limits one person to MAX_PER_PERSON requests running or waiting', async () => {
    remote.state.delay = 5
    const asks = []
    for (let i = 0; i < MAX_PER_PERSON + 3; i++)
      asks.push(ask('fs.stat', { path: 'a.txt' }, { person: 'p:one' }))
    const out = await Promise.all(asks)
    expect(out.filter((r) => r.code === 'busy').length).toBe(3)
    // The room is given back.
    expect((await ask('fs.stat', { path: 'a.txt' }, { person: 'p:one' })).ok).toBe(true)
  })

  it("cuts a listing to the limit and a search to the guest's limit", async () => {
    for (let i = 0; i < 30; i++) remote.state.tree[`src/file${i}.js`] = { text: 'x' }
    const names = await ask('fs.searchNames', { query: 'file', limit: 10 })
    expect(names.data.results).toHaveLength(10)
    expect(names.data.truncated).toBe(true)
  })

  it('asks the ignored files once for a few seconds', async () => {
    await ask('fs.list', {})
    await ask('fs.list', { dir: 'src' })
    await ask('fs.read', { path: 'a.txt' })
    expect(remote.state.calls.filter((c) => c === 'status')).toHaveLength(1)
  })
})

describe("the guest's side", () => {
  it('knows the host-offline code, words it and keeps what is shown (transient)', async () => {
    expect(LSHARE_CODES).toContain('host-offline')
    const fs = createGuestFs({ request: async () => ({ ok: false, code: 'host-offline' }) })
    const res = await fs.listDir({ root: 'lshare://p1', dir: 'lshare://p1' })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('host-offline')
    expect(res.transient).toBe(true)
    expect(res.error).toMatch(/not connected/)
  })

  it('shows the files the host sent for an SSH project like a local one', async () => {
    const fs = createGuestFs({
      request: (op, project, args) =>
        rig.handle(
          { op, project, args },
          { remoteRoots: new Map([[project, ROOT]]), rights: READ, settings: {} }
        )
    })
    const list = await fs.listDir({ root: 'lshare://p1', dir: 'lshare://p1' })
    expect(list.ok).toBe(true)
    expect(list.entries.map((e) => e.name)).toContain('src')
    const file = await fs.readForEdit('lshare://p1\\src\\main.js')
    expect(file).toMatchObject({ ok: true, text: 'main', readOnly: true })
  })
})
