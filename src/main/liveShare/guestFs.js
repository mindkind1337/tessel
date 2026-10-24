// Live Share phase 2: a shared project's files, notes and changes on the
// guest's side.
//
// The guest's Files, editor and Changes views call the same main-process
// handlers as for a local project, with the project's virtual path
// (lshare://<project>\..., src/shared/liveSharePath.js). The main process
// hands those calls here: each path becomes { project, rel }, the request
// goes to the host through `request(op, project, args)` (the guest's Live
// Share connection, given by the caller), and the host's answer comes back
// in the shape the local handler gives (explorer.js, editorFiles.js,
// sourceControl.js), so the views stay as they are.
//
// The host is not trusted either (a modified Tessel could answer anything):
// - every answer is checked for its known shape, sizes within the limits
//   both sides agree on (LSHARE_LIMITS), names without separators or anything
//   Windows reads otherwise, relative paths only; the paths the views get are
//   always built here from the project and those names, never taken from the
//   host. An answer that does not fit is refused as a whole;
// - an error is a known code, worded here in the guest's language; only
//   git's own words (already cut by the host) are shown after it;
// - what would act on the guest's own computer is refused for a shared path,
//   like remoteFs.remoteOnly: reveal in Explorer, open in another program, a
//   terminal here, VS Code, the PDF window, an agent writing the commit
//   message; push, pull, fetch and sync are the host's alone;
// - a save larger than the guest's message may be (768 KB) is refused here,
//   before anything is sent.
import { t } from '../i18n'
import { fileKind } from '../../shared/fileKinds'
import { parseLsharePath, lshareRoot, lsharePath, relInProject, segmentOk, cleanRel, isLsharePath, LSHARE_LIMITS as L, LSHARE_CODES } from '../../shared/liveSharePath'

// --- Words -----------------------------------------------------------------------------
const MESSAGES = {
  outside: () => t('main.liveShareFs.outside', 'Not in this shared project.'),
  'bad-op': () => t('main.liveShareFs.badOp', "The host's Tessel cannot do this: the host needs to update Tessel."),
  'bad-args': () => t('main.liveShareFs.badArgs', 'The host refused this request.'),
  'bad-path': () => t('main.liveShareFs.badPath', 'This path cannot be used on the host.'),
  'no-project': () => t('main.liveShareFs.noProject', 'You no longer have access to this project.'),
  'remote-project': () => t('main.liveShareFs.remoteProject', "This is not shared for a project on the host's SSH server (guests get its files, not its Changes)."),
  'host-offline': () => t('main.liveShareFs.hostOffline', "The host's server is not connected right now. Try again in a moment."),
  forbidden: () => t('main.liveShareFs.forbidden', 'The host has not given you the right to do this.'),
  revoked: () => t('main.liveShareFs.revoked', 'Your access changed before this was done: nothing was changed.'),
  'not-found': () => t('main.liveShareFs.notFound', 'Not found on the host.'),
  'not-allowed': () => t('main.liveShareFs.notAllowed', 'Guests cannot change this file or folder (or something hidden or protected in it).'),
  exists: () => t('main.liveShareFs.exists', 'This name is already taken here.'),
  'not-file': () => t('main.liveShareFs.notFile', 'This is not a file.'),
  'is-folder': () => t('main.liveShareFs.isFolder', 'This is a folder.'),
  binary: () => t('main.liveShareFs.binary', 'Binary file: it cannot be opened here.'),
  'too-large': () => t('main.liveShareFs.tooLarge', 'Too large to open from the host.'),
  encoding: () => t('main.liveShareFs.encoding', 'This file is not UTF-8 text.'),
  conflict: () => t('main.liveShareFs.conflict', 'The file was changed on the host: reload it, then save again.'),
  'not-repo': () => t('main.liveShareFs.notRepo', 'This folder is not in a git repository.'),
  'nothing-staged': () => t('main.liveShareFs.nothingStaged', 'Stage at least one file to commit.'),
  'staged-outside': () => t('main.liveShareFs.stagedOutside', 'Files outside this project are staged on the host: the host must commit or unstage them first.'),
  'staged-hidden': () => t('main.liveShareFs.stagedHidden', 'Files the host keeps hidden from guests are staged: the host must commit or unstage them first.'),
  'no-message': () => t('main.liveShareFs.noMessage', 'Enter a commit message to commit.'),
  'no-identity': () => t('main.liveShareFs.noIdentity', 'Git on the host does not know a name and email yet.'),
  'bad-commit': () => t('main.liveShareFs.badCommit', 'Unknown commit.'),
  unavailable: () => t('main.liveShareFs.unavailable', 'Not available on the host.'),
  git: () => t('main.liveShareFs.git', 'Git failed on the host.'),
  busy: () => t('main.liveShareFs.busy', 'The host is busy: try again in a moment.'),
  failed: () => t('main.liveShareFs.failed', 'The host could not do this.'),
  offline: () => t('main.liveShareFs.offline', 'The host did not answer.'),
  'bad-answer': () => t('main.liveShareFs.badAnswer', 'The host sent an answer Tessel does not accept.'),
  'local-only': () => t('main.liveShareFs.localOnly', 'Not available for a project shared with you.'),
  'too-large-to-send': () => t('main.liveShareFs.tooLargeToSend', 'Too large to send to the host (over 768 KB).')
}
// The host's note on a file's committed version, in the guest's words.
const HEAD_NOTES = {
  'not-repo': () => t('main.editor.noteNotRepo', 'Not in a git repository: there is no committed version to compare with.'),
  outside: () => t('main.editor.noteOutside', 'Outside the repository: there is no committed version to compare with.'),
  'no-commit': () => t('main.editor.noteNoCommit', 'No commit yet: the left side is empty.'),
  'new-file': () => t('main.editor.noteNewFile', 'Not in the last commit (a new file): the left side is empty.')
}

