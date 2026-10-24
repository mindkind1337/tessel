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
import { remoteRootTooBroad } from '../../shared/remoteRootPolicy'

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
    unguarded: [],
    hooks: [],
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
  // Every call must be a guest's (guest: true): the others are listed.
  const track = async (name, o, fn) => {
    state.calls.push(name)
    if (!(o && o.guest === true)) state.unguarded.push(name)
    state.inflight++
    state.maxInflight = Math.max(state.maxInflight, state.inflight)
    try {
      if (state.delay) await new Promise((r) => setTimeout(r, state.delay))
      return fn()
    } finally {
      state.inflight--
    }
  }
  const hasGit = (r) => !!state.tree[r ? `${r}/.git` : '.git']
  const section = (r, d) => ({
    dir: d,
    ok: true,
    truncated: !!(state.truncatedDirs || []).includes(r),
    hasGit: hasGit(r) && !!r,
    entries: kids(r)
      .filter(([name]) => name !== '.git')
      .map(([name, v]) => ({ name, dir: !!v.dir, ...(v.link ? { link: true } : {}) }))
  })
  const down = (extra = {}) => ({ ok: false, error: 'ssh me@secret-host:22 down', ...extra })
  const svc = {
    hasRoot: (v) => v === ROOT,
    connectedQuietly: () => state.connected,
    listDir: (q) =>
      track('listDir', q, () => {
        if (!state.connected) return down({ transient: true })
        const r = rel(q.dir || q.root)
        if (r === null) return { ok: false, error: 'Outside the project.' }
        if (r && !(state.tree[r] && state.tree[r].dir))
          return { ok: false, error: 'The folder is gone: /home/me/app/' + r }
        const { dir: _d, ...rest } = section(r, q.dir)
        return rest
      }),
    listMany: (q) =>
      track('listMany', q, () => {
        if (!state.connected) return down({ transient: true })
        const results = []
        for (const d of q.dirs) {
          const r = rel(d)
          if (r === null || (r && !(state.tree[r] && state.tree[r].dir))) {
            results.push({ dir: d, ok: false, error: 'gone' })
            continue
          }
          results.push(section(r, d))
          // The host's own chain of single sub-folders.
          let cur = r
          let curV = d
          while (q.chain) {
            const subs = kids(cur).filter(([n]) => n !== '.git')
            if (subs.length !== 1 || !subs[0][1].dir) break
            cur = cur ? `${cur}/${subs[0][0]}` : subs[0][0]
            curV = `${curV}\\${subs[0][0]}`
            results.push(section(cur, curV))
          }
        }
        return { ok: true, results }
      }),
    statForEdit: (file, o) =>
      track('stat', o, () => {
        const v = state.tree[rel(file)]
        if (!state.connected) return down()
        return v && !v.dir
          ? { ok: true, exists: true, ...stat(v), sig: 'r:1:2:3' }
          : { ok: true, exists: false, sig: null }
      }),
    readForEdit: (file, o) =>
      track('read', o, () => {
        if (!state.connected) return down({ code: 'error' })
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
    writeForEdit: (q) =>
      track('write', q, () => {
        const { file, text, bom, expectHash, expectSig, createOnly } = q
        if (!state.connected) return down()
        const r = rel(file)
        const cur = state.tree[r]
        if (createOnly && cur) return { ok: false, conflict: true }
        if (cur && expectHash && expectHash !== `sha256:${hashOf(bytes(cur))}`)
          return { ok: false, conflict: true }
        if (cur && !expectHash && expectSig === undefined) return { ok: false, error: 'no guard' }
        if (!cur && !createOnly) return { ok: false, error: 'a new file needs the not-there guard' }
        state.tree[r] = { text, bom, mtime: 5000 }
        state.written = { r, text, bom, expectHash, expectSig, createOnly }
        return { ok: true, ...stat(state.tree[r]) }
      }),
    readImage: (file, o) =>
      track('image', o, () => {
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
    searchNames: (q) =>
      track('names', q, () => ({
        ok: true,
        truncated: false,
        results: Object.entries(state.tree)
          .filter(([k]) => k.toLowerCase().includes(String(q.query).toLowerCase()))
          .map(([k, v]) => ({ name: k.split('/').pop(), rel: k, dir: !!v.dir }))
      })),
    searchContent: (q) =>
      track('content', q, () => ({
        ok: true,
        truncated: false,
        results: Object.entries(state.tree)
          .filter(([, v]) => typeof v.text === 'string' && v.text.includes(q.query))
          .map(([k, v]) => ({ rel: k, line: 1, text: v.text }))
      })),
    projectStatus: (q) =>
      track('status', q, () => {
        if (state.statusFails) return { ok: false, error: 'git failed at /home/me/app' }
        const files = {}
        for (const p of state.ignored) files[`${ROOT}\\${p.replace(/\//g, '\\')}`] = '!'
        return { ok: true, repo: true, files }
      }),
    hooksPathOf: (q) =>
      track('hooks', q, () =>
        state.hooks === null ? { ok: false } : { ok: true, rels: state.hooks }
      )
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

describe('security review fixes', () => {
  const OKW = { recheck: async () => true }
  const withTree = (more) => Object.assign(remote.state.tree, more)

  describe('1: the hooks folder of core.hooksPath is not writable with only edit', () => {
    beforeEach(() => {
      withTree({
        scripts: { dir: true },
        'scripts/hooks': { dir: true },
        'scripts/hooks/pre-commit': { text: '#!/bin/sh\n' }
      })
      remote.state.hooks = ['scripts/hooks']
    })

    it('refuses a write there and reads it read only; the type right allows it', async () => {
      const cur = (await ask('fs.read', { path: 'scripts/hooks/pre-commit' }, { rights: EDIT }))
        .data
      expect(cur.readOnly).toBe(true)
      const args = { path: 'scripts/hooks/pre-commit', text: 'evil', expectHash: cur.hash }
      expect((await ask('fs.write', args, { rights: EDIT, ...OKW })).code).toBe('not-allowed')
      expect(
        (await ask('fs.write', { path: 'scripts/hooks/new', text: 'x' }, { rights: EDIT, ...OKW }))
          .code
      ).toBe('not-allowed')
      expect(remote.state.calls).not.toContain('write')
      const typed = { edit: true, type: true }
      expect(
        (await ask('fs.read', { path: 'scripts/hooks/pre-commit' }, { rights: typed })).data
          .readOnly
      ).toBe(false)
      expect((await ask('fs.write', args, { rights: typed, ...OKW })).ok).toBe(true)
    })

    it('a hooks folder that cannot be read: no write at all, and everything reads read only', async () => {
      remote.state.hooks = null
      const cur = (await ask('fs.read', { path: 'a.txt' }, { rights: EDIT })).data
      expect(cur.readOnly).toBe(true)
      expect(
        (
          await ask(
            'fs.write',
            { path: 'a.txt', text: 'x', expectHash: cur.hash },
            { rights: EDIT, ...OKW }
          )
        ).code
      ).toBe('not-allowed')
      expect(
        (await ask('fs.write', { path: 'fresh.txt', text: 'x' }, { rights: EDIT, ...OKW })).code
      ).toBe('not-allowed')
      expect(remote.state.calls).not.toContain('write')
    })

    it('a project with no hooks folder set writes as before', async () => {
      remote.state.hooks = []
      const cur = (await ask('fs.read', { path: 'a.txt' }, { rights: EDIT })).data
      expect(cur.readOnly).toBe(false)
      expect(
        (
          await ask(
            'fs.write',
            { path: 'a.txt', text: 'x', expectHash: cur.hash },
            { rights: EDIT, ...OKW }
          )
        ).ok
      ).toBe(true)
    })
  })

  describe('2: the guests cannot flood the host session', () => {
    it('every call to the host is a guest call (behind its own requests, no sign-in)', async () => {
      await ask('fs.list', {})
      await ask('fs.list', { dir: 'src' })
      await ask('fs.listMany', { dirs: ['', 'src'] })
      await ask('fs.read', { path: 'src/main.js' }, { rights: EDIT })
      await ask('fs.stat', { path: 'a.txt' })
      await ask('fs.image', { path: 'pic.png' })
      await ask('fs.searchNames', { query: 'main' })
      await ask('fs.searchContent', { query: 'main' })
      const cur = (await ask('fs.read', { path: 'a.txt' }, { rights: EDIT })).data
      await ask(
        'fs.write',
        { path: 'a.txt', text: 'x', expectHash: cur.hash },
        { rights: EDIT, ...OKW }
      )
      expect(remote.state.calls.length).toBeGreaterThan(10)
      expect(remote.state.unguarded).toEqual([])
    })

    it('a save does not make the ignore list scanned again, only an ignore file does (after the minimum interval)', async () => {
      let t = 1_000_000
      rig = createRemoteShareFiles({ remote: remote.svc, now: () => t })
      const scans = () => remote.state.calls.filter((c) => c === 'status').length
      await ask('fs.list', {})
      expect(scans()).toBe(1)
      t += 4000
      await ask('fs.write', { path: 'src/n.js', text: 'ok' }, { rights: EDIT, ...OKW })
      await ask('fs.list', {})
      expect(scans()).toBe(1)
      t += 5000 // past the cache's life: scanned again
      await ask('fs.list', {})
      expect(scans()).toBe(2)
      withTree({ '.gitignore': { text: 'build\n' } })
      const typed = { edit: true, type: true }
      const cur = (await ask('fs.read', { path: '.gitignore' }, { rights: typed })).data
      await ask(
        'fs.write',
        { path: '.gitignore', text: 'build\nx\n', expectHash: cur.hash },
        { rights: typed, ...OKW }
      )
      // Stale, but not scanned again within the minimum interval.
      await ask('fs.list', {})
      expect(scans()).toBe(2)
      t += 4000
      await ask('fs.list', {})
      expect(scans()).toBe(3)
    })

    it('a scan that failed is not repeated at once either', async () => {
      remote.state.statusFails = true
      await ask('fs.list', {})
      await ask('fs.list', {})
      await ask('fs.read', { path: 'a.txt' })
      expect(remote.state.calls.filter((c) => c === 'status')).toHaveLength(1)
    })

    it("a listMany with chain is one request to the host's own chain, not a listing per folder", async () => {
      withTree({
        deep: { dir: true },
        'deep/a': { dir: true },
        'deep/a/b': { dir: true },
        'deep/a/b/c.txt': { text: 'c' }
      })
      await ask('fs.list', {}) // the root is known
      remote.state.calls.length = 0
      const res = await ask('fs.listMany', { dirs: ['deep'], chain: true })
      expect(res.data.results.map((r) => r.dir)).toEqual(['deep', 'deep/a', 'deep/a/b'])
      expect(remote.state.calls.filter((c) => c === 'listMany')).toHaveLength(1)
      // (One listing of the project's own folder checks that the folder asked is no link.)
      expect(remote.state.calls.filter((c) => c === 'listDir').length).toBeLessThanOrEqual(1)
    })

    it('a chain never goes through a link or a hidden folder', async () => {
      withTree({
        solo: { dir: true },
        'solo/next': { link: true, dir: true },
        'solo/next/x': { text: 'x' }
      })
      const res = await ask('fs.listMany', { dirs: ['solo'], chain: true })
      expect(res.data.results.map((r) => r.dir)).toEqual(['solo'])
      expect(res.data.results[0].entries).toEqual([])
    })
  })

  describe('3: a dropped session answers host-offline, never signs in', () => {
    it('a call the remote service answers not-connected is host-offline', async () => {
      const orig = remote.svc.listDir
      remote.svc.listDir = async (q) => {
        remote.state.calls.push('listDir')
        if (q.guest !== true) throw new Error('not a guest call')
        return {
          ok: false,
          error: 'x is not connected. Use Connect to sign in.',
          code: 'not-connected'
        }
      }
      const res = await ask('fs.list', {})
      expect(res).toEqual({ ok: false, code: 'host-offline' })
      remote.svc.listDir = orig
    })
  })

  describe('4: links and host paths in search results', () => {
    it('drops the hits on a link, and the names of links', async () => {
      withTree({ 'src/ln.js': { link: true, text: '/home/me/.ssh/id_rsa main' } })
      const content = await ask('fs.searchContent', { query: 'main' })
      expect(content.data.results.map((r) => r.rel)).toEqual(['src/main.js'])
      const names = await ask('fs.searchNames', { query: 'ln' })
      expect(names.data.results.map((r) => r.rel)).not.toContain('src/ln.js')
      expect(JSON.stringify([content, names])).not.toContain('.ssh')
    })

    it('scrubs the host folder from a hit text', async () => {
      withTree({ 'src/note.txt': { text: 'see /home/me/app/src/main.js main' } })
      const content = await ask('fs.searchContent', { query: 'main' })
      const hit = content.data.results.find((r) => r.rel === 'src/note.txt')
      expect(hit.text).not.toContain('/home/me/app')
    })

    it('drops results below a link folder', async () => {
      const names = await ask('fs.searchNames', { query: 'inner' })
      expect(names.data.results).toEqual([])
    })
  })

  describe('5: a nested repository is not shared', () => {
    beforeEach(() => {
      withTree({
        nested: { dir: true },
        'nested/.git': { dir: true },
        'nested/app.js': { text: 'nested main' },
        'nested/sub': { dir: true },
        'nested/sub/deep.js': { text: 'deep main' }
      })
    })

    it('lists, reads, stats, writes and searches nothing inside it', async () => {
      expect((await ask('fs.list', { dir: 'nested' })).code).toBe('not-found')
      expect((await ask('fs.list', { dir: 'nested/sub' })).code).toBe('not-found')
      expect((await ask('fs.read', { path: 'nested/app.js' })).code).toBe('not-found')
      expect((await ask('fs.read', { path: 'nested/sub/deep.js' })).code).toBe('not-found')
      expect((await ask('fs.stat', { path: 'nested/app.js' })).data).toEqual({
        exists: false,
        sig: null
      })
      expect(
        (await ask('fs.write', { path: 'nested/x.js', text: 'x' }, { rights: EDIT, ...OKW })).code
      ).toBe('not-allowed')
      const found = (await ask('fs.searchContent', { query: 'main' })).data.results.map(
        (r) => r.rel
      )
      expect(found).toEqual(['src/main.js'])
      expect((await ask('fs.searchNames', { query: 'deep' })).data.results).toEqual([])
      const many = await ask('fs.listMany', { dirs: ['nested', 'src'] })
      expect(many.data.results.find((r) => r.dir === 'nested').ok).toBe(false)
      expect(many.data.results.find((r) => r.dir === 'src').ok).toBe(true)
    })

    it('a folder too large to look for a .git in is refused too, the project itself is not', async () => {
      remote.state.truncatedDirs = ['src']
      expect((await ask('fs.list', { dir: 'src' })).code).toBe('too-large')
      remote.state.truncatedDirs = ['']
      expect((await ask('fs.list', {})).ok).toBe(true)
    })

    it('the project itself may be a repository (its own .git)', async () => {
      expect((await ask('fs.list', {})).ok).toBe(true)
    })
  })

  describe('7: an undecided repository is unreadable for guests, no dialog', () => {
    it('answers failed (nothing shown) when the ignored files cannot be read', async () => {
      remote.state.statusFails = true
      expect((await ask('fs.list', {})).code).toBe('failed')
    })
  })

  describe('8: creating a file', () => {
    it('asks the host for a not-there guard; a file made meanwhile is not overwritten', async () => {
      const res = await ask(
        'fs.write',
        { path: 'src/new.js', text: 'ok' },
        { rights: EDIT, ...OKW }
      )
      expect(res.ok).toBe(true)
      expect(remote.state.written.createOnly).toBe(true)
      // The host says something is there now (another process made it).
      const orig = remote.svc.writeForEdit
      remote.svc.writeForEdit = async () => ({ ok: false, conflict: true })
      const raced = await ask(
        'fs.write',
        { path: 'src/other.js', text: 'x' },
        { rights: EDIT, ...OKW }
      )
      expect(raced.code).toBe('conflict')
      remote.svc.writeForEdit = orig
    })

    it('every refusal to change a path is the same code: no existence oracle for ignored or hidden files', async () => {
      const codes = new Set()
      for (const path of [
        'ignored.log',
        'build/new.js',
        '.env',
        'nowhere/new.js',
        '.git/x',
        'link-env',
        'linkdir/x',
        'nested-none/x',
        'src/key.pem'
      ]) {
        const res = await ask(
          'fs.write',
          { path, text: 'x', expectHash: hashOf(Buffer.from('x')) },
          { rights: EDIT, ...OKW }
        )
        expect(res.ok, path).toBe(false)
        codes.add(res.code)
      }
      expect([...codes]).toEqual(['not-allowed'])
    })

    it("the host's shell makes a new file only if nothing is there, and cuts a read at its limit", async () => {
      const { prelude } = await import('../remoteShell')
      const text = prelude('0123456789abcdef0123456789abcdef')
      expect(text).toContain('mv -n "$__tmp" "$__P"')
      expect(text).toContain('[ -z "$6" ] || { __t_sig "$__P"; return 95; }')
      expect(text).toContain('head -c "$(($3+1))" "$__P"')
      expect(text).toContain('! -type d ! -type l -print0')
    })
  })

  describe('9: a root that is too broad is not shared', () => {
    it('refuses the host root, ~, a home folder and a system folder', async () => {
      for (const root of [
        'ssh://ssh-a1/',
        'ssh://ssh-a1/~',
        'ssh://ssh-a1/home/me',
        'ssh://ssh-a1/etc',
        'ssh://ssh-a1/srv'
      ]) {
        const res = await rig.handle(
          { op: 'fs.list', project: 'p1', args: {} },
          { remoteRoots: new Map([['p1', root]]), rights: READ, settings: {} }
        )
        expect(res.code, root).toBe('remote-project')
      }
      expect(remote.state.calls).toEqual([])
    })

    it('the policy and the root cleaner agree', () => {
      expect(remoteRootTooBroad('/')).toBe(true)
      expect(remoteRootTooBroad('~')).toBe(true)
      expect(remoteRootTooBroad('/home/me')).toBe(true)
      expect(remoteRootTooBroad('/home/me/app')).toBe(false)
      expect(remoteRootTooBroad('~/app')).toBe(false)
      expect(remoteRootTooBroad('/srv/app')).toBe(false)
      expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: '/home/me' })).toBeNull()
      expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: '~' })).toBeNull()
      expect(cleanRemoteRoot({ hostId: 'ssh-a1', path: '/home/me/app' })).toBe(ROOT)
    })
  })

  describe('6: the share keeps hiding ignored and secret files by default', () => {
    it('with no setting at all, secret names and ignored files are hidden', async () => {
      const res = await ask('fs.list', {}, { settings: {} })
      const names = res.data.entries.map((e) => e.name)
      expect(names).not.toContain('.env')
      expect(names).not.toContain('build')
    })
  })
})
