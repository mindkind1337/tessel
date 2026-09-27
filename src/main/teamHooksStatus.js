// Read-only diagnostics. Installation is not proof that a running CLI has
// loaded its hooks, and saved Codex trust is not a comparison of current hashes.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { HOOK_EVENTS, CODEX_HOOK_EVENTS, GEMINI_HOOK_EVENTS, COPILOT_HOOK_EVENTS, COPILOT_HOOKS_FILE } from './teamInstall'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const snake = (event) => event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()

function readText(file, label) {
  try {
    return { text: fs.readFileSync(file, 'utf8') }
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    // Never return source text or parser errors: these files can hold secrets.
    return { error: `Cannot read ${label}.` }
  }
}

function addError(agent, error) {
  agent.error = agent.error ? `${agent.error} ${error}` : error
}

function installation(home, id, scriptPath, events) {
  const file = join(home, `.${id}`, id === 'codex' ? 'hooks.json' : 'settings.json')
  const agent = {
    id,
    hooks: 'missing',
    events: Object.fromEntries(events.map((e) => [e, false])),
    approval: null,
    lastSignal: null,
    inbox: false
  }
  const matches = []
  const data = readText(file, `${id} hooks`)
  if (data.missing) return { agent, matches, file }
  try {
    if (data.error) throw new Error(data.error)
    const config = JSON.parse(data.text)
    if (!record(config) || (config.hooks !== undefined && !record(config.hooks))) throw new Error()
    const hooks = config.hooks || {}
    for (const event of events) {
      if (hooks[event] === undefined) continue
      if (!Array.isArray(hooks[event])) throw new Error()
      hooks[event].forEach((group, groupIndex) => {
        if (!record(group) || !Array.isArray(group.hooks)) throw new Error()
        group.hooks.forEach((handler, handlerIndex) => {
          if (!record(handler)) throw new Error()
          const command =
            id === 'codex' && process.platform === 'win32' && handler.commandWindows !== undefined
              ? handler.commandWindows
              : handler.command
          const want = `node "${scriptPath}" --hook${id === 'claude' ? '' : ` --${id}`}`
          if (
            handler.type !== 'command' ||
            typeof command !== 'string' ||
            command.trim() !== want ||
            !scriptPath
          )
            return
          // A restricted matcher does not provide the unconditional installation
          // used by Tessel (e.g. Stop vs a particular tool or startup source).
          if (group.matcher !== undefined && group.matcher !== '' && group.matcher !== '*') return
          if (
            id === 'gemini' &&
            Array.isArray(config.hooksConfig?.disabled) &&
            config.hooksConfig.disabled.includes(handler.name || handler.command)
          ) {
            addError(agent, 'A Tessel hook is disabled in Gemini settings.json.')
          }
          agent.events[event] = true
          matches.push({ event, key: `${file}:${snake(event)}:${groupIndex}:${handlerIndex}` })
        })
      })
    }
    const count = Object.values(agent.events).filter(Boolean).length
    agent.hooks = count === events.length ? 'installed' : count ? 'partial' : 'missing'
    if (id === 'claude' && config.disableAllHooks === true) {
      agent.hooks = 'error'
      addError(agent, 'Claude hooks are disabled in settings.json.')
    }
    if (id === 'gemini' && config.hooksConfig?.enabled === false) {
      addError(agent, 'Gemini hooks are disabled in settings.json.')
    }
    if (agent.error) agent.hooks = 'error'
  } catch {
    agent.hooks = 'error'
    addError(agent, data.error || `Cannot read ${id} hooks (invalid JSON or hook structure).`)
  }
  return { agent, matches, file }
}