// git's words from the host: no control characters, cut.
// eslint-disable-next-line no-control-regex -- control characters are what it removes
const cleanDetail = (d) => (typeof d === 'string' ? d.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, L.detail) : '')

// A failed call in the local handlers' shape: { ok: false, error, code }
// (conflict: the editor's flag; transient: the host did not answer, what is
// shown stays).
export function failure(code, detail) {
  const known = Object.hasOwn(MESSAGES, code) ? code : 'failed'
  const extra = known === 'git' ? cleanDetail(detail) : ''
  const error = extra ? t('main.liveShareFs.gitDetail', 'Git failed on the host: {{detail}}', { detail: extra }) : MESSAGES[known]()
  return { ok: false, error, code: known, ...(known === 'conflict' ? { conflict: true } : {}), ...(known === 'offline' || known === 'host-offline' ? { transient: true } : {}) }
}
export const localOnly = () => failure('local-only')

// --- Checking the host's answers (pure) --------------------------------------------
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 1e9 ? v : 0)
const numOr = (v, d = null) => (Number.isFinite(v) ? v : d)
const bool = (v) => v === true
const clip = (s, max) => (typeof s === 'string' ? s.slice(0, max) : '')
const isCommit = (v) => typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v)
const isHash = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const sigOf = (v) => (typeof v === 'string' && /^\d{1,20}:\d{1,20}$/.test(v) ? v : null)
const word = (v, max = 40) => (typeof v === 'string' && /^[\w-]+$/.test(v) && v.length <= max ? v : undefined)
// A text of at most max bytes (UTF-8).
export function textWithin(v, max) {
  if (typeof v !== 'string' || v.length > max) return false
  return v.length * 3 <= max || Buffer.byteLength(v, 'utf8') <= max
}
const relOk = (v) => typeof v === 'string' && !!v && cleanRel(v) === v

// A folder's entries from the host -> [{ name, dir, link? }] (names a guest
// can address, each once), or null when it is not a list within max.
export function checkEntries(list, max = L.entries) {
  if (!Array.isArray(list) || list.length > max) return null
  const seen = new Set()
  const out = []
  for (const e of list) {
    if (!isObj(e) || !segmentOk(e.name) || seen.has(e.name.toLowerCase())) return null
    seen.add(e.name.toLowerCase())
    out.push({ name: e.name, dir: bool(e.dir), ...(e.link === true ? { link: true } : {}) })
  }
  return out
}

// A list of relative paths from the host, or null.
export function checkRels(list, max) {
  if (!Array.isArray(list) || list.length > max) return null
  return list.every(relOk) ? list.slice() : null
}

