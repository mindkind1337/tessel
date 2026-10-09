// A streamable HTTP MCP server for Codex, written straight into its
// config.toml (CODEX_HOME, else ~/.codex):
//   [mcp_servers.context7]
//   url = "https://mcp.context7.com/mcp"
//   bearer_token_env_var = "TOKEN"          (optional)
//   http_headers = { "X-Api-Key" = "..." }  (optional)
// `codex mcp add --url` is not used for these: when the server offers OAuth it
// starts a browser sign-in on its own, from a hidden process Tessel cannot
// show, even for a server that works without it (Context7). Signing in is
// left to `codex mcp login <name>`, run in a visible pane.
// Only this server's own tables are replaced; the rest of the file is kept as
// it is. A server written another way (inline under [mcp_servers], dotted
// keys) is never rewritten: the change is refused.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { writeFileAtomic } from './safeJson'
import { t } from './i18n'

export function codexHome(env = process.env, home = os.homedir()) {
  return env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : join(home, '.codex')
}

// A TOML basic string (JSON's escapes are valid TOML ones).
export function tomlString(value) {
  return JSON.stringify(String(value))
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
const keyRe = (name) => `(?:${esc(name)}|"${esc(name)}"|'${esc(name)}')`

// The server's tables: [mcp_servers.<name>] and its sub-tables.
const headerRe = (name) => new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${keyRe(name)}\\s*(?:\\.[^\\]]*)?\\]\\s*(?:#.*)?$`)
const ANY_HEADER = /^\s*\[/
const SERVERS_HEADER = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/

// -> { kept, had } (the file without this server's tables) or { error }
export function removeServerTables(text, name) {
  const lines = String(text || '').split(/\r?\n/)
  const own = headerRe(name)
  const inline = new RegExp(`^\\s*${keyRe(name)}\\s*=`)
  const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${keyRe(name)}\\s*[.=]`)
  const kept = []
  let inOwn = false
  let inServers = false
  let atTop = true
  let had = false
  for (const line of lines) {
    if (ANY_HEADER.test(line)) {
      atTop = false
      inOwn = own.test(line)
      inServers = SERVERS_HEADER.test(line)
      if (inOwn) had = true
    } else if ((inServers && inline.test(line)) || (atTop && dotted.test(line))) {
      return { error: t('main.mcp.codexOtherForm', 'Codex already has "{{name}}" written another way in config.toml: Tessel leaves it as it is. Edit it by hand or remove it first.', { name }) }
    }
    if (!inOwn) kept.push(line)
  }
  return { kept: kept.join('\n'), had }
}

// cfg: { url, headers: { Name: value }, bearerEnvVar }
export function codexHttpTable(name, cfg) {
  const lines = [`[mcp_servers.${name}]`, `url = ${tomlString(cfg.url)}`]
  if (cfg.bearerEnvVar) lines.push(`bearer_token_env_var = ${tomlString(cfg.bearerEnvVar)}`)
  const headers = Object.entries(cfg.headers || {})
  if (headers.length) lines.push(`http_headers = { ${headers.map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')} }`)
  return lines.join('\n') + '\n'
}

// Write the server. `verify()` (optional) asks Codex to read the new file
// back -> { ok, error }; when it cannot, the previous file is put back.
// -> { ok, changed } or { ok: false, error }
export async function setCodexHttpServer(name, cfg, { home = codexHome(), verify } = {}) {
  const file = join(home, 'config.toml')
  let text = ''
  try {
    if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, error: t('main.jsonAgents.readFailed', 'Could not read {{file}}: {{error}}', { file, error: err.message }) }
  }
  const crlf = /\r\n/.test(text)
  const split = removeServerTables(text, name)
  if (split.error) return { ok: false, error: split.error }
  const table = codexHttpTable(name, cfg)
  let next = split.kept.replace(/\s*$/, '')
  next = (next ? next + '\n\n' : '') + table
  if (crlf) next = next.replace(/\r?\n/g, '\r\n')
  if (next === text) return { ok: true, changed: false }
  try {
    fs.mkdirSync(home, { recursive: true })
    if (text) fs.copyFileSync(file, `${file}.tessel-bak`)
    writeFileAtomic(file, next)
  } catch (err) {
    return { ok: false, error: t('main.jsonAgents.writeFailed', 'Could not write {{file}}: {{error}}', { file, error: err.message }) }
  }
  if (verify) {
    const v = await verify()
    if (!v || !v.ok) {
      try {
        if (text) writeFileAtomic(file, text)
        else fs.rmSync(file, { force: true })
      } catch {
        // the .tessel-bak copy is still there
      }
      const why = v && v.error ? ` (${v.error})` : ''
      return { ok: false, error: t('main.mcp.codexRejectedEntry', 'Codex could not read the new server, so Tessel left its settings as they were.') + why }
    }
  }
  return { ok: true, changed: true }
}