// Only the single-line TOML spelling written by Codex is inspected. This is
// deliberately not a TOML parser: multiline/inline tables and ambiguous forms
// return unknown instead of manufacturing approval. Quote-aware scanning keeps
// comments, paths containing #, and text resembling table headers out of records.
function uncomment(line) {
  let quote = null
  let escaped = false
  const brackets = []
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (escaped) escaped = false
      else if (quote === '"' && c === '\\') escaped = true
      else if (c === quote) quote = null
    } else if (c === '#') {
      if (brackets.length) throw new Error()
      return line.slice(0, i).trim()
    } else if (c === '"' || c === "'") {
      if (line.slice(i, i + 3) === c.repeat(3)) throw new Error()
      quote = c
    } else if (c === '[' || c === '{') brackets.push(c)
    else if (c === ']' || c === '}') {
      if (brackets.pop() !== (c === ']' ? '[' : '{')) throw new Error()
    }
  }
  if (quote || brackets.length) throw new Error()
  return line.trim()
}

function stringValue(value) {
  if (/^'[^'\r\n]*'$/.test(value)) return value.slice(1, -1)
  if (/^"(?:[^"\\\r\n]|\\.)*"$/.test(value)) {
    // JSON covers Codex's normal escaped Windows paths. Other TOML string
    // escapes deliberately remain unknown rather than being misinterpreted.
    return JSON.parse(value)
  }
  throw new Error()
}

function keyParts(source) {
  const parts = []
  let rest = source.trim()
  while (rest) {
    const match = /^(?:[A-Za-z0-9_-]+|'[^'\r\n]*'|"(?:[^"\\\r\n]|\\.)*")/.exec(rest)
    if (!match) throw new Error()
    const key = match[0]
    parts.push(key.startsWith('"') || key.startsWith("'") ? stringValue(key) : key)
    rest = rest.slice(key.length).trim()
    if (!rest) break
    if (!rest.startsWith('.') || !rest.slice(1).trim()) throw new Error()
    rest = rest.slice(1).trim()
  }
  if (!parts.length) throw new Error()
  return parts
}

function savedTrust(text) {
  const states = new Map()
  const features = {}
  const headers = new Set()
  const keys = new Set()
  let table = []
  for (const raw of text.split(/\r?\n/)) {
    const line = uncomment(raw)
    if (!line) continue
    if (line.startsWith('[')) {
      if (!line.endsWith(']') || line.startsWith('[[')) throw new Error()
      table = keyParts(line.slice(1, -1))
      const key = JSON.stringify(table)
      if (headers.has(key)) throw new Error()
      headers.add(key)
      continue
    }
    // Find the assignment outside a quoted key.
    const assignment =
      /^((?:(?:[A-Za-z0-9_-]+|'[^']*'|"(?:[^"\\]|\\.)*")\s*\.\s*)*(?:[A-Za-z0-9_-]+|'[^']*'|"(?:[^"\\]|\\.)*"))\s*=\s*(.+)$/.exec(
        line
      )
    if (!assignment) throw new Error()
    const path = [...table, ...keyParts(assignment[1])]
    const key = JSON.stringify(path)
    if (keys.has(key)) throw new Error()
    keys.add(key)
    const value = assignment[2].trim()
    if (path[0] === 'features') {
      if (path.length !== 2) throw new Error()
      if (path[1] === 'hooks' || path[1] === 'codex_hooks') {
        if (value !== 'true' && value !== 'false') throw new Error()
        features[path[1]] = value === 'true'
      }
    } else if (path[0] === 'hooks') {
      if (path.length !== 4 || path[1] !== 'state') throw new Error()
      if (!states.has(path[2])) states.set(path[2], {})
      const state = states.get(path[2])
      if (path[3] === 'trusted_hash') state.hash = stringValue(value)
      else if (path[3] === 'enabled') {
        if (value !== 'true' && value !== 'false') throw new Error()
        state.enabled = value === 'true'
      } else throw new Error()
    }
  }
  return { states, disabled: (features.hooks ?? features.codex_hooks) === false }
}