// Git's entries ({ path, oldPath?, area?, status?, ... }) from the host, or null.
const ENTRY_FIELDS = ['area', 'status', 'conflictStatus', 'conflictKind']
export function checkScmEntries(list, max = L.scmEntries) {
  if (!Array.isArray(list) || list.length > max) return null
  const out = []
  for (const e of list) {
    if (!isObj(e) || !relOk(e.path)) return null
    if (e.oldPath !== undefined && !relOk(e.oldPath)) return null
    const x = { path: e.path }
    if (e.oldPath !== undefined) x.oldPath = e.oldPath
    for (const f of ENTRY_FIELDS) if (word(e[f]) !== undefined) x[f] = e[f]
    if (e.conflict === true) x.conflict = true
    if (e.binary === true) x.binary = true
    for (const f of ['added', 'removed']) if (e[f] === null || (Number.isSafeInteger(e[f]) && e[f] >= 0)) x[f] = e[f]
    out.push(x)
  }
  return out
}

const checkRef = (r) =>
  isObj(r) && typeof r.id === 'string' && r.id.length <= 300
    ? { id: r.id, name: clip(r.name, 300), revision: isCommit(r.revision) ? r.revision : '', category: clip(r.category, 20) }
    : undefined

const IMAGE_URL = /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|svg\+xml);base64,[A-Za-z0-9+/]*={0,2}$/
const WEB_URL = /^https?:\/\/[^\s/@]+(?:\/[^\s]*)?$/

