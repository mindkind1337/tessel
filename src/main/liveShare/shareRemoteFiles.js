// Live Share: the files of a shared project that lives on an SSH host.
//
// The host's Tessel reads such a project through its own SSH session
// (remoteFs.js, the one its Files tab and editor use). A guest's file
// requests for it are answered here from that session, with the rules of a
// local shared project (shareRequests.js, shareScope.js):
//
// - the project is the host's own saved remote project (the virtual root the
//   host's window gave with its layout): a guest never names a host, a
//   remote path or an absolute path, only a path relative to the project
//   (the same strict argument shapes as for a local project). Everything
//   goes through remoteFs, which finds each path below the saved project and
//   makes the host resolve it again (links included) inside the folder;
// - a symbolic link is never followed for a guest: it is left out of
//   listings and refused for reading, saving and statting (a link to
//   ".env" inside the project would otherwise open it under another name),
//   and so is any path below a link (checked from the listings of its
//   folders, cached for a few seconds);
// - hidden like a local project: .git and .tessel always, and with "Hide
//   ignored and secret files" on (the default) the secret names and every
//   file the project's git repository ignores (git status --ignored, read
//   over the same session). If that cannot be read, nothing is shown: it
//   fails closed;
// - rights per op as for a local project (mayRun): reading comes with the
//   project, saving needs `edit` (and `type` for the files that run things,
//   isProtectedRel), asked again right before the write (ctx.recheck);
// - a save is atomic on the host (remoteFs writeForEdit) and only replaces
//   the file as the guest last read it (its hash), never .git or .tessel;
// - sizes: a file is statted before it is read (nothing larger than the
//   local limits comes over the connection), listings and searches are cut
//   to the same limits, a save to 768 KB;
// - the host's SSH session is shared with its own panels: at most
//   MAX_ACTIVE of the guests' requests run at once per host and MAX_WAITING
//   wait (MAX_PER_PERSON per person), the rest answer 'busy'; listings go
//   behind the host's own requests in the session's queue; a host whose
//   server is not connected answers 'host-offline' and a guest's request
//   never starts a sign-in;
// - answers carry names and relative paths only, errors only fixed codes
//   (never the host's text, which names its folders and server), and
//   assertNoHostPaths runs over every answer on its way out.
//
// Ops it answers: fs.list, fs.listMany, fs.stat, fs.read, fs.image, fs.write,
// fs.searchNames, fs.searchContent, and (empty, for the views that ask at
// once) fs.status, fs.sparse. Anything else is 'remote-project' ("not shared
// for a project on an SSH server"): Changes, notes, creating, renaming and
// deleting files, tasks' review.
import { cleanRel, segmentOk, LSHARE_LIMITS as L } from '../../shared/liveSharePath'
import { fileKind } from '../../shared/fileKinds'
import { childPath, parseRemotePath } from '../../shared/remotePath'
import { hashOf, signatureOf } from '../editorFiles'
import { parseOpArgs, mayRun } from './shareRequests'
import {
  assertNoHostPaths,
  hiddenByName as nameHidden,
  hidesPrivate,
  writeAllowed,
  touchesSpecial
} from './shareScope'

export const REMOTE_OPS = Object.freeze([
  'fs.list',
  'fs.listMany',
  'fs.stat',
  'fs.read',
  'fs.image',
  'fs.write',
  'fs.searchNames',
  'fs.searchContent',
  'fs.status',
  'fs.sparse'
])
export const MAX_ACTIVE = 2 // requests on one host's session at once
export const MAX_WAITING = 6 // and waiting for their turn
export const MAX_PER_PERSON = 3 // running or waiting, per person
const IGNORE_TTL_MS = 8000
const VERIFIED_TTL_MS = 10_000
const MAX_DEPTH = 32
const MAX_ANCESTORS = 33

// .tessel is hidden whole (its notes are not shared for an SSH project).
const hiddenByName = (rel, settings) => touchesSpecial(rel) || nameHidden(rel, settings)
const done = (data) => ({ ok: true, data })
const fail = (code) => ({ ok: false, code })
const join2 = (a, b) => (a ? `${a}/${b}` : b)
const dirname = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const basename = (rel) => (rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel)
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const sigOf = (st) =>
  st && Number.isFinite(st.mtimeMs) && Number.isFinite(st.size) ? signatureOf(st) : null