function codexApproval(home, result) {
  const { agent, matches } = result
  const data = readText(join(home, '.codex', 'config.toml'), 'Codex config.toml')
  if (data.error) return addError(agent, data.error)
  try {
    const { states, disabled } = savedTrust(data.text || '')
    if (disabled) {
      agent.hooks = 'error'
      return addError(agent, 'Codex hooks are disabled in config.toml.')
    }
    if (agent.hooks === 'error' || !matches.length) return
    // At least one enabled, saved approval per required event. Other disabled
    // copies do not prevent an enabled handler for that event from executing.
    agent.approval = CODEX_HOOK_EVENTS.every((event) =>
      matches.some((match) => {
        const state = states.get(match.key)
        return match.event === event && state?.hash?.trim() && state.enabled !== false
      })
    )
      ? 'approved'
      : 'needs-approval'
  } catch {
    addError(
      agent,
      'Codex approval is unknown: config.toml uses an unsupported or invalid form. Check /hooks.'
    )
  }
}

function sessionSignals(sessionsDir, agents) {
  if (!sessionsDir) return
  let files
  try {
    files = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (error.code !== 'ENOENT') agents.forEach((a) => addError(a, 'Cannot read session reports.'))
    return
  }
  for (const file of files) {
    if (!file.isFile() || !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.json$/.test(file.name)) continue
    try {
      const report = JSON.parse(fs.readFileSync(join(sessionsDir, file.name), 'utf8'))
      if (!record(report) || !Number.isFinite(report.at) || report.at <= 0) continue
      const agent = agents.find((a) => a.id === report.agent)
      if (!agent) continue
      if (!agent.lastSignal || report.at > agent.lastSignal.at) {
        agent.lastSignal = {
          paneId: file.name.slice(0, -5),
          at: report.at,
          source: typeof report.source === 'string' ? report.source : ''
        }
      }
      if (agent.id === 'claude' && typeof report.inbox === 'string' && report.inbox.trim())
        agent.inbox = true
    } catch {
      // One incomplete/old report must not hide other agents' signals.
    }
  }
}

// Copilot CLI: Tessel's own hooks file, one command per event (--event=<name>).
function copilotInstallation(home, scriptPath) {
  const agent = {
    id: 'copilot',
    hooks: 'missing',
    events: Object.fromEntries(COPILOT_HOOK_EVENTS.map((e) => [e, false])),
    approval: null,
    lastSignal: null,
    inbox: false
  }
  const data = readText(join(home, '.copilot', 'hooks', COPILOT_HOOKS_FILE), 'copilot hooks')
  if (data.missing) return agent
  try {
    if (data.error) throw new Error(data.error)
    const config = JSON.parse(data.text)
    if (!record(config) || !record(config.hooks)) throw new Error()
    for (const event of COPILOT_HOOK_EVENTS) {
      const want = `node "${scriptPath}" --hook --copilot --event=${event}`
      const list = Array.isArray(config.hooks[event]) ? config.hooks[event] : []
      agent.events[event] =
        !!scriptPath && list.some((h) => record(h) && h.type === 'command' && String(h.powershell || h.bash || '').trim() === want)
    }
    const on = Object.values(agent.events).filter(Boolean).length
    agent.hooks = on === COPILOT_HOOK_EVENTS.length ? 'installed' : on ? 'partial' : 'missing'
  } catch (error) {
    agent.hooks = 'error'
    // Never the file's content or a parser message: generic only.
    addError(agent, data.error || 'Cannot read copilot hooks.')
  }
  return agent
}

export function hooksStatus({ home = os.homedir(), sessionsDir, scriptPath } = {}) {
  const claude = installation(home, 'claude', scriptPath, HOOK_EVENTS)
  const codex = installation(home, 'codex', scriptPath, CODEX_HOOK_EVENTS)
  const gemini = installation(home, 'gemini', scriptPath, GEMINI_HOOK_EVENTS)
  codexApproval(home, codex)
  const agents = [claude.agent, codex.agent, gemini.agent, copilotInstallation(home, scriptPath)]
  sessionSignals(sessionsDir, agents)
  return { agents }
}
