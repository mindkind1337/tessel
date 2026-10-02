// Set up the Tessel team tools (teamMcp/server.cjs) for the agent CLIs, so
// teammates message each other in the background (never typed into a
// terminal):
//   - the server script, copied to Tessel's data folder;
//   - Claude Code: an MCP server "tessel-team" (user scope) and hooks that
//     show new team messages as context (UserPromptSubmit, PostToolUse, Stop);
//   - Codex: the same MCP server in ~/.codex/config.toml, forwarding the
//     pane's TESSEL_* variables.
// Each step is skipped when already done. Only Tessel's own entries are
// added, updated or removed; everything else is left as it is.
import fs from 'fs'
import os from 'os'
import { join } from 'path'

export const SERVER_NAME = 'tessel-team'
const HOOK_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'Stop']
const OURS = 'tessel-team-mcp.cjs'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tessel-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

// Write the server script where agents can run it. -> its path
export function writeServerScript(dataDir, source) {
  const file = join(dataDir, OURS)
  let old = null
  try {
    old = fs.readFileSync(file, 'utf8')
  } catch {
    // first time
  }
  if (old !== source) writeAtomic(file, source)
  return file
}

const quote = (p) => `"${p}"`
const isOurs = (h) => h && typeof h === 'object' && String(h.command || '').includes(OURS)

// Claude Code hooks in ~/.claude/settings.json.
// -> { changed: bool } or { error }
export function installClaudeHooks(scriptPath, home = os.homedir()) {
  const dir = join(home, '.claude')
  const file = join(dir, 'settings.json')
  const exists = fs.existsSync(file)
  const settings = exists ? readJson(file) : {}
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    return { error: `${file} could not be read, so Tessel did not change it.` }
  const command = `node ${quote(scriptPath)} --hook`
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  let changed = false
  for (const event of HOOK_EVENTS) {
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
    kept.push({ matcher: '', hooks: [{ type: 'command', command }] })
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
export function claudeServerPresent(scriptPath, home = os.homedir()) {
  const cfg = readJson(join(home, '.claude.json'))
  const s = cfg && cfg.mcpServers && cfg.mcpServers[SERVER_NAME]
  return !!(s && Array.isArray(s.args) && s.args.includes(scriptPath))
}
