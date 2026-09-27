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

// OpenCode: a plugin (it has no command hooks), ~/.config/opencode/plugins/
// tessel-team.js, loaded by every OpenCode; it does nothing outside a Tessel
// pane (no TESSEL_PANE_ID). It runs the same hook script (node, --opencode):
// the conversation (session events), messages added to a tool's result, and,
// when the session is idle (just finished, or waiting), the messages sent to
// it as a new message through its own API: an idle OpenCode is woken without
// anything typed into its terminal.
export const OPENCODE_PLUGIN_FILE = 'tessel-team.js'
export const OPENCODE_MARKER = '// Tessel team tools: OpenCode plugin'
export function opencodePlugin(scriptPath) {
  return `${OPENCODE_MARKER}. Written by Tessel and replaced when it updates; delete it to remove.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = ${JSON.stringify(scriptPath)}
const IDLE_CHECK_MS = 15000

export const TesselTeam = async ({ client, directory }) => {
  if (!process.env.TESSEL_PANE_ID) return {}
  const hook = (event, sessionId) => {
    try {
      const r = spawnSync('node', [SCRIPT, '--hook', '--opencode'], {
        input: JSON.stringify({ hook_event_name: event, session_id: sessionId || '', cwd: directory, stop_hook_active: false }),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000
      })
      return r.stdout ? JSON.parse(r.stdout) : null
    } catch {
      return null
    }
  }
  let current = null // the session this OpenCode works in
  let idle = false
  let sending = false
  // Messages already claimed (read) but not yet handed to OpenCode: kept
  // until a send succeeds, also on disk (per pane), so neither a failed send
  // nor OpenCode restarting meanwhile loses them.
  const keep = join(tmpdir(), 'tessel-opencode-' + process.env.TESSEL_PANE_ID.replace(/[^A-Za-z0-9._-]/g, '_') + '.txt')
  let pending = null
  try {
    pending = readFileSync(keep, 'utf8') || null
  } catch {}
  const hold = (text) => {
    pending = text
    try {
      if (text) writeFileSync(keep, text)
      else rmSync(keep, { force: true })
    } catch {}
  }
  // Waiting messages, sent as a new message while the session is idle.
  const deliver = async () => {
    if (!current || !idle || sending) return
    sending = true
    try {
      if (!pending) {
        const out = hook('Stop', current)
        if (out && out.decision === 'block' && out.reason) hold(out.reason)
      }
      if (pending) {
        idle = false
        // promptAsync answers once OpenCode has taken the message (a failure
        // then means it was not taken: safe to send again); prompt, in older
        // versions, waits for the whole reply.
        const req = { path: { id: current }, body: { parts: [{ type: 'text', text: pending }] } }
        const r = client.session.promptAsync ? await client.session.promptAsync(req) : await client.session.prompt(req)
        if (r && r.error) throw new Error('not taken')
        hold(null)
      }
    } catch {
      idle = true // not sent: the next check sends the same messages again
    } finally {
      sending = false
    }
  }
  const timer = setInterval(deliver, IDLE_CHECK_MS)
  if (timer.unref) timer.unref()
  return {
    event: async ({ event }) => {
      const p = (event && event.properties) || {}
      const id = p.sessionID || (p.info && p.info.id) || null
      if (event.type === 'session.created' || event.type === 'session.updated') {
        if (id && (!p.info || !p.info.parentID) && id !== current) {
          current = id
          hook('SessionStart', id)
        }
      } else if (event.type === 'session.status') {
        if (id === current) idle = !!(p.status && p.status.type === 'idle')
      } else if (event.type === 'session.idle') {
        if (!id || (current && id !== current)) return
        current = id
        idle = true
        await deliver()
      }
    },
    'tool.execute.after': async (input, output) => {
      if (!output || typeof output.output !== 'string') return
      const out = hook('PostToolUse', (input && input.sessionID) || current)
      const note = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext
      if (note) output.output += '\\n\\n' + note
    }
  }
}
`
}
export function installOpencodePlugin(scriptPath, home = os.homedir()) {
  const file = join(home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE)
  const text = opencodePlugin(scriptPath)
  try {
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8')
      if (old === text) return { changed: false }
      if (!old.startsWith(OPENCODE_MARKER)) return { error: `${file} is not Tessel's, so it was left alone.` }
    }
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
