// Set up the Tessel team tools (teamMcp/server.cjs) for the agent CLIs, so
// teammates message each other in the background (never typed into a
// terminal):
//   - the server script, copied to a folder shared by every Tessel build
//     (%APPDATA%\tessel-team): the dev build and the installed app point
//     the agents to the same file, so they never rewrite each other's
//     settings; the file is only replaced by a newer version;
//   - Claude Code: an MCP server "tessel-team" (user scope) and hooks that
//     show new team messages as context (UserPromptSubmit, PostToolUse, Stop);
//   - Codex: the same MCP server in ~/.codex/config.toml, forwarding the
//     pane's TESSEL_* variables.
// Each step is skipped when already done. Only Tessel's own entries are
// added, updated or removed; everything else is left as it is.
import fs from 'fs'
import os from 'os'
import { join, dirname } from 'path'
import { readJson } from './fileRead'
import { writeFileAtomic as writeAtomic } from './safeJson'

export const SERVER_NAME = 'tessel-team'
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']
const OURS = 'tessel-team-mcp.cjs'

// The server's VERSION ('1.4.0' -> [1, 4, 0]), or null.
export function scriptVersion(source) {
  const m = /const VERSION = '(\d+)\.(\d+)\.(\d+)'/.exec(String(source || ''))
  return m ? m.slice(1).map(Number) : null
}

function older(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

// Write the server script where agents can run it, in the shared folder:
// only when missing, unreadable or older (another build with a newer version
// keeps its own). -> its path
export function writeServerScript(sharedDir, source) {
  fs.mkdirSync(sharedDir, { recursive: true })
  const file = join(sharedDir, OURS)
  let old = null
  try {
    old = fs.readFileSync(file, 'utf8')
  } catch {
    // first time
  }
  const have = scriptVersion(old)
  const mine = scriptVersion(source)
  if (old !== source && (!have || !mine || older(have, mine))) writeAtomic(file, source)
  return file
}

const quote = (p) => `"${p}"`
const isOurs = (h) => h && typeof h === 'object' && String(h.command || '').includes(OURS)

// Claude Code hooks in ~/.claude/settings.json.
// -> { changed: bool } or { error }
export function installClaudeHooks(scriptPath, home = os.homedir()) {
  return installHooks(join(home, '.claude', 'settings.json'), HOOK_EVENTS, `node ${quote(scriptPath)} --hook`)
}

// Codex hooks in ~/.codex/hooks.json (the same format; hooks are on by
// default since Codex 0.157). SessionStart and UserPromptSubmit report the
// conversation; Stop can continue once with unread team messages. Codex
// requires the updated hook definition to be reviewed/trusted in /hooks.
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop']
export function installCodexHooks(scriptPath, home = os.homedir()) {
  const command = `node ${quote(scriptPath)} --hook --codex`
  return installHooks(join(home, '.codex', 'hooks.json'), CODEX_HOOK_EVENTS, command, { commandWindows: command })
}

// Gemini CLI hooks in ~/.gemini/settings.json (Claude Code's format and
// answers; on by default, no approval step for user hooks): the conversation
// (SessionStart), messages with each prompt (BeforeAgent) and after each tool
// (AfterTool), and at the turn's end (AfterAgent).
export const GEMINI_HOOK_EVENTS = ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent']
export function installGeminiHooks(scriptPath, home = os.homedir()) {
  return installHooks(join(home, '.gemini', 'settings.json'), GEMINI_HOOK_EVENTS, `node ${quote(scriptPath)} --hook --gemini`)
}

// Copilot CLI hooks: Tessel's own file in ~/.copilot/hooks/ (its settings and
// the user's other hooks are never touched). Claude Code's event names, which
// Copilot accepts with Claude's answers: the conversation (SessionStart),
// messages after each tool (PostToolUse) and at the turn's end (Stop). Not its
// prompt hook: it cannot add text there. The event is named in the command.
export const COPILOT_HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'Stop']
export const COPILOT_HOOKS_FILE = 'tessel-team.json'
export function installCopilotHooks(scriptPath, home = os.homedir()) {
  const file = join(home, '.copilot', 'hooks', COPILOT_HOOKS_FILE)
  const hooks = {}
  for (const event of COPILOT_HOOK_EVENTS) {
    const command = `node ${quote(scriptPath)} --hook --copilot --event=${event}`
    hooks[event] = [{ type: 'command', bash: command, powershell: command, timeoutSec: 30 }]
  }
  const text = JSON.stringify({ version: 1, hooks }, null, 2) + '\n'
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return { changed: false }
    fs.mkdirSync(dirname(file), { recursive: true })
    writeAtomic(file, text)
    return { changed: true }
  } catch (err) {
    return { error: `${file}: ${err.message}` }
  }
}

