// User preferences. One reactive object shared by the settings dialog, App and
// every TerminalPane; App persists it with the workspace layout.
import { reactive } from 'vue'
import { isTheme } from './themes'
import { UI_LANGUAGES } from './i18n'
import { validHiddenUsageProviders } from '../../shared/usageProviders'
import { validSessionOptionSettings } from '../../shared/agentSessionOptions'
import { MAX_CONCURRENT_LIMIT, NESTED_DEPTH_LIMIT } from '../../shared/orchestration'

// Font names: the same in every language.
export const FONT_FAMILIES = [
  'Cascadia Mono', // i18n-ignore
  'Cascadia Code', // i18n-ignore
  'Consolas',
  'JetBrains Mono', // i18n-ignore
  'Fira Code', // i18n-ignore
  'Courier New' // i18n-ignore
]

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'classic',
  // The interface's language: 'system' (Windows' language when Tessel has
  // it, else English), 'en' or 'fr'.
  uiLanguage: 'system',
  hiddenUsageProviders: [],
  fontSize: 13,
  fontFamily: 'Cascadia Mono', // i18n-ignore
  cursorStyle: 'block', // 'block' | 'bar' | 'underline'
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: true,
  rightClickPaste: true,
  confirmMultilinePaste: true,
  alwaysSelect: false,
  desktopNotifications: true,
  inAppAlerts: true,
  // A short sound with each new notification: 'none' | 'chime' | 'ping'.
  alertSound: 'none',
  confirmCloseAgent: true,
  // Type a one-line reminder into an idle agent's terminal when team
  // messages wait for it (nothing else can start an idle agent's turn). Off:
  // messages stay in the background only, read when the agent next works.
  teamWakeUps: true,
  // Also type that reminder into an agent whose state its hooks have not
  // confirmed yet (a Codex relaunched in place), with the same checks (never
  // while you type there, over a draft, an approval or an unsent line). Off:
  // Tessel asks you first (a toast with a button).
  teamWakeUnconfirmed: false,
  // Cursor's status hooks (~/.cursor/hooks.json, read by both its CLI and
  // its editor): off unless turned on. Its prompt hook must answer for every
  // prompt; a failing or left-behind one could block them all.
  cursorStatusHooks: false,
  // Settings > Orchestration (Orca's coordinator and workers): ask before an
  // agent starts workers (on by default), how many workers one coordinator
  // runs at a time (the rest wait in a queue), how deep workers may nest
  // (1: the lead's workers cannot start more).
  orchestrationConfirmWorkers: true,
  orchestrationMaxWorkers: 4,
  orchestrationMaxDepth: 1,
  // How a Claude or Codex worker starts: in a terminal pane (as always), or
  // as a chat agent (no terminal: its brief and messages are turns).
  orchestrationWorkerMode: 'terminal',
  // A chat agent idle this many minutes has its process stopped (0: never);
  // its next message starts it again, its conversation resumed.
  chatIdleMinutes: 30,
  restoreWorkspaces: true,
  resumeAgents: true,
  // Windows input method tip for voice typing ('' = whatever is active).
  voiceTip: '',
  // true once you pick a voice language yourself (then we never override it).
  voiceTipChosen: false,
  // [{ id, name, command, accent }] agents you add yourself (Tools dialog).
  customAgents: [],
  // [{ id, name, text, enter }] text you send to the active pane from the
  // command palette ("Run: <name>"); enter: also press Enter.
  quickCommands: [],
  // Settings > Agents. { [agent id]: { enabled, command, args, env } }: its
  // own command, arguments, "NAME=value" variables; enabled false hides it.
  agentPrefs: {},
  // Settings > Agents, each agent's default model and effort (Orca's
  // nativeChatSessionOptions): { [agent id]: { model?, valuesByModel:
  // { [model]: { effort } } } }. No model = the agent's own default, no flag.
  agentSessionOptions: {},
  // The agent a new pane starts (Ctrl+Shift+T): '' = the default shell.
  defaultAgent: '',
  // 'manual' (agents ask before acting) or 'yolo' (each agent's own
  // skip-approvals flag, unless you set its arguments yourself).
  agentPermissions: 'manual',
  // Folders where agents always start in Yolo (pane menu > Yolo in this
  // folder), whatever agentPermissions says.
  yoloFolders: [],
  // Keep the computer from sleeping: 'off' | 'agents' (while an agent is
  // working) | 'on' (while Tessel is open).
  keepAwake: 'off',
  // A countdown in Claude's panes until its prompt cache expires, and how
  // long the cache lasts (5 min, or 1 h for a longer cache).
  promptCacheTimer: false,
  // Agent panes named after their conversation (Claude Code's title, Codex's
  // thread name) until you rename them.
  autoTitles: true,
  // Agent sleep: an agent idle this long stops its terminal (its pane and
  // conversation stay; opening the pane resumes it). Off by default.
  agentSleep: false,
  agentSleepMinutes: 30,
  // Update agent CLIs by themselves when a newer version is found, at a safe
  // moment (panes running them idle: restarted in place, conversation
  // resumed). Off by default: Settings > Agents shows an Update button.
  autoUpdateAgents: false,
  promptCacheTtlMs: 300000,
  // The code editor (like Orca's): save by itself a moment after you stop
  // typing (off by default), the minimap, word wrap, preview tabs (a file
  // opened with one click replaces the previous one until you edit it), and
  // the Changes view side by side instead of inline.
  editorAutoSave: false,
  editorAutoSaveDelayMs: 1000,
  editorMinimap: false,
  editorWordWrap: true,
  editorPreviewTabs: true,
  diffSideBySide: false,
  // The left sidebar, like Orca's (same defaults): its Workspace options
  // menu (group, sort, project order, filters, card properties, agent
  // activity layout), the projects shown, the collapsed project groups.
  sidebarGroupBy: 'repo', // 'repo' (Project) | 'none'
  sidebarSortBy: 'recent', // 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  sidebarProjectOrderBy: 'manual', // 'manual' | 'recent'
  showSleepingWorkspaces: true,
  alwaysShowDefaultBranchWorkspace: true,
  hideDefaultBranchWorkspace: false,
  sidebarFilterRepoIds: [],
  sidebarCollapsedGroups: [],
  worktreeCardProperties: ['ports', 'inline-agents'],
  agentActivityDisplayMode: 'compact', // 'compact' | 'full'
  // Settings > Appearance > Window & Sidebar (Orca's).
  compactWorktreeCards: false,
  leftSidebarAppearanceMode: 'default', // 'default' | 'match-terminal' | 'tinted'
  leftSidebarTintColor: '#18181b',
  leftSidebarTintOpacity: 0.08,
  // The status bar at the bottom (Orca's) and the indicators it shows.
  statusBarVisible: true,
  statusBarItems: ['ssh', 'resource-usage', 'ports'],
  // Like Orca's (Settings > Editor): the editor's own font ('' = the
  // terminal font), and how diffs show whitespace, unchanged lines and long
  // lines.
  editorFontFamily: '',
  diffShowWhitespace: false,
  diffCollapseUnchanged: false,
  diffWordWrap: false,

  // Terminal typography and cursor (Orca's defaults).
  fontWeight: 500,
  fontWeightBold: 700,
  lineHeight: 1,
  cursorOpacity: 1,

  // Appearance: the whole app's zoom (Chromium zoom level, 0 = 100 %),
  // unfocused panes dimmed, the dividers between panes, the space around
  // the terminal grid, the mouse hidden while typing, usage percentages
  // used or remaining, git-ignored files in the explorer.
  uiZoomLevel: 0,
  inactivePaneOpacity: 0.9,
  dividerThickness: 3,
  terminalPaddingX: 4,
  terminalPaddingY: 4,
  hideMouseWhileTyping: false,
  usagePercentageDisplay: 'used', // 'used' | 'remaining'
  // Minutes between automatic usage refreshes while the window is in use; 0 = off.
  usageRefreshMinutes: 15,
  showGitIgnoredFiles: true,

  // Terminal rendering and interaction. gpuAcceleration: 'auto' (WebGL
  // unless the graphics are software-only; the normal renderer if WebGL
  // fails), 'on' or 'off'. minimumContrastRatio: null = automatic (by the
  // theme's background), 1 = off, else the ratio. wordSeparator '' = xterm's.
  gpuAcceleration: 'auto',
  minimumContrastRatio: null,
  scrollSensitivity: 1.15,
  fastScrollSensitivity: 5,
  focusFollowsMouse: false,
  copyTrimsGutter: true,
  allowOsc52Clipboard: true,
  wordSeparator: '',

  // Notifications (Orca's): the master switch, a bell from a terminal you
  // aren't looking at, nothing for the pane you are looking at, the volume
  // of the alert sound.
  notificationsEnabled: true,
  notifyTerminalBell: false,
  notifySuppressWhenFocused: true,
  notificationVolume: 100,

  // Ask before deleting a workspace (its panes and tasks).
  confirmDeleteWorkspace: true,
  // Where task copies (git worktrees) go: '' = next to the project, in
  // <project>.worktrees; a relative path is inside the project; an absolute
  // one holds a folder per project.
  workspaceDir: '',
  // Branch names of task copies: 'git-username' | 'custom' | 'none'. Tessel
  // keeps its own agent/ prefix by default.
  branchPrefix: 'custom',
  branchPrefixCustom: 'agent',
  sourceControlGroupOrder: 'changes-first',
  // The Changes tab shows files as a folder tree or a flat list (Orca's view mode).
  sourceControlViewMode: 'tree'
})

