// Which model an agent pane uses, for the pane header.
//
// Best first:
// 1. The conversation file (Claude Code and Codex): the model of the latest
//    answer, so a change with /model shows up.
// 2. A --model / -m option in the agent's command.
// 3. The agent's settings file (the folder's own first, then the user's).
// Nothing found: null (the header shows nothing rather than a guess).
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { isUuid } from './agentSessions'

const TAIL = 256 * 1024

function readTail(file, bytes = TAIL) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    const n = fs.readSync(fd, buf, 0, len, size - len)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// JSON, or JSON with comments and trailing commas (.jsonc).
function parseLoose(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    /* comments? */
  }
  try {
    const plain = text
      .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '')
      .replace(/,(\s*[}\]])/g, '$1')
    return JSON.parse(plain)
  } catch {
    return null
  }
}

// --- 1. Conversation files -------------------------------------------------

// The model of the latest answer in a Claude Code transcript (JSON lines).
export function claudeModelFromText(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model"')) continue
    try {
      const o = JSON.parse(line)
      const m = o && o.message && o.message.model
      if (o.type === 'assistant' && typeof m === 'string' && m && !m.startsWith('<')) return m
    } catch {
      /* a line cut by the tail read */
    }
  }
  return null
}

// The model (and reasoning effort) of the latest turn in a Codex rollout.
export function codexModelFromText(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model"')) continue
    try {
      const o = JSON.parse(line)
      const p = o && o.payload
      if (!p) continue
      if (o.type === 'turn_context' && typeof p.model === 'string' && p.model) {
        return { model: p.model, effort: typeof p.effort === 'string' ? p.effort : null }
      }
      const s = p.type === 'thread_settings_applied' && p.thread_settings
      if (s && typeof s.model === 'string' && s.model) {
        const effort = s.reasoning_effort || s.effort
        return { model: s.model, effort: typeof effort === 'string' ? effort : null }
      }
    } catch {
      /* a line cut by the tail read */
    }
  }
  return null
}

const fileCache = new Map() // session id -> transcript path

function claudeTranscript(id, home) {
  const hit = fileCache.get(id)
  if (hit && fs.existsSync(hit)) return hit
  const root = join(home, '.claude', 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const f = join(root, d.name, `${id}.jsonl`)
    if (fs.existsSync(f)) {
      fileCache.set(id, f)
      return f
    }
  }
  return null
}

function codexRollout(id, home, now = Date.now()) {
  const hit = fileCache.get(id)
  if (hit && fs.existsSync(hit)) return hit
  const root = join(home, '.codex', 'sessions')
  const d = new Date(now)
  // Newest day first, at most 30 days back.
  for (let i = 0; i < 31; i++) {
    const dir = join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    )
    d.setDate(d.getDate() - 1)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    const f = files.find((n) => n.startsWith('rollout-') && n.endsWith(`${id}.jsonl`))
    if (f) {
      fileCache.set(id, join(dir, f))
      return join(dir, f)
    }
  }
  return null
}

// --- 2. The command's own option ----------------------------------------------

export function modelFromCommand(command) {
  const m = /(?:^|\s)(?:--model|-m)(?:=|\s+)("([^"]+)"|'([^']+)'|([^\s"']+))/.exec(String(command || ''))
  return m ? m[2] || m[3] || m[4] : null
}

// --- 3. Settings files ------------------------------------------------------------

// Codex's config.toml: the top-level `model` and `model_reasoning_effort`
// (before the first [section]).
export function codexModelFromToml(text) {
  const top = String(text || '').split(/^\s*\[/m)[0]
  const val = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(top)
    return m ? m[1] : null
  }
  const model = val('model')
  return model ? { model, effort: val('model_reasoning_effort') } : null
}

function jsonModel(file, pick) {
  const o = parseLoose(readText(file))
  if (!o || typeof o !== 'object') return null
  const m = pick(o)
  return typeof m === 'string' && m.trim() ? m.trim() : null
}

const plainModel = (o) => o.model
const nestedModel = (o) => (o.model && typeof o.model === 'object' ? o.model.name : o.model)

function settingsModel(agentId, cwd, home) {
  const files = []
  if (agentId === 'claude') {
    if (cwd) files.push(join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'))
    files.push(join(home, '.claude', 'settings.json'))
    for (const f of files) {
      const m = jsonModel(f, plainModel)
      if (m) return { model: m }
    }
    return null
  }
  if (agentId === 'codex') return codexModelFromToml(readText(join(home, '.codex', 'config.toml')))
  if (agentId === 'gemini' || agentId === 'qwen') {
    const dir = agentId === 'gemini' ? '.gemini' : '.qwen'
    if (cwd) files.push(join(cwd, dir, 'settings.json'))
    files.push(join(home, dir, 'settings.json'))
    for (const f of files) {
      const m = jsonModel(f, nestedModel)
      if (m) return { model: m }
    }
    return null
  }
  if (agentId === 'opencode') {
    if (cwd) files.push(join(cwd, 'opencode.json'), join(cwd, 'opencode.jsonc'))
    const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config')
    files.push(join(cfg, 'opencode', 'opencode.json'), join(cfg, 'opencode', 'opencode.jsonc'))
    for (const f of files) {
      const m = jsonModel(f, plainModel)
      if (m) return { model: m }
    }
    return null
  }
  if (agentId === 'copilot') {
    const m = jsonModel(join(home, '.copilot', 'config.json'), plainModel)
    return m ? { model: m } : null
  }
  return null
}

// { model, effort, source: 'session' | 'command' | 'settings' } or null.
export function agentModel({ agentId, sessionId, command, cwd } = {}, home = os.homedir()) {
  if (!agentId) return null
  if (isUuid(sessionId)) {
    if (agentId === 'claude') {
      const f = claudeTranscript(sessionId, home)
      const m = f && claudeModelFromText(readTail(f))
      if (m) {
        // The transcript never says 1M context; the settings do (opus[1m]).
        const set = settingsModel('claude', cwd, home)
        const big = set && /^(\w+)\[1m\]$/i.exec(set.model)
        const same = big && m.toLowerCase().includes(big[1].toLowerCase())
        return { model: same ? m + '[1m]' : m, effort: null, source: 'session' }
      }
    } else if (agentId === 'codex') {
      const f = codexRollout(sessionId, home)
      const m = f && codexModelFromText(readTail(f))
      if (m) return { ...m, source: 'session' }
    }
  }
  const flag = modelFromCommand(command)
  if (flag) return { model: flag, effort: null, source: 'command' }
  const s = settingsModel(agentId, cwd, home)
  return s ? { model: s.model, effort: s.effort || null, source: 'settings' } : null
}
