// Export and import of Tessel's settings: one JSON file holding the files of Tessel's
// data folder that make up the user's own setup (settings, projects and their
// layout, SSH hosts, the task board, what the user trusted, Live Share's trusted
// guests, the activity history), so a deleted data folder can be rebuilt.
//
// What is NOT in it, on purpose: every sign-in and secret. The accounts' folders
// (Claude, Codex...), provider credentials, saved passwords, cookies, the
// tessel command's token, Live Share's identity key and sealed host state, the
// terminal host's token, SSH passwords (Tessel never writes those anywhere): they
// are not portable (some are sealed to this Windows account) or must not be copied
// into a file. After an import the user signs in again.
//
// Import never writes over files Tessel is using: it stages the chosen files in
// `import-pending/` and the next start of Tessel puts them in place, before any of
// them is read (applyPendingImport), keeping each replaced file in
// `import-backups/<time>/`. Only names of the allowlist below are ever written, to
// the data folder, never a path from the file.
import fs from 'node:fs'
import path from 'node:path'

export const FORMAT = 1
export const APP = 'tessel'
export const MAX_FILE_BYTES = 40 * 1024 * 1024
export const MAX_TOTAL_BYTES = 120 * 1024 * 1024
export const PENDING_DIR = 'import-pending'
export const BACKUPS_DIR = 'import-backups'
const KEEP_BACKUPS = 5

// id -> the files in the data folder (top-level, by exact name) and the shape each must have.
export const CATEGORIES = [
  { id: 'settings', files: { 'workspace-layout.json': 'object' } },
  { id: 'hosts', files: { 'remote-hosts.json': 'object', 'ssh-host-keys.json': 'object' } },
  { id: 'board', files: { 'task-board.json': 'object' } },
  { id: 'trust', files: { 'chat-trust.json': 'object', 'git-trust.json': 'object', 'skill-sources.json': 'any' } },
  { id: 'liveshare', files: { 'liveshare-settings.json': 'object', 'liveshare-trusted.json': 'object' } },
  { id: 'activity', files: { 'activity.json': 'array' } }
]
const ALL = new Map(CATEGORIES.flatMap((c) => Object.entries(c.files).map(([name, shape]) => [name, { category: c.id, shape }])))

const fail = (code) => Object.assign(new Error(code), { code })
const shapeOk = (value, shape) => shape === 'any' || (shape === 'array' ? Array.isArray(value) : !!value && typeof value === 'object' && !Array.isArray(value))

// -> { bundle, included: [{ id, files: [{ name, bytes }] }], missing: [name] }
export function buildBackup({ dir, categories, appVersion = '', build = '', now = Date.now, fsImpl = fs } = {}) {
  const wanted = new Set(Array.isArray(categories) ? categories : CATEGORIES.map((c) => c.id))
  const files = {}
  const included = []
  const missing = []
  let total = 0
  for (const cat of CATEGORIES) {
    if (!wanted.has(cat.id)) continue
    const list = []
    for (const [name, shape] of Object.entries(cat.files)) {
      let text
      try {
        const file = path.join(dir, name)
        const st = fsImpl.lstatSync(file)
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a plain file') // i18n-ignore
        if (st.size > MAX_FILE_BYTES) throw fail('too-big')
        text = fsImpl.readFileSync(file, 'utf8')
      } catch (err) {
        if (err && err.code === 'too-big') throw err
        missing.push(name)
        continue
      }
      // A file that is being written or damaged is not put in a backup that looks good.
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        missing.push(name)
        continue
      }
      if (!shapeOk(parsed, shape)) {
        missing.push(name)
        continue
      }
      total += Buffer.byteLength(text)
      if (total > MAX_TOTAL_BYTES) throw fail('too-big')
      files[name] = text
      list.push({ name, bytes: Buffer.byteLength(text) })
    }
    if (list.length) included.push({ id: cat.id, files: list })
  }
  return { bundle: { app: APP, format: FORMAT, createdAt: now(), appVersion: String(appVersion).slice(0, 40), build: String(build).slice(0, 40), files }, included, missing }
}