// --- The guest's handlers ------------------------------------------------------------
// createGuestFs({ request }) where request(op, project, args) -> Promise of
// the host's answer ({ ok: true, data } | { ok: false, code, detail? }); it
// may reject (the connection is gone).
export function createGuestFs({ request } = {}) {
  // A call to the host: its answer checked by check(data) -> the fields to
  // answer with, or null (refused).
  async function call(op, project, args, check) {
    let res
    try {
      res = await request(op, project, args)
    } catch {
      return failure('offline')
    }
    if (!isObj(res)) return failure('bad-answer')
    if (res.ok !== true) return failure(LSHARE_CODES.includes(res.code) ? res.code : 'failed', res.detail)
    if (!isObj(res.data)) return failure('bad-answer')
    let data
    try {
      data = check(res.data)
    } catch {
      data = null
    }
    return data ? { ok: true, ...data } : failure('bad-answer')
  }

  // A virtual path, in the project of `root` when one is given (a call for
  // one project never reaches another). -> { project, rel } | null
  function locate(root, p) {
    const base = root === undefined || root === null ? null : parseLsharePath(root)
    if (root !== undefined && root !== null && !base) return null
    const target = p === undefined || p === null || p === '' ? root : p
    if (base && !isLsharePath(target)) {
      const rel = relInProject(base.project, target)
      return rel === null ? null : { project: base.project, rel }
    }
    const loc = parseLsharePath(target)
    if (!loc || (base && loc.project !== base.project)) return null
    return loc
  }
  const outside = () => failure('outside')
  const pathOf = (project, rel) => lsharePath(project, rel)

  // --- Files tree --------------------------------------------------------------------
  function listDir({ root, dir, dotfiles = true } = {}) {
    const loc = locate(root, dir)
    if (!loc) return Promise.resolve(outside())
    return call('fs.list', loc.project, { dir: loc.rel, dotfiles: dotfiles !== false }, (d) => {
      const entries = checkEntries(d.entries)
      if (!entries) return null
      return {
        entries: entries.map((e) => ({ name: e.name, path: pathOf(loc.project, [loc.rel, e.name].filter(Boolean).join('/')), dir: e.dir, ...(e.link ? { link: true } : {}) })),
        truncated: bool(d.truncated),
        hidden: count(d.hidden)
      }
    })
  }

  async function listMany({ root, dirs, dotfiles = true, chain = false } = {}) {
    const base = locate(root, root)
    if (!base) return outside()
    const asked = new Map() // rel -> the path as the view gave it
    const results = []
    for (const d of (Array.isArray(dirs) ? dirs : []).filter((x) => typeof x === 'string').slice(0, L.listMany)) {
      const loc = locate(root, d)
      if (loc && !asked.has(loc.rel)) asked.set(loc.rel, d)
      else if (!loc) results.push({ dir: d, ...outside() })
    }
    if (!asked.size) return { ok: true, results }
    const res = await call('fs.listMany', base.project, { dirs: [...asked.keys()], dotfiles: dotfiles !== false, chain: chain === true }, (d) => {
      if (!Array.isArray(d.results) || d.results.length > L.listMany * 33) return null
      const out = []
      let total = 0
      for (const r of d.results) {
        if (!isObj(r) || cleanRel(r.dir) !== r.dir) return null
        const dir = asked.get(r.dir) || pathOf(base.project, r.dir)
        if (r.ok !== true) {
          out.push({ dir, ...failure(LSHARE_CODES.includes(r.code) ? r.code : 'failed') })
          continue
        }
        const entries = checkEntries(r.entries)
        if (!entries) return null
        total += entries.length
        if (total > L.listManyEntries) return null
        out.push({
          dir,
          ok: true,
          entries: entries.map((e) => ({ name: e.name, path: pathOf(base.project, [r.dir, e.name].filter(Boolean).join('/')), dir: e.dir, ...(e.link ? { link: true } : {}) })),
          truncated: bool(r.truncated),
          hidden: count(r.hidden)
        })
      }
      return { results: out }
    })
    return res.ok ? { ok: true, results: [...results, ...res.results] } : res
  }

  function projectStatus({ root } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    return call('fs.status', loc.project, {}, (d) => {
      if (!d.repo) return { files: {}, repo: false }
      if (!isObj(d.files)) return null
      const keys = Object.keys(d.files)
      if (keys.length > L.scmEntries) return null
      const files = {}
      for (const rel of keys) {
        if (!relOk(rel) || !/^[MADRCU!]$/.test(d.files[rel])) return null
        files[pathOf(loc.project, rel)] = d.files[rel]
      }
      return { files, repo: true, hidden: count(d.hidden) }
    })
  }

  function sparseInfo({ root } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    return call('fs.sparse', loc.project, {}, (d) => {
      if (!d.sparse) return { sparse: false, dirs: [] }
      const dirs = checkRels(d.dirs, L.entries)
      return dirs ? { sparse: true, dirs: dirs.map((rel) => ({ rel, path: pathOf(loc.project, rel) })) } : null
    })
  }

  function searchNames({ root, dir, query, dotfiles = true, limit = L.results } = {}) {
    const loc = locate(root, root)
    const scope = dir ? locate(root, dir) : loc
    if (!loc || !scope) return Promise.resolve(outside())
    const q = typeof query === 'string' ? query.slice(0, L.query) : ''
    if (!q.trim()) return Promise.resolve({ ok: true, results: [], truncated: false })
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, L.results) : L.results
    return call('fs.searchNames', loc.project, { query: q, dir: scope.rel, dotfiles: dotfiles !== false, limit: max }, (d) => {
      if (!Array.isArray(d.results) || d.results.length > L.results) return null
      const results = []
      for (const r of d.results) {
        if (!isObj(r) || !relOk(r.rel)) return null
        results.push({ name: r.rel.split('/').pop(), path: pathOf(loc.project, r.rel), rel: r.rel, dir: bool(r.dir) })
      }
      return { results, truncated: bool(d.truncated), hidden: count(d.hidden) }
    })
  }

  function searchContent({ root, query, limit = L.results } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    const q = typeof query === 'string' ? query.slice(0, L.contentQuery) : ''
    if (!q.trim()) return Promise.resolve({ ok: true, results: [], truncated: false })
    const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, L.results) : L.results
    return call('fs.searchContent', loc.project, { query: q, limit: max }, (d) => {
      if (!Array.isArray(d.results) || d.results.length > L.results) return null
      const results = []
      for (const r of d.results) {
        if (!isObj(r) || !relOk(r.rel) || !Number.isSafeInteger(r.line) || r.line < 1 || typeof r.text !== 'string' || r.text.length > 1000) return null
        results.push({ path: pathOf(loc.project, r.rel), rel: r.rel, line: r.line, text: r.text })
      }
      return { results, truncated: bool(d.truncated), hidden: count(d.hidden) }
    })
  }

  function create({ root, dir, name, folder = false } = {}) {
    const loc = locate(root, dir)
    const n = typeof name === 'string' ? name.trim() : ''
    if (!loc) return Promise.resolve(outside())
    if (!segmentOk(n)) return Promise.resolve(failure('bad-path'))
    const rel = [loc.rel, n].filter(Boolean).join('/')
    return call('fs.create', loc.project, { dir: loc.rel, name: n, folder: folder === true }, (d) => (d.rel === rel ? { path: pathOf(loc.project, rel) } : null))
  }

  function rename({ root, path, name } = {}) {
    const loc = locate(root, path)
    const n = typeof name === 'string' ? name.trim() : ''
    if (!loc || !loc.rel) return Promise.resolve(outside())
    if (!segmentOk(n)) return Promise.resolve(failure('bad-path'))
    const parent = loc.rel.includes('/') ? loc.rel.slice(0, loc.rel.lastIndexOf('/')) : ''
    const rel = [parent, n].filter(Boolean).join('/')
    return call('fs.rename', loc.project, { path: loc.rel, name: n }, (d) => (d.rel === rel ? { path: pathOf(loc.project, rel) } : null))
  }

  function trash({ root, path } = {}) {
    const loc = locate(root, path)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    return call('fs.trash', loc.project, { path: loc.rel }, () => ({ name: loc.rel.split('/').pop() }))
  }

  // Jump to file: { ok, files: [rel], truncated, source }.
  function listProjectFiles(root) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    return call('fs.fileList', loc.project, {}, (d) => {
      const files = checkRels(d.files, L.fileList)
      return files ? { files, truncated: bool(d.truncated), source: d.source === 'git' ? 'git' : 'walk', hidden: count(d.hidden) } : null
    })
  }

  // --- Editor ------------------------------------------------------------------------
  const fileStat = (d) => ({ size: count(d.size), mtimeMs: numOr(d.mtimeMs, 0), sig: sigOf(d.sig) })

  function readForEdit(file) {
    const loc = locate(null, file)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    return call('fs.read', loc.project, { path: loc.rel }, (d) => {
      if (!textWithin(d.text, L.textBytes) || !isHash(d.hash)) return null
      return { text: d.text, bom: bool(d.bom), ...fileStat(d), hash: d.hash, readOnly: d.readOnly !== false }
    })
  }

  function statForEdit(file) {
    const loc = locate(null, file)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    return call('fs.stat', loc.project, { path: loc.rel }, (d) => (d.exists === true ? { exists: true, ...fileStat(d) } : { exists: false, sig: null }))
  }

  // { file, text, bom, expectHash } -> as editorFiles.writeForEdit answers.
  function writeForEdit({ file, text, bom = false, expectHash } = {}) {
    const loc = locate(null, file)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    if (typeof text !== 'string') return Promise.resolve(failure('bad-args'))
    if (!textWithin(text, L.writeBytes - (bom ? 3 : 0))) return Promise.resolve(failure('too-large-to-send'))
    const args = { path: loc.rel, text, bom: bom === true, ...(isHash(expectHash) ? { expectHash } : {}) }
    return call('fs.write', loc.project, args, (d) => (isHash(d.hash) ? { ...fileStat(d), hash: d.hash } : null))
  }

  function headContent(file) {
    const loc = locate(null, file)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    return call('fs.head', loc.project, { path: loc.rel }, (d) => {
      if (!textWithin(d.text, L.textBytes)) return null
      const note = Object.hasOwn(HEAD_NOTES, d.note) ? HEAD_NOTES[d.note]() : ''
      return { repo: bool(d.repo), isNew: bool(d.isNew), text: d.text, note }
    })
  }

  // An image for the viewer: { ok, kind: 'image', size, dataUrl }.
  function readImage(file) {
    const loc = locate(null, file)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    if (fileKind(loc.rel) !== 'image') return Promise.resolve(failure('not-file'))
    return call('fs.image', loc.project, { path: loc.rel }, (d) => {
      const max = Math.ceil((L.imageBytes * 4) / 3) + 64
      if (typeof d.dataUrl !== 'string' || d.dataUrl.length > max || !IMAGE_URL.test(d.dataUrl)) return null
      return { kind: 'image', size: count(d.size), dataUrl: d.dataUrl }
    })
  }

  // The file viewer (fileView.js readForView): text kinds and images; a PDF
  // opens in a window of this computer, so not for a shared file.
  async function readForView(file) {
    const loc = locate(null, file)
    if (!loc || !loc.rel) return outside()
    const kind = fileKind(loc.rel)
    if (kind === 'pdf') return localOnly()
    if (kind === 'image') return readImage(file)
    const res = await readForEdit(file)
    return res.ok ? { ok: true, kind, size: res.size, text: res.text } : res
  }

  // --- Notes -------------------------------------------------------------------------
  const NOTES = '.tessel/notes.md'
  function loadNotes({ dir } = {}) {
    const loc = locate(dir, dir)
    if (!loc) return Promise.resolve(outside())
    return call('notes.load', loc.project, {}, (d) => {
      if (d.exists !== true) return { exists: false, path: pathOf(loc.project, NOTES), text: '', mtime: null }
      if (!textWithin(d.text, L.notesBytes)) return null
      return { exists: true, path: pathOf(loc.project, NOTES), text: d.text, mtime: numOr(d.mtime) }
    })
  }

  function saveNotes({ dir, text, baseMtime } = {}) {
    const loc = locate(dir, dir)
    if (!loc) return Promise.resolve(outside())
    const body = String(text ?? '')
    if (!textWithin(body, L.notesBytes)) return Promise.resolve(failure('too-large-to-send'))
    return call('notes.save', loc.project, { text: body, baseMtime: Number.isFinite(baseMtime) ? baseMtime : null }, (d) => ({ path: pathOf(loc.project, NOTES), mtime: numOr(d.mtime) }))
  }

  // --- Local History (phase 2b: the host's saves of a file, its Timeline) -----
  // The localHistory:list / read calls for a host's file: { path } -> { ok,
  // entries: [{ id, source, timestamp }] } (newest first) and { path, id } ->
  // { ok, text }, as this computer's Local History answers.
  const LOCAL_ID = /^[a-z0-9]{6,32}$/
  function localHistoryList({ path } = {}) {
    const loc = parseLsharePath(path)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    return call('history.local', loc.project, { path: loc.rel }, (d) => {
      if (!Array.isArray(d.entries) || d.entries.length > L.localEntries) return null
      const entries = []
      for (const e of d.entries) {
        if (!isObj(e) || !LOCAL_ID.test(String(e.id)) || !Number.isFinite(e.timestamp)) return null
        entries.push({ id: e.id, source: e.source === 'save' ? 'save' : 'other', timestamp: e.timestamp })
      }
      return { entries }
    })
  }
  function localHistoryRead({ path, id } = {}) {
    const loc = parseLsharePath(path)
    if (!loc || !loc.rel) return Promise.resolve(outside())
    if (typeof id !== 'string' || !LOCAL_ID.test(id)) return Promise.resolve(failure('not-found'))
    return call('history.localRead', loc.project, { path: loc.rel, id }, (d) => (typeof d.text === 'string' && textWithin(d.text, L.textBytes) ? { text: d.text } : null))
  }

  // --- Changes -----------------------------------------------------------------------
  // Paths the Changes view gives (from the project, or virtual) -> wire
  // paths of `project`, or null when one is not.
  function relsOf(project, paths) {
    const list = Array.isArray(paths) ? paths : [paths]
    if (!list.length || list.length > L.pathsPerCall) return null
    const out = []
    for (const p of list) {
      const rel = relInProject(project, p)
      if (!rel) return null
      if (!out.includes(rel)) out.push(rel)
    }
    return out
  }

  function scmStatus({ root } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    return call('scm.status', loc.project, {}, (d) => {
      if (!d.repo) return { repo: false }
      const entries = checkScmEntries(d.entries)
      if (!entries) return null
      return {
        repo: true,
        // The entries are from the project's folder: the view joins them to it.
        top: lshareRoot(loc.project),
        branch: typeof d.branch === 'string' ? clip(d.branch, 300) : null,
        detached: bool(d.detached),
        head: isCommit(d.head) ? d.head : null,
        hasCommits: bool(d.hasCommits),
        upstream: typeof d.upstream === 'string' ? clip(d.upstream, 300) : null,
        hasUpstream: bool(d.hasUpstream),
        ahead: count(d.ahead),
        behind: count(d.behind),
        operation: ['merge', 'rebase', 'cherry-pick'].includes(d.operation) ? d.operation : null,
        remotes: Array.isArray(d.remotes) ? d.remotes.filter((r) => typeof r === 'string').slice(0, 50).map((r) => clip(r, 200)) : [],
        entries,
        hidden: count(d.hidden),
        truncated: bool(d.truncated)
      }
    })
  }

  function scmFileVersions({ root, path, area, oldPath, commit, base } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    const rel = relInProject(loc.project, path)
    const oldRel = oldPath ? relInProject(loc.project, oldPath) : null
    if (!rel || (oldPath && !oldRel)) return Promise.resolve(outside())
    const args = { path: rel, area, ...(oldRel ? { oldPath: oldRel } : {}), ...(isCommit(commit) ? { commit } : {}), ...(isCommit(base) ? { base } : {}) }
    return call('scm.versions', loc.project, args, (d) => {
      const where = { rel, full: pathOf(loc.project, rel), exists: bool(d.exists), top: lshareRoot(loc.project) }
      if (d.binary === true) return { binary: true, ...where }
      if (!textWithin(d.original, L.textBytes) || !textWithin(d.modified, L.textBytes)) return null
      return { original: d.original, modified: d.modified, ...where }
    })
  }

  function scmHistory({ root, limit, base } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, L.historyLimit) : 50
    return call('scm.history', loc.project, { limit: n, ...(typeof base === 'string' && base ? { base: base.slice(0, 200) } : {}) }, (d) => {
      if (!Array.isArray(d.items) || d.items.length > L.historyLimit) return null
      const items = []
      for (const c of d.items) {
        if (!isObj(c) || !isCommit(c.id)) return null
        items.push({
          id: c.id,
          parentIds: Array.isArray(c.parentIds) ? c.parentIds.filter(isCommit).slice(0, 16) : [],
          subject: clip(c.subject, 1000),
          message: clip(c.message, L.message),
          author: clip(c.author, 200),
          displayId: clip(c.displayId, 16),
          timestamp: numOr(c.timestamp, undefined),
          references: Array.isArray(c.references) ? c.references.slice(0, 50).map(checkRef).filter(Boolean) : []
        })
      }
      return {
        items,
        currentRef: checkRef(d.currentRef),
        remoteRef: checkRef(d.remoteRef),
        baseRef: checkRef(d.baseRef),
        mergeBase: isCommit(d.mergeBase) ? d.mergeBase : undefined,
        hasMore: bool(d.hasMore),
        limit: count(d.limit) || n
      }
    })
  }

  function scmCommitFiles({ root, commit } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    if (!isCommit(commit)) return Promise.resolve(failure('bad-commit'))
    return call('scm.commitFiles', loc.project, { commit }, (d) => {
      const entries = checkScmEntries(d.entries)
      if (!entries || !isCommit(d.commit)) return null
      return { entries, commit: d.commit, parent: isCommit(d.parent) ? d.parent : null, hidden: count(d.hidden) }
    })
  }

  function scmBranchCompare({ root } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    return call('scm.branchCompare', loc.project, {}, (d) => {
      if (d.base === null || d.base === undefined) return { base: null }
      const files = checkScmEntries(d.files)
      if (typeof d.base !== 'string' || !files) return null
      return {
        base: clip(d.base, 300),
        mergeBase: isCommit(d.mergeBase) ? d.mergeBase : null,
        ahead: count(d.ahead),
        behind: count(d.behind),
        added: Number.isSafeInteger(d.added) && d.added >= 0 ? d.added : null,
        removed: Number.isSafeInteger(d.removed) && d.removed >= 0 ? d.removed : null,
        reviewUrl: typeof d.reviewUrl === 'string' && d.reviewUrl.length <= 2048 && WEB_URL.test(d.reviewUrl) ? d.reviewUrl : null,
        onBase: bool(d.onBase),
        head: isCommit(d.head) ? d.head : null,
        files,
        filesTruncated: bool(d.filesTruncated),
        hidden: count(d.hidden)
      }
    })
  }

  function scmFileHistory({ root, path, limit } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    const rel = relInProject(loc.project, path)
    if (!rel) return Promise.resolve(outside())
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, L.historyLimit) : 50
    return call('scm.fileHistory', loc.project, { path: rel, limit: n }, (d) => {
      if (!Array.isArray(d.items) || d.items.length > L.historyLimit) return null
      const items = []
      for (const c of d.items) {
        if (!isObj(c) || !isCommit(c.id)) return null
        items.push({ id: c.id, author: clip(c.author, 200), email: '', time: numOr(c.time, 0), message: clip(c.message, L.message) })
      }
      return { items, hasMore: bool(d.hasMore), uncommitted: bool(d.uncommitted), rel }
    })
  }

  function scmCommitInfo({ root, commit } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    if (!isCommit(commit)) return Promise.resolve(failure('bad-commit'))
    return call('scm.commitInfo', loc.project, { commit }, (d) => {
      const s = isObj(d.stats) ? d.stats : {}
      const webUrl = typeof d.webUrl === 'string' && d.webUrl.length <= 2048 && WEB_URL.test(d.webUrl) ? d.webUrl : null
      return { stats: { files: count(s.files), insertions: count(s.insertions), deletions: count(s.deletions) }, webUrl }
    })
  }

  // A commit hash in a host's pane or conversation: a commit of the shared
  // project? Asked through what the host already shares of its history (the
  // files of a commit, scm.commitFiles): no right for that, no link. Only
  // its full id comes back (no subject nor author over this request).
  function scmResolveCommit({ root, commit } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    if (!isCommit(commit) || commit.length > 40) return Promise.resolve(failure('bad-commit'))
    return call('scm.commitFiles', loc.project, { commit }, (d) => (isCommit(d.commit) && d.commit.startsWith(commit) ? { id: d.commit, subject: '', author: '', timestamp: null } : null))
  }

  function change(op) {
    return ({ root, paths } = {}) => {
      const loc = locate(root, root)
      if (!loc) return Promise.resolve(outside())
      const rels = relsOf(loc.project, paths)
      if (!rels) return Promise.resolve(outside())
      return call(op, loc.project, { paths: rels }, (d) => (op === 'scm.discard' ? { restored: count(d.restored), trashed: count(d.trashed) } : {}))
    }
  }

  function scmCommit({ root, message } = {}) {
    const loc = locate(root, root)
    if (!loc) return Promise.resolve(outside())
    const msg = String(message || '')
      .replace(/\r/g, '')
      .replace(/\0/g, '')
      .trim()
    if (!msg) return Promise.resolve(failure('no-message'))
    if (msg.length > L.message) return Promise.resolve(failure('too-large-to-send'))
    return call('scm.commit', loc.project, { message: msg }, (d) => ({ sha: isCommit(d.sha) ? d.sha : null }))
  }

  // The local handlers' scm object for a shared project (index.js scmFor).
  const scm = {
    scmStatus,
    scmFileVersions,
    scmHistory,
    scmCommitFiles,
    scmBranchCompare,
    scmFileHistory,
    scmCommitInfo,
    scmResolveCommit,
    scmStage: change('scm.stage'),
    scmUnstage: change('scm.unstage'),
    scmDiscard: change('scm.discard'),
    scmCommit,
    // The host's alone: they use its credentials, or its agents.
    scmPush: async () => localOnly(),
    scmPull: async () => localOnly(),
    scmFetch: async () => localOnly(),
    scmSync: async () => localOnly(),
    scmStagedDiff: async () => localOnly()
  }

  return {
    // explorer (index.js explorerFor)
    listDir,
    listMany,
    projectStatus,
    sparseInfo,
    searchNames,
    searchContent,
    create,
    rename,
    trash,
    listProjectFiles,
    // editor and viewer
    readForEdit,
    statForEdit,
    writeForEdit,
    headContent,
    readImage,
    readForView,
    // notes
    loadNotes,
    saveNotes,
    // Local History (the Timeline)
    localHistoryList,
    localHistoryRead,
    scm,
    localOnly
  }
}

// The main-process calls a shared path never makes on this computer: reveal
// in Explorer, open in VS Code or its own program, the PDF window, a terminal
// here (a pane started in the folder), an agent writing the commit message;
// and push, pull, fetch, sync (the host's credentials). index.js answers
// them with localOnly() when refusesLocal(path).
export const LOCAL_ONLY_ACTIONS = Object.freeze(['explorer:reveal', 'files:open', 'files:openPdf', 'pty:create', 'scm:generate', 'scm:push', 'scm:pull', 'scm:fetch', 'scm:sync'])
export const refusesLocal = (p) => isLsharePath(p)