export const SIDEBAR_SORTS = ['name', 'smart', 'recent', 'repo', 'manual']
export const WORKTREE_CARD_PROPERTIES = ['ports', 'inline-agents']
export const STATUS_BAR_ITEMS = ['ssh', 'resource-usage', 'ports']
export const MAX_LEFT_SIDEBAR_TINT_OPACITY = 0.35

const idList = (v, max = 200) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length <= 200))].slice(0, max) : null

export const EDITOR_AUTOSAVE_MIN_MS = 250
export const EDITOR_AUTOSAVE_MAX_MS = 10000

// Ranges, as in Orca's settings.
// The choices Settings offers for the automatic usage refresh (0 = off).
export const USAGE_REFRESH_MINUTES = Object.freeze([0, 5, 15, 30, 60])
export const LIMITS = Object.freeze({
  fontWeight: [100, 900],
  fontWeightBold: [100, 900],
  lineHeight: [1, 3],
  cursorOpacity: [0, 1],
  uiZoomLevel: [-3, 5],
  inactivePaneOpacity: [0, 1],
  dividerThickness: [1, 32],
  terminalPaddingX: [0, 512],
  terminalPaddingY: [0, 512],
  scrollSensitivity: [0.5, 3],
  fastScrollSensitivity: [1, 10],
  notificationVolume: [0, 100],
  minimumContrastRatio: [1, 21]
})
export const UI_ZOOM_STEP = 0.5
export const GPU_MODES = ['auto', 'on', 'off']
export const SOURCE_CONTROL_GROUP_ORDERS = ['changes-first', 'staged-first', 'untracked-first']
export const BRANCH_PREFIX_MODES = ['git-username', 'custom', 'none']

