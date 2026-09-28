// User preferences. One reactive object shared by the settings dialog, App and
// every TerminalPane; App persists it with the workspace layout.
import { reactive } from 'vue'
import { isTheme } from './themes'

export const FONT_FAMILIES = [
  'Cascadia Mono',
  'Cascadia Code',
  'Consolas',
  'JetBrains Mono',
  'Fira Code',
  'Courier New'
]

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'classic',
  fontSize: 13,
  fontFamily: 'Cascadia Mono',
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
  restoreWorkspaces: true,
  resumeAgents: true,
  // Draw terminals with the graphics card (WebGL). Off = plain renderer.
  gpuRendering: true,
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
  // The agent a new pane starts (Ctrl+Shift+T): '' = the default shell.
  defaultAgent: '',
  // 'manual' (agents ask before acting) or 'yolo' (each agent's own
  // skip-approvals flag, unless you set its arguments yourself).
  agentPermissions: 'manual',
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
  diffSideBySide: false
})

export const EDITOR_AUTOSAVE_MIN_MS = 250
export const EDITOR_AUTOSAVE_MAX_MS = 10000

const fresh = () => ({ ...DEFAULT_SETTINGS, customAgents: [], quickCommands: [], agentPrefs: {} })

export const settings = reactive(fresh())

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// Merge saved values over the defaults, ignoring anything malformed.
export function loadSettings(saved) {
  if (!saved || typeof saved !== 'object') return
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = saved[key]
    if (key === 'customAgents') {
      if (Array.isArray(v)) settings.customAgents = v.filter(validCustomAgent).slice(0, 30)
      continue
    }
    if (key === 'agentPrefs') {
      settings.agentPrefs = validAgentPrefs(v)
      continue
    }
    if (key === 'agentPermissions' && !['manual', 'yolo'].includes(v)) continue
    if (key === 'keepAwake' && !['off', 'agents', 'on'].includes(v)) continue
    if (key === 'promptCacheTtlMs' && ![300000, 3600000].includes(v)) continue
    if (key === 'agentSleepMinutes' && !(Number.isInteger(v) && v >= 1 && v <= 1440)) continue
    if (
      key === 'editorAutoSaveDelayMs' &&
      !(Number.isInteger(v) && v >= EDITOR_AUTOSAVE_MIN_MS && v <= EDITOR_AUTOSAVE_MAX_MS)
    )
      continue
    if (key === 'quickCommands') {
      if (Array.isArray(v)) settings.quickCommands = v.filter(validQuickCommand).slice(0, 100)
      continue
    }
    if (typeof v !== typeof def) continue
    if (key === 'theme' && !isTheme(v)) continue
    if (key === 'cursorStyle' && !['block', 'bar', 'underline'].includes(v)) continue
    if (key === 'alertSound' && !['none', 'chime', 'ping'].includes(v)) continue
    settings[key] = v
  }
  settings.fontSize = clamp(Math.round(settings.fontSize), 8, 28)
  settings.scrollback = clamp(Math.round(settings.scrollback), 500, 100000)
}

// Resets preferences; your custom agents and quick commands are kept.
export function resetSettings() {
  const keep = { customAgents: settings.customAgents, quickCommands: settings.quickCommands, agentPrefs: settings.agentPrefs }
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
  return `"${family}", "Cascadia Mono", Consolas, "Courier New", monospace`
}

export { clamp }