// createRemoteShareFiles({ remote, log?, now? }): remote is the remoteFs
// service (or a function giving it, or null while it is not there).
// -> { handle(req, ctx), supports(op) }
// ctx: { remoteRoots: Map project -> virtual root, rights, settings,
// recheck?, cancelled?, person? }, the host's.
export function createRemoteShareFiles({ remote, log = null, now = () => Date.now() } = {}) {
  const service = () => (typeof remote === 'function' ? remote() : remote) || null
  const gates = new Map() // hostId -> { active, queue: [] }
  const persons = new Map() // hostId\nperson -> count
  const ignoredCache = new Map() // virtual root -> { at, set } | { at, promise }
  const verified = new Map() // virtual root -> Map(dir rel -> expiry)

  // --- Concurrency ----------------------------------------------------------
  // -> a release function, or null when the host's session is as busy as
  // guests may make it.
  function enter(hostId, person) {
    const key = `${hostId}\n${person}`
    if ((persons.get(key) || 0) >= MAX_PER_PERSON) return null
    let gate = gates.get(hostId)
    if (!gate) gates.set(hostId, (gate = { active: 0, queue: [] }))
    if (gate.active >= MAX_ACTIVE && gate.queue.length >= MAX_WAITING) return null
    persons.set(key, (persons.get(key) || 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      persons.set(key, (persons.get(key) || 1) - 1)
      if (persons.get(key) <= 0) persons.delete(key)
      gate.active--
      const next = gate.queue.shift()
      if (next) {
        gate.active++
        next()
      } else if (!gate.active) gates.delete(hostId)
    }
    return new Promise((resolve) => {
      const start = () => resolve(release)
      if (gate.active < MAX_ACTIVE) {
        gate.active++
        start()
      } else gate.queue.push(start)
    })
  }

  // --- Reading the host's folders ------------------------------------------
  const virt = (root, rel) => (rel ? childPath(root, rel) : root)

  // One folder as the host lists it: { entries: Map name -> { dir, link }, truncated } | { code }
  async function listRaw(svc, root, rel, st) {
    const res = await svc.listDir({ root, dir: virt(root, rel), dotfiles: true, background: true })
    // A folder that is gone or cannot be read (the words stay here).
    if (!res || res.ok !== true) return { code: failedCode(svc, st, res, 'not-found') }
    const entries = new Map()
    for (const e of res.entries || []) {
      if (typeof e.name === 'string' && segmentOk(e.name))
        entries.set(e.name, { dir: !!e.dir, link: e.link === true })
    }
    return { entries, truncated: !!res.truncated }
  }
  // A failed call: the server is not connected (now), the host cannot be
  // asked, or the host's own words that stay here.
  function failedCode(svc, st, res, fallback = 'failed') {
    if (!svc.connectedQuietly(st.hostId)) return 'host-offline'
    // The host did not answer in time (slow, busy): later.
    if (res && res.transient) return 'busy'
    return fallback
  }

  const verifiedOf = (root) => {
    let m = verified.get(root)
    if (!m) verified.set(root, (m = new Map()))
    return m
  }
  const isVerified = (root, rel) => !rel || (verifiedOf(root).get(rel) || 0) > now()
  const markVerified = (root, rel) => {
    const m = verifiedOf(root)
    if (m.size > 2000) m.clear()
    m.set(rel, now() + VERIFIED_TTL_MS)
  }

  // Is every folder on the way to `rel` (and `rel` itself when it is a
  // folder) a real folder, not a link? One request for all the folders above
  // it. -> null (yes) | a code
  async function verifyDir(svc, root, rel, st) {
    if (isVerified(root, rel)) return null
    const segs = rel.split('/')
    if (segs.length > MAX_DEPTH) return 'bad-path'
    const parents = ['']
    for (let i = 1; i < segs.length; i++) parents.push(segs.slice(0, i).join('/'))
    // Folders already known to be real are not listed again.
    const need = parents.filter((p) => !isVerified(root, p))
    const lists = new Map()
    if (need.length) {
      if (need.length > MAX_ANCESTORS) return 'bad-path'
      const res = await svc.listMany({
        root,
        dirs: need.map((p) => virt(root, p)),
        dotfiles: true,
        background: true
      })
      if (!res || res.ok !== true) return failedCode(svc, st, res)
      for (let i = 0; i < need.length; i++) {
        const r = (res.results || []).find((x) => x && x.dir === virt(root, need[i]))
        if (!r || r.ok !== true) return failedCode(svc, st, r || res)
        lists.set(need[i], r)
      }
    }
    for (let i = 0; i < segs.length; i++) {
      const parent = parents[i]
      let entry
      if (lists.has(parent))
        entry = (lists.get(parent).entries || []).find((e) => e.name === segs[i])
      else if (isVerified(root, join2(parent, segs[i]))) continue
      else {
        const one = await listRaw(svc, root, parent, st)
        if (one.code) return one.code
        entry = one.entries.get(segs[i])
      }
      if (!entry) return 'not-found'
      if (entry.link === true || entry.dir !== true) return 'not-found'
      markVerified(root, join2(parent, segs[i]))
    }
    return null
  }

  // The entry `rel` names, from the listing of its folder (after the folder
  // itself is known to be real). -> { entry: { dir, link } | null } | { code }
  async function entryOf(svc, root, rel, st) {
    const parent = dirname(rel)
    const bad = await verifyDir(svc, root, parent, st)
    if (bad) return { code: bad }
    const one = await listRaw(svc, root, parent, st)
    if (one.code) return { code: one.code }
    const entry = one.entries.get(basename(rel)) || null
    if (!entry && one.truncated) return { code: 'too-large' } // cannot tell
    return { entry, listing: one }
  }

  // --- What git ignores ---------------------------------------------------------
  // The project's ignored paths (files and folders, relative to it), from git
  // status --ignored on the host. null: it cannot be read (fail closed).
  async function ignoredOf(svc, root) {
    const cached = ignoredCache.get(root)
    if (cached && cached.set && now() - cached.at < IGNORE_TTL_MS) return cached.set
    if (cached && cached.promise) return cached.promise
    const promise = (async () => {
      const res = await svc.projectStatus({ root, ignored: true })
      if (!res || res.ok !== true) return null
      const set = new Set()
      const base = `${root.replace(/[\\/]+$/, '')}\\`
      for (const [path, letter] of Object.entries(res.files || {})) {
        if (letter !== '!' || !path.startsWith(base)) continue
        set.add(path.slice(base.length).replace(/\\/g, '/'))
      }
      return set
    })()
    ignoredCache.set(root, { at: now(), promise })
    const set = await promise.catch(() => null)
    if (set) ignoredCache.set(root, { at: now(), set })
    else ignoredCache.delete(root)
    return set
  }
  const isIgnored = (set, rel) => {
    if (!set) return false
    let cur = rel
    for (;;) {
      if (set.has(cur)) return true
      const up = dirname(cur)
      if (up === cur || !cur.includes('/')) return false
      cur = up
    }
  }

  // The reading of the share's privacy for one request: hidden(rel) says
  // whether a guest may not see a path. -> { hidden } | { code }
  async function privacy(svc, root, st, settings, needIgnore = true) {
    let set = null
    if (hidesPrivate(settings) && needIgnore) {
      set = await ignoredOf(svc, root)
      if (!set) return { code: svc.connectedQuietly(st.hostId) ? 'failed' : 'host-offline' }
    }
    return { hidden: (rel) => hiddenByName(rel, settings) || isIgnored(set, rel) }
  }

  const invalidate = (root) => ignoredCache.delete(root)

  // --- The ops --------------------------------------------------------------------
  // Listed entries a guest may see.
  function visible(listing, dirRel, hidden) {
    const entries = []
    let count = 0
    for (const [name, e] of listing.entries) {
      if (e.link || hidden(join2(dirRel, name))) {
        count++
        continue
      }
      entries.push({ name, dir: e.dir })
    }
    return { entries, hidden: count }
  }

  async function opList(svc, a, st, settings) {
    const bad = await verifyDir(svc, st.root, a.dir, st)
    if (bad) return fail(bad)
    const p = await privacy(svc, st.root, st, settings)
    if (p.code) return fail(p.code)
    if (a.dir && p.hidden(a.dir)) return fail('not-found')
    const listing = await listRaw(svc, st.root, a.dir, st)
    if (listing.code) return fail(listing.code)
    const { entries, hidden } = visible(listing, a.dir, p.hidden)
    for (const e of entries) if (e.dir) markVerified(st.root, join2(a.dir, e.name))
    if (a.dir) markVerified(st.root, a.dir)
    return done({
      entries: entries.slice(0, L.entries),
      truncated: listing.truncated || entries.length > L.entries,
      hidden
    })
  }

  async function opListMany(svc, a, st, settings) {
    const p = await privacy(svc, st.root, st, settings)
    if (p.code) return fail(p.code)
    const results = []
    let total = 0
    let round = a.dirs.map((rel) => ({ rel, depth: 0 }))
    while (round.length) {
      const next = []
      for (const item of round) {
        if (total >= L.listManyEntries) {
          results.push({ dir: item.rel, ok: false, code: 'too-large' })
          continue
        }
        const bad =
          item.rel &&
          (p.hidden(item.rel) ? 'not-found' : await verifyDir(svc, st.root, item.rel, st))
        if (bad) {
          results.push({ dir: item.rel, ok: false, code: bad })
          continue
        }
        const listing = await listRaw(svc, st.root, item.rel, st)
        if (listing.code) {
          results.push({ dir: item.rel, ok: false, code: listing.code })
          continue
        }
        const { entries, hidden } = visible(listing, item.rel, p.hidden)
        total += entries.length
        for (const e of entries) if (e.dir) markVerified(st.root, join2(item.rel, e.name))
        results.push({ dir: item.rel, ok: true, entries, truncated: listing.truncated, hidden })
        if (a.chain && item.depth < MAX_DEPTH && entries.length === 1 && entries[0].dir)
          next.push({ rel: join2(item.rel, entries[0].name), depth: item.depth + 1 })
      }
      round = next
    }
    return done({ results })
  }

  // A file a guest may read: not hidden, not a link, below real folders.
  // -> { rel, size?, ... } | { code }
  async function fileOf(svc, a, st, settings, { mustExist = true } = {}) {
    if (hiddenByName(a.path, settings)) return { code: 'not-found' }
    const p = await privacy(svc, st.root, st, settings)
    if (p.code) return { code: p.code }
    if (p.hidden(a.path)) return { code: 'not-found' }
    const got = await entryOf(svc, st.root, a.path, st)
    if (got.code) return { code: got.code }
    if (!got.entry) return mustExist ? { code: 'not-found' } : { exists: false }
    if (got.entry.link) return { code: mustExist ? 'not-found' : 'not-allowed' }
    return { exists: true, dir: got.entry.dir }
  }
  const fileVirtual = (st, rel) => childPath(st.root, rel)

  async function opStat(svc, a, st, settings) {
    const f = await fileOf(svc, a, st, settings)
    if (f.code === 'not-found') return done({ exists: false, sig: null })
    if (f.code) return fail(f.code)
    if (f.dir) return done({ exists: false, sig: null })
    const res = await svc.statForEdit(fileVirtual(st, a.path))
    if (!res || res.ok !== true) return fail(failedCode(svc, st, res))
    if (!res.exists) return done({ exists: false, sig: null })
    return done({ exists: true, size: res.size, mtimeMs: res.mtimeMs, sig: sigOf(res) })
  }

  // A file's size before it is read, so nothing over the limit comes over
  // the connection. -> { stat } | { code }
  async function sizeCheck(svc, st, rel, max) {
    const s = await svc.statForEdit(fileVirtual(st, rel))
    if (!s || s.ok !== true) return { code: failedCode(svc, st, s) }
    if (!s.exists) return { code: 'not-found' }
    if (s.size > max) return { code: 'too-large' }
    return { stat: s }
  }

  const readCode = {
    missing: 'not-found',
    'too-large': 'too-large',
    'not-file': 'not-file',
    binary: 'binary',
    encoding: 'encoding'
  }
  const canWrite = (rights, rel) =>
    rights.edit === true && writeAllowed(rel, rights) && !touchesSpecial(rel)

  async function opRead(svc, a, st, settings, rights) {
    const f = await fileOf(svc, a, st, settings)
    if (f.code) return fail(f.code)
    if (f.dir) return fail('not-file')
    const size = await sizeCheck(svc, st, a.path, L.textBytes)
    if (size.code) return fail(size.code)
    const res = await svc.readForEdit(fileVirtual(st, a.path))
    if (!res || res.ok !== true)
      return fail((res && readCode[res.code]) || failedCode(svc, st, res))
    const raw = Buffer.concat([res.bom ? BOM : Buffer.alloc(0), Buffer.from(res.text, 'utf8')])
    if (raw.length > L.textBytes) return fail('too-large')
    return done({
      text: res.text,
      bom: !!res.bom,
      size: raw.length,
      mtimeMs: res.mtimeMs,
      sig: sigOf({ mtimeMs: res.mtimeMs, size: raw.length }),
      hash: hashOf(raw),
      readOnly: !canWrite(rights, a.path)
    })
  }

  async function opImage(svc, a, st, settings) {
    if (fileKind(a.path) !== 'image') return fail('not-file')
    const f = await fileOf(svc, a, st, settings)
    if (f.code) return fail(f.code)
    if (f.dir) return fail('not-file')
    const size = await sizeCheck(svc, st, a.path, L.imageBytes)
    if (size.code) return fail(size.code)
    const res = await svc.readImage(fileVirtual(st, a.path))
    if (!res || res.ok !== true)
      return fail(res && res.kind === 'image' ? 'too-large' : failedCode(svc, st, res))
    if (typeof res.dataUrl !== 'string' || res.size > L.imageBytes) return fail('too-large')
    return done({ size: res.size, dataUrl: res.dataUrl })
  }

  async function opWrite(svc, a, st, settings, rights, ctx) {
    if (Buffer.byteLength(a.text, 'utf8') + (a.bom ? 3 : 0) > L.writeBytes) return fail('too-large')
    if (touchesSpecial(a.path) || hiddenByName(a.path, settings) || !canWrite(rights, a.path))
      return fail('not-allowed')
    const f = await fileOf(svc, a, st, settings, { mustExist: false })
    if (f.code) return fail(f.code === 'not-found' ? 'not-allowed' : f.code)
    if (f.exists && f.dir) return fail('is-folder')
    let expect = {}
    if (f.exists) {
      // A file there is replaced only as the guest last read it: compared
      // here with what the host has now, and the host compares again with
      // that very version when it writes (atomic, one rename).
      if (!a.expectHash) return fail('conflict')
      const size = await sizeCheck(svc, st, a.path, L.textBytes)
      if (size.code) return fail(size.code === 'too-large' ? 'conflict' : size.code)
      const cur = await svc.readForEdit(fileVirtual(st, a.path))
      if (!cur || cur.ok !== true)
        return fail((cur && readCode[cur.code]) || failedCode(svc, st, cur))
      const raw = Buffer.concat([cur.bom ? BOM : Buffer.alloc(0), Buffer.from(cur.text, 'utf8')])
      if (hashOf(raw) !== a.expectHash) return fail('conflict')
      expect = cur.hash ? { expectHash: cur.hash } : { expectSig: cur.sig }
    }
    if (typeof ctx.recheck === 'function') {
      let ok
      try {
        ok = (await ctx.recheck()) === true
      } catch {
        ok = false
      }
      if (!ok) return fail('revoked')
    }
    const res = await svc.writeForEdit({
      file: fileVirtual(st, a.path),
      text: a.text,
      bom: a.bom,
      ...expect
    })
    invalidate(st.root)
    if (!res || res.ok !== true)
      return fail(res && res.conflict ? 'conflict' : failedCode(svc, st, res))
    const raw = Buffer.concat([a.bom ? BOM : Buffer.alloc(0), Buffer.from(a.text, 'utf8')])
    return done({
      size: raw.length,
      mtimeMs: res.mtimeMs,
      sig: sigOf({ mtimeMs: res.mtimeMs, size: raw.length }),
      hash: hashOf(raw)
    })
  }

  // Search results: a path a guest may see (not hidden, ignored, or below a
  // link: a link shows by name only and is refused when read).
  async function opSearchNames(svc, a, st, settings) {
    const p = await privacy(svc, st.root, st, settings)
    if (p.code) return fail(p.code)
    if (a.dir) {
      const bad = p.hidden(a.dir) ? 'not-found' : await verifyDir(svc, st.root, a.dir, st)
      if (bad) return fail(bad)
    }
    const res = await svc.searchNames({
      root: st.root,
      dir: a.dir ? virt(st.root, a.dir) : undefined,
      query: a.query,
      dotfiles: a.dotfiles,
      limit: 500
    })
    if (!res || res.ok !== true) return fail(failedCode(svc, st, res))
    const results = []
    let truncated = !!res.truncated
    for (const r of res.results || []) {
      const rel = cleanRel(r.rel)
      if (!rel || p.hidden(rel)) continue
      if (results.length >= a.limit) truncated = true
      else results.push({ rel, dir: !!r.dir })
    }
    return done({ results, truncated, hidden: 0 })
  }

  async function opSearchContent(svc, a, st, settings) {
    const p = await privacy(svc, st.root, st, settings)
    if (p.code) return fail(p.code)
    const res = await svc.searchContent({ root: st.root, query: a.query, limit: 500 })
    if (!res || res.ok !== true) return fail(failedCode(svc, st, res))
    const results = []
    let truncated = !!res.truncated
    for (const r of res.results || []) {
      const rel = cleanRel(r.rel)
      if (!rel || p.hidden(rel)) continue
      if (results.length >= a.limit) truncated = true
      else results.push({ rel, line: r.line, text: String(r.text || '').slice(0, 1000) })
    }
    return done({ results, truncated, hidden: 0 })
  }

  const RUN = {
    'fs.list': (svc, a, st, c) => opList(svc, a, st, c.settings),
    'fs.listMany': (svc, a, st, c) => opListMany(svc, a, st, c.settings),
    'fs.stat': (svc, a, st, c) => opStat(svc, a, st, c.settings),
    'fs.read': (svc, a, st, c) => opRead(svc, a, st, c.settings, c.rights),
    'fs.image': (svc, a, st, c) => opImage(svc, a, st, c.settings),
    'fs.write': (svc, a, st, c) => opWrite(svc, a, st, c.settings, c.rights, c),
    'fs.searchNames': (svc, a, st, c) => opSearchNames(svc, a, st, c.settings),
    'fs.searchContent': (svc, a, st, c) => opSearchContent(svc, a, st, c.settings)
  }

  const supports = (op) => typeof op === 'string' && REMOTE_OPS.includes(op)

  // req: { op, project, args } as the guest sent it.
  async function handle(req, ctx = {}) {
    const { op: name, project, args } = req && typeof req === 'object' ? req : {}
    if (!supports(name)) return fail('remote-project')
    const a = parseOpArgs(name, args)
    if (!a) return fail('bad-args')
    const rights = ctx.rights && typeof ctx.rights === 'object' ? ctx.rights : {}
    if (!mayRun(name, rights)) return fail('forbidden')
    const roots = ctx.remoteRoots
    const root = roots instanceof Map && typeof project === 'string' ? roots.get(project) : null
    const parsed = typeof root === 'string' ? parseRemotePath(root) : null
    if (!parsed) return fail('remote-project')
    const svc = service()
    if (!svc || typeof svc.hasRoot !== 'function' || !svc.hasRoot(root))
      return fail('remote-project')
    const settings = ctx.settings && typeof ctx.settings === 'object' ? ctx.settings : {}
    const st = { hostId: parsed.hostId, root, path: parsed.path }
    // No server connection, no answer: a guest's request never starts a
    // sign-in on the host's computer.
    if (!svc.connectedQuietly(st.hostId)) return fail('host-offline')
    // Nothing to read in git terms here: the views that ask for it get none.
    if (name === 'fs.status') return done({ repo: false, files: {}, hidden: 0 })
    if (name === 'fs.sparse') return done({ sparse: false, dirs: [] })
    const release = await enter(
      st.hostId,
      typeof ctx.person === 'string' && ctx.person ? ctx.person : 'anon'
    )
    if (!release) return fail('busy')
    let res
    try {
      if (typeof ctx.cancelled === 'function' && ctx.cancelled()) return fail('failed')
      res = await RUN[name](svc, a, st, { settings, rights, recheck: ctx.recheck })
    } catch (err) {
      if (log && log.warn)
        log.warn('liveshare', `remote request ${name} failed: ${err && err.message}`) // i18n-ignore log line
      return fail(svc.connectedQuietly(st.hostId) ? 'failed' : 'host-offline')
    } finally {
      release()
    }
    if (!res || typeof res !== 'object') return fail('failed')
    if (!res.ok) return fail(typeof res.code === 'string' ? res.code : 'failed')
    const keep =
      name === 'fs.read'
        ? ['text']
        : name === 'fs.searchContent'
          ? ['results.*.text']
          : name === 'fs.image'
            ? ['dataUrl']
            : []
    const { value, hits } = assertNoHostPaths(res.data, [st.path, root], { keep })
    if (hits && log && log.warn)
      log.warn('liveshare', `answer to ${name}: ${hits} host path(s) replaced`) // i18n-ignore log line
    return done(value)
  }

  // For tests and a share that stops: forget what was read.
  function reset() {
    ignoredCache.clear()
    verified.clear()
  }

  return { handle, supports, reset }
}