// A number of a setting in its range (null when not a finite number).
export function limitNumber(key, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const [lo, hi] = LIMITS[key]
  return Math.min(hi, Math.max(lo, v))
}

const fresh = () => ({
  ...DEFAULT_SETTINGS,
  customAgents: [],
  quickCommands: [],
  agentPrefs: {},
  agentSessionOptions: {},
  yoloFolders: [],
  hiddenUsageProviders: [],
  sidebarFilterRepoIds: [],
  sidebarCollapsedGroups: [],
  worktreeCardProperties: [...DEFAULT_SETTINGS.worktreeCardProperties],
  statusBarItems: [...DEFAULT_SETTINGS.statusBarItems]
})

export const settings = reactive(fresh())

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// Merge saved values over the defaults, ignoring anything malformed.
export function loadSettings(saved) {
  if (!saved || typeof saved !== 'object') return
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = saved[key]
    if (key === 'hiddenUsageProviders') {
      settings.hiddenUsageProviders = validHiddenUsageProviders(v)
      continue
    }
    if (key === 'customAgents') {
      if (Array.isArray(v)) settings.customAgents = v.filter(validCustomAgent).slice(0, 30)
      continue
    }
    if (key === 'agentPrefs') {
      settings.agentPrefs = validAgentPrefs(v)
      continue
    }
    if (key === 'agentSessionOptions') {
      settings.agentSessionOptions = validSessionOptionSettings(v)
      continue
    }
    if (key === 'yoloFolders') {
      if (Array.isArray(v))
        settings.yoloFolders = [...new Set(v.filter((f) => typeof f === 'string' && f.trim() && f.length <= 1024).map((f) => f.trim()))].slice(0, 100)
      continue
    }
    if (key === 'agentPermissions' && !['manual', 'yolo'].includes(v)) continue
    if (key === 'keepAwake' && !['off', 'agents', 'on'].includes(v)) continue
    if (key === 'promptCacheTtlMs' && ![300000, 3600000].includes(v)) continue
    if (key === 'agentSleepMinutes' && !(Number.isInteger(v) && v >= 1 && v <= 1440)) continue
    if (key === 'orchestrationMaxWorkers' && !(Number.isInteger(v) && v >= 1 && v <= MAX_CONCURRENT_LIMIT)) continue
    if (key === 'orchestrationMaxDepth' && !(Number.isInteger(v) && v >= 1 && v <= NESTED_DEPTH_LIMIT)) continue
    if (key === 'orchestrationWorkerMode' && !['terminal', 'chat'].includes(v)) continue
    if (key === 'chatIdleMinutes' && !(Number.isInteger(v) && v >= 0 && v <= 1440)) continue
    if (
      key === 'editorAutoSaveDelayMs' &&
      !(Number.isInteger(v) && v >= EDITOR_AUTOSAVE_MIN_MS && v <= EDITOR_AUTOSAVE_MAX_MS)
    )
      continue
    if (key === 'quickCommands') {
      if (Array.isArray(v)) settings.quickCommands = v.filter(validQuickCommand).slice(0, 100)
      continue
    }
    if (key === 'sidebarFilterRepoIds' || key === 'sidebarCollapsedGroups') {
      const list = idList(v)
      if (list) settings[key] = list
      continue
    }
    if (key === 'worktreeCardProperties' || key === 'statusBarItems') {
      const known = key === 'statusBarItems' ? STATUS_BAR_ITEMS : WORKTREE_CARD_PROPERTIES
      const list = idList(v)
      if (list) settings[key] = list.filter((x) => known.includes(x))
      continue
    }
    if (key === 'sidebarGroupBy' && !['repo', 'none'].includes(v)) continue
    if (key === 'sidebarSortBy' && !SIDEBAR_SORTS.includes(v)) continue
    if (key === 'sidebarProjectOrderBy' && !['manual', 'recent'].includes(v)) continue
    if (key === 'agentActivityDisplayMode' && !['compact', 'full'].includes(v)) continue
    if (key === 'leftSidebarAppearanceMode' && !['default', 'match-terminal', 'tinted'].includes(v)) continue
    if (key === 'leftSidebarTintColor' && !(typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v))) continue
    if (key === 'leftSidebarTintOpacity') {
      if (typeof v === 'number' && Number.isFinite(v)) settings[key] = clamp(v, 0, MAX_LEFT_SIDEBAR_TINT_OPACITY)
      continue
    }
    if (key === 'minimumContrastRatio') {
      // null = automatic; a number is kept in xterm's range.
      if (v === null || v === undefined) settings.minimumContrastRatio = null
      else if (limitNumber(key, v) !== null) settings.minimumContrastRatio = limitNumber(key, v)
      continue
    }
    if (key === 'gpuAcceleration') {
      // Before Orca's 3 choices: gpuRendering on/off. Off stays off; on
      // (the old default) becomes Auto.
      if (GPU_MODES.includes(v)) settings.gpuAcceleration = v
      else if (saved.gpuRendering === false) settings.gpuAcceleration = 'off'
      continue
    }
    if (typeof v !== typeof def) continue
    if (key in LIMITS) {
      settings[key] = limitNumber(key, v) ?? def
      continue
    }
    if (key === 'theme' && !isTheme(v)) continue
    if (key === 'uiLanguage' && !UI_LANGUAGES.some((l) => l.value === v)) continue
    if (key === 'cursorStyle' && !['block', 'bar', 'underline'].includes(v)) continue
    if (key === 'alertSound' && !['none', 'chime', 'ping'].includes(v)) continue
    if (key === 'usagePercentageDisplay' && !['used', 'remaining'].includes(v)) continue
    if (key === 'usageRefreshMinutes' && !USAGE_REFRESH_MINUTES.includes(v)) continue
    if (key === 'sourceControlGroupOrder' && !SOURCE_CONTROL_GROUP_ORDERS.includes(v)) continue
    if (key === 'sourceControlViewMode' && !['tree', 'list'].includes(v)) continue
    if (key === 'branchPrefix' && !BRANCH_PREFIX_MODES.includes(v)) continue
    if (['editorFontFamily', 'wordSeparator', 'branchPrefixCustom'].includes(key) && v.length > 200) continue
    if (key === 'workspaceDir' && v.length > 1000) continue
    settings[key] = v
  }
  settings.fontSize = clamp(Math.round(settings.fontSize), 8, 28)
  settings.scrollback = clamp(Math.round(settings.scrollback), 500, 100000)
  settings.fontWeight = Math.round(settings.fontWeight)
  settings.fontWeightBold = Math.round(settings.fontWeightBold)
  settings.dividerThickness = Math.round(settings.dividerThickness)
  settings.notificationVolume = Math.round(settings.notificationVolume)
}

