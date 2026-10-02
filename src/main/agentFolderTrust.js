// Pre-trust the folder an agent starts in, in that agent's own settings, so it
// does not stop at "Do you trust this folder?" when Tessel starts it there.
// After Orca's src/main/agent-trust-presets.ts, agent-workspace-trust.ts,
// execution-host-workspace-trust.ts, claude/claude-folder-trust-file.ts and
// src/shared/home-or-filesystem-root.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
//
// Which folders (Tessel's consent rule, stricter than Orca's): only a folder
// the user already chose in Tessel, checked here in the main process, never
// a path the window just names:
//   - a local project folder of the saved layout (a project the user added),
//   - a folder the user trusted for chat agents (chatTrust.js),
//   - a copy Tessel made itself from such a project's own code (its HEAD or
//     a local branch, recorded by workerCopies.js and verified both ways by
//     git's links). A pull request's copy (a pinned commit, maybe a fork's
//     code) or a remote branch's is never pre-trusted: the agent asks.
// Never a home folder, a folder above one or a disk root for an agent whose
// trust there would cover every folder below it; never over SSH or in WSL
// (that agent reads another computer's settings); only when Settings > Agents
// "Trust the folder when Tessel starts an agent" is on.
//
// Every write is minimal and atomic (temp file + rename, the file's mode and
// a symbolic link's target kept): one entry added, every other key, line and
// comment left as it was. A file that cannot be read or parsed is never
// rewritten. Any failure, or a write slower than DEADLINE_MS, means only that
// the agent asks, as it would without Tessel.
import fs from 'fs'
import os from 'os'
import { dirname, join, resolve, posix, win32 } from 'path'
import { writeFileAtomic } from './safeJson.js'
import { trustKey } from './chat/chatTrust.js'
import { withCodexProjectTrusted } from './codexProjectTrust.js'

export const DEADLINE_MS = 1500

// Tessel's agent ids -> the trust each one reads.
export const TRUST_PRESETS = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  copilot: 'copilot',
  antigravity: 'antigravity'
}

// Whether trust on a folder also covers the folders below it, per each
// agent's own lookup: Claude walks up parent folders, Copilot accepts any
// trusted ancestor. Codex matches its start folder (or that folder's repo
// root), Antigravity the exact folder, and Cursor never inherits from a
// home, a folder above one or a shallow path.
export const INHERITS_FROM_A_HOME = {
  claude: true,
  codex: false,
  cursor: false,
  copilot: true,
  antigravity: false
}

// --- Too broad: a disk root, a home, or a folder above a home ---------------
const comparable = (p) => {
  let s = String(p).replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(s) || s.startsWith('//')) s = s.toLowerCase()
  return s.length > 1 && !/^[a-z]:\/$/i.test(s) ? s.replace(/\/+$/, '') : s
}
const ROOT = /^(?:\/|[a-z]:\/?|\/\/[^/]+(?:\/[^/]+)?)$/i

function forms(p) {
  const out = [p, resolve(p)]
  try {
    out.push(fs.realpathSync.native(p))
  } catch {
    /* missing: given and resolved forms */
  }
  return out
}

export function isTooBroadToPreTrust(folder, homes) {
  const homeKeys = homes.filter(Boolean).flatMap(forms).map(comparable)
  return forms(folder)
    .map(comparable)
    .some((key) => ROOT.test(key) || homeKeys.some((h) => h === key || h.startsWith(`${key}/`)))
}