// The file the user picked -> what it holds, checked, or a code. Nothing is written.
export function inspectBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_TOTAL_BYTES * 2) throw fail('too-big')
  let bundle
  try {
    bundle = JSON.parse(text)
  } catch {
    throw fail('not-a-backup')
  }
  if (!bundle || typeof bundle !== 'object' || bundle.app !== APP || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) throw fail('not-a-backup')
  if (!Number.isInteger(bundle.format) || bundle.format < 1) throw fail('not-a-backup')
  if (bundle.format > FORMAT) throw fail('newer')
  const files = {}
  const included = []
  let total = 0
  for (const cat of CATEGORIES) {
    const list = []
    for (const [name, shape] of Object.entries(cat.files)) {
      if (!Object.prototype.hasOwnProperty.call(bundle.files, name)) continue
      const body = bundle.files[name]
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_FILE_BYTES) continue
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        continue
      }
      if (!shapeOk(parsed, shape)) continue
      total += Buffer.byteLength(body)
      if (total > MAX_TOTAL_BYTES) throw fail('too-big')
      files[name] = body
      list.push({ name, bytes: Buffer.byteLength(body) })
    }
    if (list.length) included.push({ id: cat.id, files: list })
  }
  if (!included.length) throw fail('empty')
  return {
    files,
    summary: { createdAt: Number.isFinite(bundle.createdAt) ? bundle.createdAt : null, appVersion: String(bundle.appVersion || '').slice(0, 40), build: String(bundle.build || '').slice(0, 40), categories: included }
  }
}

// Chosen categories of an inspected backup -> staged in the data folder, to be put in
// place at the next start. -> { count, categories }
export function stageImport({ dir, files, categories, now = Date.now, fsImpl = fs } = {}) {
  const wanted = new Set(Array.isArray(categories) ? categories : [])
  const names = []
  for (const cat of CATEGORIES) {
    if (!wanted.has(cat.id)) continue
    for (const name of Object.keys(cat.files)) if (Object.prototype.hasOwnProperty.call(files, name)) names.push(name)
  }
  if (!names.length) throw fail('nothing-chosen')
  const pending = path.join(dir, PENDING_DIR)
  fsImpl.rmSync(pending, { recursive: true, force: true })
  fsImpl.mkdirSync(pending, { recursive: true })
  for (const name of names) fsImpl.writeFileSync(path.join(pending, name), files[name])
  // The manifest last: a staging cut short has no manifest and is never applied.
  fsImpl.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify({ format: FORMAT, at: now(), files: names }))
  return { count: names.length, categories: [...wanted] }
}

export const hasPendingImport = (dir, fsImpl = fs) => fsImpl.existsSync(path.join(dir, PENDING_DIR, 'manifest.json'))

// At start, before anything reads the data folder: put the staged files in place.
// Each replaced file is kept in import-backups/<time>/. -> { applied: [names], failed: [names] }
export function applyPendingImport({ dir, now = Date.now, fsImpl = fs } = {}) {
  const pending = path.join(dir, PENDING_DIR)
  const out = { applied: [], failed: [] }
  let manifest
  try {
    manifest = JSON.parse(fsImpl.readFileSync(path.join(pending, 'manifest.json'), 'utf8'))
  } catch {
    // No manifest: a staging that never finished (or nothing). Dropped.
    try {
      fsImpl.rmSync(pending, { recursive: true, force: true })
    } catch {
      /* stays, harmless */
    }
    return out
  }
  const names = Array.isArray(manifest && manifest.files) ? manifest.files.filter((n) => typeof n === 'string' && ALL.has(n)) : []
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const backups = path.join(dir, BACKUPS_DIR, stamp)
  for (const name of names) {
    try {
      const source = path.join(pending, name)
      const st = fsImpl.lstatSync(source)
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) throw new Error('bad staged file') // i18n-ignore
      const body = fsImpl.readFileSync(source, 'utf8')
      if (!shapeOk(JSON.parse(body), ALL.get(name).shape)) throw new Error('bad shape') // i18n-ignore
      const target = path.join(dir, name)
      if (fsImpl.existsSync(target)) {
        fsImpl.mkdirSync(backups, { recursive: true })
        fsImpl.copyFileSync(target, path.join(backups, name))
      }
      const tmp = `${target}.import-tmp`
      fsImpl.writeFileSync(tmp, body)
      fsImpl.renameSync(tmp, target)
      // A leftover of the replaced file's own safety copy would bring the old data back.
      for (const extra of [`${name}.bak`]) fsImpl.rmSync(path.join(dir, extra), { force: true })
      out.applied.push(name)
    } catch {
      out.failed.push(name)
    }
  }
  try {
    fsImpl.rmSync(pending, { recursive: true, force: true })
  } catch {
    /* stays, applied again next start */
  }
  // Only the last few safety copies are kept.
  try {
    const root = path.join(dir, BACKUPS_DIR)
    const all = fsImpl.readdirSync(root).sort()
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fsImpl.rmSync(path.join(root, old), { recursive: true, force: true })
  } catch {
    /* none */
  }
  return out
}
