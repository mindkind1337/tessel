// What a copy of a person's setup may hold (settingsSync.js). A copy is never filtered: it is
// rebuilt, field by field, from what this file lists, so that what nobody thought of is simply not
// there. The same rebuild runs twice: on the computer that sends, where it leaves out what is not
// valid (that computer's own files must not stop its uploads), and on the one that receives, where
// anything out of shape refuses the whole copy (a real sender never produces it).
//
// Not in a copy, on any computer: a pane's command (looked up here from its agent's id), what a
// pane may do, a page's address and title, teams, the broadcast switch, side browsers, a host's
// proxy command, jump host and key file, the settings not listed in SYNCED_SETTINGS.
//
// Each computer then keeps what is its own: localizeRebuilt makes the copy fit this computer, and
// finishLayout, finishHosts and finishBoard lay it over this computer's files at the start that
// applies it, so a change made here after "Use them" still counts.
import { sanitizeTarget } from './remoteHosts'
import { isRemotePath, parseRemotePath } from '../shared/remotePath'

export const MAX_SYNC_PANES = 200
export const MAX_SYNC_PROJECTS = 500
export const MAX_SYNC_DEPTH = 16
// A split's sizes are shares of 100: far above that is no size.
const MAX_SIZE = 1000
const MAX_CARDS = 5000
const MAX_TARGETS = 500
const MAX_PATH = 1024
const MAX_DEVICE = 40

const LAYOUT = 'workspace-layout.json'
const HOSTS = 'remote-hosts.json'
const BOARD = 'task-board.json'
export const SYNCED_FILE_NAMES = [LAYOUT, HOSTS, BOARD]

