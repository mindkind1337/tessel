// MCP servers of the agent CLIs that keep them in a JSON settings file
// (Claude Code and Codex have their own commands, see agentTools.js):
//   Gemini CLI   ~/.gemini/settings.json         "mcpServers": { name: { command, args, env | httpUrl/url, headers, trust } }
//   Qwen Code    ~/.qwen/settings.json           same format (a Gemini CLI fork)
//   Copilot CLI  ~/.copilot/mcp-config.json      "mcpServers": { name: { type: local|http, command, args, env, tools | url, headers } }
//   OpenCode     ~/.config/opencode/opencode.json "mcp": { name: { type: local, command: [..], environment | type: remote, url, headers } }
//   Cline        ~/.cline/data/settings/cline_mcp_settings.json "mcpServers": { name: { command, args, env | type: streamableHttp, url, headers } }
//   Kimi Code    ~/.kimi-code/mcp.json           "mcpServers": { name: { command, args, env | transport: http|sse, url, headers } }
//   Cursor CLI   ~/.cursor/mcp.json              "mcpServers": { name: { command, args, env | url, headers } }
//   Antigravity  ~/.gemini/config/mcp_config.json "mcpServers": { name: { command, args, env | serverUrl, headers, disabled } }
//                (the format `agy mcp add` writes; agy reads url too)
//   Muse Code    ~/.config/muse/settings.json    "mcpServers" (or its older "mcp_servers"): { name: { command, args, env | url, headers, enabled } }
//                (its settings: "schema_version": 1 is kept, and added to a new file)
// HTTP servers are streamable HTTP unless `sse` is set (an SSE endpoint):
// Gemini/Qwen httpUrl vs url, Copilot/Cline/Kimi their type, OpenCode and
// Cursor find out by themselves. Antigravity and Muse only speak streamable HTTP.
// Only the server entries are read or changed; everything else in the file is
// kept as it is. A file that cannot be read as JSON (comments in a .jsonc,
// say) is never rewritten: the change is refused with a clear error.
import fs from 'fs'
import os from 'os'
import { join, dirname } from 'path'
import { writeFileAtomic } from './safeJson'
import { t } from './i18n'
import { findNode } from './nodePath'
import { museSettingsFile } from './museSessions'

export const JSON_AGENTS = ['gemini', 'qwen', 'copilot', 'opencode', 'cline', 'kimi', 'cursor', 'antigravity', 'muse']