// Tessel's command in each event's hook list of a hooks file ({ hooks: {
// Event: [{ matcher, hooks: [{ type, command }] }] } }), replacing an older
// Tessel entry and keeping everything else. -> { changed } or { error }
function installHooks(file, events, command, extra = {}) {
  const dir = dirname(file)
  const exists = fs.existsSync(file)
  const settings = exists ? readJson(file) : {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return { error: `${file} could not be read, so Tessel did not change it.` }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  let changed = false
  for (const event of events) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    const already = list.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command))
    const stale = list.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h) && h.command !== command))
    if (already && !stale) continue
    // Only Tessel's own hook entries are removed (an older path); the other
    // hooks of a group, and the group itself, stay.
    const kept = []
    for (const g of list) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g)
        continue
      }
      const others = g.hooks.filter((h) => !isOurs(h))
      if (others.length === g.hooks.length) kept.push(g)
      else if (others.length) kept.push({ ...g, hooks: others })
    }
    kept.push({ matcher: '', hooks: [{ type: 'command', command, ...extra }] })
    hooks[event] = kept
    changed = true
  }
  if (!changed) return { changed: false }
  settings.hooks = hooks
  fs.mkdirSync(dir, { recursive: true })
  if (exists && !fs.existsSync(`${file}.before-tessel`)) fs.copyFileSync(file, `${file}.before-tessel`)
  writeAtomic(file, JSON.stringify(settings, null, 2) + '\n')
  return { changed: true }
}

// The lines of Tessel's own table in a Codex config.toml (any spelling of the
// key, with its sub-tables), or null.
const OUR_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:tessel-team|"tessel-team"|'tessel-team')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_HEADER = /^\s*\[/
export function splitCodexConfig(text) {
  const lines = String(text || '').split(/\r?\n/)
  const kept = []
  const ours = []
  let inOurs = false
  for (const line of lines) {
    if (ANY_HEADER.test(line)) inOurs = OUR_HEADER.test(line)
    ;(inOurs ? ours : kept).push(line)
  }
  return { kept: kept.join('\n'), ours: ours.join('\n') }
}

export function codexTable(scriptPath) {
  return (
    `[mcp_servers.${SERVER_NAME}]\n` +
    `command = 'node'\n` +
    `args = ['${scriptPath}']\n` +
    `env_vars = ["TESSEL_PANE_ID", "TESSEL_PROJECT_DIR"]\n` +
    // Only the team tools run without asking (they read and send team
    // messages); every other tool and command keeps Codex's own approvals.
    `default_tools_approval_mode = "approve"\n`
  )
}

// Codex: [mcp_servers.tessel-team] in ~/.codex/config.toml. The new file is
// checked with Codex itself (`validate(text)` -> { ok, error }) before it
// replaces the old one.
// -> { changed: bool } or { error }
export async function installCodexServer(scriptPath, validate, home = os.homedir()) {
  const dir = join(home, '.codex')
  if (!fs.existsSync(dir)) return { changed: false } // Codex not set up here
  const file = join(dir, 'config.toml')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  // TOML literal strings ('...') keep Windows backslashes as they are.
  if (scriptPath.includes("'")) return { error: 'The Tessel data folder has a quote in its path.' }
  const { kept, ours } = splitCodexConfig(text)
  const want = codexTable(scriptPath)
  if (ours.trim() === want.trim()) return { changed: false }
  const next = kept.replace(/\s*$/, '\n') + '\n' + want
  if (validate) {
    const v = await validate(next)
    if (!v || !v.ok) return { error: `Codex would not accept the new settings, so Tessel left them as they were${v && v.error ? ` (${v.error})` : ''}.` }
  }
  if (text && !fs.existsSync(`${file}.before-tessel`)) fs.copyFileSync(file, `${file}.before-tessel`)
  writeAtomic(file, next)
  return { changed: true }
}

// Claude Code's MCP server (user scope), from ~/.claude.json. -> true when
// it is already there with this script.
// A "tessel-team" server is registered for Claude Code (any script path).
export function claudeServerExists(home = os.homedir()) {
  const cfg = readJson(join(home, '.claude.json'))
  return !!(cfg && cfg.mcpServers && cfg.mcpServers[SERVER_NAME])
}

export function claudeServerPresent(scriptPath, home = os.homedir()) {
  const cfg = readJson(join(home, '.claude.json'))
  const s = cfg && cfg.mcpServers && cfg.mcpServers[SERVER_NAME]
  return !!(s && Array.isArray(s.args) && s.args.includes(scriptPath))
}
