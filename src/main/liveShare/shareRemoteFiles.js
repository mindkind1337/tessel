// Live Share: the files of a shared project that lives on an SSH host.
//
// The host's Tessel reads such a project over its own SSH connection, on the
// guests' own lane (remoteFs.js LANES 'guest': an exec channel of its own on
// the signed-in connection, a small queue, every request bounded on the
// host): a guest's work never waits in, or holds, the host's own session
// (its Files panel, the agent checks of the terminals it opens). Guests' file
// requests are answered here with the rules of a local shared project
// (shareRequests.js, shareScope.js):
//
// - the project is the host's own saved remote project (the virtual root the
//   host's window gave with its layout); a guest only ever names a path
//   relative to it (the strict argument shapes of a local project), never a
//   host, a remote path or an absolute path;
// - every request is checked on the host, in the same request as what it
//   reads or writes (remoteShell.js __t_gp): each part of the path below the
//   project folder is a real folder (or the file itself), never a link (a
//   link to ".env" would open it under another name) and never a folder
//   holding a .git (a nested repository, with its own rules and hooks).
//   Links and nested repositories are left out of listings and searches;
// - hidden like a local project: .git and .tessel always; with "Hide ignored
//   and secret files" on (the default) the secret names, and what the
//   project's git ignores, asked of git on the host for the paths of the
//   request only (git check-ignore over a folder's names, one file, a batch
//   of search results; never a scan of the project). If git cannot tell,
//   nothing is given: it fails closed;
// - rights per op as for a local project (mayRun): reading comes with the
//   project, saving needs `edit` (and `type` for the files that run things,
//   isProtectedRel: the folder core.hooksPath names too), asked again right
//   before the write (ctx.recheck);
// - a save replaces a file only while it is still the version the guest
//   read (compared by the host right before its atomic rename) and makes a
//   new one only if nothing is there;
// - sizes: the host cuts reads at the local limits (nothing larger comes over
//   the connection), listings and searches have the same limits, a save 768 KB;
// - a few guests' requests at once per host (MAX_ACTIVE, MAX_WAITING,
//   MAX_PER_PERSON), the rest answer 'busy'; a host whose server is not
//   connected answers 'host-offline', and a guest's request never starts a
//   sign-in;
// - answers carry names and relative paths only, errors fixed codes (never
//   the host's words), and assertNoHostPaths runs over every answer.
//
// Ops: fs.list, fs.listMany, fs.stat, fs.read, fs.image, fs.write,
// fs.searchNames, fs.searchContent, and (empty, for the views that ask at
// once) fs.status, fs.sparse. Anything else is 'remote-project' ("not shared
// for a project on an SSH server"): Changes, notes, creating, renaming and
// deleting files, tasks' review.
import { cleanRel, segmentOk, LSHARE_LIMITS as L } from '../../shared/liveSharePath'
import { fileKind, extOf, IMAGE_MIME } from '../../shared/fileKinds'
import { parseRemotePath } from '../../shared/remotePath'
import { remoteRootTooBroad } from '../../shared/remoteRootPolicy'
import { hashOf, signatureOf, looksBinary } from '../editorFiles'
import { parseOpArgs, mayRun } from './shareRequests'
import { assertNoHostPaths, hiddenByName as nameHidden, hidesPrivate, writeAllowed, touchesSpecial } from './shareScope'

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
export const MAX_ACTIVE = 2 // guests' requests running at once per host
export const MAX_WAITING = 6 // and waiting for their turn
export const MAX_PER_PERSON = 3 // running or waiting, per person
// The project folder's real path and its hooks folder, read again after this.
export const INFO_TTL_MS = 30_000
// Levels of sole sub-folders one listMany follows (compact folders).
const MAX_CHAIN = 8