// Resets preferences; your custom agents and quick commands are kept.
export function resetSettings() {
  const keep = {
    customAgents: settings.customAgents,
    quickCommands: settings.quickCommands,
    agentPrefs: settings.agentPrefs,
    agentSessionOptions: settings.agentSessionOptions
  }
  Object.assign(settings, fresh(), keep)
}

// { [agent id]: { enabled?, command?, args?, env? } } from storage: only
// well-formed entries, strings trimmed to sane sizes.
export function validAgentPrefs(v) {
  const out = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [id, p] of Object.entries(v).slice(0, 100)) {
    if (!/^[\w.-]{1,60}$/.test(id) || !p || typeof p !== 'object') continue
    const e = {}
    if (typeof p.enabled === 'boolean') e.enabled = p.enabled
    for (const f of ['command', 'args']) if (typeof p[f] === 'string' && p[f].length <= 2000) e[f] = p[f]
    if (typeof p.env === 'string' && p.env.length <= 16384) e.env = p.env
    out[id] = e
  }
  return out
}

export function validQuickCommand(q) {
  return (
    q &&
    typeof q.id === 'string' &&
    typeof q.name === 'string' &&
    q.name.trim() &&
    typeof q.text === 'string' &&
    q.text.trim() &&
    q.text.length <= 20000 &&
    typeof q.enter === 'boolean'
  )
}

export function validCustomAgent(a) {
  return (
    a &&
    typeof a.id === 'string' &&
    typeof a.name === 'string' &&
    a.name.trim() &&
    typeof a.command === 'string' &&
    a.command.trim() &&
    (a.accent === undefined || typeof a.accent === 'string')
  )
}

export function fontStack(family) {
  return `"${family}", "Cascadia Mono", Consolas, "Courier New", monospace` // i18n-ignore
}

// The editor's font: its own when set (a CSS font list is taken as it is,
// a single name is quoted), else the terminal's.
export function editorFontStack(s) {
  const own = String(s.editorFontFamily || '').trim()
  if (!own) return fontStack(s.fontFamily)
  const first = own.includes(',') || /^["']/.test(own) ? own : `"${own.replace(/"/g, '')}"`
  return `${first}, "Cascadia Mono", Consolas, "Courier New", monospace` // i18n-ignore
}

export { clamp }
