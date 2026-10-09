// MCP servers of the agent CLIs that keep them in a JSON settings file
// (Claude Code and Codex have their own commands, see agentTools.js):
//   Gemini CLI   ~/.gemini/settings.json         "mcpServers": { name: { command, args, env | httpUrl/url, headers, trust } }
//   Qwen Code    ~/.qwen/settings.json           same format (a Gemini CLI fork)
//   Copilot CLI  ~/.copilot/mcp-config.json      "mcpServers": { name: { type: local|http, command, args, env, tools | url, headers } }
//   OpenCode     ~/.config/opencode/opencode.json "mcp": { name: { type: local, command: [..], environment | type: remote, url, headers } }
//   Cline        ~/.cline/data/settings/cline_mcp_settings.json "mcpServers": { name: { command, args, env | type: streamableHttp, url, headers } }
//   Kimi Code    ~/.kimi-code/mcp.json           "mcpServers": { name: { command, args, env | transport: http|sse, url, headers } }
//   Cursor CLI   ~/.cursor/mcp.json              "mcpServers": { name: { command, args, env | url, headers } }
// HTTP servers are streamable HTTP unless `sse` is set (an SSE endpoint):
// Gemini/Qwen httpUrl vs url, Copilot/Cline/Kimi their type, OpenCode and
// Cursor find out by themselves.
// Only the server entries are read or changed; everything else in the file is
// kept as it is. A file that cannot be read as JSON (comments in a .jsonc,
// say) is never rewritten: the change is refused with a clear error.
import fs from 'fs'
import os from 'os'
import { join, dirname } from 'path'
import { writeFileAtomic } from './safeJson'
import { t } from './i18n'
import { findNode } from './nodePath'

export const JSON_AGENTS = ['gemini', 'qwen', 'copilot', 'opencode', 'cline', 'kimi', 'cursor']

function settingsFile(agent, home = os.homedir()) {
  if (agent === 'gemini') return join(home, '.gemini', 'settings.json')
  if (agent === 'qwen') return join(home, '.qwen', 'settings.json')
  if (agent === 'copilot') return join(home, '.copilot', 'mcp-config.json')
  if (agent === 'cursor') return join(home, '.cursor', 'mcp.json')
  if (agent === 'kimi') return join(process.env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'mcp.json')
  if (agent === 'cline') {
    // Cline's own overrides first (CLINE_MCP_SETTINGS_PATH, CLINE_DATA_DIR, CLINE_DIR).
    const env = process.env
    if (env.CLINE_MCP_SETTINGS_PATH && env.CLINE_MCP_SETTINGS_PATH.trim()) return env.CLINE_MCP_SETTINGS_PATH.trim()
    return join(clineDataDir(home), 'settings', 'cline_mcp_settings.json')
  }
  if (agent === 'opencode') {
    const dir = join(home, '.config', 'opencode')
    const jsonc = join(dir, 'opencode.jsonc')
    return fs.existsSync(join(dir, 'opencode.json')) || !fs.existsSync(jsonc) ? join(dir, 'opencode.json') : jsonc
  }
  return null
}

// Cline's data folder (settings, sessions): ~/.cline/data unless moved.
export function clineDataDir(home = os.homedir()) {
  const env = process.env
  if (env.CLINE_DATA_DIR && env.CLINE_DATA_DIR.trim()) return env.CLINE_DATA_DIR.trim()
  const dir = env.CLINE_DIR && env.CLINE_DIR.trim() ? env.CLINE_DIR.trim() : join(home, '.cline')
  return join(dir, 'data')
}

const KEY = { gemini: 'mcpServers', qwen: 'mcpServers', copilot: 'mcpServers', opencode: 'mcp', cline: 'mcpServers', kimi: 'mcpServers', cursor: 'mcpServers' }

// -> { data } (null data: no file yet) or { error }
function readSettings(file) {
  if (!fs.existsSync(file)) return { data: null }
  let text
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch (err) {
    return { error: t('main.jsonAgents.readFailed', 'Could not read {{file}}: {{error}}', { file, error: err.message }) }
  }
  if (!text.trim()) return { data: null }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: t('main.jsonAgents.notObject', '{{file}} is not a settings object.', { file }) }
    return { data }
  } catch {
    return { error: t('main.jsonAgents.notPlainJson', '{{file}} has comments or is not plain JSON: Tessel does not rewrite it. Edit it by hand.', { file }) }
  }
}