// .tessel is hidden whole (its notes are not shared for an SSH project).
const hiddenByName = (rel, settings) => touchesSpecial(rel) || nameHidden(rel, settings)
const done = (data) => ({ ok: true, data })
const fail = (code) => ({ ok: false, code })
const join2 = (a, b) => (a ? `${a}/${b}` : b)
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const sigOf = (mtimeMs, size) => (Number.isFinite(mtimeMs) && Number.isFinite(size) ? signatureOf({ mtimeMs, size }) : null)
// A folder's real path inside a git folder is no project to share (its
// objects and config would be its files).
const inGitFolder = (real) => /(^|\/)\.git(\/|$)/i.test(String(real || ''))

// createRemoteShareFiles({ remote, log?, now? }): remote is the remoteFs
// service (or a function giving it, or null while it is not there).
// -> { handle(req, ctx), supports(op), reset() }
// ctx: { remoteRoots: Map project -> virtual root, rights, settings,
// recheck?, cancelled?, person? }, the host's.
export function createRemoteShareFiles({ remote, log = null, now = () => Date.now() } = {}) {
  const service = () => (typeof remote === 'function' ? remote() : remote) || null
  const gates = new Map() // hostId -> { active, queue: [] }
  const persons = new Map() // hostId\nperson -> count
  const infos = new Map() // virtual root -> { at, promise }
  const hashKinds = new Map() // hostId -> 'sha256' | 'other' (the host's file hashes)

  // --- Concurrency ----------------------------------------------------------
  // -> a release function, or null when the host already has as many guests'
  // requests as it takes.
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

  // A remoteFs guest answer's code -> the guest's. Not connected: the host's
  // server is down (host-offline), or only the guests' lane could not be
  // had (busy, later). 'unknown' (git could not tell what it ignores) and
  // anything else: 'failed'.
  function codeOf(svc, st, code, missing = 'not-found') {
    if (code === 'not-connected') return svc.connectedQuietly(st.hostId) ? 'busy' : 'host-offline'
    if (code === 'busy') return 'busy'
    if (code === 'missing' || code === 'refused') return missing
    if (code === 'too-large' || code === 'not-file' || code === 'is-folder' || code === 'conflict') return code
    return 'failed'
  }
  // A read: a folder is "not a file" (as for a local project).
  const readCode = (svc, st, code) => (code === 'is-folder' ? 'not-file' : codeOf(svc, st, code))

  // The project folder's real path (checked: not a broad folder, not in a
  // git folder) and its hooks folder, kept INFO_TTL_MS.
  // -> { hooks: string[] | null } | { code }
  function infoOf(svc, st) {
    const hit = infos.get(st.root)
    if (hit && now() - hit.at < INFO_TTL_MS) return hit.promise
    const promise = Promise.resolve(svc.guest.info({ root: st.root })).then(
      (r) => {
        if (!r || !r.ok) return { code: codeOf(svc, st, r && r.code) }
        if (remoteRootTooBroad(r.real) || inGitFolder(r.real)) return { code: 'remote-project' }
        return { hooks: Array.isArray(r.hooks) ? r.hooks : null }
      },
      () => ({ code: 'failed' })
    )
    infos.set(st.root, { at: now(), promise })
    // Only an answer is kept (not a host that did not answer).
    promise.then((v) => {
      if (v.code && v.code !== 'remote-project' && infos.get(st.root)?.promise === promise) infos.delete(st.root)
    })
    return promise
  }

  // What a guest may see of a folder the host listed. -> { entries, hidden }
  function visible(one, dirRel, settings, dotfiles = true) {
    const entries = []
    let hidden = 0
    for (const e of one.entries) {
      if (!dotfiles && e.name.startsWith('.')) continue
      const rel = join2(dirRel, e.name)
      const shown =
        segmentOk(e.name) &&
        (e.kind === 'd' || e.kind === 'f' || e.kind === 'o') &&
        !hiddenByName(rel, settings) &&
        !(one.ignored && one.ignored.has(e.name))
      if (shown) entries.push({ name: e.name, dir: e.kind === 'd' })
      else hidden++
    }
    return { entries, hidden }
  }

  // --- The ops --------------------------------------------------------------------
  async function opList(svc, a, st, settings) {
    if (a.dir && hiddenByName(a.dir, settings)) return fail('not-found')
    const res = await svc.guest.list({ root: st.root, dirs: [a.dir], ignore: hidesPrivate(settings) })
    if (!res || !res.ok) return fail(codeOf(svc, st, res && res.code))
    const one = res.results.find((r) => r.rel === a.dir)
    if (!one || !one.ok) return fail(codeOf(svc, st, one ? one.code : 'failed'))
    const { entries, hidden } = visible(one, a.dir, settings, a.dotfiles !== false)
    return done({ entries: entries.slice(0, L.entries), truncated: one.truncated || entries.length > L.entries, hidden })
  }

  // In rounds: the folders asked, then (chain) the sole sub-folder of each
  // that shows only one, as the local project's listMany does.
  async function opListMany(svc, a, st, settings) {
    const ignore = hidesPrivate(settings)
    const results = []
    let round = []
    for (const rel of a.dirs) {
      if (rel && hiddenByName(rel, settings)) results.push({ dir: rel, ok: false, code: 'not-found' })
      else round.push(rel)
    }
    const seen = new Set(round)
    let total = 0
    for (let depth = 0; round.length && depth <= (a.chain ? MAX_CHAIN : 0); depth++) {
      const res = await svc.guest.list({ root: st.root, dirs: round, ignore })
      if (!res || !res.ok) {
        // The folders asked could not be read: the request fails; a chained
        // round only stops the chain (the window reads them when opened).
        if (depth === 0) return fail(codeOf(svc, st, res && res.code))
        break
      }
      const next = []
      for (const one of res.results) {
        if (!one.ok) {
          results.push({ dir: one.rel, ok: false, code: codeOf(svc, st, one.code) })
          continue
        }
        if (total >= L.listManyEntries) {
          results.push({ dir: one.rel, ok: false, code: 'too-large' })
          continue
        }
        const { entries, hidden } = visible(one, one.rel, settings, a.dotfiles !== false)
        total += entries.length
        results.push({ dir: one.rel, ok: true, entries, truncated: one.truncated, hidden })
        if (a.chain && !one.truncated && entries.length === 1 && entries[0].dir) {
          const sub = join2(one.rel, entries[0].name)
          if (!seen.has(sub) && !hiddenByName(sub, settings)) {
            seen.add(sub)
            next.push(sub)
          }
        }
      }
      round = next
    }
    return done({ results })
  }

  async function opStat(svc, a, st, settings) {
    const none = done({ exists: false, sig: null })
    if (hiddenByName(a.path, settings)) return none
    const res = await svc.guest.stat({ root: st.root, rel: a.path, ignore: hidesPrivate(settings) })
    if (!res || !res.ok) {
      const code = codeOf(svc, st, res && res.code)
      return code === 'not-found' ? none : fail(code)
    }
    if (!res.exists) return none
    return done({ exists: true, size: res.size, mtimeMs: res.mtimeMs, sig: sigOf(res.mtimeMs, res.size) })
  }

  // May this guest change `rel`? hooks: the hooks folders (null: unknown).
  const canWrite = (rights, rel, hooks) =>
    rights.edit === true && Array.isArray(hooks) && writeAllowed(rel, rights, hooks) && !touchesSpecial(rel)

  // A file's text as a guest reads it. -> { text, bom, raw, res } | { code }
  async function readText(svc, st, rel, settings) {
    const res = await svc.guest.read({ root: st.root, rel, max: L.textBytes, ignore: hidesPrivate(settings) })
    if (!res || !res.ok) return { code: readCode(svc, st, res && res.code) }
    if (res.hostHash) hashKinds.set(st.hostId, res.hostHash.startsWith('sha256:') ? 'sha256' : 'other')
    const raw = res.buf
    if (looksBinary(raw)) return { code: 'binary' }
    const bom = raw.length >= 3 && raw.subarray(0, 3).equals(BOM)
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bom ? raw.subarray(3) : raw), bom, raw, res }
    } catch {
      return { code: 'encoding' }
    }
  }

  async function opRead(svc, a, st, settings, rights) {
    if (hiddenByName(a.path, settings)) return fail('not-found')
    const got = await readText(svc, st, a.path, settings)
    if (got.code) return fail(got.code)
    const info = rights.edit === true ? await infoOf(svc, st) : null
    return done({
      text: got.text,
      bom: got.bom,
      size: got.raw.length,
      mtimeMs: got.res.mtimeMs,
      sig: sigOf(got.res.mtimeMs, got.raw.length),
      hash: hashOf(got.raw),
      readOnly: !canWrite(rights, a.path, info && info.hooks)
    })
  }

  async function opImage(svc, a, st, settings) {
    const mime = fileKind(a.path) === 'image' ? IMAGE_MIME[extOf(a.path)] : null
    if (!mime) return fail('not-file')
    if (hiddenByName(a.path, settings)) return fail('not-found')
    const res = await svc.guest.read({ root: st.root, rel: a.path, max: L.imageBytes, ignore: hidesPrivate(settings) })
    if (!res || !res.ok) return fail(readCode(svc, st, res && res.code))
    return done({ size: res.buf.length, dataUrl: `data:${mime};base64,${res.buf.toString('base64')}` })
  }

  // A refusal to change a path is 'not-allowed' whatever the reason (hidden,
  // ignored, protected, a link, a nested repository, a folder that is not
  // there): it says nothing of what exists.
  async function opWrite(svc, a, st, settings, rights, ctx) {
    const data = Buffer.concat([a.bom ? BOM : Buffer.alloc(0), Buffer.from(a.text, 'utf8')])
    if (data.length > L.writeBytes) return fail('too-large')
    if (hiddenByName(a.path, settings) || rights.edit !== true) return fail('not-allowed')
    const info = await infoOf(svc, st)
    if (info.code) return fail(info.code)
    if (!canWrite(rights, a.path, info.hooks)) return fail('not-allowed')
    const ignore = hidesPrivate(settings)
    // The version it replaces: the guest's hash, in the host's own form (its
    // sha256 is the same hash). A host without sha256 (cksum): the file is
    // read and compared here first, then the host compares its own hash.
    let expect = a.expectHash ? { expectHash: `sha256:${a.expectHash}` } : { createOnly: true }
    if (a.expectHash && hashKinds.get(st.hostId) === 'other') {
      const cur = await readText(svc, st, a.path, settings)
      if (cur.code === 'not-found') expect = { createOnly: true }
      else if (cur.code) return fail(cur.code === 'too-large' || cur.code === 'binary' || cur.code === 'encoding' ? 'conflict' : cur.code)
      else if (hashOf(cur.raw) !== a.expectHash || !cur.res.hostHash) return fail('conflict')
      else expect = { expectHash: cur.res.hostHash }
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
    const res = await svc.guest.write({ root: st.root, rel: a.path, data, ignore, ...expect })
    if (!res || !res.ok) {
      const code = res && res.code
      if (code === 'missing' || code === 'refused') return fail('not-allowed')
      return fail(codeOf(svc, st, code))
    }
    if (res.hostHash) hashKinds.set(st.hostId, res.hostHash.startsWith('sha256:') ? 'sha256' : 'other')
    return done({ size: data.length, mtimeMs: res.mtimeMs, sig: sigOf(res.mtimeMs, data.length), hash: hashOf(data) })
  }

  // Search results a guest may name (wire paths, not hidden by name), then
  // checked on the host (no link, no nested repository, not ignored).
  // -> { good: Set } | { code }
  async function checked(svc, st, rels, settings) {
    if (!rels.length) return { good: new Set() }
    const res = await svc.guest.check({ root: st.root, rels, ignore: hidesPrivate(settings) })
    if (!res || !res.ok) return { code: codeOf(svc, st, res && res.code, 'failed') }
    return { good: res.good }
  }

  async function opSearchNames(svc, a, st, settings) {
    if (a.dir && hiddenByName(a.dir, settings)) return fail('not-found')
    const res = await svc.guest.searchNames({ root: st.root, query: a.query })
    if (!res || !res.ok) return fail(codeOf(svc, st, res && res.code, 'failed'))
    const within = a.dir ? `${a.dir}/` : ''
    const found = []
    for (const r of res.results) {
      const rel = cleanRel(r.rel)
      if (!rel || hiddenByName(rel, settings)) continue
      if (within && !rel.startsWith(within)) continue
      if (a.dotfiles === false && rel.split('/').some((s) => s.startsWith('.'))) continue
      found.push({ rel, dir: !!r.dir })
    }
    const ok = await checked(svc, st, found.map((r) => r.rel), settings)
    if (ok.code) return fail(ok.code)
    const results = []
    let truncated = !!res.truncated
    for (const r of found) {
      if (!ok.good.has(r.rel)) continue
      if (results.length >= a.limit) truncated = true
      else results.push(r)
    }
    return done({ results, truncated, hidden: 0 })
  }

  async function opSearchContent(svc, a, st, settings) {
    const res = await svc.guest.searchContent({ root: st.root, query: a.query })
    if (!res || !res.ok) return fail(codeOf(svc, st, res && res.code, 'failed'))
    const found = []
    for (const r of res.results) {
      const rel = cleanRel(r.rel)
      if (rel && !hiddenByName(rel, settings)) found.push({ rel, line: r.line, text: String(r.text || '').slice(0, 1000) })
    }
    const ok = await checked(svc, st, [...new Set(found.map((r) => r.rel))], settings)
    if (ok.code) return fail(ok.code)
    const results = []
    let truncated = !!res.truncated
    for (const r of found) {
      if (!ok.good.has(r.rel)) continue
      if (results.length >= a.limit) truncated = true
      else results.push(r)
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
    // A root too broad to share (the host's root, a home or system folder).
    if (!parsed || remoteRootTooBroad(parsed.path)) return fail('remote-project')
    const svc = service()
    if (!svc || typeof svc.hasRoot !== 'function' || !svc.hasRoot(root) || !svc.guest) return fail('remote-project')
    const settings = ctx.settings && typeof ctx.settings === 'object' ? ctx.settings : {}
    const st = { hostId: parsed.hostId, root, path: parsed.path }
    // No server connection, no answer: a guest's request never starts a
    // sign-in on the host's computer.
    if (!svc.connectedQuietly(st.hostId)) return fail('host-offline')
    // Nothing to read in git terms here: the views that ask for it get none.
    if (name === 'fs.status') return done({ repo: false, files: {}, hidden: 0 })
    if (name === 'fs.sparse') return done({ sparse: false, dirs: [] })
    const release = await enter(st.hostId, typeof ctx.person === 'string' && ctx.person ? ctx.person : 'anon')
    if (!release) return fail('busy')
    let res
    try {
      if (typeof ctx.cancelled === 'function' && ctx.cancelled()) return fail('failed')
      // The folder's real path is no broad folder (a link to one); not known:
      // nothing is given.
      const info = await infoOf(svc, st)
      if (info.code) return fail(info.code)
      res = await RUN[name](svc, a, st, { settings, rights, recheck: ctx.recheck })
    } catch (err) {
      // (log.warn(text): liveShare.js tags it with its area.)
      if (log && log.warn) log.warn(`remote request ${name} failed: ${err && err.message}`) // i18n-ignore log line
      return fail(svc.connectedQuietly(st.hostId) ? 'failed' : 'host-offline')
    } finally {
      release()
    }
    if (!res || typeof res !== 'object') return fail('failed')
    if (!res.ok) return fail(typeof res.code === 'string' ? res.code : 'failed')
    const keep = name === 'fs.read' ? ['text'] : name === 'fs.image' ? ['dataUrl'] : []
    const { value, hits } = assertNoHostPaths(res.data, [st.path, root], { keep })
    if (hits && log && log.warn) log.warn(`answer to ${name}: ${hits} host path(s) replaced`) // i18n-ignore log line
    return done(value)
  }

  // For tests and a share that stops: forget what was read.
  function reset() {
    infos.clear()
    hashKinds.clear()
  }

  return { handle, supports, reset }
}