function settingsFile(agent, home = os.homedir()) {
  if (agent === 'gemini') return join(home, '.gemini', 'settings.json')
  if (agent === 'qwen') return join(home, '.qwen', 'settings.json')
  if (agent === 'copilot') return join(home, '.copilot', 'mcp-config.json')
  if (agent === 'cursor') return join(home, '.cursor', 'mcp.json')
  // The Antigravity CLI's own servers (not Gemini CLI's ~/.gemini/settings.json).
  if (agent === 'antigravity') return join(home, '.gemini', 'config', 'mcp_config.json')
  // Muse Code's servers are in its settings, beside its hooks and the rest.
  if (agent === 'muse') return museSettingsFile(home)
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

const KEY = { gemini: 'mcpServers', qwen: 'mcpServers', copilot: 'mcpServers', opencode: 'mcp', cline: 'mcpServers', kimi: 'mcpServers', cursor: 'mcpServers', antigravity: 'mcpServers', muse: 'mcpServers' }

// The key an agent's file keeps its servers under. Muse also reads its older
// "mcp_servers": the one the file has is kept; with both, Muse turns MCP off
// for the session, and Tessel refuses to pick one. -> { key } or { error }
function serversKey(agent, data, file) {
  if (agent !== 'muse' || !data) return { key: KEY[agent] }
  const canonical = Object.hasOwn(data, 'mcpServers')
  const legacy = Object.hasOwn(data, 'mcp_servers')
  if (canonical && legacy)
    return { error: t('main.jsonAgents.museBothKeys', '{{file}} has both mcpServers and mcp_servers, so Muse Code turns its MCP servers off. Keep one of them; Tessel did not change the file.', { file }) }
  return { key: legacy ? 'mcp_servers' : 'mcpServers' }
}

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
  // Antigravity: url, or the older serverUrl its own `agy mcp add` writes.
  const url = e.httpUrl || e.url || (agent === 'antigravity' ? e.serverUrl : '')
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
  // Muse Code: the fields its own rewrite of its settings keeps (no type: an
  // entry with url is streamable HTTP; no SSE, refused before this).
  if (agent === 'muse') {
    if (cfg.transport === 'http') {
      const e = { url: cfg.url }
      if (cfg.headers && Object.keys(cfg.headers).length) e.headers = cfg.headers
      return e
    }
    const e = { command: cfg.command, args: cfg.args || [] }
    if (cfg.env && Object.keys(cfg.env).length) e.env = cfg.env
    return e
  }
  // Antigravity: what `agy mcp add` writes (serverUrl for HTTP). It has no
  // SSE transport: an SSE endpoint is refused before this (addMcp, copyMcp).
  if (agent === 'antigravity') {
    if (cfg.transport === 'http') {
      const e = { serverUrl: cfg.url }
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

// { envKeys, headerKeys }: the names of a server's environment variables and
// headers, never their values; each only when there is one.
export function secretNames(cfg = {}) {
  const names = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).filter(Boolean) : [])
  const out = {}
  const envKeys = names(cfg.env)
  const headerKeys = names(cfg.headers)
  if (envKeys.length) out.envKeys = envKeys
  if (headerKeys.length) out.headerKeys = headerKeys
  return out
}

// -> { servers: [{ name, type, target, envKeys?, headerKeys? }], error }
export function listJsonAgent(agent, home) {
  const file = settingsFile(agent, home)
  if (!file) return { servers: [], error: t('main.jsonAgents.unknownAgent', 'Unknown agent.') }
  const r = readSettings(file)
  if (r.error) return { servers: [], error: r.error }
  const k = serversKey(agent, r.data, file)
  if (k.error) return { servers: [], error: k.error }
  const map = (r.data && r.data[k.key]) || {}
  const servers = []
  for (const [name, e] of Object.entries(map)) {
    const cfg = entryToConfig(agent, e)
    if (!cfg) continue
    const target = cfg.transport === 'http' ? cfg.url : [cfg.command, ...cfg.args].filter(Boolean).join(' ')
    // Never expose env values or headers (usually secrets). Antigravity's
    // `agy mcp disable` keeps a server with "disabled": true, Muse's with
    // "enabled": false.
    const off = (agent === 'antigravity' && e && e.disabled === true) || (agent === 'muse' && e && e.enabled === false)
    servers.push({ name, scope: 'user', type: cfg.transport === 'http' ? 'http' : 'stdio', target, ...(off ? { enabled: false } : {}), ...secretNames(cfg) })
  }
  return { servers, error: null }
}

export function jsonAgentConfig(agent, name, home) {
  const file = settingsFile(agent, home)
  const r = file ? readSettings(file) : { error: t('main.jsonAgents.unknownAgent', 'Unknown agent.') }
  if (r.error || !r.data) return null
  const k = serversKey(agent, r.data, file)
  if (k.error) return null
  const e = (r.data[k.key] || {})[name]
  return e ? entryToConfig(agent, e) : null
}

// What stays the user's when Tessel rewrites its own server entry (its team
// tools at each start): a server the user turned off stays off (Muse's
// "enabled": false, Antigravity's "disabled": true), and Muse's timeouts.
export function userKeptFields(agent, old) {
  if (!old || typeof old !== 'object' || Array.isArray(old)) return {}
  const kept = {}
  if (agent === 'muse') {
    if (old.enabled === false) kept.enabled = false
    for (const [k, v] of Object.entries(old)) if (/timeout/i.test(k) && (typeof v === 'number' || (v && typeof v === 'object'))) kept[k] = v
  }
  if (agent === 'antigravity' && old.disabled === true) kept.disabled = true
  return kept
}

// entry: the agent's own entry (configToEntry). keepUser: what the user set
// on the entry already there stays (userKeptFields). -> { ok } or { ok: false, error }
export function setJsonAgentServer(agent, name, entry, home, { keepUser = false } = {}) {
  const file = settingsFile(agent, home)
  if (!file) return { ok: false, error: t('main.jsonAgents.unknownAgent', 'Unknown agent.') }
  const r = readSettings(file)
  if (r.error) return { ok: false, error: r.error }
  const data = r.data || (agent === 'opencode' ? { $schema: 'https://opencode.ai/config.json' } : {})
  const k = serversKey(agent, data, file)
  if (k.error) return { ok: false, error: k.error }
  const key = k.key
  // Muse refuses to start on a settings file without it.
  if (agent === 'muse' && data.schema_version === undefined) data.schema_version = 1
  if (agent === 'kimi' && Object.hasOwn(data, key) && (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])))
    return { ok: false, error: t('main.jsonAgents.kimiNotObject', 'Kimi mcpServers is not an object; the existing file was left unchanged.') }
  if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) data[key] = {}
  if (keepUser) entry = { ...entry, ...userKeptFields(agent, data[key][name]) }
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
  const k = serversKey(agent, r.data, file)
  if (k.error) return { ok: false, error: k.error }
  const map = r.data && r.data[k.key]
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
  // the pane id and secret (no backslash) go that way; the rest of the
  // pane's variables (TESSEL_PROJECT_DIR...) reach the server anyway, as
  // OpenCode starts a local server with its own environment plus these.
  if (agent === 'opencode') return configToEntry(agent, { ...stdio, env: { TESSEL_PANE_ID: '{env:TESSEL_PANE_ID}', TESSEL_TEAM_SECRET: '{env:TESSEL_TEAM_SECRET}' } })
  // Kimi, Copilot, Cline and Antigravity hand their whole environment (the
  // pane's) to the server; Cline and Antigravity never expand $VAR in env
  // values (a "$TESSEL_PANE_ID" would reach the server as it is), so none is
  // written.
  if (agent === 'copilot' || agent === 'cline' || agent === 'kimi' || agent === 'antigravity') return configToEntry(agent, stdio)
  // Muse Code starts a server with a cleared environment: the pane's
  // variables go through env, expanded by Muse (${NAME}). ":-" makes a missing
  // one empty (a Muse run outside Tessel): Muse would turn every server off
  // for a variable it cannot expand.
  if (agent === 'muse') {
    const names = ['TESSEL_PANE_ID', 'TESSEL_TEAM_SECRET', 'TESSEL_PROJECT_DIR', 'TESSEL_RUNTIME_DIR', 'APPDATA']
    return configToEntry(agent, { ...stdio, env: Object.fromEntries(names.map((n) => [n, `\${${n}:-}`])) })
  }
  // Gemini CLI / Qwen Code: variables expanded from the environment; trusted,
  // so its tools run without asking each time (like Codex's "approve").
  return configToEntry(
    agent,
    { ...stdio, env: { TESSEL_PANE_ID: '$TESSEL_PANE_ID', TESSEL_PROJECT_DIR: '$TESSEL_PROJECT_DIR', TESSEL_TEAM_SECRET: '$TESSEL_TEAM_SECRET' } },
    { trust: true }
  )
}