function writeSettings(file, data) {
  fs.mkdirSync(dirname(file), { recursive: true })
  // The previous version is kept next to it, in case.
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.tessel-bak`)
  } catch {
    // no copy this time
  }
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n')
}

// One agent entry -> { transport: 'stdio'|'http', command, args, env, url, headers }
export function entryToConfig(agent, e = {}) {
  if (!e || typeof e !== 'object') return null
  if (agent === 'opencode') {
    if (e.type === 'remote' || e.url) return { transport: 'http', sse: false, url: e.url || '', headers: { ...(e.headers || {}) } }
    const cmd = Array.isArray(e.command) ? e.command.map(String) : e.command ? [String(e.command)] : []
    return { transport: 'stdio', command: cmd[0] || '', args: cmd.slice(1), env: { ...(e.environment || {}) } }
  }
  const url = e.httpUrl || e.url
  if (url || ['http', 'sse', 'streamableHttp'].includes(e.type) || ['http', 'sse'].includes(e.transport)) {
    const sse =
      e.type === 'sse' ||
      e.transport === 'sse' ||
      // Gemini CLI / Qwen Code: url without a type is an SSE endpoint.
      ((agent === 'gemini' || agent === 'qwen') && !e.httpUrl && !!e.url && e.type !== 'http')
    return { transport: 'http', sse, url: url || '', headers: { ...(e.headers || {}) } }
  }
  return {
    transport: 'stdio',
    command: e.command ? String(e.command) : '',
    args: Array.isArray(e.args) ? e.args.map(String) : [],
    env: { ...(e.env || {}) }
  }
}

// { transport, command, args, env, url, headers } -> the agent's own entry.
export function configToEntry(agent, cfg, extra = {}) {
  if (agent === 'opencode') {
    if (cfg.transport === 'http') {
      const e = { type: 'remote', url: cfg.url, enabled: true }
      if (cfg.headers && Object.keys(cfg.headers).length) e.headers = cfg.headers
      return e
    }
    const e = { type: 'local', command: [cfg.command, ...(cfg.args || [])], enabled: true }
    if (cfg.env && Object.keys(cfg.env).length) e.environment = cfg.env
    return e
  }
  if (agent === 'copilot') {
    if (cfg.transport === 'http') {
      const e = { type: cfg.sse ? 'sse' : 'http', url: cfg.url, tools: ['*'] }
      if (cfg.headers && Object.keys(cfg.headers).length) e.headers = cfg.headers
      return e
    }
    const e = { type: 'local', command: cfg.command, args: cfg.args || [], tools: ['*'] }
    if (cfg.env && Object.keys(cfg.env).length) e.env = cfg.env
    return e
  }
  if (agent === 'cline' || agent === 'kimi') {
    if (cfg.transport === 'http') {
      const e = agent === 'kimi' ? { transport: cfg.sse ? 'sse' : 'http', url: cfg.url } : { type: cfg.sse ? 'sse' : 'streamableHttp', url: cfg.url }
      if (cfg.headers && Object.keys(cfg.headers).length) e.headers = cfg.headers
      return e
    }
    const e = { command: cfg.command, args: cfg.args || [] }
    if (cfg.env && Object.keys(cfg.env).length) e.env = cfg.env
    return e
  }
  if (agent === 'cursor') {
    if (cfg.transport === 'http') {
      const e = { url: cfg.url }
      if (cfg.headers && Object.keys(cfg.headers).length) e.headers = cfg.headers
      return e
    }
    const e = { command: cfg.command, args: cfg.args || [] }
    if (cfg.env && Object.keys(cfg.env).length) e.env = cfg.env
    return e
  }
  // Gemini CLI, Qwen Code: httpUrl is streamable HTTP, url an SSE endpoint.
  if (cfg.transport === 'http') {
    const e = cfg.sse ? { url: cfg.url } : { httpUrl: cfg.url }
    if (cfg.headers && Object.keys(cfg.headers).length) e.headers = cfg.headers
    return { ...e, ...extra }
  }
  const e = { command: cfg.command, args: cfg.args || [] }
  if (cfg.env && Object.keys(cfg.env).length) e.env = cfg.env
  return { ...e, ...extra }
}

// -> { servers: [{ name, type, target }], error }
export function listJsonAgent(agent, home) {
  const file = settingsFile(agent, home)
  if (!file) return { servers: [], error: t('main.jsonAgents.unknownAgent', 'Unknown agent.') }
  const r = readSettings(file)
  if (r.error) return { servers: [], error: r.error }
  const map = (r.data && r.data[KEY[agent]]) || {}
  const servers = []
  for (const [name, e] of Object.entries(map)) {
    const cfg = entryToConfig(agent, e)
    if (!cfg) continue
    const target = cfg.transport === 'http' ? cfg.url : [cfg.command, ...cfg.args].filter(Boolean).join(' ')
    // Never expose env values or headers (usually secrets).
    servers.push({ name, scope: 'user', type: cfg.transport === 'http' ? 'http' : 'stdio', target })
  }
  return { servers, error: null }
}

export function jsonAgentConfig(agent, name, home) {
  const file = settingsFile(agent, home)
  const r = file ? readSettings(file) : { error: t('main.jsonAgents.unknownAgent', 'Unknown agent.') }
  if (r.error || !r.data) return null
  const e = (r.data[KEY[agent]] || {})[name]
  return e ? entryToConfig(agent, e) : null
}

// entry: the agent's own entry (configToEntry). -> { ok } or { ok: false, error }
export function setJsonAgentServer(agent, name, entry, home) {
  const file = settingsFile(agent, home)
  if (!file) return { ok: false, error: t('main.jsonAgents.unknownAgent', 'Unknown agent.') }
  const r = readSettings(file)
  if (r.error) return { ok: false, error: r.error }
  const data = r.data || (agent === 'opencode' ? { $schema: 'https://opencode.ai/config.json' } : {})
  const key = KEY[agent]
  if (agent === 'kimi' && Object.hasOwn(data, key) && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])))
    return { ok: false, error: t('main.jsonAgents.kimiNotObject', 'Kimi mcpServers is not an object; the existing file was left unchanged.') }
  if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) data[key] = {}
  if (JSON.stringify(data[key][name]) === JSON.stringify(entry)) return { ok: true, changed: false }
  data[key][name] = entry
  try {
    writeSettings(file, data)
  } catch (err) {
    return { ok: false, error: t('main.jsonAgents.writeFailed', 'Could not write {{file}}: {{error}}', { file, error: err.message }) }
  }
  return { ok: true, changed: true }
}

export function removeJsonAgentServer(agent, name, home) {
  const file = settingsFile(agent, home)
  if (!file) return { ok: false, error: t('main.jsonAgents.unknownAgent', 'Unknown agent.') }
  const r = readSettings(file)
  if (r.error) return { ok: false, error: r.error }
  const map = r.data && r.data[KEY[agent]]
  if (!map || !(name in map)) return { ok: true, changed: false }
  delete map[name]
  try {
    writeSettings(file, r.data)
  } catch (err) {
    return { ok: false, error: t('main.jsonAgents.writeFailed', 'Could not write {{file}}: {{error}}', { file, error: err.message }) }
  }
  return { ok: true, changed: true }
}

// The Tessel team tools entry for this agent: the pane's identity comes from
// the pane's environment (each CLI's own way of passing it). Node by its
// absolute path (nodePath.js), never by name: a node.exe in the folder the
// agent runs in would be started instead.
export function teamToolsEntry(agent, scriptPath, node = findNode()) {
  const stdio = { transport: 'stdio', command: node, args: [scriptPath] }
  // OpenCode puts {env:…} values into the file as raw text before reading it
  // as JSON: a Windows path (backslashes) would break the whole file. Only
  // the pane id (no backslash) goes that way; the project folder is found
  // from the folder OpenCode runs in.
  if (agent === 'opencode') return configToEntry(agent, { ...stdio, env: { TESSEL_PANE_ID: '{env:TESSEL_PANE_ID}', TESSEL_TEAM_SECRET: '{env:TESSEL_TEAM_SECRET}' } })
  // Kimi, Copilot and Cline hand their whole environment (the pane's) to the
  // server; Cline never expands $VAR in env values, so none is written.
  if (agent === 'copilot' || agent === 'cline' || agent === 'kimi') return configToEntry(agent, stdio)
  // Gemini CLI / Qwen Code: variables expanded from the environment; trusted,
  // so its tools run without asking each time (like Codex's "approve").
  return configToEntry(
    agent,
    { ...stdio, env: { TESSEL_PANE_ID: '$TESSEL_PANE_ID', TESSEL_PROJECT_DIR: '$TESSEL_PROJECT_DIR', TESSEL_TEAM_SECRET: '$TESSEL_TEAM_SECRET' } },
    { trust: true }
  )
}
