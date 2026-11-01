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
// What decides what the user's agents may do (agent commands, run rules, Yolo and
// auto-approve, SSH proxy commands, host keys, trusted guests and folders) is the
// "security" part: an import brings it back only if the user ticks it, and otherwise
// keeps what this computer already has (a file from someone else must not decide it).
// Agent environment variables (they hold API keys) are never exported.
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
  { id: 'hosts', files: { 'remote-hosts.json': 'object' } },
  { id: 'board', files: { 'task-board.json': 'object' } },
  { id: 'liveshare', files: { 'liveshare-settings.json': 'object' } },
  { id: 'activity', files: { 'activity.json': 'array' } },
  // Brought back only when ticked: it decides what agents may do and who may connect.
  { id: 'security', files: { 'ssh-host-keys.json': 'object', 'liveshare-trusted.json': 'object', 'chat-trust.json': 'object', 'git-trust.json': 'object', 'skill-sources.json': 'any' } }
]
export const SECURITY = 'security'

// The settings that decide what agents may do (kept as they are here unless "security" is ticked).
export const SENSITIVE_SETTINGS = [
  'agentPermissions', 'yoloFolders', 'agentTerminal', 'agentTerminalAutoApprove', 'agentTerminalAutoApproveWarned',
  'agentTerminalIgnoreDefaultRules', 'agentTerminalYoloNoAsk', 'agentTerminalRules', 'agentTerminalWorkspaceRules',
  'agentFolderTrust', 'agentRelay', 'agentRelayAsk', 'agentRelayMax', 'orchestrationConfirmWorkers',
  'teamWakeUnconfirmed', 'customAgents', 'quickCommands', 'agentPrefs', 'cursorStatusHooks'
]
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// The layout file's own shape: what the start-up restore walks. A file that does not look
// like one is refused before it is staged, not found out at the next start.
export function layoutOk(layout) {
  if (!isObject(layout)) return false
  if (layout.settings !== undefined && !isObject(layout.settings)) return false
  const spaces = layout.workspaces
  if (spaces === undefined) return true
  if (!Array.isArray(spaces) || spaces.length > 2000) return false
  return spaces.every((w) => isObject(w) && (w.tree === undefined || w.tree === null || isObject(w.tree)))
}

// Agent environment variables hold API keys: never exported.
function withoutEnv(layout) {
  const prefs = layout && layout.settings && layout.settings.agentPrefs
  if (!isObject(prefs)) return layout
  const copy = { ...layout, settings: { ...layout.settings, agentPrefs: {} } }
  for (const [id, pref] of Object.entries(prefs)) {
    if (isObject(pref)) {
      const { env, ...rest } = pref // eslint-disable-line no-unused-vars -- the env is what is dropped
      copy.settings.agentPrefs[id] = rest
    } else copy.settings.agentPrefs[id] = pref
  }
  return copy
}

// The commands the panes of a layout start (a restored agent pane runs its command).
function agentCommands(node, out = new Set(), depth = 0) {
  if (depth > 60 || !node) return out
  if (Array.isArray(node)) node.forEach((n) => agentCommands(n, out, depth + 1))
  else if (isObject(node)) {
    if (typeof node.agentCommand === 'string') out.add(node.agentCommand)
    for (const v of Object.values(node)) if (v && typeof v === 'object') agentCommands(v, out, depth + 1)
  }
  return out
}
function dropUnknownCommands(node, known, depth = 0) {
  if (depth > 60 || !node) return
  if (Array.isArray(node)) node.forEach((n) => dropUnknownCommands(n, known, depth + 1))
  else if (isObject(node)) {
    if (typeof node.agentCommand === 'string' && !known.has(node.agentCommand)) node.agentCommand = null
    for (const v of Object.values(node)) if (v && typeof v === 'object') dropUnknownCommands(v, known, depth + 1)
  }
}