// Control characters, and those that show nothing or turn what follows around: a name must read as
// what it is. What a sender has of them is taken out; a copy that holds them is refused.
const HIDDEN = '\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u2028\\u2029\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}'
// eslint-disable-next-line no-misleading-character-class -- hidden characters, one by one, are what is looked for
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${HIDDEN}]`, 'u')
// eslint-disable-next-line no-misleading-character-class -- hidden characters, one by one, are what is looked for
const CONTROL_BUT_LINES = new RegExp(`[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f${HIDDEN}]`, 'u')
// eslint-disable-next-line no-misleading-character-class -- hidden characters, one by one, are what is looked for
const HIDDEN_ALL = new RegExp(`[${HIDDEN}]`, 'gu')
// A computer's name, wherever it is shown or told to an agent: it can say who, and nothing else.
export const safeDeviceName = (name) =>
  String(name || '')
    .replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const PANE_ID = /^pane-[\w-]{1,100}$/
const WS_ID = /^ws-[\w-]{1,100}$/
const AGENT_ID = /^[\w.-]{1,60}$/
const SHELL_ID = /^[\w.:() -]{1,80}$/
const HOST_ID = /^ssh-[\w-]{1,60}$/
const TARGET_ID = /^[\w.-]{1,80}$/
const CARD_ID = /^[\w.:-]{1,80}$/
const COLOR = /^#[0-9a-fA-F]{3,8}$/
const BRANCH = /^(?!-)[^\s~^:?*[\\]{1,200}$/
// A folder on an SSH host: never one that reads as a share on this computer.
const REMOTE_PATH = /^(?:\/(?![\\/])|~$|~\/)[^\\]*$/
// The window's own rules for what goes in a command line (agentResumeLine.js safeSessionId) and
// for a chat's conversation (App.vue deserializeNode).
export const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{5,79}$/
const CHAT_SESSION_ID = /^(?:[0-9a-f-]{8,64}|ses_[A-Za-z0-9]{20,40})$/i

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const refused = (code = 'refused') => Object.assign(new Error(code), { code })
const parse = (text) => {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

// A folder this computer may look at: a drive letter, or on macOS and Linux one slash. Everything
// else (a share, \\?\, \??\, a relative path, a URL) is refused without ever being touched, because
// merely asking Windows whether a share's folder exists sends this computer's sign-in to it.
export function localFolderOk(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH || CONTROL.test(p)) return false
  return /^[A-Za-z]:[\\/]/.test(p) || /^\/(?![\\/])/.test(p)
}

// --- settings ---------------------------------------------------------------------------------
const bool = (v) => typeof v === 'boolean'
const num = (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const word = (max = 80) => (v) => typeof v === 'string' && v.length <= max && !CONTROL.test(v)
const oneOf = (...list) => (v) => list.includes(v)
const words = (items = 50, max = 300) => (v) => Array.isArray(v) && v.length <= items && v.every(word(max))
const fontName = (v) => typeof v === 'string' && v.length <= 200 && /^[\p{L}\p{N} ,.'_-]*$/u.test(v)
const orNull = (check) => (v) => v === null || check(v)

// What follows a person: how Tessel looks and how its panels are arranged. Nothing here runs
// anything, decides what an agent may do, opens anything by itself, hides an alert or takes away a
// question. Every other setting stays what this computer has, a new one included until it is added
// here. Each is checked: a value out of shape is dropped, and this computer's stays.
export const SYNCED_SETTINGS = {
  theme: word(),
  uiLanguage: word(20),
  hiddenUsageProviders: words(),
  fontSize: num(6, 72),
  fontFamily: fontName,
  fontWeight: num(100, 900),
  fontWeightBold: num(100, 900),
  lineHeight: num(0.5, 3),
  cursorStyle: oneOf('block', 'bar', 'underline'),
  cursorBlink: bool,
  cursorOpacity: num(0, 1),
  scrollback: num(0, 1_000_000),
  minimumContrastRatio: orNull(num(1, 21)),
  scrollSensitivity: num(0.1, 20),
  fastScrollSensitivity: num(0.1, 50),
  focusFollowsMouse: bool,
  copyTrimsGutter: bool,
  tileNewPanes: bool,
  autoTitles: bool,
  promptCacheTimer: bool,
  promptCacheTtlMs: num(0, 24 * 3600 * 1000),
  editorMinimap: bool,
  editorWordWrap: bool,
  editorPreviewTabs: bool,
  editorFontFamily: fontName,
  editorFontSize: num(6, 72),
  fileIcons: oneOf('color', 'mono', 'off'),
  diffSideBySide: bool,
  diffShowWhitespace: bool,
  diffCollapseUnchanged: bool,
  diffWordWrap: bool,
  browserZoomLevel: num(-5, 5),
  sidebarGroupBy: oneOf('repo', 'none'),
  sidebarSortBy: oneOf('name', 'smart', 'recent', 'repo', 'manual'),
  sidebarProjectOrderBy: oneOf('manual', 'recent'),
  showSleepingWorkspaces: bool,
  alwaysShowDefaultBranchWorkspace: bool,
  hideDefaultBranchWorkspace: bool,
  worktreeCardProperties: words(20, 40),
  agentActivityDisplayMode: oneOf('compact', 'full'),
  compactWorktreeCards: bool,
  leftSidebarAppearanceMode: oneOf('default', 'match-terminal', 'tinted'),
  leftSidebarTintColor: (v) => typeof v === 'string' && COLOR.test(v),
  leftSidebarTintOpacity: num(0, 1),
  statusBarVisible: bool,
  statusBarItems: words(20, 40),
  uiZoomLevel: num(-3, 5),
  inactivePaneOpacity: num(0.3, 1),
  dividerThickness: num(1, 12),
  terminalPaddingX: num(0, 40),
  terminalPaddingY: num(0, 40),
  hideMouseWhileTyping: bool,
  usagePercentageDisplay: oneOf('used', 'remaining'),
  usageRefreshMinutes: num(0, 1440),
  showGitIgnoredFiles: bool,
  explorerCompactFolders: bool,
  explorerOpenEditorsShown: bool,
  explorerFolderShown: bool,
  explorerOutlineShown: bool,
  explorerTimelineShown: bool,
  explorerOutlineHeight: num(40, 4000),
  explorerTimelineHeight: num(40, 4000),
  explorerOutlineFollowCursor: bool,
  explorerOutlineFilterOnType: bool,
  explorerOutlineSortBy: oneOf('position', 'name', 'kind'),
  explorerTimelineGit: bool,
  explorerTimelineLocal: bool,
  sourceControlGroupOrder: word(30),
  sourceControlViewMode: oneOf('tree', 'list', 'flat')
}

export function pickSettings(settings) {
  const out = {}
  if (!isObject(settings)) return out
  for (const [key, check] of Object.entries(SYNCED_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(settings, key) && check(settings[key])) out[key] = settings[key]
  }
  return out
}

// --- the rebuild ------------------------------------------------------------------------------
function checker(strict) {
  const bad = () => {
    if (strict) throw refused()
    return undefined
  }
  const text = (given, max, shape = null, control = CONTROL) => {
    if (given === undefined || given === null) return undefined
    const value = strict || typeof given !== 'string' ? given : given.replace(HIDDEN_ALL, '')
    if (typeof value !== 'string' || value.length > max || control.test(value) || (shape && !shape.test(value))) return bad()
    return value
  }
  const int = (value, min, max) => {
    if (value === undefined || value === null) return undefined
    return Number.isInteger(value) && value >= min && value <= max ? value : bad()
  }
  return { bad, text, int, strict }
}
const set = (out, key, value) => {
  if (value !== undefined) out[key] = value
}

function rebuildWorktree(src, c) {
  if (src === undefined || src === null) return undefined
  if (!isObject(src)) return c.bad()
  const path = c.text(src.path, MAX_PATH)
  if (!path) return c.bad()
  const out = { path }
  set(out, 'branch', c.text(src.branch, 200, BRANCH))
  return out
}

function rebuildTerminal(src, out, c) {
  set(out, 'shellId', c.text(src.shellId, 80, SHELL_ID))
  // A name the person gave it, not what the program running there calls itself.
  if (src.title !== undefined && src.title !== null && typeof src.title !== 'string') c.bad()
  if (src.titleSet === true) {
    const title = c.text(src.title, 200)
    if (title) {
      out.title = title
      out.titleSet = true
    }
  }
  set(out, 'accent', c.text(src.accent, 9, COLOR))
  const zoom = c.int(src.fontZoom, -20, 20)
  if (zoom) out.fontZoom = zoom
  set(out, 'worktree', rebuildWorktree(src.worktree, c))
  set(out, 'remoteHostId', c.text(src.remoteHostId, 64, HOST_ID))
  set(out, 'remotePath', c.text(src.remotePath, MAX_PATH, REMOTE_PATH))
}

function rebuildLeaf(src, c, count) {
  if (++count.panes > MAX_SYNC_PANES) throw refused(c.strict ? 'refused' : 'too-many-panes')
  const id = c.text(src.id, 110, PANE_ID)
  if (!id) return c.bad() ?? null
  const kind = src.kind === undefined || src.kind === null ? 'shell' : src.kind
  if (!['shell', 'agent', 'chat', 'browser', 'editor'].includes(kind)) return c.bad() ?? null
  const out = { type: 'leaf', id, kind }
  set(out, 'num', c.int(src.num, 1, 1_000_000))
  set(out, 'paneName', c.text(src.paneName, 80))
  set(out, 'viewPath', c.text(src.viewPath, 1000))
  if (kind === 'browser') {
    // A pane stays where it is, on a blank page: what a page is called and where it is never travel.
    return out
  }
  if (kind === 'editor') {
    if (src.files !== undefined && src.files !== null && !Array.isArray(src.files)) c.bad()
    const files = []
    for (const file of Array.isArray(src.files) ? src.files.slice(0, 50) : []) {
      if (!isObject(file)) {
        c.bad()
        continue
      }
      const path = c.text(file.path, MAX_PATH)
      if (path) files.push({ path, preview: file.preview === true })
    }
    if (!files.length) return null
    out.files = files
    const active = c.text(src.activePath, MAX_PATH)
    if (active && files.some((f) => f.path === active)) out.activePath = active
    return out
  }
  if (kind === 'chat') {
    const cwd = c.text(src.cwd, MAX_PATH)
    if (!cwd) return c.bad() ?? null
    out.agentId = c.text(src.agentId, 60, AGENT_ID) || 'claude'
    out.cwd = cwd
    set(out, 'projectDir', c.text(src.projectDir, MAX_PATH))
    set(out, 'sessionId', c.text(src.sessionId, 80, CHAT_SESSION_ID))
    set(out, 'worktree', rebuildWorktree(src.worktree, c))
    return out
  }
  rebuildTerminal(src, out, c)
  if (kind === 'agent') {
    // Never taken from a copy. Text is left aside; anything else is no command at all.
    if (src.agentCommand !== undefined && src.agentCommand !== null && typeof src.agentCommand !== 'string') c.bad()
    const agentId = c.text(src.agentId, 60, AGENT_ID)
    if (!agentId) {
      c.bad()
      out.kind = 'shell'
      return out
    }
    out.agentId = agentId
    set(out, 'sessionId', c.text(src.sessionId, 80, SESSION_ID))
  }
  return out
}

function rebuildNode(src, c, count, depth) {
  if (src === undefined || src === null) return null
  if (!isObject(src)) return c.bad() ?? null
  if (depth > MAX_SYNC_DEPTH) throw refused(c.strict ? 'refused' : 'too-many-panes')
  if (src.type === 'leaf') return rebuildLeaf(src, c, count)
  if (src.type !== 'split' || !Array.isArray(src.children)) return c.bad() ?? null
  const children = []
  const kept = []
  src.children.forEach((child, i) => {
    const built = rebuildNode(child, c, count, depth + 1)
    if (built) {
      children.push(built)
      kept.push(i)
    }
  })
  if (!children.length) return null
  if (children.length === 1) return children[0]
  let dir = src.dir
  if (dir !== 'row' && dir !== 'col') {
    c.bad()
    dir = 'row'
  }
  const given = Array.isArray(src.sizes) && src.sizes.length === src.children.length && src.sizes.every((n) => Number.isFinite(n) && n >= 0 && n <= MAX_SIZE)
  if (!given && src.sizes !== undefined && src.sizes !== null) c.bad()
  const sizes = given ? kept.map((i) => src.sizes[i]) : children.map(() => 100 / children.length)
  return { type: 'split', dir, sizes, children }
}

function rebuildProject(src, c, count) {
  if (!isObject(src)) return c.bad() ?? null
  const id = c.text(src.id, 110, WS_ID)
  if (!id) return c.bad() ?? null
  const out = { id }
  set(out, 'name', c.text(src.name, 200))
  out.cwd = c.text(src.cwd, MAX_PATH) ?? null
  if (src.remote !== undefined && src.remote !== null) {
    const hostId = isObject(src.remote) ? c.text(src.remote.hostId, 64, HOST_ID) : c.bad()
    const path = isObject(src.remote) ? c.text(src.remote.path, MAX_PATH, REMOTE_PATH) : undefined
    if (hostId && path) {
      out.remote = { hostId, path }
      out.cwd = null
    } else c.bad()
  }
  if (src.group !== undefined && src.group !== null) {
    if (!isObject(src.group) || !Array.isArray(src.group.repos)) c.bad()
    else {
      const repos = []
      for (const repo of src.group.repos.slice(0, 500)) {
        if (!isObject(repo)) {
          c.bad()
          continue
        }
        const path = c.text(repo.path, MAX_PATH)
        if (path) {
          const entry = { path }
          set(entry, 'name', c.text(repo.name, 200))
          repos.push(entry)
        }
      }
      if (repos.length) out.group = { repos }
    }
  }
  if (src.gridModes !== undefined && src.gridModes !== null) {
    if (!isObject(src.gridModes)) c.bad()
    else {
      const modes = {}
      for (const [key, mode] of Object.entries(src.gridModes).slice(0, 200)) {
        if (key.length <= 1000 && !CONTROL.test(key) && (mode === 'manual' || mode === 'tiled')) modes[key] = mode
        else c.bad()
      }
      if (Object.keys(modes).length) out.gridModes = modes
    }
  }
  if (src.manualSizes === true) out.manualSizes = true
  out.tree = rebuildNode(src.tree, c, count, 0)
  return out
}

// A saved layout -> the same, with only what a copy may hold, always in the same order. strict:
// throws { code: 'refused' } for anything out of shape, the older top-level tree included.
export function rebuildLayout(layout, { strict = false } = {}) {
  const c = checker(strict)
  if (!isObject(layout)) throw refused()
  if (layout.tree !== undefined && layout.tree !== null) c.bad()
  if (layout.settings !== undefined && layout.settings !== null && !isObject(layout.settings)) c.bad()
  if (!Array.isArray(layout.workspaces)) {
    c.bad()
    return { version: 2, settings: pickSettings(layout.settings), workspaces: [] }
  }
  if (layout.workspaces.length > MAX_SYNC_PROJECTS) throw refused(strict ? 'refused' : 'too-many-panes')
  const count = { panes: 0 }
  const workspaces = []
  const seen = new Set()
  const ids = new Set()
  for (const src of layout.workspaces) {
    const project = rebuildProject(src, c, count)
    if (!project) continue
    if (seen.has(project.id)) {
      c.bad()
      continue
    }
    seen.add(project.id)
    // One pane id twice would be two panes on one terminal.
    forEachPane(project.tree, (pane) => {
      if (ids.has(pane.id)) c.bad()
      ids.add(pane.id)
    })
    workspaces.push(project)
  }
  return { version: 2, settings: pickSettings(layout.settings), workspaces }
}

// The hosts, without what is this computer's: a proxy command, a jump host, a key file, and what
// makes it connect somewhere other than the address shown (an alias of its ~/.ssh/config).
export function rebuildHosts(hosts, { strict = false } = {}) {
  const c = checker(strict)
  if (!isObject(hosts)) throw refused()
  if (!Array.isArray(hosts.targets)) {
    c.bad()
    return { version: 1, targets: [] }
  }
  if (hosts.targets.length > MAX_TARGETS) c.bad()
  const targets = []
  for (const raw of hosts.targets.slice(0, MAX_TARGETS)) {
    const id = isObject(raw) ? c.text(raw.id, 80, TARGET_ID) : c.bad()
    if (!id) {
      c.bad()
      continue
    }
    const { target, error } = sanitizeTarget({ id, label: c.text(raw.label, 200), host: raw.host, port: raw.port, username: raw.username }, { id })
    if (error || !target) {
      c.bad()
      continue
    }
    const { configHost, source, ...travels } = target // eslint-disable-line no-unused-vars -- what stays on each computer
    targets.push(travels)
  }
  return { version: 1, targets }
}

// The board's cards, without what happened to them on this computer: a card's copy of the code, its
// merge, the decisions and reports attached to it, the agents' ledger, the history.
const CARD_SYNCED = ['id', 'title', 'brief', 'note', 'column', 'wsId', 'paneId', 'deps', 'createdAt', 'columnSince', 'startedAt', 'doneAt']
export function rebuildBoard(board, { strict = false } = {}) {
  const c = checker(strict)
  // The older shape, still read: a bare list.
  const list = Array.isArray(board) && !strict ? board : isObject(board) && Array.isArray(board.tasks) ? board.tasks : null
  if (!list) {
    if (strict || !isObject(board)) throw refused()
    return { version: 1, tasks: [] }
  }
  if (list.length > MAX_CARDS) throw refused(strict ? 'refused' : 'too-many-panes')
  const tasks = []
  for (const src of list) {
    if (!isObject(src)) {
      c.bad()
      continue
    }
    const id = c.text(src.id, 80, CARD_ID)
    // eslint-disable-next-line no-misleading-character-class -- hidden characters, one by one, are what is looked for
    const title = strict ? c.text(src.title, 2000) : typeof src.title === 'string' ? src.title.replace(new RegExp(CONTROL.source, 'gu'), ' ').slice(0, 2000) : undefined
    if (!id || !title) {
      c.bad()
      continue
    }
    const column = ['todo', 'doing', 'review', 'done'].includes(src.column) ? src.column : c.bad() ?? 'todo'
    const out = { id, title, column }
    set(out, 'brief', c.text(src.brief, 20000, null, CONTROL_BUT_LINES))
    set(out, 'note', c.text(src.note, 20000, null, CONTROL_BUT_LINES))
    set(out, 'wsId', c.text(src.wsId, 110, WS_ID))
    set(out, 'paneId', c.text(src.paneId, 110, PANE_ID))
    if (src.deps !== undefined && src.deps !== null) {
      if (!Array.isArray(src.deps)) c.bad()
      else {
        const deps = src.deps.slice(0, 100).map((d) => c.text(d, 80, CARD_ID)).filter(Boolean)
        if (deps.length) out.deps = deps
      }
    }
    for (const key of ['createdAt', 'columnSince', 'startedAt', 'doneAt']) {
      if (src[key] === undefined || src[key] === null) continue
      if (Number.isFinite(src[key])) out[key] = src[key]
      else c.bad()
    }
    tasks.push(out)
  }
  return { version: 1, tasks }
}

const REBUILD = { [LAYOUT]: rebuildLayout, [HOSTS]: rebuildHosts, [BOARD]: rebuildBoard }

// The files of a bundle, as received -> the same, rebuilt, or throws { code: 'refused' }.
export function rebuildReceived(files) {
  const out = {}
  for (const name of SYNCED_FILE_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(files, name)) continue
    if (typeof files[name] !== 'string') throw refused()
    let parsed
    try {
      parsed = JSON.parse(files[name])
    } catch {
      throw refused()
    }
    out[name] = JSON.stringify(REBUILD[name](parsed, { strict: true }))
  }
  return out
}
export const rebuildToSend = (name, parsed) => JSON.stringify(REBUILD[name](parsed, { strict: false }))

// --- panes ------------------------------------------------------------------------------------
export function forEachPane(node, visit) {
  if (!isObject(node)) return
  if (node.type === 'leaf') visit(node)
  else if (Array.isArray(node.children)) node.children.forEach((child) => forEachPane(child, visit))
}
function mapPanes(node, change) {
  if (!isObject(node)) return node
  if (node.type === 'leaf') return change(node)
  if (Array.isArray(node.children)) return { ...node, children: node.children.map((child) => mapPanes(child, change)) }
  return node
}

// --- made ready for this computer ---------------------------------------------------------------
// A rebuilt layout -> what this computer can use. Nothing starts by itself: an agent and a terminal
// both come back asleep and held until a click, an agent with this computer's own command for its
// agent, a chat waits for its first message. A pane whose agent or folder is not here comes back as a
// plain terminal (it starts in the home folder), and a share is never looked at, wherever it is
// named. What had to change is kept apart (shadow), so that this computer's uploads still carry the
// copy as it was: what fits this computer never degrades another one.
//
// Every pane goes through this, even one said to run here: the pane may be closed, or its terminal
// gone, by the next start. finishLayout is what gives a pane that still runs here back as it is.
// agents: Map of id -> { command, name, available }. -> { layout, missing, missingAgents, shadow }
export function localizeRebuilt(layout, { agents = new Map(), folderExists = () => false, now = Date.now } = {}) {
  const missing = new Set()
  const missingAgents = new Set()
  const shadow = { panes: {}, projects: {} }
  const looked = new Map()
  const isHere = (folder) => {
    if (!folder) return true
    if (looked.has(folder)) return looked.get(folder)
    const here = localFolderOk(folder) && !!folderExists(folder)
    looked.set(folder, here)
    if (!here) missing.add(folder)
    return here
  }
  // A chat's folder: on this computer, or a real address on an SSH host. Each is checked by itself.
  const remoteOk = (p) => isRemotePath(p) && !!parseRemotePath(p)
  const chatFolderOk = (p) => {
    if (!p) return true
    if (remoteOk(p)) return true
    return isHere(p)
  }
  const at = now()
  const held = () => ({ at, held: true })
  const plain = (pane) => ({ type: 'leaf', id: pane.id, kind: 'shell', ...(pane.paneName ? { paneName: pane.paneName } : {}), ...(pane.num ? { num: pane.num } : {}), ...(pane.shellId ? { shellId: pane.shellId } : {}), sleeping: held() })
  const workspaces = layout.workspaces.map((src) => {
    const project = { ...src }
    if (project.cwd && !project.remote) {
      isHere(project.cwd)
      // Refused, not looked at: a share never reaches the window, or the terminals started there.
      if (!localFolderOk(project.cwd)) {
        shadow.projects[project.id] = { cwd: project.cwd }
        project.cwd = null
      }
    }
    if (project.group) {
      const repos = project.group.repos.filter((repo) => localFolderOk(repo.path))
      if (repos.length !== project.group.repos.length) {
        shadow.projects[project.id] = { ...shadow.projects[project.id], group: project.group }
        if (repos.length) project.group = { repos }
        else delete project.group
      }
    }
    const onHost = (pane) => !!(src.remote || pane.remoteHostId)
    project.tree = mapPanes(project.tree, (given) => {
      const keep = (localKind) => {
        shadow.panes[given.id] = { localKind, pane: given }
      }
      // The grid a pane was in becomes the Files and Changes root when it is on screen.
      let pane = given
      if (pane.viewPath && !localFolderOk(pane.viewPath)) {
        const { viewPath, ...rest } = pane
        pane = rest
        missing.add(viewPath)
        keep(pane.kind)
      }
      if (pane.kind === 'browser') return pane
      if (pane.kind === 'editor') {
        const files = pane.files.filter((file) => localFolderOk(file.path))
        if (files.length === pane.files.length) return pane
        // A pane with no file left comes back as nothing: a terminal keeps its place.
        keep(files.length ? 'editor' : 'shell')
        return files.length ? { ...pane, files, ...(files.some((f) => f.path === pane.activePath) ? {} : { activePath: files[0].path }) } : plain(pane)
      }
      if (pane.kind === 'chat') {
        const copy = pane.worktree ? pane.worktree.path : null
        if (!chatFolderOk(pane.cwd) || !chatFolderOk(copy)) {
          keep('shell')
          return plain(pane)
        }
        // Never looked at, or worse: a chat's project folder goes through the same door.
        const { projectDir, ...rest } = pane
        return { ...rest, ...(projectDir && (remoteOk(projectDir) || localFolderOk(projectDir)) ? { projectDir } : {}), held: true }
      }
      const copy = pane.worktree ? pane.worktree.path : null
      // Main asks the system about a pane's folder even on a host: a share is refused there too.
      const refusedCopy = !!copy && !localFolderOk(copy)
      if (refusedCopy) missing.add(copy)
      const folderHere = !refusedCopy && (onHost(pane) || isHere(copy || (project.remote ? null : src.cwd)))
      if (pane.kind === 'shell') {
        if (!copy || folderHere) return { ...pane, sleeping: held() }
        const { worktree, ...rest } = pane // eslint-disable-line no-unused-vars -- what is not on this computer
        keep('shell')
        return { ...rest, sleeping: held() }
      }
      // On an SSH host, its agent is looked for there when it wakes.
      const known = agents.get(pane.agentId)
      const here = known && (onHost(pane) || known.available !== false) ? known : null
      if (!here) missingAgents.add(pane.agentId)
      if (!here || !folderHere) {
        const { agentId, sessionId, worktree, ...rest } = pane // eslint-disable-line no-unused-vars -- what makes it an agent here
        keep('shell')
        return { ...rest, kind: 'shell', sleeping: held() }
      }
      return { ...pane, agentCommand: here.command, ...(pane.titleSet || !here.name ? {} : { title: here.name }), sleeping: held() }
    })
    return project
  })
  return { layout: { ...layout, workspaces }, missing: [...missing], missingAgents: [...missingAgents], shadow }
}

// Before sending: what this computer changed only to fit (above) goes back as it was in the copy,
// unless the person made something else of that pane here.
export function restoreShadow(layout, shadow) {
  if (!isObject(shadow)) return layout
  const panes = isObject(shadow.panes) ? shadow.panes : {}
  const projects = isObject(shadow.projects) ? shadow.projects : {}
  const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key)
  // Rebuilt once more: the same setup always gives the same text, so nothing here looks like a change.
  return rebuildLayout({
    ...layout,
    workspaces: layout.workspaces.map((src) => {
      const project = { ...src }
      const kept = has(projects, project.id) ? projects[project.id] : null
      if (kept && kept.cwd && !project.cwd && !project.remote) project.cwd = kept.cwd
      if (kept && kept.group) project.group = kept.group
      project.tree = mapPanes(project.tree, (pane) => {
        const was = has(panes, pane.id) ? panes[pane.id] : null
        if (!was || pane.kind !== was.localKind) return pane
        // The name and number the person gives it here are theirs.
        return { ...was.pane, ...(pane.paneName ? { paneName: pane.paneName } : {}), ...(pane.num ? { num: pane.num } : {}), ...(pane.titleSet && pane.title ? { title: pane.title, titleSet: true } : {}) }
      })
      return project
    })
  })
}

// --- laid over this computer's files, at the start that applies it ---------------------------------
// The keys a copy says something about, per kind: every other key of this computer's pane is its own.
const PANE_SYNCED = {
  shell: ['shellId', 'title', 'titleSet', 'accent', 'fontZoom', 'worktree', 'remoteHostId', 'remotePath'],
  agent: ['shellId', 'title', 'titleSet', 'accent', 'fontZoom', 'worktree', 'remoteHostId', 'remotePath', 'agentId', 'sessionId', 'agentCommand', 'sleeping'],
  chat: ['agentId', 'cwd', 'projectDir', 'sessionId', 'worktree', 'held'],
  browser: [],
  editor: ['files', 'activePath']
}
const PANE_COMMON = ['type', 'id', 'kind', 'num', 'paneName', 'viewPath']
// A drive's folders do not care for case; a POSIX system's do.
const folderKey = (p) => {
  const key = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(key) ? key.toLowerCase() : key
}
// What a pane may do, here. It was decided for what that pane was: not for what a copy makes of it.
const PANE_PINS = ['permissions', 'permissionMode', 'launchYolo', 'launchSig', 'launchedAt', 'rootNoYolo']
const sameFolder = (a, b) => (a ? folderKey(a) : '') === (b ? folderKey(b) : '')
// Nothing and null are the same: the window writes one, a copy the other.
const same = (a, b) => (a ?? null) === (b ?? null)
const sameRemote = (a, b) => (!a && !b) || (!!a && !!b && a.hostId === b.hostId && a.path === b.path)

// Only a folder the person chose on this computer is theirs to trust. A project from elsewhere is
// marked, whatever it says of itself, and the agents started there ask (worktreeList.js).
// current: this computer's layout as it is now. What a copy or a file says of this is never read.
export function markFolders(workspaces, current) {
  const chosen = new Set()
  if (isObject(current) && Array.isArray(current.workspaces)) {
    for (const w of current.workspaces) {
      if (isObject(w) && typeof w.cwd === 'string' && w.cwd && !w.remote && w.fromCopy !== true) chosen.add(folderKey(w.cwd))
    }
  }
  return workspaces.map((project) => {
    if (!isObject(project)) return project
    const { fromCopy, ...rest } = project // eslint-disable-line no-unused-vars -- never taken from what arrives
    return typeof rest.cwd === 'string' && rest.cwd && !rest.remote && !chosen.has(folderKey(rest.cwd)) ? { ...rest, fromCopy: true } : rest
  })
}

// addresses: 'copy' only on the person's word: a project or a pane this computer has moves to
// another host then, and not otherwise (hostChangesOf says which).
export function finishLayout(stagedBody, currentBody, { running = [], addresses = 'keep' } = {}) {
  const staged = JSON.parse(stagedBody)
  const current = parse(currentBody)
  const here = isObject(current) ? current : {}
  const panes = new Map()
  const ownerOf = new Map()
  const projects = new Map()
  if (Array.isArray(here.workspaces)) {
    for (const w of here.workspaces) {
      if (!isObject(w)) continue
      if (typeof w.id === 'string') projects.set(w.id, w)
      forEachPane(w.tree, (pane) => {
        if (typeof pane.id === 'string') {
          panes.set(pane.id, pane)
          ownerOf.set(pane.id, w)
        }
      })
    }
  }
  const stillRunning = new Set(Array.isArray(running) ? running : [])
  const agreed = addresses === 'copy'
  // A project that moves to another host without the person's word stays where it is here.
  const stayed = staged.workspaces.map((project) => {
    const own = projects.get(project.id)
    if (agreed || !own || sameRemote(own.remote, project.remote)) return project
    const { remote, ...rest } = project // eslint-disable-line no-unused-vars -- what it said
    return { ...rest, cwd: own.remote || typeof own.cwd !== 'string' ? null : own.cwd, ...(own.remote ? { remote: own.remote } : {}) }
  })
  const workspaces = markFolders(stayed, here).map((project) => {
    const tree = mapPanes(project.tree, (given) => {
      const own = panes.get(given.id)
      if (!own) return given
      // Its terminal runs here: it comes back as it is, what it may do and how it started included.
      if (stillRunning.has(given.id) && ['shell', 'agent'].includes(own.kind || 'shell')) return own
      // On the host it is on here, unless the person agreed.
      let pane = given
      if (!agreed && (!same(pane.remoteHostId, own.remoteHostId) || !same(pane.remotePath, own.remotePath))) {
        const { remoteHostId, remotePath, ...rest } = pane // eslint-disable-line no-unused-vars -- what it said
        pane = { ...rest, ...(own.remoteHostId ? { remoteHostId: own.remoteHostId } : {}), ...(own.remotePath ? { remotePath: own.remotePath } : {}) }
      }
      if ((own.kind || 'shell') !== pane.kind) return pane
      const synced = new Set([...PANE_COMMON, ...(PANE_SYNCED[pane.kind] || [])])
      const mine = Object.fromEntries(Object.entries(own).filter(([key]) => !synced.has(key)))
      // A pin was given to that agent, in that folder, on that host. A copy that changes any of them
      // does not keep what it was allowed to do.
      const was = ownerOf.get(given.id) || {}
      const aimedElsewhere =
        !same(pane.agentId, own.agentId) ||
        !same(pane.remoteHostId, own.remoteHostId) ||
        !same(pane.remotePath, own.remotePath) ||
        !sameFolder(pane.worktree && pane.worktree.path, own.worktree && own.worktree.path) ||
        !sameFolder(project.cwd, was.cwd) ||
        !sameRemote(project.remote, was.remote)
      if (aimedElsewhere) for (const key of PANE_PINS) delete mine[key]
      return { ...mine, ...pane }
    })
    return { ...project, tree }
  })
  const shown = Array.isArray(here.workspaces) && isObject(here.workspaces[here.currentIndex]) ? here.workspaces[here.currentIndex].id : null
  const index = workspaces.findIndex((w) => w.id === shown)
  // Teams, the broadcast switch, side browsers, the panels' widths: this computer's.
  return JSON.stringify({
    ...here,
    version: 2,
    settings: { ...(isObject(here.settings) ? here.settings : {}), ...staged.settings },
    workspaces,
    currentIndex: index >= 0 ? index : 0
  })
}

const address = (t) => `${t.username ? `${t.username}@` : ''}${t.host}${t.port && t.port !== 22 ? `:${t.port}` : ''}`
const sameAddress = (a, b) => a.host === b.host && (a.port || 22) === (b.port || 22) && (a.username || '') === (b.username || '')

// Where SSH would go because of this copy, that this computer does not already go: a host of this
// computer with another address, a new host, a project or a pane moved to another host. The person
// decides, in one question. -> [{ kind: 'changed' | 'added' | 'moved', id, label, from, to }]
export function hostChangesOf(copyBody, currentBody, copyLayoutBody = null, currentLayoutBody = null) {
  const out = []
  const copy = parse(copyBody)
  const current = parse(currentBody)
  const own = isObject(current) && Array.isArray(current.targets) ? current.targets.filter(isObject) : []
  const copied = isObject(copy) && Array.isArray(copy.targets) ? copy.targets.filter(isObject) : []
  // Its name can be anyone's: where it connects says which host this is.
  const hostText = (id, ...places) => {
    const host = places.flat().find((t) => t.id === id)
    return host ? `${String(host.label || id)} (${address(host)})` : String(id)
  }
  for (const target of copied) {
    const mine = own.find((t) => t.id === target.id)
    if (!mine) out.push({ kind: 'added', id: target.id, label: String(target.label || '').slice(0, 120), from: null, to: address(target) })
    else if (!sameAddress(mine, target)) out.push({ kind: 'changed', id: target.id, label: String(mine.label || target.label || '').slice(0, 120), from: address(mine), to: address(target) })
  }
  const layout = parse(copyLayoutBody)
  const here = parse(currentLayoutBody)
  if (isObject(layout) && Array.isArray(layout.workspaces) && isObject(here) && Array.isArray(here.workspaces)) {
    // What it is now as this computer has it; what it would be as the copy has it.
    const where = (w, ...places) => (w.remote ? `${hostText(w.remote.hostId, ...places)}:${w.remote.path}` : String(w.cwd || ''))
    const onHost = (pane, ...places) => (pane.remoteHostId ? `${hostText(pane.remoteHostId, ...places)}${pane.remotePath ? `:${pane.remotePath}` : ''}` : '')
    const panes = new Map()
    for (const w of here.workspaces) if (isObject(w)) forEachPane(w.tree, (pane) => panes.set(pane.id, pane))
    for (const w of layout.workspaces) {
      if (!isObject(w)) continue
      const mine = here.workspaces.find((p) => isObject(p) && p.id === w.id)
      if (mine && !sameRemote(mine.remote, w.remote)) out.push({ kind: 'moved', id: w.id, label: String(mine.name || w.name || '').slice(0, 120), from: where(mine, own, copied), to: where(w, copied, own) })
      forEachPane(w.tree, (pane) => {
        const was = panes.get(pane.id)
        if (was && (!same(pane.remoteHostId, was.remoteHostId) || !same(pane.remotePath, was.remotePath))) out.push({ kind: 'moved', id: pane.id, label: String(was.paneName || was.title || pane.paneName || pane.id).slice(0, 120), from: onHost(was, own, copied), to: onHost(pane, copied, own) })
      })
    }
  }
  return out.slice(0, 50)
}

// A host this computer has stays as it is, its name too, unless the person agreed to what the copy
// says of it (addresses: 'copy'); its proxy command, jump host and key file stay either way, and a
// new host comes only then. A host only here stays.
export function finishHosts(stagedBody, currentBody, { addresses = 'keep' } = {}) {
  const staged = JSON.parse(stagedBody)
  const current = parse(currentBody)
  const here = isObject(current) ? current : {}
  const own = new Map((Array.isArray(here.targets) ? here.targets : []).filter((t) => isObject(t) && typeof t.id === 'string').map((t) => [t.id, t]))
  const seen = new Set()
  const targets = []
  for (const target of staged.targets) {
    seen.add(target.id)
    const mine = own.get(target.id)
    if (addresses === 'copy') {
      // Its alias in ~/.ssh/config was for the address it had.
      targets.push(!mine ? target : sameAddress(mine, target) ? { ...mine, label: target.label } : { ...mine, ...target, configHost: target.host, source: 'manual' })
    } else if (mine) targets.push(mine)
  }
  for (const [id, target] of own) if (!seen.has(id)) targets.push(target)
  return JSON.stringify({ ...here, version: 1, targets })
}

// A card keeps what happened to it here. Words that are not this computer's say so: what agents
// read of a card from a copy is marked, as a Live Share guest's is (App.vue, teamMcp/server.cjs).
export function finishBoard(stagedBody, currentBody, { device = '' } = {}) {
  const staged = JSON.parse(stagedBody)
  const current = parse(currentBody)
  const here = isObject(current) ? current : {}
  const list = Array.isArray(current) ? current : Array.isArray(here.tasks) ? here.tasks : []
  const own = new Map(list.filter((t) => isObject(t) && typeof t.id === 'string').map((t) => [t.id, t]))
  const from = safeDeviceName(device).slice(0, MAX_DEVICE).trim() || 'another computer'
  const tasks = staged.tasks.map((card) => {
    const mine = own.get(card.id)
    const sameWords = !!mine && mine.title === card.title && (mine.brief || '') === (card.brief || '') && (mine.note || '') === (card.note || '')
    const kept = mine ? Object.fromEntries(Object.entries(mine).filter(([key]) => !CARD_SYNCED.includes(key))) : {}
    if (sameWords) return { ...kept, ...card }
    delete kept.guestBy
    return { ...kept, ...card, copiedFrom: from }
  })
  const ids = new Set(tasks.map((t) => t.id))
  const deleted = Array.isArray(here.deleted) ? here.deleted.filter((id) => !ids.has(id)) : undefined
  return JSON.stringify({ ...here, version: 1, tasks, ...(deleted ? { deleted } : {}) })
}

export function finishFile(name, stagedBody, currentBody, manifest = {}) {
  if (name === LAYOUT) return finishLayout(stagedBody, currentBody, { running: manifest.running, addresses: manifest.hostAddresses })
  if (name === HOSTS) return finishHosts(stagedBody, currentBody, { addresses: manifest.hostAddresses })
  if (name === BOARD) return finishBoard(stagedBody, currentBody, { device: manifest.device })
  return stagedBody
}

// --- what a copy holds -----------------------------------------------------------------------------
// In numbers, for the question "Use them?".
export function summaryOf(files) {
  const layout = parse(files[LAYOUT])
  const hosts = parse(files[HOSTS])
  const board = parse(files[BOARD])
  const spaces = isObject(layout) && Array.isArray(layout.workspaces) ? layout.workspaces : []
  let panes = 0
  let agents = 0
  for (const w of spaces) {
    forEachPane(w.tree, (pane) => {
      panes++
      if (pane.kind === 'agent' || pane.kind === 'chat') agents++
    })
  }
  return {
    projects: spaces.length,
    names: spaces.slice(0, 5).map((w) => String(w.name || '').slice(0, 60)).filter(Boolean),
    panes,
    agents,
    hosts: isObject(hosts) && Array.isArray(hosts.targets) ? hosts.targets.length : 0,
    cards: isObject(board) && Array.isArray(board.tasks) ? board.tasks.length : 0
  }
}

// What an upload is compared with: is this still the same setup, or did most of it vanish?
export function shapeOf(files) {
  const layout = parse(files[LAYOUT])
  const hosts = parse(files[HOSTS])
  const board = parse(files[BOARD])
  const spaces = isObject(layout) && Array.isArray(layout.workspaces) ? layout.workspaces : []
  let panes = 0
  for (const w of spaces) forEachPane(w.tree, () => panes++)
  return {
    files: Object.keys(files).filter((name) => SYNCED_FILE_NAMES.includes(name)).sort(),
    projects: spaces.map((w) => w.id).slice(0, MAX_SYNC_PROJECTS),
    panes,
    hosts: isObject(hosts) && Array.isArray(hosts.targets) ? hosts.targets.map((t) => t.id).slice(0, MAX_TARGETS) : [],
    cards: isObject(board) && Array.isArray(board.tasks) ? board.tasks.length : 0
  }
}

// -> what vanished since the last copy, if it is a lot (asked before anything goes up), or null.
export function shrunkFrom(before, now) {
  if (!isObject(before) || !isObject(now)) return null
  const out = {}
  const files = (before.files || []).filter((name) => !(now.files || []).includes(name))
  if (files.length) out.files = files
  const keptOf = (a, b) => (a || []).filter((id) => (b || []).includes(id)).length
  const projects = (before.projects || []).length
  if (projects && keptOf(before.projects, now.projects) < Math.ceil(projects / 2)) out.projects = { from: projects, to: (now.projects || []).length }
  if (before.panes >= 4 && now.panes < before.panes / 2) out.panes = { from: before.panes, to: now.panes }
  const hosts = (before.hosts || []).length
  if (hosts >= 2 && keptOf(before.hosts, now.hosts) < Math.ceil(hosts / 2)) out.hosts = { from: hosts, to: (now.hosts || []).length }
  if (before.cards >= 10 && now.cards < before.cards / 2) out.cards = { from: before.cards, to: now.cards }
  return Object.keys(out).length ? out : null
}
