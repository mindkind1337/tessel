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
  quickCommands: []
})

const fresh = () => ({ ...DEFAULT_SETTINGS, customAgents: [], quickCommands: [] })

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
    if (key === 'quickCommands') {
      if (Array.isArray(v)) settings.quickCommands = v.filter(validQuickCommand).slice(0, 100)
      continue
    }
    if (typeof v !== typeof def) continue
    if (key === 'theme' && !isTheme(v)) continue
    if (key === 'cursorStyle' && !['block', 'bar', 'underline'].includes(v)) continue
    settings[key] = v
  }
  settings.fontSize = clamp(Math.round(settings.fontSize), 8, 28)
  settings.scrollback = clamp(Math.round(settings.scrollback), 500, 100000)
}

// Resets preferences; your custom agents and quick commands are kept.
export function resetSettings() {
  const keep = { customAgents: settings.customAgents, quickCommands: settings.quickCommands }
  Object.assign(settings, fresh(), keep)
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