// What an import without "security" does to the files it brings: the sensitive settings
// and the agents' commands stay what this computer has, a host's proxy command is dropped.
export function withoutSecurity(name, body, currentBody) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  let current = null
  try {
    current = currentBody ? JSON.parse(currentBody) : null
  } catch {
    current = null
  }
  if (name === 'workspace-layout.json' && isObject(parsed)) {
    if (isObject(parsed.settings)) {
      for (const key of SENSITIVE_SETTINGS) {
        delete parsed.settings[key]
        if (current && isObject(current.settings) && Object.prototype.hasOwnProperty.call(current.settings, key)) parsed.settings[key] = current.settings[key]
      }
    }
    dropUnknownCommands(parsed.workspaces, agentCommands(current && current.workspaces))
    return JSON.stringify(parsed)
  }
  if (name === 'remote-hosts.json' && isObject(parsed) && Array.isArray(parsed.targets)) {
    for (const target of parsed.targets) if (isObject(target)) delete target.proxyCommand
    return JSON.stringify(parsed)
  }
  return body
}
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
        // One file too big (an activity history can be) is left out and listed, the rest is exported.
        if (st.size > MAX_FILE_BYTES) {
          missing.push(name)
          continue
        }
        text = fsImpl.readFileSync(file, 'utf8')
      } catch {
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
      if (name === 'workspace-layout.json') text = JSON.stringify(withoutEnv(parsed))
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
      if (name === 'workspace-layout.json' && !layoutOk(parsed)) continue
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
  // A link planted where the staging goes is never followed.
  for (const p of [pending, path.join(dir, BACKUPS_DIR)]) {
    try {
      if (fsImpl.lstatSync(p).isSymbolicLink()) throw fail('failed')
    } catch (err) {
      if (err && err.code === 'failed') throw err
    }
  }
  const security = wanted.has(SECURITY)
  const bodies = {}
  for (const name of names) {
    let body = files[name]
    if (!security) {
      let currentBody = null
      try {
        currentBody = fsImpl.readFileSync(path.join(dir, name), 'utf8')
      } catch {
        currentBody = null
      }
      body = withoutSecurity(name, body, currentBody)
    }
    bodies[name] = body
  }
  fsImpl.rmSync(pending, { recursive: true, force: true })
  fsImpl.mkdirSync(pending, { recursive: true })
  for (const name of names) fsImpl.writeFileSync(path.join(pending, name), bodies[name])
  // The manifest last: a staging cut short has no manifest and is never applied.
  fsImpl.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify({ format: FORMAT, at: now(), files: names }))
  return { count: names.length, categories: CATEGORIES.filter((c) => wanted.has(c.id)).map((c) => c.id) }
}

// A target another program has open for a moment (an antivirus, the indexer) is tried again.
function renameWithRetry(fsImpl, from, to) {
  let last
  for (let i = 0; i < 6; i++) {
    try {
      fsImpl.renameSync(from, to)
      return
    } catch (err) {
      last = err
      if (!err || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break
      const until = Date.now() + 100 * (i + 1)
      while (Date.now() < until) { /* a short wait: this runs once, at start */ }
    }
  }
  throw last
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
  const names = Array.isArray(manifest && manifest.files) ? [...new Set(manifest.files.filter((n) => typeof n === 'string' && ALL.has(n)))] : []
  // A link where the staging or the safety copies go is not followed: nothing is applied.
  for (const p of [pending, path.join(dir, BACKUPS_DIR)]) {
    try {
      if (fsImpl.lstatSync(p).isSymbolicLink()) return { applied: [], failed: names }
    } catch {
      /* not there yet */
    }
  }
  // Applied at most once from this manifest: a crash half-way is resumed from the staged
  // files that are left, never started over on top of what was already applied.
  try {
    fsImpl.renameSync(path.join(pending, 'manifest.json'), path.join(pending, 'manifest.applying'))
  } catch {
    return { applied: [], failed: names }
  }
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
      renameWithRetry(fsImpl, tmp, target)
      out.applied.push(name)
      fsImpl.rmSync(source, { force: true })
    } catch {
      out.failed.push(name)
    }
  }
  if (out.failed.length) {
    // What could not be put in place stays staged, to be tried again at the next start.
    try {
      fsImpl.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify({ format: FORMAT, at: now(), files: out.failed }))
      fsImpl.rmSync(path.join(pending, 'manifest.applying'), { force: true })
    } catch {
      /* the staging stays as it is */
    }
  } else {
    try {
      fsImpl.rmSync(pending, { recursive: true, force: true })
    } catch {
      /* stays without a manifest: dropped at the next start */
    }
  }
  // Only the last few safety copies are kept, never the one this import just made.
  try {
    const root = path.join(dir, BACKUPS_DIR)
    const all = fsImpl.readdirSync(root).filter((n) => n !== stamp).sort()
    for (const old of all.slice(0, Math.max(0, all.length - (KEEP_BACKUPS - 1)))) fsImpl.rmSync(path.join(root, old), { recursive: true, force: true })
  } catch {
    /* none */
  }
  return out
}