function realpathOrSelf(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

// --- Claude Code: projects[<folder>].hasTrustDialogAccepted in ~/.claude.json
// The file Claude reads: a legacy <config dir>/.config.json wins, else
// .claude.json in CLAUDE_CONFIG_DIR or the home (-custom-oauth with a custom
// OAuth URL).
export function claudeConfigFile(env, home, { style = process.platform === 'win32' ? 'win32' : 'posix', exists = fs.existsSync } = {}) {
  const p = style === 'win32' ? win32 : posix
  const dir = env.CLAUDE_CONFIG_DIR || ''
  const legacy = p.join((dir || p.join(home, '.claude')).normalize('NFC'), '.config.json')
  if (exists(legacy)) return legacy
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''
  return p.join(dir || home, `.claude${suffix}.json`)
}

// The keys Claude looks the folder up by: NFC, normalized, / on Windows; the
// given (resolved) and the real path.
export function claudeTrustKeys(folder, style = process.platform === 'win32' ? 'win32' : 'posix') {
  const p = style === 'win32' ? win32 : posix
  const keys = new Set()
  for (const form of [resolve(folder), realpathOrSelf(folder)]) {
    const n = p.normalize(form.normalize('NFC'))
    keys.add(style === 'win32' ? n.replaceAll('\\', '/') : n)
  }
  return [...keys]
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// -> { kind: 'unchanged' | 'refuse' } | { kind: 'changed', config }
export function withClaudeFolderTrust(config, keys) {
  if (config.projects !== undefined && !isPlainObject(config.projects)) return { kind: 'refuse' }
  const projects = { ...config.projects }
  if (keys.some((k) => isPlainObject(projects[k]) && projects[k].hasTrustDialogAccepted === true)) return { kind: 'unchanged' }
  for (const k of keys) projects[k] = isPlainObject(projects[k]) ? { ...projects[k], hasTrustDialogAccepted: true } : { hasTrustDialogAccepted: true }
  return { kind: 'changed', config: { ...config, projects } }
}

function readObject(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(data) ? data : null
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Claude Code takes <file>.lock (a folder, proper-lockfile's way) while it
// writes its config. Tessel takes it the same way and never breaks it: held
// after a few short tries means the agent asks.
async function withClaudeLock(file, fn) {
  const lock = `${file}.lock`
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (err) {
      if (err.code !== 'EEXIST' || i >= 4) return 'locked'
      await sleep(Math.min(250, 50 * 2 ** i))
    }
  }
  try {
    return fn()
  } finally {
    try {
      fs.rmdirSync(lock)
    } catch {
      /* already gone */
    }
  }
}

// Never creates the file (Claude makes it on first run).
// -> 'granted' | 'unchanged' | 'missing-config' | 'unreadable' | 'locked'
export async function grantClaudeFolderTrust(file, keys) {
  if (!fs.existsSync(file)) return 'missing-config'
  const first = readObject(file)
  if (!first) return 'unreadable'
  // Most launches need nothing: the lock only when a write is due.
  const planned = withClaudeFolderTrust(first, keys).kind
  if (planned !== 'changed') return planned === 'refuse' ? 'unreadable' : 'unchanged'
  return withClaudeLock(file, () => {
    // Read again under the lock, then write at once (synchronously).
    const current = readObject(file)
    if (!current) return 'unreadable'
    const change = withClaudeFolderTrust(current, keys)
    if (change.kind !== 'changed') return change.kind === 'refuse' ? 'unreadable' : 'unchanged'
    writeFileAtomic(file, `${JSON.stringify(change.config, null, 2)}\n`)
    return 'granted'
  })
}

// --- Codex: [projects."<real path>"] trust_level = "trusted" in config.toml ---
// The config of the Codex home it runs with (CODEX_HOME, else ~/.codex); not
// created when that home does not exist (Codex not set up there).
export function markCodexProjectTrusted(folder, codexHome) {
  if (!fs.existsSync(codexHome)) return 'missing-config'
  const file = join(codexHome, 'config.toml')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') return 'unreadable'
  }
  const next = withCodexProjectTrusted(text, realpathOrSelf(folder))
  if (!next.changed) return next.reason || 'unchanged'
  writeFileAtomic(file, next.text)
  return 'granted'
}

// --- Cursor: ~/.cursor/projects/<slug>/.workspace-trusted -------------------
export function cursorSlug(abs) {
  return abs.replace(/^[\\/]+/, '').replace(/[\\/:*?"<>|]+/g, '-')
}
export function markCursorWorkspaceTrusted(folder, home) {
  const abs = realpathOrSelf(folder)
  const slug = cursorSlug(abs)
  if (!slug) return 'unchanged'
  const dir = join(home, '.cursor', 'projects', slug)
  const file = join(dir, '.workspace-trusted')
  if (fs.existsSync(file)) return 'unchanged'
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(file, `${JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: abs }, null, 2)}\n`)
  return 'granted'
}

// --- A path added to a list in a JSON settings file -------------------------
// Copilot CLI: ~/.copilot/config.json trustedFolders. Antigravity (agy):
// ~/.gemini/antigravity-cli/settings.json trustedWorkspaces (not the Gemini
// CLI's file). A file that does not parse is the user's to fix: left alone.
function appendTrustedPath(file, key, folder) {
  const abs = realpathOrSelf(folder)
  let config = {}
  if (fs.existsSync(file)) {
    config = readObject(file)
    if (!config) return 'unreadable'
  }
  if (config[key] !== undefined && !Array.isArray(config[key])) return 'unreadable'
  const list = Array.isArray(config[key]) ? config[key] : []
  if (list.some((e) => typeof e === 'string' && realpathOrSelf(e) === abs)) return 'unchanged'
  fs.mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(file, `${JSON.stringify({ ...config, [key]: [...list, abs] }, null, 2)}\n`)
  return 'granted'
}
export const markCopilotFolderTrusted = (folder, home) =>
  appendTrustedPath(join(home, '.copilot', 'config.json'), 'trustedFolders', folder)
export const markAntigravityWorkspaceTrusted = (folder, home) =>
  appendTrustedPath(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'trustedWorkspaces', folder)

// --- The service --------------------------------------------------------------
// chatTrust: { isTrusted(dir) }; workerCopies: { trustRoots(cwd, { worker }) }.
export function createAgentFolderTrust({
  chatTrust = null,
  workerCopies = null,
  homedir = os.homedir,
  platform = process.platform,
  deadlineMs = DEADLINE_MS,
  log = null
} = {}) {
  let roots = new Set()
  // One write at a time per agent: two launches never race on one file.
  const queues = new Map()

  const realKey = (p) => trustKey(realpathOrSelf(p))

  // The saved layout's local project folders (worktreeList.localRootsOfLayout).
  function setRoots(list) {
    roots = new Set((Array.isArray(list) ? list : []).map((p) => realKey(p)).filter(Boolean))
  }

  const chosen = (dir) => roots.has(realKey(dir)) || chatTrust?.isTrusted(dir) === true

  // The folder to trust for an agent started in `cwd`, or null.
  function eligibleFolder(cwd) {
    if (typeof cwd !== 'string' || !trustKey(cwd) || /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]/i.test(cwd)) return null
    try {
      if (!fs.statSync(cwd).isDirectory()) return null
    } catch {
      return null
    }
    if (chosen(cwd)) return cwd
    // A copy Tessel made from a chosen project's own code.
    let copyOf = []
    try {
      copyOf = workerCopies?.trustRoots(cwd, { worker: true }) || []
    } catch {
      copyOf = []
    }
    return copyOf.some((project) => chosen(project)) ? cwd : null
  }

  function write(preset, folder, env) {
    const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir()
    switch (preset) {
      case 'claude':
        return grantClaudeFolderTrust(claudeConfigFile(env, home, { style: platform === 'win32' ? 'win32' : 'posix' }), claudeTrustKeys(folder, platform === 'win32' ? 'win32' : 'posix'))
      case 'codex':
        return markCodexProjectTrusted(folder, env.CODEX_HOME || join(home, '.codex'))
      case 'cursor':
        return markCursorWorkspaceTrusted(folder, home)
      case 'copilot':
        return markCopilotFolderTrusted(folder, home)
      case 'antigravity':
        return markAntigravityWorkspaceTrusted(folder, home)
    }
    return 'unchanged'
  }

  // Before Tessel starts agent `agentId` in `cwd` with variables `env` (the
  // launch's own, CLAUDE_CONFIG_DIR / CODEX_HOME of its account included).
  // Never throws, never waits past the deadline.
  // -> 'granted' | 'unchanged' | 'off' | 'not-eligible' | 'too-broad' | ... | 'failed' | 'timeout'
  async function apply({ agentId, cwd, env = {}, enabled = false, wsl = false, remote = false } = {}) {
    const preset = Object.hasOwn(TRUST_PRESETS, agentId) ? TRUST_PRESETS[agentId] : null
    if (!preset) return 'no-preset'
    if (enabled !== true) return 'off'
    if (remote || wsl) return 'not-eligible'
    let timer
    const job = (async () => {
      const folder = eligibleFolder(cwd)
      if (!folder) return 'not-eligible'
      const e = env && typeof env === 'object' ? env : {}
      if (INHERITS_FROM_A_HOME[preset] && isTooBroadToPreTrust(folder, [homedir(), e.HOME, e.USERPROFILE])) return 'too-broad'
      const prev = queues.get(preset) || Promise.resolve()
      const run = prev.then(() => write(preset, folder, e))
      queues.set(preset, run.catch(() => {}))
      return run
    })()
    try {
      const outcome = await Promise.race([job, new Promise((r) => (timer = setTimeout(() => r('timeout'), deadlineMs)))])
      if (outcome === 'timeout') log?.warn?.('agents', `${preset} folder trust did not finish in ${deadlineMs} ms; the agent may ask`)
      return outcome
    } catch (err) {
      log?.warn?.('agents', `${preset} folder trust failed (the agent will ask): ${err && err.message}`)
      return 'failed'
    } finally {
      clearTimeout(timer)
      job.catch(() => {})
    }
  }

  return { setRoots, eligibleFolder, apply }
}
