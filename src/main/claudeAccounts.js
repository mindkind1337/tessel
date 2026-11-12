// Independent implementation informed by stablyai/orca's Claude account/runtime
// auth services (MIT, Lovecast Inc., 2026). Credentials stay in private main-process
// storage; public records contain identity metadata only. Windows/file auth only.
//
// Each managed account runs Claude Code with its own config folder
// (CLAUDE_CONFIG_DIR = its auth folder): its sign-in lives there and only there,
// and Claude refreshes it there. The system login stays in ~/.claude, untouched.
// Before a launch the account's folder is linked to the system Claude folder's
// conversations, plugins, skills… and its settings are synced both ways with
// the system's, so every account shares them. The "selected" account is the
// default for new sessions.
import os from 'os'
import fs from 'fs/promises'
import { join, resolve, isAbsolute, dirname, relative, sep } from 'path'
import { randomUUID, createHash } from 'crypto'
import { t } from './i18n'
import { ACCOUNT_AUTH_ENV } from './providerLogin'
import {
  authError,
  inspect,
  ensureDirectory,
  readText,
  writeText,
  exclusiveText,
  jsonObject,
  ownedDirectory,
  removeOwnedDirectory
} from './claudeAccountsStorage'

const MARKER = '.tessel-managed-claude-auth'
const STALE_LOGIN_MS = 60 * 60 * 1000 // a sign-in times out after 10 minutes
const LOGIN_PID = '.tessel-login-pid' // a sign-in whose end was never confirmed
const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SYSTEM_FILE_LIMIT = 8 * 1024 * 1024
// The system Claude folder's folders every account uses as its own (junctions),
// created there when missing: conversations and what Claude keeps beside them,
// plugins, skills, agents, commands… Its other folders are shared too, unless
// they are Claude's own state for that folder (PRIVATE_ENTRIES).
export const SHARED_FOLDERS = [
  'projects',
  'session-env',
  'file-history',
  'shell-snapshots',
  'todos',
  'tasks',
  'plans',
  'transcripts',
  'paste-cache',
  'plugins',
  'skills',
  'agents',
  'commands',
  'output-styles',
  'ide',
  'chrome'
]
// Each config folder's own: logins, logs, caches, state, the local install,
// and `sessions` (its live-process registry). The prompt history
// (history.jsonl) stays each account's own too.
const PRIVATE_ENTRIES = new Set([
  'api-dumps',
  'backups',
  'bridge-spawn',
  'cache',
  'ccr',
  'debug',
  'downloads',
  'dump-prompts',
  'feedback',
  'feedback-bundles',
  'file-transfers',
  'image-cache',
  'jobs',
  'local',
  'local-settings',
  'logs',
  'mcp-discovery-cache',
  'mcp-skill-archives',
  'project-settings',
  'remote',
  'remote-control',
  'scratch',
  'seed-admin',
  'sessions',
  'shares',
  'startup-perf',
  'state',
  'statsig',
  'storage-v2',
  'systemd',
  'teams',
  'telemetry',
  'traces',
  'uploads',
  'usage-data'
])
const sharedFolderName = (name) =>
  !PRIVATE_ENTRIES.has(name) &&
  !name.startsWith('.') &&
  !/^(daemon|agent-memory)/.test(name) &&
  !name.endsWith('.merge')
// Synced with the system folder before each launch: a change made on one side
// since the last launch goes to the other; changed on both, the system's
// wins. Copied, not linked: Claude replaces these files when it saves them.
// Only these: an unknown file could hold a login, and a second copy of one
// breaks it.
export const COPIED_FILES = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'keybindings.json']
const SETTINGS_FILES = new Set(['settings.json', 'settings.local.json'])
// What the last sync left on both sides, in each account's folder.
const SYNC_STATE = '.tessel-sync.json'
// The settings that choose how Claude signs in, and the env entries that
// carry a key or a token or send its requests elsewhere (a gateway would get
// the account's own token, with the headers meant for it): never in an
// account's copy (it signs in with its own login), and never removed from
// the system's.
const AUTH_SETTINGS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod', 'forceLoginOrgUUID']
const ENDPOINT_ENV = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS'
]
const AUTH_ENV = new Set([...ACCOUNT_AUTH_ENV.claude, ...ENDPOINT_ENV].map((name) => name.toUpperCase()))
// Tessel's own hook handlers (teamInstall.js) run this script. Tessel adds
// them to an account's settings.json at each launch (with the node of that
// session) and to the system's: never the person's change. The account's
// copy holds the system's.
const TESSEL_HOOK = 'tessel-team-mcp.cjs'
const MEMORY_IMPORT = '@~/.claude/CLAUDE.md'
// Claude's own bookkeeping in .claude.json (counters, times, what it saw or
// did last, caches): every session changes it. The system's when it has one,
// else the account's; never written back, kept aside or recorded.
const BOOKKEEPING = /count|history|^last|seen|tips|cache|^example|stamp|(At|Time|Date)$/i
// In the sync state: an entry the account keeps alone (gone from the system
// after the account changed it).
const OWN = '*'
// The keys of the system's .claude.json an account's own one never takes: its
// login and ids, first-start facts, caches, and its subscription, passes,
// usage, organization and claude.ai state (all bound to an account).
const ACCOUNT_KEYS = new Set([
  'userID',
  'machineID',
  'numStartups',
  'hasAvailableSubscription',
  'additionalModelOptionsAnsweredAt',
  'artifactRosterDenied',
  'lastSeenOrgDefaultUpdatedAt',
  'startupPrefetchedAt',
  'hasRemoteEnvironment'
])
export const sharedStateKey = (key) =>
  !ACCOUNT_KEYS.has(key) &&
  !/cache|passes|oauth|api_?key|token|subscription|usage|^claudeai|^bridge|^remote|^first/i.test(key) &&
  !/^org|Org/.test(key)
