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
import { t } from './i18n'
import { hookNode, hookCommand, pluginNodeSource } from './nodePath'
import { removeKimiHooks } from './kimiHooks'
export { installKimiHooks, KIMI_HOOK_EVENTS } from './kimiHooks'

export const SERVER_NAME = 'tessel-team'
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop']
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

const isOurs = (h) => h && typeof h === 'object' && String(h.command || '').includes(OURS)

// Claude Code hooks in ~/.claude/settings.json.
// -> { changed: bool } or { error }
// Every hook command runs an absolute node (nodePath.js), found at install
// time unless `node` is given; none found: nothing is installed.
export function installClaudeHooks(scriptPath, home = os.homedir(), { configDir = join(home, '.claude'), node } = {}) {
  const found = hookNode(scriptPath, node)
  if (found.error) return found
  return installHooks(join(configDir, 'settings.json'), HOOK_EVENTS, hookCommand(found.node, scriptPath, '--hook'))
}

// Codex hooks in ~/.codex/hooks.json (the same format; hooks are on by
// default since Codex 0.157). SessionStart and UserPromptSubmit report the
// conversation; Stop can continue once with unread team messages. Codex
// requires the updated hook definition to be reviewed/trusted in /hooks.
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop']
export function installCodexHooks(scriptPath, home = os.homedir(), { configDir = join(home, '.codex'), node } = {}) {
  const found = hookNode(scriptPath, node)
  if (found.error) return found
  const command = hookCommand(found.node, scriptPath, '--hook --codex')
  return installHooks(join(configDir, 'hooks.json'), CODEX_HOOK_EVENTS, command, { commandWindows: command })
}

// Gemini CLI hooks in ~/.gemini/settings.json (Claude Code's format and
// answers; on by default, no approval step for user hooks): the conversation
// (SessionStart), messages with each prompt (BeforeAgent) and after each tool
// (AfterTool), and at the turn's end (AfterAgent). The others only report its
// status: a tool starting (BeforeTool), a permission asked (Notification), the
// session's end.
export const GEMINI_HOOK_EVENTS = ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'Notification', 'SessionEnd']
export function installGeminiHooks(scriptPath, home = os.homedir(), { node } = {}) {
  const found = hookNode(scriptPath, node)
  if (found.error) return found
  return installHooks(join(home, '.gemini', 'settings.json'), GEMINI_HOOK_EVENTS, hookCommand(found.node, scriptPath, '--hook --gemini'))
}