const queues = new Map()
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const publicText = (value) =>
  text(value)
    ?.replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 240) || null
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])])
        )
      : value
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`
const fold = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const lstatOrNull = (path) =>
  fs.lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
const absentOauth = () => ({ present: false, value: null })
const oauthField = (config) =>
  Object.hasOwn(config, 'oauthAccount')
    ? { present: true, value: config.oauthAccount }
    : absentOauth()
const identity = (value) => ({
  account: text(value?.accountUuid ?? value?.accountId),
  email: text(value?.emailAddress ?? value?.email)?.toLowerCase() || null,
  organization: text(value?.organizationUuid ?? value?.organizationId ?? value?.orgId)
})
const conflict = (a, b) =>
  ['account', 'email', 'organization'].some((k) => a[k] && b[k] && a[k] !== b[k])
function matches(a, b) {
  return (
    !conflict(a, b) &&
    !!((a.account && a.account === b.account) || (a.email && a.email === b.email)) &&
    (!a.organization || a.organization === b.organization)
  )
}
// Who an account's folder shows signed in (its .claude.json profile, or its
// login when that names someone), against the identity saved at sign-in:
// 'none' (nobody yet: a new folder), 'same', or 'other' (a /login to another
// account in one of its sessions).
function folderIdentity(saved, value) {
  const who = identity(value)
  if (!who.account && !who.email) return 'none'
  const same = (saved.account && saved.account === who.account) || (saved.email && saved.email === who.email)
  return same && !conflict(saved, who) ? 'same' : 'other'
}
// A valid credentials document with no claude.ai login in it.
function signedOut(raw) {
  const parsed = jsonObject(raw)
  return !Object.hasOwn(parsed, 'claudeAiOauth') || parsed.claudeAiOauth === null
}
function credentials(raw) {
  if (raw === null) return null
  const parsed = jsonObject(raw)
  if (!object(parsed.claudeAiOauth) || !text(parsed.claudeAiOauth.accessToken))
    throw authError(t('main.claudeAccount.credentialsInvalid', 'Claude OAuth credentials are missing or invalid.'))
  return parsed.claudeAiOauth
}
function metadata(raw) {
  if (raw === null) return { version: 1, selectedId: null, accounts: [] }
  const value = jsonObject(raw)
  if (
    value.version !== 1 ||
    !(value.selectedId === null || typeof value.selectedId === 'string') ||
    !(value.perSession === undefined || typeof value.perSession === 'boolean') ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 100 ||
    value.accounts.some(
      (a) =>
        !object(a) ||
        !UUID.test(a.id) ||
        !object(a.identity) ||
        !['account', 'email', 'organization'].every(
          (key) => a.identity[key] === null || typeof a.identity[key] === 'string'
        ) ||
        (!a.identity.account && !a.identity.email) ||
        typeof a.lastLoginAt !== 'string'
    ) ||
    new Set(value.accounts.map((a) => a.id)).size !== value.accounts.length
  )
    throw authError()
  return value
}
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(stable(value))).digest('base64url').slice(0, 16)
const some = (map) => Object.keys(map).length > 0
// One value of .claude.json, synced both ways. `base`: its digest at the last
// sync (OWN: kept by the account alone; undefined: absent on both sides then,
// or no sync yet). -> the account's and the system's values (undefined:
// none), the next base, and `lost`: the account's value a system change
// replaced. `removals`: an entry removed in the account is removed from the
// system too. `bookkeeping`: Claude's own (BOOKKEEPING). `writeBack` false:
// the system is left as it is this time.
function syncValue(a, s, base, { removals = false, bookkeeping = false, writeBack = true } = {}) {
  const ha = a === undefined ? undefined : digest(a)
  const hs = s === undefined ? undefined : digest(s)
  if (bookkeeping) return { a: s === undefined ? a : s, s }
  if (ha === hs) return { a, s, base: ha }
  if (base === OWN) return s === undefined ? { a, s, base: OWN } : { a: s, s, base: hs, lost: a }
  // Only the system changed it.
  if (ha === base) return { a: s, s, base: hs }
  // Only the account changed it.
  if (hs === base) {
    if (!writeBack) return { a, s, base }
    if (a === undefined) return removals ? { a, s: undefined, base: undefined } : { a: s, s, base: hs }
    return { a, s: a, base: ha }
  }
  // Both changed it: the system's wins. Gone from the system: the account keeps its own.
  if (s === undefined) return { a, s, base: OWN }
  return { a: s, s, base: hs, lost: a }
}
// One map's entries synced (`each` decides each one): the account's and the
// system's maps keep their key order, new keys at the end.
function syncMap(own, system, base, each) {
  const account = { ...own }
  const shared = { ...system }
  const next = {}
  const lost = {}
  const known = object(base) ? base : {}
  for (const key of new Set([...Object.keys(own), ...Object.keys(system), ...Object.keys(known)])) {
    const result = each(key, own[key], system[key], known[key])
    if (!result) continue
    if (result.a === undefined) delete account[key]
    else account[key] = result.a
    if (result.s === undefined) delete shared[key]
    else shared[key] = result.s
    if (result.base !== undefined) next[key] = result.base
    if (result.lost !== undefined) lost[key] = result.lost
  }
  return { account, system: shared, base: next, lost }
}
// A project's fields. Its trust stays the account's own when given there
// (Tessel trusts a folder right before a launch), never written back.
function syncProjectField(key, a, s, base, writeBack) {
  if (key === 'hasTrustDialogAccepted') return { a: a === true || s === undefined ? a : s, s }
  return syncValue(a, s, typeof base === 'string' ? base : undefined, {
    removals: true,
    bookkeeping: BOOKKEEPING.test(key),
    writeBack
  })
}
// Not changed in the account since the last sync, its bookkeeping and trust aside.
function projectUnchanged(entry, base) {
  const counted = (key) => key !== 'hasTrustDialogAccepted' && !BOOKKEEPING.test(key)
  return [...new Set([...Object.keys(entry), ...Object.keys(base)])]
    .filter(counted)
    .every((key) => (entry[key] === undefined ? undefined : digest(entry[key])) === base[key])
}
// One project of `projects`, field by field. Gone from the system: gone from
// the account too, unless the account changed it since (then its own).
function syncProject(a, s, base, writeBack) {
  if ((a !== undefined && !object(a)) || (s !== undefined && !object(s)))
    return syncValue(a, s, typeof base === 'string' ? base : undefined, { writeBack })
  if (a === undefined && s === undefined) return null
  // Never removed from the system for being gone from the account.
  if (a === undefined) return syncProject(s, s, undefined, writeBack)
  if (s === undefined && object(base)) {
    if (projectUnchanged(a, base)) return { a: undefined, s: undefined, base: undefined }
    return { a, s: undefined, base: OWN }
  }
  if (s === undefined && base === OWN) return { a, s: undefined, base: OWN }
  const fields = syncMap(a, s ?? {}, object(base) ? base : undefined, (key, x, y, z) =>
    syncProjectField(key, x, y, z, writeBack)
  )
  return {
    a: fields.account,
    // Nothing of it written back: still not in the system.
    s: s === undefined && !some(fields.system) ? undefined : fields.system,
    base: fields.base,
    lost: some(fields.lost) ? fields.lost : undefined
  }
}
// The shared keys of the account's .claude.json and the system's, synced:
// the user's MCP servers one by one, the projects field by field, the other
// keys whole. A key the account's file dropped since the last sync (Claude
// drops one set back to its default) goes from the system's too, unless
// `removals` is false (a file missing or started again). An account file
// without its projects or MCP servers takes the system's, never removing any
// there.
function syncConfig(own, system, base, writeBack, removals) {
  return syncMap(own, system, base, (key, a, s, b) => {
    if (!sharedStateKey(key)) return null
    const known = typeof b === 'string' ? b : undefined
    if (key === 'env') return syncEnv(a, s, known, { removals, writeBack })
    if (key !== 'projects' && key !== 'mcpServers')
      return syncValue(a, s, known, { removals, bookkeeping: BOOKKEEPING.test(key), writeBack })
    if (s !== undefined && !object(s)) return syncValue(a, s, known, { writeBack })
    if (!object(a)) return s === undefined ? null : { ...syncEntries(key, s, s, undefined, writeBack), a: s }
    return syncEntries(key, a, s, b, writeBack)
  })
}
// .claude.json's `env`, which Claude applies to its process: never a sign-in
// or endpoint entry on the account's side (synced without them), and the
// system's own kept when the account's change is written back.
function syncEnv(a, s, base, options) {
  const strip = (env) => {
    if (!object(env)) return env
    const rest = authEnvEntries(env, false)
    return some(rest) || !some(env) ? rest : undefined
  }
  const result = syncValue(strip(a), strip(s), base, options)
  if (equal(result.s, strip(s))) return { ...result, s }
  const own = authEnvEntries(s, true)
  return { ...result, s: object(result.s) ? { ...result.s, ...own } : some(own) ? own : result.s }
}
function syncEntries(key, a, s, base, writeBack) {
  const entries = syncMap(a, s ?? {}, object(base) ? base : undefined, (name, x, y, z) =>
    key === 'projects'
      ? syncProject(x, y, z, writeBack)
      : syncValue(x, y, typeof z === 'string' ? z : undefined, { removals: true, writeBack })
  )
  return {
    a: entries.account,
    s: s === undefined && !some(entries.system) ? undefined : entries.system,
    base: entries.base,
    lost: some(entries.lost) ? entries.lost : undefined
  }
}
// An account's .claude.json, synced with the system's (`base`: the sync state
// of the last launch, null: none yet), with its own login identity. Never a
// token: none is in either file's shared keys, and the login itself stays in
// .credentials.json. `removals` false: the account's file was missing or
// unreadable (nothing it lacks was removed in a session).
// -> { account, system (null: unchanged), base, lost }
export function accountState(own, system, oauth, base = null, { writeBack = true, signedIn = false, removals = true } = {}) {
  let result = { account: { ...own }, system: null, base, lost: {} }
  if (object(system)) {
    // Most of what it had at the last sync gone: Claude started the file again
    // (it was damaged). Its fresh defaults are not changes: it takes the
    // system's shared keys again.
    const had = object(base) ? Object.keys(base) : []
    const restarted = had.length >= 4 && had.filter((key) => !Object.hasOwn(own, key)).length * 2 > had.length
    const mine = restarted ? Object.fromEntries(Object.entries(own).filter(([key]) => !sharedStateKey(key))) : own
    const synced = syncConfig(mine, system, base, writeBack, removals && !restarted)
    result = { ...synced, system: equal(synced.system, system) ? null : synced.system }
  }
  // Claude keeps its profile there fresher than the one saved at sign-in; a
  // folder with none yet gets the saved one. Another account's is never
  // replaced here (the caller refuses that folder), only by a new sign-in.
  result.account.oauthAccount =
    signedIn || folderIdentity(identity(oauth), own.oauthAccount) === 'none' ? oauth : own.oauthAccount
  return result
}
// A settings object without the handlers of Tessel's hooks, and without the
// groups and events left empty (Tessel adds its own to an empty event).
const tesselHook = (handler) => String(handler?.command || '').includes(TESSEL_HOOK)
function withoutTesselHooks(settings) {
  if (!object(settings.hooks)) return settings
  const hooks = {}
  for (const [event, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) {
      hooks[event] = list
      continue
    }
    const kept = []
    for (const group of list) {
      const others = object(group) && Array.isArray(group.hooks) ? group.hooks.filter((h) => !tesselHook(h)) : null
      if (!others || others.length === group.hooks.length) kept.push(group)
      else if (others.length) kept.push({ ...group, hooks: others })
    }
    if (kept.length) hooks[event] = kept
  }
  const next = { ...settings, hooks }
  if (!some(hooks)) delete next.hooks
  return next
}
// Tessel's hook groups alone, as teamInstall.js adds them.
function tesselHooks(settings) {
  const out = {}
  for (const [event, list] of Object.entries(object(settings.hooks) ? settings.hooks : {}))
    for (const group of Array.isArray(list) ? list : []) {
      const ours = object(group) && Array.isArray(group.hooks) ? group.hooks.filter(tesselHook) : []
      if (ours.length) (out[event] ||= []).push({ ...group, hooks: ours })
    }
  return out
}
// Settings (without Tessel's hooks) with these Tessel hook groups added at
// the end of their events, where teamInstall.js puts them.
function withHooks(settings, ours) {
  if (!some(ours)) return settings
  const hooks = object(settings.hooks) ? { ...settings.hooks } : {}
  for (const [event, groups] of Object.entries(ours))
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...groups]
  return { ...settings, hooks }
}
// The account's copy with the system's Tessel hooks in place of its own,
// whatever else changed: one Tessel added to or removed from the system's
// reaches the copy.
function withSystemHooks(name, contents, system) {
  if (contents === null || !SETTINGS_FILES.has(name)) return contents
  const value = parseJson(contents)
  const current = system === null ? {} : parseJson(system)
  if (!object(value) || !object(current)) return contents
  const ours = tesselHooks(current)
  return equal(tesselHooks(value), ours) ? contents : encode(withHooks(withoutTesselHooks(value), ours))
}
const authEnvEntries = (env, keep) =>
  Object.fromEntries(Object.entries(object(env) ? env : {}).filter(([name]) => AUTH_ENV.has(name.toUpperCase()) === keep))
// A settings object without its sign-in settings.
function withoutAuth(settings) {
  const next = { ...settings }
  for (const key of AUTH_SETTINGS) delete next[key]
  if (object(settings.env)) {
    const env = authEnvEntries(settings.env, false)
    if (Object.keys(env).length !== Object.keys(settings.env).length) {
      if (some(env)) next.env = env
      else delete next.env
    }
  }
  return next
}
const parseJson = (contents) => {
  try {
    return JSON.parse(contents)
  } catch {
    return undefined
  }
}
// The account's copy of a copied file: as it is, without sign-in settings.
function accountCopy(name, contents) {
  if (contents === null || !SETTINGS_FILES.has(name)) return contents
  const value = parseJson(contents)
  if (!object(value)) return contents
  const copy = withoutAuth(value)
  return equal(copy, value) ? contents : encode(copy)
}
// What tells a change made by the person in a copied file: its content,
// formatting aside, without sign-in settings or Tessel's own hooks.
function fingerprint(name, contents) {
  if (contents === null) return null
  const value = name.endsWith('.json') ? parseJson(contents) : undefined
  const comparable =
    value === undefined
      ? `text:${contents}`
      : `json:${JSON.stringify(stable(SETTINGS_FILES.has(name) && object(value) ? withoutTesselHooks(withoutAuth(value)) : value))}`
  return createHash('sha256').update(comparable).digest('base64url').slice(0, 22)
}
// The system's file once the account's change is written back: the account's
// content, with the system's own sign-in settings and Tessel hooks kept.
// null: nothing valid to write back.
function writtenBack(name, account, system) {
  const own = name.endsWith('.json') ? parseJson(account) : account
  if (own === undefined) return null
  if (!SETTINGS_FILES.has(name)) return account
  const current = system === null ? {} : parseJson(system)
  if (!object(own) || !object(current)) return null
  const next = withHooks(withoutTesselHooks(withoutAuth(own)), tesselHooks(current))
  for (const key of AUTH_SETTINGS) if (Object.hasOwn(current, key)) next[key] = current[key]
  const env = authEnvEntries(current.env, true)
  if (some(env)) next.env = { ...(object(next.env) ? next.env : {}), ...env }
  return equal(next, own) ? account : encode(next)
}
// The lines a session added to the account's memory file (its import of the
// system's aside), without blank lines around them.
function addedMemory(contents) {
  const lines = (contents ?? '').split(/\r?\n/).filter((line) => line.trim() !== MEMORY_IMPORT)
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  return lines
}
// The system's memory already holds these lines, whole and one after the
// other (never as part of a longer line).
function memoryHolds(system, lines) {
  if (!lines.length) return true
  const all = system.split(/\r?\n/)
  for (let i = 0; i + lines.length <= all.length; i++) if (lines.every((line, j) => all[i + j] === line)) return true
  return false
}
// Lines without those already moved (each once).
function withoutLines(lines, moved) {
  const rest = [...lines]
  for (const line of moved) {
    const at = rest.indexOf(line)
    if (at !== -1) rest.splice(at, 1)
  }
  return addedMemory(rest.join('\n'))
}
const AUTH_NAMES = new RegExp(`\\b(${[...AUTH_SETTINGS, ...AUTH_ENV].join('|')})\\b`, 'i')
// A settings file holding a sign-in setting. Not valid JSON: any mention of
// one counts (it can't be removed safely).
function holdsAuth(contents) {
  const value = parseJson(contents)
  if (value === undefined) return AUTH_NAMES.test(contents)
  return object(value) && !equal(withoutAuth(value), value)
}

export function createClaudeAccounts({
  userData,
  home = os.homedir(),
  env = process.env,
  runLogin,
  now = Date.now,
  log = null,
  pidAlive = running,
  // Whether the system Claude folder is free of sessions an older version
  // started (they keep using it until they stop).
  canMigrate = async () => true
} = {}) {
  if (!text(userData) || !isAbsolute(userData) || !isAbsolute(home))
    throw authError(t('main.claudeAccount.absolutePaths', 'Absolute account storage and home paths are required.'))
  const data = resolve(userData)
  const accountsRoot = join(data, 'claude-accounts')
  const runtimeRoot = join(data, 'claude-runtime-auth')
  const indexPath = join(accountsRoot, 'accounts.json')
  // Left by older versions, which copied the chosen account into the system files.
  const snapshotPath = join(runtimeRoot, 'system-default-auth.json')
  const journalPath = join(runtimeRoot, 'transaction.json')
  const given = text(env.CLAUDE_CONFIG_DIR)
  if (given && !isAbsolute(given)) throw authError(t('main.claudeAccount.configDirAbsolute', 'CLAUDE_CONFIG_DIR must be absolute.'))
  // One inherited from a session on an added account (Tessel started from
  // its terminal) is that account's folder, not the system's.
  const override = given && !(fold(given) + sep).startsWith(fold(accountsRoot) + sep) ? given : null
  const configDir = override || join(resolve(home), '.claude')
  const defaultConfigDir = fold(configDir) === fold(join(home, '.claude'))
  const credentialsPath = join(configDir, '.credentials.json')
  // Claude config-dir logins use a colocated .claude.json (also used by Orca).
  const configPath = override
    ? join(configDir, '.claude.json')
    : join(resolve(home), '.claude.json')
  const binding = { credentialsPath, configPath }
  const queueKey = process.platform === 'win32' ? data.toLowerCase() : data
  const warn = (message) => log?.warn?.('accounts', message)
  const authPath = (id) => {
    if (!UUID.test(id)) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
    return join(accountsRoot, id, 'auth')
  }
  const safe = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      throw error?.safeClaudeAccountError ? error : authError()
    }
  }
  const serialized = (fn) => {
    const previous = queues.get(queueKey) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => safe(fn))
    queues.set(queueKey, next)
    next
      .finally(() => {
        if (queues.get(queueKey) === next) queues.delete(queueKey)
      })
      .catch(() => {})
    return next
  }
  const readMetadata = async () => metadata(await readText(indexPath))
  const readConfig = async () => {
    const raw = await readText(configPath)
    const config = raw === null ? {} : jsonObject(raw)
    if (
      Object.hasOwn(config, 'oauthAccount') &&
      config.oauthAccount !== null &&
      !object(config.oauthAccount)
    )
      throw authError()
    return config
  }
  async function systemAuth() {
    // A missing child of an unreadable/link home must never look logged out.
    await inspect(resolve(home), true)
    const raw = await readText(credentialsPath)
    if (raw !== null) jsonObject(raw)
    return { credentials: raw, oauth: oauthField(await readConfig()) }
  }
  async function managed(id) {
    const path = authPath(id)
    try {
      if (!(await ownedDirectory(accountsRoot, path, MARKER, id))) return { status: 'missing' }
      const raw = await readText(join(path, '.credentials.json'))
      const accountRaw = await readText(join(path, 'oauth-account.json'))
      if (raw === null || accountRaw === null) return { status: 'missing' }
      // Signed out in its folder (Claude Code dropped its login, a sign-in
      // that expired): a sign-in is needed, as for the system's (authStatus).
      // It was 'unknown', and "Sign in again", the one way to fix it, was
      // refused as unreadable storage.
      if (signedOut(raw)) return { status: 'missing' }
      const token = credentials(raw)
      const oauth = jsonObject(accountRaw)
      if (conflict(identity(token), identity(oauth))) throw authError()
      return { status: 'ready', raw, oauth, token }
    } catch {
      return { status: 'unknown' }
    }
  }
  // A login one of its sessions is refreshing can read half-written: read
  // once more, a moment later, before calling it unreadable.
  async function steady(id) {
    const auth = await managed(id)
    if (auth.status !== 'unknown') return auth
    await sleep(200)
    return managed(id)
  }
  // Signed in to another account in its folder (a /login in one of its
  // sessions): its .claude.json profile, or its login when that names
  // someone, is not the account saved at sign-in. Such a folder is never
  // launched, selected, read for usage or "repaired": a new sign-in fixes it.
  async function signedInElsewhere(id, saved) {
    const folder = authPath(id)
    try {
      if (!(await ownedDirectory(accountsRoot, folder, MARKER, id))) return false
      const config = await readText(join(folder, '.claude.json'))
      if (config !== null && folderIdentity(saved, jsonObject(config).oauthAccount) === 'other') return true
      const raw = await readText(join(folder, '.credentials.json'))
      const login = raw === null ? null : jsonObject(raw).claudeAiOauth
      return object(login) && folderIdentity(saved, login) === 'other'
    } catch {
      return false // unreadable: not known here (the login checks refuse it)
    }
  }
  // Its own folder, its credentials a valid document with no usable login
  // in it (a login with no token): a new sign-in replaces it. Only for
  // "Sign in again"; elsewhere such a folder stays unreadable.
  async function noUsableLogin(id) {
    let raw
    try {
      const folder = authPath(id)
      if (!(await ownedDirectory(accountsRoot, folder, MARKER, id))) return false
      raw = await readText(join(folder, '.credentials.json'))
      if (raw === null) return false
      jsonObject(raw)
    } catch {
      return false
    }
    try {
      credentials(raw)
      return false
    } catch {
      return true
    }
  }
  const otherAccount = () =>
    t(
      'main.claudeAccount.otherAccount',
      'This Claude account was switched to another account by a /login in one of its sessions. Sign in to it again: Settings > AI provider accounts > Sign in again.'
    )
  function publicAccount(account, status, selectedId) {
    return {
      id: account.id,
      label: publicText(account.label) || publicText(account.email) || 'Claude account',
      email: publicText(account.email),
      organization: publicText(account.organization),
      plan: publicText(account.plan),
      status,
      lastLoginAt: account.lastLoginAt,
      active: account.id === selectedId
    }
  }
  function authStatus(auth) {
    if (auth.credentials === null) return 'missing'
    try {
      const stored = jsonObject(auth.credentials)
      // A valid credentials document may hold API/provider auth without a
      // claude.ai OAuth login. System default may still launch with that setup.
      if (!Object.hasOwn(stored, 'claudeAiOauth') || stored.claudeAiOauth === null) return 'missing'
      const token = credentials(auth.credentials)
      const who = identity(auth.oauth.value)
      return auth.oauth.present && (who.account || who.email) && !conflict(identity(token), who)
        ? 'ready'
        : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  // The system login's display fields, as a managed account's row shows them:
  // its email and organization from .claude.json, its plan from the
  // credentials' subscriptionType field (nothing else of that file leaves here).
  function systemDetails(auth) {
    const status = authStatus(auth)
    const oauth = auth.oauth.present && object(auth.oauth.value) ? auth.oauth.value : {}
    let plan = null
    try {
      if (status === 'ready') plan = publicText(credentials(auth.credentials).subscriptionType)
    } catch {
      /* no plan shown */
    }
    return {
      status,
      email: publicText(oauth.emailAddress ?? oauth.email),
      organization: publicText(oauth.organizationName ?? oauth.organizationUuid),
      plan
    }
  }
  async function snapshot() {
    const raw = await readText(snapshotPath)
    if (raw !== null) {
      const value = jsonObject(raw)
      if (
        value.version !== 1 ||
        !equal(value.binding, binding) ||
        !(value.credentials === null || typeof value.credentials === 'string') ||
        !object(value.oauth) ||
        typeof value.oauth.present !== 'boolean' ||
        (value.oauth.present && value.oauth.value !== null && !object(value.oauth.value))
      )
        throw authError(t('main.claudeAccount.systemSnapshotInvalid', 'The system-default Claude auth snapshot is unavailable or invalid.'))
      if (value.credentials !== null) jsonObject(value.credentials)
      return value
    }
    throw authError(t('main.claudeAccount.systemSnapshotMissing', 'The system-default Claude auth snapshot is missing.'))
  }
  async function slotPath(change) {
    if (change.kind === 'index') return indexPath
    if (change.kind === 'credentials') return credentialsPath
    if (change.kind === 'managedCredentials' || change.kind === 'managedOauth') {
      const path = authPath(change.id)
      if (!(await ownedDirectory(accountsRoot, path, MARKER, change.id))) throw authError()
      return join(
        path,
        change.kind === 'managedCredentials' ? '.credentials.json' : 'oauth-account.json'
      )
    }
    throw authError()
  }
  async function readSlot(change) {
    return change.kind === 'oauth'
      ? oauthField(await readConfig())
      : readText(await slotPath(change))
  }
  async function applySlot(change, value, expected) {
    const current = await readSlot(change)
    if (equal(current, value)) return
    if (!equal(current, expected))
      throw authError(
        t('main.claudeAccount.changedRecovery', 'Claude account files changed during the operation. Recovery requires the original files.')
      )
    if (change.kind === 'oauth') {
      const raw = await readText(configPath)
      const config = raw === null ? {} : jsonObject(raw)
      if (!equal(oauthField(config), expected)) throw authError()
      if (value.present) config.oauthAccount = value.value
      else delete config.oauthAccount
      await writeText(configPath, Object.keys(config).length ? encode(config) : null, raw)
    } else await writeText(await slotPath(change), value, current)
  }
  function validateJournal(value) {
    if (
      value.version !== 1 ||
      !equal(value.binding, binding) ||
      !Array.isArray(value.changes) ||
      value.changes.length > 12
    )
      throw authError()
    for (const change of value.changes) {
      if (
        !object(change) ||
        !['index', 'credentials', 'oauth', 'managedCredentials', 'managedOauth'].includes(
          change.kind
        )
      )
        throw authError()
      if (change.kind.startsWith('managed') && !UUID.test(change.id)) throw authError()
      for (const part of ['before', 'after']) {
        const v = change[part]
        if (change.kind === 'oauth') {
          if (
            !object(v) ||
            typeof v.present !== 'boolean' ||
            (v.present && v.value !== null && !object(v.value))
          )
            throw authError()
        } else if (!(v === null || typeof v === 'string')) throw authError()
        else if (change.kind === 'index') metadata(v)
        else if (v !== null) jsonObject(v)
      }
    }
  }
  async function recover() {
    const raw = await readText(journalPath)
    if (raw === null) return
    const journal = jsonObject(raw)
    validateJournal(journal)
    for (const change of [...journal.changes].reverse())
      await applySlot(change, change.before, change.after)
    await writeText(journalPath, null, raw)
  }
  async function transaction(changes) {
    const prepared = []
    for (const change of changes) {
      const before = await readSlot(change)
      if (Object.hasOwn(change, 'expected') && !equal(before, change.expected))
        throw authError(
          t('main.claudeAccount.changedRetry', 'Claude account files changed during the operation. Retry after other logins finish.')
        )
      if (!equal(before, change.after)) prepared.push({ ...change, before })
    }
    if (!prepared.length) return
    const journal = { version: 1, binding, changes: prepared }
    validateJournal(journal)
    const raw = encode(journal)
    await exclusiveText(journalPath, raw)
    try {
      for (const change of prepared) await applySlot(change, change.after, change.before)
      await writeText(journalPath, null, raw)
    } catch {
      try {
        await recover()
      } catch {
        throw authError(
          t('main.claudeAccount.rollbackFailed', 'Claude account change could not be rolled back. Launch is blocked until recovery succeeds.')
        )
      }
      throw authError(t('main.claudeAccount.changeFailed', 'Claude account change failed; the previous login was restored.'))
    }
  }
  function accountChanges(id, auth) {
    return [
      { kind: 'managedCredentials', id, after: auth.raw },
      { kind: 'managedOauth', id, after: encode(auth.oauth) }
    ]
  }
  // The system files' login, when it is this account's and newer than its
  // saved copy (an older version's session refreshed it there).
  async function refreshed(account, saved) {
    if (saved.status !== 'ready') return saved
    const runtime = await systemAuth()
    if (runtime.credentials === null) return saved
    let token
    try {
      token = credentials(runtime.credentials)
    } catch {
      return saved
    }
    const who = identity(runtime.oauth.value)
    if (!runtime.oauth.present || !matches(account.identity, who) || conflict(identity(token), who))
      return saved
    const beforeExpiry = Number(saved.token.expiresAt)
    const afterExpiry = Number(token.expiresAt)
    if (Number.isFinite(beforeExpiry) && Number.isFinite(afterExpiry) && afterExpiry < beforeExpiry)
      return saved
    return { status: 'ready', raw: runtime.credentials, oauth: runtime.oauth.value, token }
  }
  // An older version put the chosen account's login into the system Claude
  // files (after a snapshot of the system's own). Put the system login back
  // once, the account's refreshed login captured first; it stays the default
  // for new sessions. The snapshot, a copy of a login, is then deleted.
  const legacy = (state, raw) => raw !== null && state.selectedId !== null && !state.perSession
  // The system files still hold this account's sign-in (the older version's
  // switch), not one made since (another account, or signed out).
  function holds(account, runtime) {
    if (!account || runtime.credentials === null || !runtime.oauth.present) return false
    let token
    try {
      token = credentials(runtime.credentials)
    } catch {
      return false
    }
    const who = identity(runtime.oauth.value)
    return matches(account.identity, who) && !conflict(identity(token), who)
  }
  // The account's sign-in to keep before the system files are changed: its
  // saved copy (refreshed from the system's when newer), or, that copy gone,
  // the system's (holds() proved it is this account's), its folder made
  // again if needed.
  async function capturedLogin(account, saved, runtime) {
    if (saved.status === 'ready') return refreshed(account, saved)
    const path = authPath(account.id)
    if (!(await ownedDirectory(accountsRoot, path, MARKER, account.id))) {
      await ensureDirectory(path)
      await exclusiveText(join(path, MARKER), `${account.id}\n`)
    }
    return { status: 'ready', raw: runtime.credentials, oauth: runtime.oauth.value }
  }
  // Not while Claude sessions an older version started still run: they use
  // the system folder, and would read or write the wrong sign-in there.
  const switchPending = () =>
    Object.assign(
      authError(
        t(
          'main.claudeAccount.switchPending',
          'Claude sessions started before the update still use the system sign-in. Restart them first (Settings > AI provider accounts).'
        )
      ),
      { switchPending: true }
    )
  async function migrate() {
    const raw = await readText(snapshotPath)
    if (raw === null) return
    const state = await readMetadata()
    if (legacy(state, raw)) {
      if (!(await canMigrate())) throw switchPending()
      const old = state.accounts.find((a) => a.id === state.selectedId)
      const runtime = await systemAuth()
      // Put back while the system files still hold that account's sign-in
      // (or its record is gone: only the switch left it there).
      if (!old || holds(old, runtime)) {
        let auth = old ? await managed(old.id) : null
        if (auth?.status === 'unknown')
          throw authError(
            t('main.claudeAccount.selectedUnreadable', 'The selected Claude account is unreadable. No authentication files were changed.')
          )
        const changes = []
        if (old) {
          auth = await capturedLogin(old, auth, runtime)
          changes.push(...accountChanges(old.id, auth))
        }
        const original = await snapshot()
        // Only over what was just checked: a sign-in made meanwhile stops it
        // (tried again later, and then kept).
        changes.push(
          { kind: 'credentials', after: original.credentials, expected: runtime.credentials },
          { kind: 'oauth', after: original.oauth, expected: runtime.oauth },
          { kind: 'index', after: encode({ ...state, selectedId: old ? old.id : null, perSession: true }) }
        )
        await transaction(changes)
        if (auth?.status === 'ready') await writeOwnState(old.id, auth.oauth)
      } else {
        // Signed in to another account since, or signed out: that stays.
        await transaction([{ kind: 'index', after: encode({ ...state, perSession: true }) }])
        warn('Claude account: the system sign-in changed since the account switch; kept as it is') // i18n-ignore log
      }
    }
    await writeText(snapshotPath, null, raw)
  }
  // Before the sessions an older version started are stopped: whether its
  // switch can be undone (the account readable, the snapshot usable), so
  // they are never stopped for nothing. snapshotInvalid: only giving the
  // switch up is left (discardSwitch).
  async function checkSwitch() {
    const raw = await readText(snapshotPath)
    if (raw === null) return { ok: true }
    const state = await readMetadata()
    if (!legacy(state, raw)) return { ok: true }
    const old = state.accounts.find((a) => a.id === state.selectedId)
    // Signed in to another account since: nothing to put back.
    if (old && !holds(old, await systemAuth())) return { ok: true }
    if (old && (await managed(old.id)).status === 'unknown')
      return {
        ok: false,
        error: t('main.claudeAccount.selectedUnreadable', 'The selected Claude account is unreadable. No authentication files were changed.')
      }
    try {
      await snapshot()
    } catch (error) {
      return { ok: false, error: error?.message || '', snapshotInvalid: true }
    }
    return { ok: true }
  }
  // The older version's switch, given up (its snapshot can't be used). The
  // system files keep a sign-in made since; if they still hold the
  // account's, it goes to the account's own folder and the system is signed
  // out (one sign-in kept in two places signs one of them out at its next
  // refresh). Not while sessions that version started still run.
  async function discardSwitch() {
    const raw = await readText(snapshotPath)
    if (raw === null) return { ok: true }
    const state = await readMetadata()
    let signedOut = false
    if (legacy(state, raw)) {
      if (!(await canMigrate())) throw switchPending()
      const old = state.accounts.find((a) => a.id === state.selectedId)
      const runtime = await systemAuth()
      const changes = []
      if (old && holds(old, runtime)) {
        const saved = await managed(old.id)
        if (saved.status === 'unknown')
          throw authError(
            t('main.claudeAccount.selectedUnreadable', 'The selected Claude account is unreadable. No authentication files were changed.')
          )
        const auth = await capturedLogin(old, saved, runtime)
        changes.push(
          ...accountChanges(old.id, auth),
          { kind: 'credentials', after: null, expected: runtime.credentials },
          { kind: 'oauth', after: { present: false, value: null }, expected: runtime.oauth }
        )
        signedOut = true
      }
      changes.push({ kind: 'index', after: encode({ ...state, perSession: true }) })
      await transaction(changes)
    }
    await writeText(snapshotPath, null, raw)
    return { ok: true, ...(signedOut ? { signedOut: true } : {}) }
  }
  // Claude takes <file>.lock (a folder, proper-lockfile's way) while it writes
  // its config; so does Tessel, never breaking it. Held: false, nothing done.
  async function underClaudeLock(file, fn) {
    const lock = `${file}.lock`
    for (let i = 0; ; i++) {
      try {
        await fs.mkdir(lock)
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (i >= 4) return false
        await sleep(Math.min(250, 50 * 2 ** i))
      }
    }
    try {
      await fn()
      return true
    } finally {
      await fs.rmdir(lock).catch(() => {})
    }
  }
  // What the last sync left on both sides (fingerprints): of the copied files
  // and of .claude.json's shared keys; and `memory`, the memory lines being
  // moved to the system's (see syncMemory). None or unreadable: synced as a
  // first time.
  async function readSync(folder) {
    try {
      const raw = await readText(join(folder, SYNC_STATE))
      const value = raw === null ? null : jsonObject(raw)
      if (
        value?.version === 1 &&
        object(value.files) &&
        Object.values(value.files).every((v) => v === null || typeof v === 'string')
      )
        return {
          files: value.files,
          config: object(value.config) ? value.config : null,
          memory:
            Array.isArray(value.memory) && value.memory.every((batch) => Array.isArray(batch) && batch.every((line) => typeof line === 'string'))
              ? value.memory
              : null
        }
    } catch {
      /* none */
    }
    return { files: {}, config: null, memory: null }
  }
  const writeSync = (folder, state) =>
    writeText(
      join(folder, SYNC_STATE),
      encode({ version: 1, files: state.files, config: state.config, ...(state.memory ? { memory: state.memory } : {}) })
    )
  // The account's version of what changed on both sides, kept next to its
  // file (<name>.conflict-<time>) while the system's wins.
  async function keepAside(folder, name, contents) {
    const aside = `${name}.conflict-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`
    await writeText(join(folder, aside), contents)
    warn(`Claude account: ${name} changed both in its sessions and in the system; the system's kept, its own in ${aside}`) // i18n-ignore log
  }
  // The account's own .claude.json (accountState), synced with the system's
  // under both files' Claude locks. Best effort: a session still starts
  // without it (Claude fetches its profile itself). `signedIn`: right after a
  // sign-in, whose identity replaces the folder's. `initial`: made only while
  // it is still missing, and never writing the system's file (a usage read).
  // -> 'switched' when its folder is signed in to another account (then left
  // as it is).
  async function writeOwnState(id, oauth, { signedIn = false, initial = false } = {}) {
    const folder = authPath(id)
    const file = join(folder, '.claude.json')
    let outcome = null
    const write = async (writeBack) => {
      let systemRaw = null
      let system = null
      try {
        systemRaw = await readText(configPath)
        system = systemRaw === null ? {} : jsonObject(systemRaw)
      } catch {
        warn('Claude account: the system Claude settings could not be read; shared settings not updated') // i18n-ignore log
      }
      const raw = await readText(file)
      // Made by a session (or a launch) meanwhile: left to them.
      if (initial && raw !== null) return
      let own = {}
      // Missing or damaged: what it lacks was not removed in a session.
      let removals = raw !== null
      try {
        own = raw === null ? {} : jsonObject(raw)
      } catch {
        // Damaged: Claude starts it again too.
        removals = false
      }
      if (!signedIn && folderIdentity(identity(oauth), own.oauthAccount) === 'other') {
        outcome = 'switched'
        return
      }
      const sync = await readSync(folder)
      let next = accountState(own, system, oauth, sync.config, { writeBack: writeBack && system !== null, signedIn, removals })
      // The account's values a system change replaces are kept aside before
      // anything is written: if they can't be, nothing is replaced.
      if (some(next.lost)) await keepAside(folder, '.claude.json', encode(next.lost))
      // The system's first: refused, the account's changes stay in its file
      // (written back at a later launch) and it only takes the system's.
      if (next.system)
        try {
          await writeText(configPath, encode(next.system), systemRaw)
        } catch {
          warn('Claude account: the system Claude settings could not be written; its changes are kept for a later launch') // i18n-ignore log
          next = accountState(own, system, oauth, sync.config, { writeBack: false, signedIn, removals })
        }
      if (raw === null || !equal(next.account, own)) await writeText(file, encode(next.account), raw)
      if (system !== null) await writeSync(folder, { ...(await readSync(folder)), config: next.base })
    }
    try {
      let held = false
      let ran = false
      // The system's lock first, then the account's: always in this order.
      const systemHeld = initial
        ? false
        : await underClaudeLock(configPath, async () => {
            ran = true
            held = await underClaudeLock(file, () => write(true))
          }).catch((error) => {
            if (ran) throw error
            return false
          })
      // Claude busy with the system's file (or no lock there), or only made:
      // nothing written back this time.
      if (!systemHeld) held = await underClaudeLock(file, () => write(false))
      if (!held) warn('Claude account: its settings file is locked; shared settings not updated') // i18n-ignore log
    } catch {
      warn('Claude account: its settings file could not be updated') // i18n-ignore log
    }
    if (outcome === 'switched')
      warn('Claude account: signed in to another account in one of its sessions; its files are left as they are') // i18n-ignore log
    return outcome
  }
  // Moves one file to `target`, never over one there: a hard link fails when
  // `target` exists (where links cannot be made, an exclusive copy does).
  // -> false when it stays (`target` exists, or it changed while copied).
  async function moveFile(source, target) {
    try {
      await fs.link(source, target)
    } catch (error) {
      if (error.code === 'EEXIST') return false
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error
      return copyThenRemove(source, target)
    }
    // A session still writing it writes the same file under its new name.
    await fs.unlink(source)
    return true
  }
  // A copy is not the file: a session an older pane still runs may write to
  // the original meanwhile. Copied first under a name of its own next to
  // `target`; put in place (a hard link, never over a file there) only when
  // the original did not change during the copy, then the original goes.
  // Once in place it is never removed (another session may write to it).
  // Otherwise the copy goes, and it is tried again at a later launch.
  async function copyThenRemove(source, target) {
    const before = await fs.stat(source)
    const temporary = join(dirname(target), `.tessel-move-${randomUUID()}.tmp`)
    try {
      await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL)
      const after = await fs.stat(source)
      const copy = await fs.stat(temporary)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || copy.size !== after.size) return false
      try {
        await fs.link(temporary, target)
      } catch (error) {
        // There already, or no hard links on that drive: it stays.
        if (['EEXIST', 'EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) return false
        throw error
      }
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
    await fs.unlink(source)
    return true
  }
  // Moves what `from` holds into `to`, never over something there and never
  // through a link: what cannot move stays (counted, its paths in `left`).
  // `from` goes once empty.
  async function drain(from, to, depth = 0, left = []) {
    let count = 0
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      const source = join(from, entry.name)
      const target = join(to, entry.name)
      try {
        if (entry.isFile() && (await moveFile(source, target))) continue
        if (entry.isDirectory() && depth < 8) {
          // Made there (never over what is there), or the folder there merged into.
          await fs.mkdir(target).catch((error) => {
            if (error.code !== 'EEXIST') throw error
          })
          const there = await fs.lstat(target)
          if (there.isDirectory() && !there.isSymbolicLink()) {
            count += await drain(source, target, depth + 1, left)
            continue
          }
        }
      } catch {
        /* stays */
      }
      count++
      left.push(source)
    }
    if (!count) await fs.rmdir(from).catch(() => {})
    return count
  }
  // Before an account goes: what its sessions kept in <name>.merge (entries
  // the system folder already had) is moved there now, never over an entry
  // there; what is still left is named in the log, then removed with it.
  async function rescueMerged(folder) {
    let names
    try {
      names = (await fs.readdir(folder)).filter((name) => name.endsWith('.merge'))
    } catch {
      return
    }
    for (const name of names) {
      const aside = join(folder, name)
      const left = []
      try {
        const entry = await fs.lstat(aside)
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const shared = join(configDir, name.slice(0, -'.merge'.length))
        await fs.mkdir(shared, { recursive: true })
        if ((await fs.stat(shared)).isDirectory()) await drain(aside, shared, 0, left)
        else left.push(aside)
      } catch {
        left.push(aside)
      }
      if (left.length) {
        const shown = left.slice(0, 20).map((path) => relative(folder, path) || name)
        warn(`Claude account removed: ${left.length} of its own entries could not be moved to the system folder and are deleted: ${shown.join(', ')}${left.length > 20 ? ', …' : ''}`) // i18n-ignore log
      }
    }
  }
  // One shared folder: <account>/<name> a junction to <system>/<name>. A link
  // to another place is replaced (the link itself, never what it points to).
  // A real folder there (a session ran before it was linked) is moved aside to
  // <name>.merge and its entries into the system folder, none over one there;
  // what cannot move stays in <name>.merge and is tried again next time.
  async function linkShared(folder, name, create) {
    const source = join(configDir, name)
    const target = join(folder, name)
    const aside = `${target}.merge`
    let entry = await lstatOrNull(source)
    if (!entry && !create) return 'absent'
    if (!entry) {
      await fs.mkdir(source, { recursive: true })
      entry = await fs.lstat(source)
    }
    // The user's own link there is shared as what it points to.
    if (!(entry.isSymbolicLink() ? (await fs.stat(source)).isDirectory() : entry.isDirectory()))
      return 'absent'
    const waiting = await lstatOrNull(aside)
    if (waiting?.isDirectory() && !waiting.isSymbolicLink()) await drain(aside, source)
    const current = await lstatOrNull(target)
    let moved = false
    if (current?.isSymbolicLink()) {
      const there = await fs.realpath(target).catch(() => null)
      if (there && fold(there) === fold(await fs.realpath(source))) return 'unchanged'
      await fs.unlink(target).catch(() => fs.rmdir(target))
    } else if (current?.isDirectory()) {
      // Empty: removed. Otherwise moved aside, unless earlier entries still wait there.
      const removed = await fs.rmdir(target).then(
        () => true,
        () => false
      )
      if (!removed) {
        if (await lstatOrNull(aside)) return 'kept'
        try {
          await fs.rename(target, aside)
        } catch {
          return 'kept' // in use by a running session: next launch
        }
        moved = true
      }
    } else if (current) return 'kept'
    try {
      await fs.symlink(source, target, 'junction')
    } catch (error) {
      if (moved) await fs.rename(aside, target).catch(() => {})
      throw error
    }
    if (moved && (await drain(aside, source)))
      warn(`Claude account: some of its own ${name} entries could not be shared; kept in ${name}.merge`) // i18n-ignore log
    return 'linked'
  }
  // A system file as it is, through the user's own link if it is one;
  // null when it is not there.
  async function readSystemFile(path) {
    try {
      const stat = await fs.stat(path)
      if (!stat.isFile()) return null
      if (stat.size > SYSTEM_FILE_LIMIT) throw authError()
      return await fs.readFile(path, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
  }
  // Writes a system file atomically, through the user's own link if it is one
  // (never replacing the link), unless it changed since it was read: checked
  // before each try, so a session's write while it waits is never replaced
  // (this write is given up, and worked out again at a later launch).
  async function writeSystemFile(path, contents, expected) {
    const entry = await lstatOrNull(path)
    const target = entry?.isSymbolicLink() ? await fs.realpath(path) : path
    const temporary = join(dirname(target), `.tessel-sync-${randomUUID()}.tmp`)
    let file
    try {
      file = await fs.open(temporary, 'wx')
      await file.writeFile(contents, 'utf8')
      await file.sync()
      await file.close()
      file = null
      for (let i = 0; ; i++) {
        if ((await readSystemFile(path)) !== expected)
          throw authError(
            t('main.claudeAccount.changedRetry', 'Claude account files changed during the operation. Retry after other logins finish.')
          )
        try {
          await fs.rename(temporary, target)
          break
        } catch (error) {
          // Open for a moment elsewhere (a session reading it, an antivirus scan).
          if (i >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
          await sleep(25)
        }
      }
    } finally {
      await file?.close()
      await fs.unlink(temporary).catch(() => {})
    }
  }
  // One copied file, synced both ways since the last launch (`base`: its
  // fingerprint then; undefined: not known). Changed on both sides, the
  // system's wins and the account's is kept aside. A copy gone from the
  // account is copied again, never removed from the system. -> its fingerprint now
  async function syncFile(folder, name, base) {
    const systemPath = join(configDir, name)
    const accountPath = join(folder, name)
    const system = await readSystemFile(systemPath)
    const own = await readText(accountPath)
    const s = fingerprint(name, system)
    const a = fingerprint(name, own)
    let next = s
    let kept = own
    if (a !== s) {
      // Only the account changed it, or made one the system never had.
      const accountOnly = own !== null && a !== base && (s === base || (base === undefined && system === null))
      const content = accountOnly ? writtenBack(name, own, system) : null
      if (content !== null) {
        await writeSystemFile(systemPath, content, system)
        next = fingerprint(name, content)
      } else {
        if (own !== null && a !== base) await keepAside(folder, name, own)
        // Gone from the system folder: gone from the account's too.
        kept = accountCopy(name, system)
      }
    }
    // Never sign-in settings in the account's copy, and the system's Tessel hooks.
    kept = withSystemHooks(name, accountCopy(name, kept), system)
    if (kept !== own) await writeText(accountPath, kept, own)
    return next
  }
  // ~/.claude/CLAUDE.md is also read as a parent folder's for projects in the
  // home folder: the account's is an import of it, never a second copy. What
  // its sessions added there (a # note, /memory) goes at the end of the
  // system's, then it is the import alone again. The lines being moved are
  // recorded first: if the account's file could not be put back (or Tessel
  // stopped), the next sync finds them in the system's and never adds them
  // twice; lines added since still go.
  async function syncMemory(folder) {
    const systemPath = join(configDir, 'CLAUDE.md')
    const accountPath = join(folder, 'CLAUDE.md')
    const sync = await readSync(folder)
    let system = await readSystemFile(systemPath)
    const own = await readText(accountPath)
    let added = addedMemory(own)
    // Each batch moved before whose account file was never put back: its
    // lines already in the system's are not added again (one not there, its
    // write failed, goes with the new lines).
    const moved = (sync.memory || []).filter((batch) => system !== null && memoryHolds(system, batch))
    for (const batch of moved) added = withoutLines(added, batch)
    if (added.length) {
      await writeSync(folder, { ...sync, memory: [...moved, added] })
      const eol = system?.includes('\r\n') ? '\r\n' : '\n'
      const next = `${system ?? ''}${system && !system.endsWith('\n') ? eol : ''}${added.join(eol)}${eol}`
      await writeSystemFile(systemPath, next, system)
      system = next
    }
    // Gone from the system folder: gone from the account's too.
    await writeText(accountPath, system === null ? null : `${MEMORY_IMPORT}\n`, own)
    if (sync.memory || added.length) await writeSync(folder, { ...(await readSync(folder)), memory: null })
  }
  // Before each launch on a managed account: its folder shares the system
  // one's conversations, plugins, skills and settings (each item best effort).
  // -> 'switched' when its folder is signed in to another account,
  // 'foreignAuth' when its settings still hold another sign-in setting.
  async function prepare(id, auth) {
    const folder = authPath(id)
    if (!(await ownedDirectory(accountsRoot, folder, MARKER, id))) throw authError()
    let others = []
    try {
      others = (await fs.readdir(configDir)).filter((name) => sharedFolderName(name) && !SHARED_FOLDERS.includes(name))
    } catch {
      /* none yet: the listed ones are created */
    }
    for (const name of [...SHARED_FOLDERS, ...others]) {
      try {
        const outcome = await linkShared(folder, name, SHARED_FOLDERS.includes(name))
        if (outcome === 'kept') warn(`Claude account: its own ${name} folder is kept, not shared`) // i18n-ignore log
      } catch (error) {
        warn(`Claude account: ${name} could not be shared (${error?.code || 'error'})`) // i18n-ignore log
      }
    }
    const sync = await readSync(folder)
    const files = { ...sync.files }
    for (const name of COPIED_FILES) {
      try {
        if (name === 'CLAUDE.md' && defaultConfigDir) await syncMemory(folder)
        else files[name] = await syncFile(folder, name, Object.hasOwn(files, name) ? files[name] : undefined)
      } catch (error) {
        warn(`Claude account: ${name} could not be synced (${error?.code || 'error'})`) // i18n-ignore log
      }
    }
    try {
      await writeSync(folder, { ...(await readSync(folder)), files })
    } catch {
      warn('Claude account: its sync state could not be saved') // i18n-ignore log
    }
    // Not best effort: a session must never sign in with another credential.
    if (!(await withoutForeignAuth(folder))) return 'foreignAuth'
    const outcome = await writeOwnState(id, auth.oauth)
    if (outcome === null && !(await configWithoutForeignAuth(folder))) return 'foreignAuth'
    return outcome
  }
  // Its .claude.json's `env` (Claude applies it to the session's process)
  // holds no sign-in or endpoint entry either: writeOwnState leaves none, so
  // one still there means that file could not be written (tried twice).
  async function configWithoutForeignAuth(folder) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt) await sleep(100)
        const raw = await readText(join(folder, '.claude.json'))
        if (raw === null || !some(authEnvEntries(parseJson(raw)?.env, true))) return true
      } catch {
        /* tried again, then refused */
      }
    }
    warn('Claude account: its .claude.json still holds a sign-in setting that could not be removed; launch refused') // i18n-ignore log
    return false
  }
  // The account's settings files never keep a sign-in setting (an older copy
  // of the system's could hold an API key, a token, apiKeyHelper or a
  // gateway's address): removed,
  // then checked on what is in the file. -> false when one is still there or
  // the file can't be read (tried twice: a session may be writing it).
  async function withoutForeignAuth(folder) {
    for (const name of SETTINGS_FILES) {
      const path = join(folder, name)
      let clean = false
      for (let attempt = 0; attempt < 2 && !clean; attempt++) {
        try {
          if (attempt) await sleep(100)
          const raw = await readText(path)
          if (raw !== null && holdsAuth(raw)) {
            await writeText(path, accountCopy(name, raw), raw)
            const written = await readText(path)
            clean = written === null || !holdsAuth(written)
          } else clean = true
        } catch {
          /* tried again, then refused */
        }
      }
      if (!clean) {
        warn(`Claude account: its ${name} still holds a sign-in setting that could not be removed; launch refused`) // i18n-ignore log
        return false
      }
    }
    return true
  }
  async function login(id, { signal, onProgress } = {}) {
    await recover()
    // A sign-in only writes the account's own folder: a pending switch waits.
    await migrate().catch((error) => {
      if (!error?.switchPending) throw error
    })
    const state = await readMetadata()
    const previous = id ? state.accounts.find((a) => a.id === id) : null
    if (id && !previous) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
    // Signed in to another account in its folder: it may sign in again.
    if (
      id &&
      (await managed(id)).status === 'unknown' &&
      !(await signedInElsewhere(id, previous.identity)) &&
      !(await noUsableLogin(id))
    )
      throw authError()
    if (typeof runLogin !== 'function') throw authError(t('main.claudeAccount.loginUnavailable', 'Claude login is unavailable.'))
    if (signal?.aborted) throw authError(t('main.claudeAccount.loginCancelled', 'Claude login was cancelled.'))
    await removeStaleLogins()
    const loginId = randomUUID()
    const temporary = join(runtimeRoot, `login-${loginId}`)
    await ensureDirectory(temporary)
    await exclusiveText(join(temporary, MARKER), `login:${loginId}\n`)
    let created = null
    let cleanupSafe = true
    const guard = join(temporary, LOGIN_PID)
    const validPid = (pid) => Number.isInteger(pid) && pid > 0
    try {
      // Written before the sign-in starts (if it can't be, nothing starts),
      // then given the sign-in's PID: until its end is confirmed, its folder
      // is kept while that process runs (with no PID: for good), even if
      // Tessel stops meanwhile.
      await writeText(guard, '\n')
      // The runner reports uncertain termination explicitly. Record that before
      // cancellation checks so an aborted, possibly live child keeps its home.
      const result = await runLogin({
        provider: 'claude',
        home: temporary,
        signal,
        onProgress,
        onSpawn: (pid) => (validPid(pid) ? writeText(guard, `${pid}\n`) : undefined)
      })
      cleanupSafe = result?.cleanupSafe !== false
      if (!cleanupSafe) {
        // Its folder stays until that process is seen gone.
        if (validPid(result.pid)) await writeText(guard, `${result.pid}\n`).catch(() => {})
        throw Object.assign(
          authError(
            t('main.claudeAccount.stopFailed', 'Claude sign-in could not be stopped. Temporary files were retained because process termination could not be confirmed.')
          ),
          { cleanupSafe: false }
        )
      }
      if (signal?.aborted) throw authError(t('main.claudeAccount.loginCancelled', 'Claude login was cancelled.'))
      if (!result?.ok)
        throw authError(t('main.claudeAccount.loginIncomplete', 'Claude login did not complete. The previous account was preserved.'))
      const status = result.status
      const raw = await readText(join(temporary, '.credentials.json'))
      const token = credentials(raw)
      if (!token) throw authError(t('main.claudeAccount.noCredentials', 'Claude login produced no credentials.'))
      const configRaw =
        (await readText(join(temporary, '.claude.json'))) ??
        (await readText(join(temporary, '.config.json')))
      const oauth = configRaw === null ? null : jsonObject(configRaw).oauthAccount
      const who = identity(oauth)
      if (
        !object(status) ||
        status.loggedIn !== true ||
        !object(oauth) ||
        !matches(who, identity(status)) ||
        conflict(identity(token), who) ||
        (previous && !matches(previous.identity, who))
      )
        throw authError(t('main.claudeAccount.identityUnverified', 'Claude login identity could not be verified for this account.'))
      const accountId = id || randomUUID()
      const path = authPath(accountId)
      if (!id) {
        await ensureDirectory(path)
        await exclusiveText(join(path, MARKER), `${accountId}\n`)
        created = { id: accountId, path }
      } else if (!(await ownedDirectory(accountsRoot, path, MARKER, accountId))) throw authError()
      const account = {
        id: accountId,
        identity: who,
        email: publicText(oauth.emailAddress ?? oauth.email ?? status.email),
        organization: publicText(
          status.organizationName ?? status.orgName ?? oauth.organizationName ?? who.organization
        ),
        plan: publicText(status.subscriptionType ?? token.subscriptionType ?? status.plan),
        lastLoginAt: new Date(now()).toISOString()
      }
      account.label = account.email || publicText(oauth.displayName) || 'Claude account'
      const next = {
        ...state,
        accounts: [...state.accounts.filter((a) => a.id !== accountId), account]
      }
      await transaction([...accountChanges(accountId, { raw, oauth }), { kind: 'index', after: encode(next) }])
      created = null
      // Its own .claude.json right away: its usage can be read before a first session.
      await writeOwnState(accountId, oauth, { signedIn: true })
      return {
        ok: true,
        account: publicAccount(account, 'ready', state.selectedId),
        selectedId: state.selectedId,
        restartRequired: false
      }
    } finally {
      if (created) {
        // Leave files needed by a failed durable rollback for recovery.
        if ((await readText(journalPath)) === null)
          await removeOwnedDirectory(accountsRoot, created.path, MARKER, created.id)
      }
      // Only a copy of what was saved: a failed cleanup never undoes the
      // sign-in (the folder is removed by a later one).
      if (cleanupSafe)
        await removeOwnedDirectory(runtimeRoot, temporary, MARKER, `login:${loginId}`).catch(async () => {
          // At least its copy of the login goes now; its end was confirmed,
          // so a later sign-in may remove the rest.
          await writeText(join(temporary, '.credentials.json'), null).catch(() => {})
          await writeText(guard, null).catch(() => {})
        })
    }
  }
  // Sign-in folders an earlier sign-in left (its cleanup failed, or Tessel
  // stopped meanwhile): removed once no sign-in can still use them.
  async function removeStaleLogins() {
    let names
    try {
      names = await fs.readdir(runtimeRoot)
    } catch {
      return
    }
    for (const name of names) {
      const id = /^login-(.+)$/.exec(name)?.[1]
      if (!id || !UUID.test(id)) continue
      const path = join(runtimeRoot, name)
      try {
        const marker = await inspect(join(path, MARKER))
        if (!marker || Date.now() - marker.mtimeMs < STALE_LOGIN_MS) continue
        // A sign-in whose end was never confirmed: kept while it may still run.
        const pidText = await readText(join(path, LOGIN_PID))
        if (pidText !== null) {
          const pid = Number(pidText.trim())
          if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) continue
        }
        await removeOwnedDirectory(runtimeRoot, path, MARKER, `login:${id}`)
      } catch {
        /* kept: tried again at the next sign-in */
      }
    }
  }
  async function validSavedAccount(state, id) {
    if (id === null) return true
    const account = state.accounts.find((entry) => entry.id === id)
    if (!account) return false
    const auth = await managed(id)
    return (
      auth.status === 'ready' &&
      matches(account.identity, identity(auth.oauth)) &&
      !(await signedInElsewhere(id, account.identity))
    )
  }
  // An account row's status: signed in to another account in its folder, it
  // needs a new sign-in.
  async function accountStatus(account) {
    const status = (await managed(account.id)).status
    return status !== 'missing' && (await signedInElsewhere(account.id, account.identity)) ? 'missing' : status
  }
  const systemEnv = () => (override ? { CLAUDE_CONFIG_DIR: configDir } : {})
  return {
    // Deliberately unqueued: UI polling remains responsive during browser login.
    list: () =>
      safe(async () => {
        const state = await readMetadata()
        let system = { status: 'unknown', email: null, organization: null, plan: null }
        try {
          // Before the one-time restore, the system's login is in the snapshot.
          system = systemDetails(legacy(state, await readText(snapshotPath)) ? await snapshot() : await systemAuth())
        } catch {
          /* unknown, not missing */
        }
        const pending = await readText(journalPath)
        // An older version's switch not undone yet (see migrate).
        const switched = legacy(state, await readText(snapshotPath))
        const accounts = await Promise.all(
          state.accounts.map(async (a) =>
            publicAccount(a, pending ? 'unknown' : await accountStatus(a), state.selectedId)
          )
        )
        return {
          provider: 'claude',
          selectedId: state.selectedId,
          system: { id: null, label: 'System default', ...system, ...(pending ? { status: 'unknown' } : {}) },
          accounts,
          ...(switched ? { switchPending: true } : {})
        }
      }),
    add: (options) => serialized(() => login(null, options)),
    reauthenticate: (id, options) => serialized(() => login(id, options)),
    // The default account for new sessions. Nothing else changes: each session
    // keeps the account it started with.
    select: (id) =>
      serialized(async () => {
        await recover()
        await migrate()
        const state = await readMetadata()
        if (id !== null) {
          const account = state.accounts.find((a) => a.id === id)
          if (!account) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
          const auth = await steady(id)
          if (await signedInElsewhere(id, account.identity)) throw authError(otherAccount())
          if (auth.status !== 'ready' || !matches(account.identity, identity(auth.oauth)))
            throw authError(t('main.claudeAccount.needsLogin', 'This Claude account needs a valid login before selection.'))
          if ((await writeOwnState(id, auth.oauth)) === 'switched') throw authError(otherAccount())
        }
        await transaction([{ kind: 'index', after: encode({ ...state, selectedId: id }) }])
        return { ok: true, selectedId: id, restartRequired: false }
      }),
    remove: (id) =>
      serialized(async () => {
        await recover()
        await migrate()
        const state = await readMetadata()
        const account = state.accounts.find((a) => a.id === id)
        if (!account) throw authError(t('main.claudeAccount.unknown', 'Unknown Claude account.'))
        if ((await managed(id)).status === 'unknown' && !(await signedInElsewhere(id, account.identity)))
          throw authError(t('main.claudeAccount.removeUnsafe', 'Managed Claude auth cannot be removed safely.'))
        const selectedId = state.selectedId === id ? null : state.selectedId
        await transaction([
          { kind: 'index', after: encode({ ...state, selectedId, accounts: state.accounts.filter((a) => a.id !== id) }) }
        ])
        const result = { ok: true, selectedId, restartRequired: false }
        try {
          if (await ownedDirectory(accountsRoot, authPath(id), MARKER, id)) await rescueMerged(authPath(id))
          // Its shared folders are junctions: removed themselves, never what they point to.
          await removeOwnedDirectory(accountsRoot, authPath(id), MARKER, id, { depth: 24, count: 50000 })
          await fs.rmdir(join(accountsRoot, id)).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
          })
        } catch {
          return {
            ...result,
            warning: t('main.claudeAccount.removedNotCleaned', 'Account removed; its managed files could not be cleaned safely.')
          }
        }
        return result
      }),
    // At startup, and once the sessions an older version started are stopped:
    // its account switch is undone once (migrate).
    migrate: () =>
      serialized(async () => {
        await recover()
        await migrate()
        return { ok: true }
      }),
    // Whether the switch can be undone, before anything is stopped.
    checkSwitch: () =>
      serialized(async () => {
        await recover()
        return checkSwitch()
      }),
    // Its snapshot unusable: the switch is given up (see discardSwitch).
    discardSwitch: () =>
      serialized(async () => {
        await recover()
        return discardSwitch()
      }),
    // Whether an older version's switch is still to be undone.
    switchPending: () =>
      safe(async () => legacy(await readMetadata(), await readText(snapshotPath))),
    // Quota reads: a managed account's login is in its own folder, where its
    // sessions refresh it; the caller checks the identity found there.
    usageScope: (accountId = undefined) =>
      safe(async () => {
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        const unavailable = { ok: false, error: t('main.claudeAccount.changedUnavailable', 'The selected Claude account changed or is unavailable.') }
        // Before an older version's switch is undone (see migrate), the
        // switched account's sign-in is in the system files, where its
        // sessions refresh it; the system's own is only in the snapshot.
        if (legacy(state, await readText(snapshotPath))) {
          if (id === null) return { ok: false, error: switchPending().message }
          if (id === state.selectedId && (await validSavedAccount(state, id)))
            return { ok: true, env: systemEnv(), accountId: id, expectedIdentity: { ...state.accounts.find((row) => row.id === id).identity } }
        }
        if (id === null) return { ok: true, env: systemEnv(), accountId: null, expectedIdentity: null }
        if (typeof id !== 'string' || !(await validSavedAccount(state, id))) return unavailable
        // An account an older version added has no .claude.json of its own
        // until its first session: made now (its usage reads its profile there).
        if (!(await inspect(join(authPath(id), '.claude.json')))) {
          await serialized(async () => {
            const auth = await managed(id)
            if (auth.status === 'ready') await writeOwnState(id, auth.oauth, { initial: true })
          }).catch(() => {})
          if (!(await inspect(join(authPath(id), '.claude.json')))) return unavailable
        }
        return {
          ok: true,
          env: { CLAUDE_CONFIG_DIR: authPath(id) },
          accountId: id,
          expectedIdentity: { ...state.accounts.find((row) => row.id === id).identity }
        }
      }),
    // Conversations are shared: every account's sessions keep them in the
    // system Claude folder (their own projects folder is linked there), read
    // there for any account, even one removed since.
    sessionEnv: (accountId = undefined) =>
      safe(async () => {
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        if (id !== null && (typeof id !== 'string' || !UUID.test(id)))
          return { ok: false, error: t('main.claudeAccount.savedMissing', 'The saved Claude account is missing or unreadable.') }
        return { ok: true, env: systemEnv(), accountId: id }
      }),
    // undefined: the default account; null: the system login; an id: that
    // account, whichever is the default (a saved pane restarts on its own).
    launchEnv: (accountId = undefined) =>
      serialized(async () => {
        await recover()
        await migrate()
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        if (id === null) {
          if (authStatus(await systemAuth()) === 'unknown')
            throw authError(t('main.claudeAccount.systemAuthUnreadable', 'System Claude authentication is unreadable; launch was refused.'))
          // The configured override (if any) stays inherited by the pane; an
          // added account's folder inherited by Tessel does not.
          return { ok: true, env: {}, accountId: null, ...(given && !override ? { unsetEnv: ['CLAUDE_CONFIG_DIR'] } : {}) }
        }
        const account = typeof id === 'string' ? state.accounts.find((a) => a.id === id) : null
        if (!account)
          return {
            ok: false,
            error: t('main.claudeAccount.removedAccount', 'This Claude account is no longer in Tessel. Start the session on another account.')
          }
        const auth = await steady(id)
        if (await signedInElsewhere(id, account.identity)) return { ok: false, error: otherAccount() }
        if (auth.status === 'unknown')
          throw authError(t('main.claudeAccount.selectedAuthUnreadable', 'Selected Claude authentication is unreadable; launch was refused.'))
        if (auth.status !== 'ready' || !matches(account.identity, identity(auth.oauth)))
          return {
            ok: false,
            error: t('main.claudeAccount.signInAgain', 'This Claude account needs to sign in again (Settings > AI provider accounts).')
          }
        const prepared = await prepare(id, auth)
        if (prepared === 'switched') return { ok: false, error: otherAccount() }
        if (prepared === 'foreignAuth')
          return {
            ok: false,
            error: t(
              'main.claudeAccount.foreignAuth',
              "This Claude account's settings still hold another sign-in setting (an API key, a token, apiKeyHelper or a gateway address) that Tessel could not remove, so the session would not use this account. Close its other sessions and try again."
            )
          }
        return { ok: true, env: { CLAUDE_CONFIG_DIR: authPath(id) }, accountId: id }
      })
  }
}