// Copilot CLI hooks: Tessel's own file in ~/.copilot/hooks/ (its settings and
// the user's other hooks are never touched). Claude Code's event names, which
// Copilot accepts with Claude's answers: the conversation (SessionStart),
// messages after each tool (PostToolUse) and at the turn's end (Stop). Its
// prompt hook cannot add text: it, and the others, only report its status
// (working, waiting for you, its sub-agents). The event is named in the
// command. After Orca's src/main/copilot/copilot-managed-hook-definitions.ts,
// MIT, Copyright (c) 2026 Lovecast Inc.
export const COPILOT_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'ErrorOccurred', 'subagentStart', 'SubagentStop', 'Stop', 'SessionEnd']
export const COPILOT_HOOKS_FILE = 'tessel-team.json'
export function installCopilotHooks(scriptPath, home = os.homedir(), { node } = {}) {
  const found = hookNode(scriptPath, node)
  if (found.error) return found
  const file = join(home, '.copilot', 'hooks', COPILOT_HOOKS_FILE)
  const hooks = {}
  for (const event of COPILOT_HOOK_EVENTS) {
    const command = hookCommand(found.node, scriptPath, `--hook --copilot --event=${event}`)
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
// pane (no TESSEL_PANE_ID) nor in a chat pane (TESSEL_CHAT=1). It runs the same hook script (node, --opencode):
// the conversation (session events), messages added to a tool's result, and,
// when the session is idle (just finished, or waiting), a reminder sent to it
// as a new message through its own API: an idle OpenCode is woken without
// anything typed into its terminal, and reads its messages with team_inbox.
export const OPENCODE_PLUGIN_FILE = 'tessel-team.js'
export const OPENCODE_MARKER = '// Tessel team tools: OpenCode plugin'
export function opencodePlugin(scriptPath, node) {
  return `${OPENCODE_MARKER}. Written by Tessel and replaced when it updates; delete it to remove.
import { spawn, spawnSync } from 'node:child_process'

const SCRIPT = ${JSON.stringify(scriptPath)}
// Never "node" by name: run from the project folder, it could be a node.exe
// planted there.
const NODE = ${pluginNodeSource(node)}
const IDLE_CHECK_MS = 15000

export const TesselTeam = async ({ client, directory }) => {
  // Outside a Tessel pane, and in a chat pane's OpenCode (TESSEL_CHAT=1: the
  // chat manager reports its state and delivers team messages itself).
  if (!process.env.TESSEL_PANE_ID || process.env.TESSEL_CHAT === '1') return {}
  const hook = (event, sessionId) => {
    try {
      const r = spawnSync(NODE, [SCRIPT, '--hook', '--opencode'], {
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
  // Its status (working, waiting for you, done), for Tessel's pane: sent in
  // order, one at a time, never waited for by OpenCode. After Orca's
  // src/main/opencode/status-plugin-lifecycle-source.ts, MIT, Copyright (c)
  // 2026 Lovecast Inc.
  const statusQueue = []
  let statusRunning = false
  const nextStatus = () => {
    const input = statusQueue.shift()
    if (!input) {
      statusRunning = false
      return
    }
    statusRunning = true
    try {
      const child = spawn(NODE, [SCRIPT, '--hook', '--opencode', '--status'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      const timer = setTimeout(() => child.kill(), 20000)
      child.on('error', () => {})
      child.on('close', () => {
        clearTimeout(timer)
        nextStatus()
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    } catch {
      nextStatus()
    }
  }
  // Each event a later time than the one before: Tessel applies them in that order.
  let lastAt = 0
  const status = (event, sessionId, extra) => {
    if (!sessionId) return
    lastAt = Math.max(Date.now(), lastAt + 1)
    if (statusQueue.length >= 50) statusQueue.shift()
    statusQueue.push(JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd: directory, tessel_at: lastAt, ...(extra || {}) }))
    if (!statusRunning) nextStatus()
  }
  let current = null // the session this OpenCode works in
  let idle = false
  let busy = false // its status as last reported
  let sending = false
  let reminded = { count: 0, at: 0 }
  const asked = new Map() // a permission or question waiting -> its session
  // While the session is idle, messages waiting: a reminder is sent to it as a
  // new message, and the agent reads them with team_inbox. Nothing is read
  // here, so a failed send or OpenCode restarting never loses one. Again only
  // for more messages, or 5 minutes later.
  const deliver = async () => {
    if (!current || !idle || sending) return
    sending = true
    try {
      const out = hook('Peek', current)
      const n = (out && out.unread) || 0
      if (!n) {
        reminded = { count: 0, at: 0 }
        return
      }
      if (n <= reminded.count && Date.now() - reminded.at < 5 * 60 * 1000) return
      const text = '[Tessel] You have ' + n + ' new team message' + (n > 1 ? 's' : '') + ': read ' + (n > 1 ? 'them' : 'it') + ' with team_inbox.'
      const req = { path: { id: current }, body: { parts: [{ type: 'text', text }] } }
      // promptAsync answers once OpenCode has taken it; prompt (older
      // versions) waits for the whole reply.
      const r = client.session.promptAsync ? await client.session.promptAsync(req) : await client.session.prompt(req)
      if (r && r.error) return
      reminded = { count: n, at: Date.now() }
      idle = false
    } catch {
      // tried again at the next check
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
          busy = false
          // Also its status: the session opened.
          hook('SessionStart', id)
        }
      } else if (event.type === 'session.status') {
        if (id !== current) return
        const type = p.status && p.status.type
        idle = type === 'idle'
        if ((type === 'busy' || type === 'retry') && !busy) {
          busy = true
          status('UserPromptSubmit', id)
        } else if (type === 'idle' && busy) {
          busy = false
          status('Stop', id)
        }
      } else if (event.type === 'session.idle') {
        if (!id || (current && id !== current)) return
        current = id
        idle = true
        if (busy) {
          busy = false
          status('Stop', id)
        }
        await deliver()
      } else if (event.type === 'permission.asked' || event.type === 'permission.updated' || event.type === 'question.asked') {
        // Asked by this session or one of its sub-agents: the pane waits.
        const request = p.id || p.requestID || p.permissionID
        if (!current || !request || asked.has(request)) return
        asked.set(request, current)
        status('Elicitation', current, { tool_use_id: String(request) })
      } else if (event.type === 'permission.replied' || event.type === 'question.replied' || event.type === 'question.rejected') {
        const request = p.id || p.requestID || p.permissionID
        const owner = request && asked.get(request)
        if (!owner) return
        asked.delete(request)
        status('ElicitationResult', owner, { tool_use_id: String(request) })
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
export function installOpencodePlugin(scriptPath, home = os.homedir(), { node } = {}) {
  const found = hookNode(scriptPath, node)
  if (found.error) return found
  const file = join(home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE)
  const text = opencodePlugin(scriptPath, found.node)
  try {
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8')
      if (old === text) return { changed: false }
      if (!old.startsWith(OPENCODE_MARKER)) return { error: t('main.hooks.notTessels', "{{file}} is not Tessel's, so it was left alone.", { file }) }
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
    return { error: t('main.hooks.unreadable', '{{file}} could not be read, so Tessel did not change it.', { file }) }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  let changed = false
  for (const event of events) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : []
    const matches = (h) => h && h.type === 'command' && h.command === command && Object.entries(extra).every(([key, value]) => h[key] === value)
    const already = list.some((g) => g && [undefined, '', '*'].includes(g.matcher) && Array.isArray(g.hooks) && g.hooks.some(matches))
    const stale = list.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h) && !matches(h)))
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

// Tessel's entries out of a hooks file ({ hooks: { Event: [{ hooks: [...] }] } }):
// only its own handlers; the user's, and their groups, stay. The copy Tessel
// kept of the file (<file>.before-tessel) goes once its hooks are gone.
// -> { changed } or { error }
function removeHooksFrom(file) {
  const backup = `${file}.before-tessel`
  const dropBackup = () => {
    try {
      fs.rmSync(backup, { force: true })
    } catch {
      // harmless, shown in Settings
    }
  }
  if (!fs.existsSync(file)) {
    dropBackup()
    return { changed: false }
  }
  const settings = readJson(file)
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return { error: t('main.hooks.unreadable', '{{file}} could not be read, so Tessel did not change it.', { file }) }
  const hooks = settings.hooks
  let changed = false
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    for (const event of Object.keys(hooks)) {
      const list = hooks[event]
      if (!Array.isArray(list)) continue
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
      if (kept.length === list.length && kept.every((g, i) => g === list[i])) continue
      changed = true
      if (kept.length) hooks[event] = kept
      else delete hooks[event]
    }
  }
  if (changed) writeAtomic(file, JSON.stringify(settings, null, 2) + '\n')
  dropBackup()
  return { changed }
}

// Tessel's own file, when it is still Tessel's. -> { changed } or { error }
function removeOwnFile(file, isTessels) {
  try {
    if (!fs.existsSync(file)) return { changed: false }
    if (!isTessels(fs.readFileSync(file, 'utf8'))) return { changed: false }
    fs.rmSync(file, { force: true })
    return { changed: true }
  } catch (err) {
    return { error: `${file}: ${err.message}` }
  }
}

// Settings > "Remove Tessel hooks": Tessel's team hooks out of every agent
// (Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode, Kimi Code). Its MCP
// servers stay (Settings > MCP removes them). Tessel adds its hooks back the
// next time it sets up the team tools or starts one of these agents.
// -> { changed: [file], errors: [message] }
export async function removeTeamHooks(home = os.homedir(), { configDirs = {}, kimiHome = process.env.KIMI_CODE_HOME } = {}) {
  const changed = []
  const errors = []
  const note = (file, r) => {
    if (r.error) errors.push(r.error)
    else if (r.changed) changed.push(file)
  }
  for (const file of [
    join(configDirs.claude || join(home, '.claude'), 'settings.json'),
    join(configDirs.codex || join(home, '.codex'), 'hooks.json'),
    join(home, '.gemini', 'settings.json')
  ]) {
    try {
      note(file, removeHooksFrom(file))
    } catch (err) {
      errors.push(`${file}: ${err.message}`)
    }
  }
  const copilot = join(home, '.copilot', 'hooks', COPILOT_HOOKS_FILE)
  note(copilot, removeOwnFile(copilot, (text) => text.includes(OURS)))
  const opencode = join(home, '.config', 'opencode', 'plugins', OPENCODE_PLUGIN_FILE)
  note(opencode, removeOwnFile(opencode, (text) => text.startsWith(OPENCODE_MARKER)))
  const kimi = await removeKimiHooks(home, { kimiHome })
  if (kimi.error) errors.push(kimi.error)
  else if (kimi.changed) changed.push(kimi.file)
  return { changed, errors }
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

export function codexTable(scriptPath, node) {
  return (
    `[mcp_servers.${SERVER_NAME}]\n` +
    `command = '${node}'\n` +
    `args = ['${scriptPath}']\n` +
    `env_vars = ["TESSEL_PANE_ID", "TESSEL_PROJECT_DIR", "TESSEL_TEAM_SECRET"]\n` +
    // Only the team tools run without asking (they read and send team
    // messages); every other tool and command keeps Codex's own approvals.
    `default_tools_approval_mode = "approve"\n`
  )
}

// Codex: [mcp_servers.tessel-team] in ~/.codex/config.toml. The new file is
// checked with Codex itself (`validate(text)` -> { ok, error }) before it
// replaces the old one.
// -> { changed: bool } or { error }
export async function installCodexServer(scriptPath, validate, home = os.homedir(), { node } = {}) {
  const dir = join(home, '.codex')
  if (!fs.existsSync(dir)) return { changed: false } // Codex not set up here
  const found = hookNode(scriptPath, node)
  if (found.error) return found
  const file = join(dir, 'config.toml')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  // TOML literal strings ('...') keep Windows backslashes as they are.
  if (scriptPath.includes("'") || found.node.includes("'")) return { error: t('main.hooks.quoteInPath', 'The Tessel data folder has a quote in its path.') }
  const { kept, ours } = splitCodexConfig(text)
  const want = codexTable(scriptPath, found.node)
  if (ours.trim() === want.trim()) return { changed: false }
  const next = kept.replace(/\s*$/, '\n') + '\n' + want
  if (validate) {
    const v = await validate(next)
    if (!v || !v.ok) return { error: v && v.error ? t('main.hooks.codexRejectedWhy', 'Codex would not accept the new settings, so Tessel left them as they were ({{error}}).', { error: v.error }) : t('main.hooks.codexRejected', 'Codex would not accept the new settings, so Tessel left them as they were.') }
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

// ... with this script, run by this node (an older bare "node" is replaced).
export function claudeServerPresent(scriptPath, home = os.homedir(), node) {
  const cfg = readJson(join(home, '.claude.json'))
  const s = cfg && cfg.mcpServers && cfg.mcpServers[SERVER_NAME]
  return !!(s && Array.isArray(s.args) && s.args.includes(scriptPath) && (node === undefined || s.command === node))
}
