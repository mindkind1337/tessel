// Which model (and reasoning effort) the other terminal agents run with, for
// agentModel.js: read from their own conversation files, databases and
// settings, so the pane header, the sender identity of team messages and
// Conversations name it. Each reader is pure (text or rows in, { model,
// effort, name?, at? } or null out) beside the function that finds its file.
// Reads are bounded (a log read back from its end in chunks, or its end then
// its start; a few rows of a database), a log is parsed again only when its
// size or time changed, and nothing here starts a program or writes.
//
//   Gemini CLI  ~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl, a
//               record per line: each answer { type: 'gemini', model,
//               timestamp } (its chatRecordingService).
//   Qwen Code   <QWEN_HOME or ~/.qwen>/projects/<project>/chats/<id>.jsonl:
//               each answer { type: 'assistant', model, timestamp }.
//   Kimi Code   <KIMI_CODE_HOME or ~/.kimi-code>/sessions/<workspace>/<id>/
//               agents/main/wire.jsonl, { type, ..., time (ms) } per line: the
//               session's start (profile.bind) and each /model or /effort
//               (config.update) name { modelAlias, thinkingEffort }. Its
//               config.toml: default_model, [thinking] effort / enabled and
//               each [models."<alias>"] display_name.
//   Pi, OMP, OpenClaw  a session's JSONL (Pi's format): model_change
//               { provider, modelId }, thinking_level_change { thinkingLevel },
//               each answer message { role: 'assistant', provider, model }.
//   Droid       ~/.factory/sessions/<folder>/<id>.settings.json and
//               ~/.factory/settings.json { model, reasoningEffort }.
//   OpenCode, Kilo, ZCode  their database (OpenCode's tables): each message's
//               model (an answer: modelID, providerID, variant; a prompt:
//               model { providerID, modelID, variant }) and the session's
//               model column { id, providerID, variant }; the variant is the
//               effort ("default": none picked). Kilo's panes have no session
//               id: the session of the pane's folder written since it started.
//   Continue    ~/.continue/index/globalContext.json { cliSelectedModel }
//               (its /model pick, a name of config.yaml's models), else the
//               first chat model config.yaml lists.
//   Grok Build  <GROK_HOME or ~/.grok>/sessions/<folder>/<id>/summary.json
//               { current_model_id, reasoning_effort, updated_at } (written
//               at each turn and each /model or /effort); its config.toml
//               [models] default / default_reasoning_effort; else the default
//               model its last settings fetch named (settings_cache.json
//               settings.default_model) and that model's default effort and
//               name in models_cache.json (models.<id>.info { name,
//               reasoning_efforts: [{ value, default }] }).
//   Crush, Goose, Aider, Mistral Vibe: the model their settings name.
import fs from 'fs'
import os from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import { isUuid } from './agentSessions'
import { geminiFiles, parseGeminiHead, qwenProjectsRoot } from './agentHistory'
import { ompSessionsDir, piSessionsDir } from './agentSessionSources'
import { normDir, readHead, readJson, readRows, readTail, readText } from './fileRead'
import { latestInFile } from './latestInFile'
import { effortLevel } from '../shared/modelLabel'
import { grokHome } from './grokAccount'

const TAIL = 256 * 1024
const HEAD = 512 * 1024
const SLACK = 5000

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)
// A model id as an agent writes it: a short line of text, never a control character.
const modelId = (v) => {
  const s = str(v)
  return s && s.length <= 120 && !/[\u0000-\u001f]/.test(s) ? s : null
}
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null)
function json(text) {
  try {
    const o = JSON.parse(text)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}
// JSON, or JSON with comments and trailing commas (.jsonc).
function jsonLoose(text) {
  if (!text) return null
  const o = json(text)
  if (o) return o
  return json(
    text.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, s) => s || '').replace(/,(\s*[}\]])/g, '$1')
  )
}
// ms from an ISO time or a number (seconds or ms).
function timeOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}
const when = (at) => (at ? { at } : {})
function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
function statOf(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}
const envDir = (v) => (typeof v === 'string' && v.trim() && isAbsolute(v.trim()) ? v.trim() : '')
// Windows' per-user folders (%APPDATA%, %LOCALAPPDATA%): the real home's
// only, never for a test's or another account's home.
function winDir(home, name, rel) {
  return (home === os.homedir() && envDir(process.env[name])) || join(home, 'AppData', rel)
}

// Where a session's file is: found once, then remembered while it exists. A
// file not there yet (no message sent) is looked for again 5 s later at most.
const located = new Map() // key -> file
const missed = new Map() // key -> when it was looked for in vain
function remembered(key, find) {
  const hit = located.get(key)
  if (hit && fs.existsSync(hit)) return hit
  located.delete(key)
  if (Date.now() - (missed.get(key) || 0) < 5000) return null
  const file = find()
  if (file) {
    missed.delete(key)
    located.set(key, file)
    while (located.size > 200) located.delete(located.keys().next().value)
  } else {
    missed.set(key, Date.now())
    while (missed.size > 200) missed.delete(missed.keys().next().value)
  }
  return file
}
// What a file says, parsed again only when its size or time changed.
const parsed = new Map() // kind|file -> { size, mtime, value }
function bySize(kind, file, read) {
  const st = statOf(file)
  if (!st || !st.isFile()) return null
  const key = `${kind}|${file}`
  const hit = parsed.get(key)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.value
  const value = read(file)
  parsed.delete(key)
  parsed.set(key, { size: st.size, mtime: st.mtimeMs, value })
  while (parsed.size > 200) parsed.delete(parsed.keys().next().value)
  return value
}
// The newest line of a text that names what pick wants.
function latestLine(text, keep, pick) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!keep(lines[i])) continue
    const found = pick(json(lines[i]))
    if (found) return found
  }
  return null
}

// --- Gemini CLI, Qwen Code -----------------------------------------------------

export function geminiModelFromText(text) {
  return latestLine(
    text,
    (l) => l.includes('"gemini"') && l.includes('"model"'),
    (o) => {
      const model = o && o.type === 'gemini' ? modelId(o.model) : null
      return model ? { model, effort: null, ...when(timeOf(o.timestamp)) } : null
    }
  )
}

// Its chat file: named after its id's first 8 characters, the full id in it.
export function geminiSessionFile(id, home = os.homedir()) {
  if (!isUuid(id)) return null
  const want = id.toLowerCase()
  return remembered(`gemini|${home}|${want}`, () => {
    const end = `-${want.slice(0, 8)}.jsonl`
    for (const f of geminiFiles(home)) {
      if (f.legacy || !f.full.toLowerCase().endsWith(end)) continue
      const head = parseGeminiHead(readHead(f.full, 64 * 1024))
      if (head && head.id.toLowerCase() === want) return f.full
    }
    return null
  })
}

export function qwenModelFromText(text) {
  return latestLine(
    text,
    (l) => l.includes('"assistant"') && l.includes('"model"'),
    (o) => {
      const model = o && o.type === 'assistant' ? modelId(o.model) : null
      return model ? { model, effort: null, ...when(timeOf(o.timestamp)) } : null
    }
  )
}

// An answer's line can be megabytes (Gemini keeps a tool call's output in
// it): read back in chunks until a model shows (latestInFile.js).
const geminiFromFile = latestInFile(geminiModelFromText)
const qwenFromFile = latestInFile(qwenModelFromText)

export function qwenSessionFile(id, home = os.homedir()) {
  if (!isUuid(id)) return null
  const root = qwenProjectsRoot(home)
  return remembered(`qwen|${root}|${id}`, () => {
    for (const p of entries(root)) {
      if (!p.isDirectory() || p.isSymbolicLink()) continue
      const file = join(root, p.name, 'chats', `${id}.jsonl`)
      if (statOf(file)) return file
    }
    return null
  })
}

// --- Kimi Code -------------------------------------------------------------------

// Its thinking: "off" is no reasoning, "on" (a model without levels) no level.
const kimiEffort = (v) => (v === 'on' ? null : effortLevel(v))

// A wire record of the main agent's settings. The session's first one also
// carries its whole system prompt, after modelAlias and thinkingEffort: a
// line cut there (the end of a read window) still says them.
function kimiRecord(line) {
  if (!line.includes('"profile.bind"') && !line.includes('"config.update"')) return null
  const o = json(line)
  if (o) return o.type === 'profile.bind' || o.type === 'config.update' ? o : null
  const head = line.slice(0, 4096)
  const type = /^\{"type":"(profile\.bind|config\.update)"/.exec(head)
  if (!type) return null
  const field = (key) => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.){1,200})"`).exec(head)
    try {
      return m ? JSON.parse(`"${m[1]}"`) : undefined
    } catch {
      return undefined
    }
  }
  return { type: type[1], modelAlias: field('modelAlias'), thinkingEffort: field('thinkingEffort') }
}

// -> { model, thinking (its own word, undefined when no record names it), at }
// of the latest records, or null. model: null when only an effort was set.
export function kimiWireModel(text) {
  const lines = String(text || '').split('\n')
  let model = null
  let thinking
  let at = null
  for (let i = lines.length - 1; i >= 0 && !(model && thinking !== undefined); i--) {
    const r = kimiRecord(lines[i])
    if (!r) continue
    const t = timeOf(r.time)
    if (thinking === undefined && typeof r.thinkingEffort === 'string') {
      thinking = r.thinkingEffort
      at = at || t
    }
    if (!model && modelId(r.modelAlias)) {
      model = modelId(r.modelAlias)
      at = at || t
    }
  }
  return model || thinking !== undefined ? { model, thinking, at } : null
}

// The session's model and effort: its end first; what it does not say (the
// model picked at its start, a long session) from its start.
export function kimiModelFromWire(tailText, headText = '') {
  const tail = kimiWireModel(tailText)
  const head = tail && tail.model && tail.thinking !== undefined ? null : kimiWireModel(headText)
  const model = (tail && tail.model) || (head && head.model)
  if (!model) return null
  const thinking = tail && tail.thinking !== undefined ? tail.thinking : head ? head.thinking : undefined
  return { model, effort: kimiEffort(thinking), ...when((tail && tail.at) || (head && head.at)) }
}

const kimiHome = (home) => envDir(process.env.KIMI_CODE_HOME) || join(home, '.kimi-code')

export function kimiWireFile(id, home = os.homedir()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null
  const root = join(kimiHome(home), 'sessions')
  return remembered(`kimi|${root}|${id}`, () => {
    for (const w of entries(root)) {
      if (!w.isDirectory() || w.isSymbolicLink() || w.name.startsWith('.')) continue
      const file = join(root, w.name, id, 'agents', 'main', 'wire.jsonl')
      if (statOf(file)) return file
    }
    return null
  })
}

// The keys of a TOML file Tessel reads (strings, booleans and numbers; not
// arrays or inline tables), by section: '' for the top, 'thinking',
// 'models\n<alias>' (its parts joined by a line break, quotes taken off).
export function tomlKeys(text) {
  const out = new Map([['', new Map()]])
  let section = out.get('')
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[[')) {
      section = null // an array of tables ([[hooks]]): not read
      continue
    }
    const head = /^\[(.+)\]\s*(?:#.*)?$/.exec(line)
    if (head) {
      const parts = [...head[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s"']+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
      const name = parts.join('\n')
      if (!out.has(name)) out.set(name, new Map())
      section = out.get(name)
      continue
    }
    const kv = /^([A-Za-z0-9_-]+|"[^"]+")\s*=\s*(.+)$/.exec(line)
    if (!kv || !section) continue
    const key = kv[1].replace(/^"|"$/g, '')
    const v = kv[2].trim()
    let value
    if (v.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(v)
      try {
        value = m ? JSON.parse(`"${m[1]}"`) : undefined
      } catch {
        value = undefined
      }
    } else if (v.startsWith("'")) {
      const m = /^'([^']*)'/.exec(v)
      value = m ? m[1] : undefined
    } else {
      const bare = v.replace(/\s+#.*$/, '')
      value = bare === 'true' ? true : bare === 'false' ? false : /^-?\d+(\.\d+)?$/.test(bare) ? Number(bare) : undefined
    }
    if (value !== undefined) section.set(key, value)
  }
  return out
}

// Kimi's config.toml -> { model, effort, name? } of its default model, or null.
export function kimiConfigModel(text) {
  const toml = tomlKeys(text)
  const model = modelId(toml.get('').get('default_model'))
  if (!model) return null
  const thinking = toml.get('thinking') || new Map()
  const effort = thinking.get('enabled') === false ? 'none' : kimiEffort(thinking.get('effort'))
  const name = kimiDisplayName(toml, model)
  return { model, effort: effort || null, ...(name ? { name } : {}) }
}
function kimiDisplayName(toml, alias) {
  const m = toml.get(`models\n${alias}`)
  const name = m && str(m.get('display_name'))
  return name ? name.slice(0, 80) : null
}

export function kimiSession(id, home = os.homedir()) {
  const file = kimiWireFile(id, home)
  if (!file) return null
  const found = bySize('kimi', file, (f) => {
    const tail = readTail(f, TAIL)
    const first = kimiWireModel(tail)
    return kimiModelFromWire(tail, first && first.model && first.thinking !== undefined ? '' : readHead(f, HEAD))
  })
  if (!found) return null
  // Its display name, as config.toml names that alias.
  const name = kimiDisplayName(tomlKeys(readText(join(kimiHome(home), 'config.toml'))), found.model)
  return name ? { ...found, name } : found
}

// --- Pi, OMP, OpenClaw (Pi's session format) --------------------------------------

function piFact(o) {
  if (!o) return null
  if (o.type === 'thinking_level_change' && typeof o.thinkingLevel === 'string') return { level: o.thinkingLevel }
  const m = o.type === 'model_change' ? { id: modelId(o.modelId), provider: str(o.provider) } : o.type === 'message' && o.message && o.message.role === 'assistant' ? { id: modelId(o.message.model), provider: str(o.message.provider) } : null
  if (!m || !m.id) return null
  return { model: m.provider && !m.id.includes('/') ? `${m.provider}/${m.id}` : m.id }
}
const piKeep = (l) => l.includes('"model') || l.includes('"thinkingLevel"')

// -> { model, level (its own word; undefined when no record names one), at }
// of the newest records of a session's text, or null.
function piRecords(text) {
  const lines = String(text || '').split('\n')
  let model = null
  let level
  let at = null
  for (let i = lines.length - 1; i >= 0 && !(model && level !== undefined); i--) {
    if (!piKeep(lines[i])) continue
    const o = json(lines[i])
    const f = piFact(o)
    if (!f) continue
    if (f.level !== undefined && level === undefined) {
      level = f.level
      at = at || timeOf(o.timestamp)
    }
    if (f.model && !model) {
      model = f.model
      at = at || timeOf(o.timestamp)
    }
  }
  return model || level !== undefined ? { model, level, at } : null
}

// The model and thinking level in force at the end of a session: its end
// first; the level set at its start (Pi notes it once) from its start.
export function piModelFromWire(tailText, headText = '') {
  const tail = piRecords(tailText)
  const head = tail && tail.model && tail.level !== undefined ? null : piRecords(headText)
  const model = (tail && tail.model) || (head && head.model)
  if (!model) return null
  const level = tail && tail.level !== undefined ? tail.level : head ? head.level : undefined
  return { model, effort: level === undefined ? null : effortLevel(level), ...when((tail && tail.at) || (head && head.at)) }
}
export const piModelFromText = (text) => piModelFromWire(text)
function piFromFile(file) {
  return bySize('pi', file, (f) => {
    const tail = readTail(f, TAIL)
    const first = piRecords(tail)
    return piModelFromWire(tail, first && first.model && first.level !== undefined ? '' : readHead(f, HEAD))
  })
}

// Each change of model or thinking level, oldest first: [{ t, model, effort }]
// (Conversations: the model each line ran with).
export function piModelTimeline(lines) {
  const out = []
  let model = ''
  let level = null
  for (const line of lines || []) {
    if (!piKeep(line)) continue
    const o = json(line)
    const f = piFact(o)
    const t = o && timeOf(o.timestamp)
    if (!f || !t) continue
    const nextModel = f.model || model
    const nextLevel = f.level !== undefined ? effortLevel(f.level) : level
    if (!nextModel || (nextModel === model && nextLevel === level)) continue
    model = nextModel
    level = nextLevel
    out.push({ t, model, effort: level })
  }
  return out
}

// <sessions>/<folder slug>/<time>_<id>.jsonl
export function piSessionFile(dir, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null
  return remembered(`pi|${dir}|${id}`, () => {
    for (const d of entries(dir)) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue
      for (const f of entries(join(dir, d.name))) if (f.isFile() && f.name.endsWith(`_${id}.jsonl`)) return join(dir, d.name, f.name)
    }
    return null
  })
}
const piSession = (dir, id) => {
  const file = piSessionFile(dir, id)
  return file ? piFromFile(file) : null
}

// Pi's settings.json beside its sessions folder: { defaultProvider,
// defaultModel, defaultThinkingLevel }.
export function piSettingsModel(o) {
  const id = o && modelId(o.defaultModel)
  if (!id) return null
  const provider = str(o.defaultProvider)
  return { model: provider && !id.includes('/') ? `${provider}/${id}` : id, effort: effortLevel(o.defaultThinkingLevel) }
}
function piAgentDir(home) {
  const sessions = piSessionsDir(home)
  return basename(sessions) === 'sessions' ? dirname(sessions) : sessions
}

// OpenClaw's agent "main": its index of sessions names each one's model; its
// newest (the one its TUI goes on with), with the thinking level its file
// notes. Its config: agents.defaults.model.primary ("provider/model").
const openclawDir = (home) => join(home, '.openclaw')
export function openclawSession(home = os.homedir()) {
  const dir = join(openclawDir(home), 'agents', 'main', 'sessions')
  const index = bySize('openclaw-index', join(dir, 'sessions.json'), (f) => readJson(f))
  if (!index || typeof index !== 'object') return null
  let best = null
  for (const s of Object.values(index)) {
    if (!s || typeof s !== 'object' || !modelId(s.model)) continue
    if (!best || (num(s.updatedAt) || 0) > (num(best.updatedAt) || 0)) best = s
  }
  if (!best) return null
  const provider = str(best.modelProvider)
  const model = provider && !best.model.includes('/') ? `${provider}/${best.model.trim()}` : best.model.trim()
  const id = typeof best.sessionId === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(best.sessionId) ? best.sessionId : null
  const fromFile = id ? piFromFile(join(dir, `${id}.jsonl`)) : null
  return { model: (fromFile && fromFile.model) || model, effort: (fromFile && fromFile.effort) || null, ...when(timeOf(best.updatedAt)) }
}
export function openclawConfigModel(o) {
  const m = o && o.agents && o.agents.defaults && o.agents.defaults.model
  const id = modelId(typeof m === 'string' ? m : m && typeof m === 'object' ? m.primary : null)
  return id ? { model: id, effort: null } : null
}

// --- Droid (Factory) ----------------------------------------------------------------

export function droidSettingsModel(o) {
  const model = o && modelId(o.model)
  return model ? { model, effort: effortLevel(o.reasoningEffort) } : null
}
export function droidSessionSettings(id, home = os.homedir()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null
  const roots = [join(home, '.factory', 'sessions'), join(home, '.factory', 'projects')]
  return remembered(`droid|${home}|${id}`, () => {
    for (const root of roots) {
      for (const d of entries(root)) {
        if (!d.isDirectory() || d.isSymbolicLink()) continue
        const file = join(root, d.name, `${id}.settings.json`)
        if (statOf(file)) return file
      }
    }
    return null
  })
}
function droidSession(id, home) {
  const file = droidSessionSettings(id, home)
  if (!file) return null
  const found = bySize('droid', file, (f) => droidSettingsModel(readJson(f)))
  const st = found && statOf(file)
  return found ? { ...found, ...when(st && st.mtimeMs) } : null
}

// --- OpenCode, Kilo, ZCode (OpenCode's tables) ---------------------------------------

function opencodeModel(modelID, providerID, variant) {
  const id = modelId(modelID)
  if (!id) return null
  const provider = str(providerID)
  return { model: provider ? `${provider}/${id}` : id, effort: variant === 'default' ? null : effortLevel(variant) }
}
// A message's model: an answer's, else the one a prompt was sent with.
export function opencodeMessageModel(data) {
  const m = typeof data === 'string' ? json(data) : data && typeof data === 'object' ? data : null
  if (!m) return null
  if (m.role === 'assistant') return opencodeModel(m.modelID, m.providerID, m.variant)
  const p = m.role === 'user' && m.model && typeof m.model === 'object' ? m.model : null
  return p ? opencodeModel(p.modelID, p.providerID, p.variant !== undefined ? p.variant : m.variant) : null
}
// The session's own model column: { id, providerID, variant }.
export function opencodeSessionColumn(value) {
  const o = typeof value === 'string' ? json(value) : null
  return o ? opencodeModel(o.id || o.modelID, o.providerID, o.variant) : null
}
// rows: its newest messages, newest first ({ data, time_created }); column:
// the session's model column. The newest message that names a model wins;
// its effort, when that message names none, the column's for the same model.
export function opencodeSessionModel(column, rows, updated = null) {
  const col = opencodeSessionColumn(column)
  for (const r of rows || []) {
    const m = opencodeMessageModel(r && r.data)
    if (!m) continue
    const effort = m.effort || (col && col.model === m.model ? col.effort : null)
    return { model: m.model, effort, ...when(num(r.time_created)) }
  }
  return col ? { ...col, ...when(num(updated)) } : null
}
function opencodeDbSession(db, id) {
  const s = readRows(db, 'SELECT model, time_updated FROM session WHERE id = ?', [id])[0]
  if (!s) return null
  const rows = readRows(db, 'SELECT data, time_created FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 12', [id])
  return opencodeSessionModel(s.model, rows, s.time_updated)
}
// The session a pane runs: its id when known, else (Kilo) the newest root
// session of the pane's folder written since the pane started.
export function opencodeDbModel(db, { sessionId = null, cwd = null, since = 0 } = {}) {
  if (!db || !fs.existsSync(db)) return null
  if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(sessionId)) return opencodeDbSession(db, sessionId)
  const want = normDir(cwd)
  if (!want || !since) return null
  const rows = readRows(db, 'SELECT id, directory FROM session WHERE parent_id IS NULL AND time_updated >= ? ORDER BY time_updated DESC LIMIT 20', [Math.max(0, since - SLACK)])
  const hit = rows.find((r) => normDir(r.directory) === want && /^[A-Za-z0-9_-]{6,80}$/.test(String(r.id)))
  return hit ? opencodeDbSession(db, String(hit.id)) : null
}
const dataHome = (home) => envDir(process.env.XDG_DATA_HOME) || join(home, '.local', 'share')
const stateHome = (home) => envDir(process.env.XDG_STATE_HOME) || join(home, '.local', 'state')
const configHome = (home) => envDir(process.env.XDG_CONFIG_HOME) || join(home, '.config')
export const opencodeDbFile = (home, app = 'opencode') => join(dataHome(home), app, `${app}.db`)
export const zcodeDbFile = (home) => join(home, '.zcode', 'cli', 'db', 'db.sqlite')

// The models last picked in OpenCode's (or Kilo's) model list, newest first,
// with the variant (effort) picked for each: <state>/<app>/model.json
// { recent: [{ providerID, modelID }], variant: { "<provider>/<model>": "high" } }.
export function opencodePicked(home = os.homedir(), app = 'opencode') {
  const file = join(stateHome(home), app, 'model.json')
  const o = jsonLoose(readText(file))
  const r = o && Array.isArray(o.recent) ? o.recent[0] : null
  if (!r || !modelId(r.modelID)) return null
  const model = r.providerID ? `${r.providerID}/${r.modelID}` : r.modelID
  const variant = o.variant && typeof o.variant === 'object' ? o.variant[model] : null
  const st = statOf(file)
  return { model, effort: variant === 'default' ? null : effortLevel(variant), mtime: st ? st.mtimeMs : 0 }
}
// Kilo's settings: kilo.json(c) in the folder, then its own.
function kiloConfigModel(cwd, home) {
  const files = []
  if (cwd) files.push(join(cwd, 'kilo.json'), join(cwd, 'kilo.jsonc'))
  files.push(join(configHome(home), 'kilo', 'kilo.json'), join(configHome(home), 'kilo', 'kilo.jsonc'))
  for (const f of files) {
    const o = jsonLoose(readText(f))
    const model = o && modelId(o.model)
    if (model) return { model, effort: null }
  }
  return null
}

// --- Continue CLI -------------------------------------------------------------------

// config.yaml's models: [{ name, model, chat }] (chat: no roles listed, or
// "chat" among them), read line by line (only its models list).
export function continueModels(yaml) {
  const out = []
  let inModels = false
  let item = null
  let inRoles = false
  const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  for (const raw of String(yaml || '').split('\n')) {
    if (/^\S/.test(raw)) {
      inModels = /^models:\s*$/.test(raw)
      item = null
      continue
    }
    if (!inModels) continue
    const start = /^\s{0,4}-\s+(\w+):\s*(.*)$/.exec(raw)
    if (start) {
      item = { name: '', model: '', roles: null }
      out.push(item)
      inRoles = false
      if (start[1] === 'name' || start[1] === 'model') item[start[1]] = unquote(start[2])
      continue
    }
    if (!item) continue
    const kv = /^\s+(\w+):\s*(.*)$/.exec(raw)
    if (kv) {
      inRoles = kv[1] === 'roles'
      if (kv[1] === 'name' || kv[1] === 'model') item[kv[1]] = unquote(kv[2])
      if (inRoles) item.roles = /^\[(.*)\]$/.test(kv[2].trim()) ? kv[2].trim().slice(1, -1).split(',').map(unquote) : []
      continue
    }
    const role = /^\s+-\s+(.+)$/.exec(raw)
    if (role && inRoles && item.roles) item.roles.push(unquote(role[1]))
  }
  return out.filter((m) => m.name || m.model).map((m) => ({ name: m.name, model: m.model, chat: !m.roles || m.roles.includes('chat') }))
}
// Its /model pick (a model's name), else the first chat model it lists.
export function continueModel(selected, yaml) {
  const models = continueModels(yaml)
  const pick = str(selected)
  const m = pick ? models.find((x) => (x.name || x.model) === pick) || { name: pick, model: '' } : models.find((x) => x.chat)
  if (!m) return null
  const name = str(m.name)
  const model = modelId(m.model) && m.model !== 'AUTODETECT' ? m.model : name
  return model ? { model, effort: null, ...(name ? { name: name.slice(0, 80) } : {}) } : null
}
function continueSettings(home) {
  const dir = envDir(process.env.CONTINUE_GLOBAL_DIR) || join(home, '.continue')
  const context = readJson(join(dir, 'index', 'globalContext.json'))
  return continueModel(context && context.cliSelectedModel, readText(join(dir, 'config.yaml')))
}

// --- Settings of Crush, Goose, Aider, Mistral Vibe ------------------------------------

// Crush: the large model it was set to ({ models: { large: { model,
// provider, reasoning_effort } } }), in its data file (its model picker
// writes there), the folder's .crush.json / crush.json, then its own.
export function crushConfigModel(o) {
  const m = o && o.models && typeof o.models === 'object' ? o.models.large : null
  const model = m && typeof m === 'object' ? modelId(m.model) : null
  return model ? { model, effort: effortLevel(m.reasoning_effort) } : null
}
function crushSettings(cwd, home) {
  const local = process.platform === 'win32' ? join(winDir(home, 'LOCALAPPDATA', 'Local'), 'crush') : null
  const files = [local ? join(local, 'crush.json') : join(dataHome(home), 'crush', 'crush.json')]
  if (cwd) files.push(join(cwd, '.crush.json'), join(cwd, 'crush.json'))
  files.push(join(configHome(home), 'crush', 'crush.json'))
  for (const f of files) {
    const m = crushConfigModel(jsonLoose(readText(f)))
    if (m) return m
  }
  return null
}
// A top-level "key: value" of a YAML file (quotes and a comment taken off).
function yamlValue(yaml, key) {
  const m = new RegExp(`^${key}:\\s*["']?([^"'#\\r\\n]+?)["']?\\s*(?:#.*)?$`, 'm').exec(String(yaml || ''))
  return m ? m[1].trim() : null
}
// Goose's config.yaml: GOOSE_MODEL (GOOSE_PROVIDER beside it).
export function gooseConfigModel(yaml) {
  const model = modelId(yamlValue(yaml, 'GOOSE_MODEL'))
  return model ? { model, effort: null } : null
}
function gooseSettings(home) {
  const file =
    process.platform === 'win32' ? join(winDir(home, 'APPDATA', 'Roaming'), 'Block', 'goose', 'config', 'config.yaml') : join(configHome(home), 'goose', 'config.yaml')
  return gooseConfigModel(readText(file))
}
// Aider's .aider.conf.yml (the folder's, then the home's): model and reasoning-effort.
export function aiderConfigModel(yaml) {
  const model = modelId(yamlValue(yaml, 'model'))
  return model ? { model, effort: effortLevel(yamlValue(yaml, 'reasoning-effort')) } : null
}
function aiderSettings(cwd, home) {
  for (const f of [cwd ? join(cwd, '.aider.conf.yml') : null, join(home, '.aider.conf.yml')]) {
    const m = f && aiderConfigModel(readText(f))
    if (m) return m
  }
  return null
}
// Mistral Vibe's config.toml (the folder's .vibe, then its home): active_model.
export function vibeConfigModel(text) {
  const model = modelId(tomlKeys(text).get('').get('active_model'))
  return model ? { model, effort: null } : null
}
function vibeSettings(cwd, home) {
  const own = envDir(process.env.VIBE_HOME) || join(home, '.vibe')
  for (const f of [cwd ? join(cwd, '.vibe', 'config.toml') : null, join(own, 'config.toml')]) {
    const m = f && vibeConfigModel(readText(f))
    if (m) return m
  }
  return null
}

// --- Grok Build -------------------------------------------------------------------------

export const grokHomeDir = (home) => grokHome(home)
const grokEffort = (v) => {
  const s = str(v)
  return s && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(s.toLowerCase()) ? s.toLowerCase() : null
}
// summary.json -> { model, effort, at } or null.
export function grokSummaryModel(o) {
  const model = o && modelId(o.current_model_id)
  if (!model) return null
  return { model, effort: grokEffort(o.reasoning_effort), ...when(timeOf(o.updated_at) || timeOf(o.last_active_at)) }
}
export function grokSummaryFile(id, home = os.homedir()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null
  const root = join(grokHomeDir(home), 'sessions')
  return remembered(`grok|${root}|${id}`, () => {
    for (const d of entries(root)) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue
      const file = join(root, d.name, id, 'summary.json')
      if (statOf(file)) return file
    }
    return null
  })
}
// models_cache.json: a model's name and default effort ({ name, effort } or null).
export function grokCatalogEntry(cache, id) {
  const info = cache && cache.models && typeof cache.models === 'object' && cache.models[id] && cache.models[id].info
  if (!info || typeof info !== 'object') return null
  const efforts = Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : []
  const picked = efforts.find((e) => e && e.default === true)
  const name = str(info.name)
  return { name: name ? name.slice(0, 80) : null, effort: grokEffort(picked && picked.value) || grokEffort(info.reasoning_effort) }
}
function grokCatalog(home) {
  return bySize('grok-models', join(grokHomeDir(home), 'models_cache.json'), (f) => readJson(f))
}
const grokNamed = (found, home) => {
  const entry = grokCatalogEntry(grokCatalog(home), found.model)
  return entry && entry.name ? { ...found, name: entry.name } : found
}
function grokSession(id, home) {
  const file = grokSummaryFile(id, home)
  if (!file) return null
  const found = bySize('grok', file, (f) => grokSummaryModel(readJson(f)))
  return found ? grokNamed(found, home) : null
}
// config.toml's [models] default and default_reasoning_effort -> { model,
// effort } or null.
export function grokConfigModel(text) {
  const models = tomlKeys(text).get('models') || new Map()
  const model = modelId(models.get('default'))
  return model ? { model, effort: grokEffort(models.get('default_reasoning_effort')) } : null
}
// The settings' default (config.toml), else the one Grok Build's settings
// fetch named; an effort the config does not set: that model's default.
function grokSettings(home) {
  const dir = grokHomeDir(home)
  const config = grokConfigModel(readText(join(dir, 'config.toml')))
  let found = config
  if (!found) {
    const cache = bySize('grok-settings', join(dir, 'settings_cache.json'), (f) => {
      const o = readJson(f)
      try {
        return o && typeof o.payload === 'string' ? JSON.parse(o.payload) : o
      } catch {
        return null
      }
    })
    const model = modelId(cache && cache.settings && cache.settings.default_model)
    found = model ? { model, effort: null } : null
  }
  if (!found) return null
  const entry = grokCatalogEntry(grokCatalog(home), found.model)
  return { model: found.model, effort: found.effort || (entry && entry.effort) || null, ...(entry && entry.name ? { name: entry.name } : {}) }
}

// --- For agentModel.js -----------------------------------------------------------------

// The model a pane's running session names, or null: { model, effort,
// name?, at? }. launchedAt: when the pane started (Kilo's session is the
// one of its folder written since).
export function sessionModelOf(agentId, { sessionId = null, cwd = null, launchedAt = 0 } = {}, home = os.homedir()) {
  try {
    if (agentId === 'gemini') {
      const file = geminiSessionFile(sessionId, home)
      return file ? geminiFromFile(file) : null
    }
    if (agentId === 'qwen') {
      const file = qwenSessionFile(sessionId, home)
      return file ? qwenFromFile(file) : null
    }
    if (agentId === 'kimi') return kimiSession(sessionId, home)
    if (agentId === 'pi') return piSession(piSessionsDir(home), sessionId)
    if (agentId === 'omp') return piSession(ompSessionsDir(home), sessionId)
    if (agentId === 'droid') return droidSession(sessionId, home)
    if (agentId === 'opencode') return opencodeDbModel(opencodeDbFile(home), { sessionId, cwd, since: launchedAt })
    if (agentId === 'kilo') return opencodeDbModel(opencodeDbFile(home, 'kilo'), { cwd, since: launchedAt })
    if (agentId === 'zcode') return opencodeDbModel(zcodeDbFile(home), { sessionId })
    if (agentId === 'openclaw') return openclawSession(home)
    if (agentId === 'grok') return grokSession(sessionId, home)
  } catch {
    return null
  }
  return null
}

// The model an agent's settings name (its default), or null.
export function settingsModelOf(agentId, cwd, home = os.homedir()) {
  try {
    if (agentId === 'kimi') return kimiConfigModel(readText(join(kimiHome(home), 'config.toml')))
    if (agentId === 'droid') return droidSettingsModel(readJson(join(home, '.factory', 'settings.json')))
    if (agentId === 'pi') return piSettingsModel(readJson(join(piAgentDir(home), 'settings.json')))
    if (agentId === 'kilo') return kiloConfigModel(cwd, home)
    if (agentId === 'openclaw') return openclawConfigModel(readJson(join(openclawDir(home), 'openclaw.json')))
    if (agentId === 'continue') return continueSettings(home)
    if (agentId === 'crush') return crushSettings(cwd, home)
    if (agentId === 'goose') return gooseSettings(home)
    if (agentId === 'aider') return aiderSettings(cwd, home)
    if (agentId === 'vibe') return vibeSettings(cwd, home)
    if (agentId === 'grok') return grokSettings(home)
  } catch {
    return null
  }
  return null
}

// --effort, --reasoning-effort, --thinking or --thinking-level <level> on an
// agent's command line, as Tessel's effort label (null for a level it has
// no label for, or a bare --thinking).
export function effortFlag(command) {
  const m = /(?:^|\s)--(?:reasoning-effort|effort|thinking-level|thinking)(?:=|\s+)["']?([A-Za-z_-]+)/i.exec(String(command || ''))
  return m ? effortLevel(m[1]) : null
}
// Amp's mode (smart, rush, large, deep): what it runs with, picked by --mode.
export function ampModeFromCommand(command) {
  const m = /(?:^|\s)--mode(?:=|\s+)["']?(smart|rush|large|deep|free)\b/i.exec(String(command || ''))
  return m ? m[1].toLowerCase() : null
}

// Folders whose files say a model changed, for watchModelFiles:
// [{ agent, dir, match, recursive? }].
export function modelWatchTargets(home = os.homedir()) {
  const kimi = kimiHome(home)
  const out = [
    { agent: 'gemini', dir: join(process.env.GEMINI_CLI_HOME || home, '.gemini', 'tmp'), match: /^session-.+\.jsonl$/, recursive: true },
    { agent: 'qwen', dir: qwenProjectsRoot(home), match: /\.jsonl$/, recursive: true },
    { agent: 'kimi', dir: kimi, match: /^config\.toml$/ },
    { agent: 'kimi', dir: join(kimi, 'sessions'), match: /^wire\.jsonl$/, recursive: true },
    { agent: 'pi', dir: piSessionsDir(home), match: /\.jsonl$/, recursive: true },
    { agent: 'pi', dir: piAgentDir(home), match: /^settings\.json$/ },
    { agent: 'omp', dir: ompSessionsDir(home), match: /\.jsonl$/, recursive: true },
    { agent: 'droid', dir: join(home, '.factory'), match: /^settings\.json$/ },
    { agent: 'droid', dir: join(home, '.factory', 'sessions'), match: /\.settings\.json$/, recursive: true },
    { agent: 'opencode', dir: join(dataHome(home), 'opencode'), match: /^opencode\.db/, every: 5000 },
    { agent: 'kilo', dir: join(dataHome(home), 'kilo'), match: /^kilo\.db/, every: 5000 },
    { agent: 'kilo', dir: join(stateHome(home), 'kilo'), match: /^model\.json$/ },
    { agent: 'kilo', dir: join(configHome(home), 'kilo'), match: /^kilo\.jsonc?$/ },
    { agent: 'zcode', dir: join(home, '.zcode', 'cli', 'db'), match: /^db\.sqlite/, every: 5000 },
    { agent: 'openclaw', dir: join(openclawDir(home), 'agents', 'main', 'sessions'), match: /\.jsonl?$/ },
    { agent: 'continue', dir: join(home, '.continue', 'index'), match: /^globalContext\.json$/ },
    { agent: 'continue', dir: join(home, '.continue'), match: /^config\.yaml$/ },
    { agent: 'openclaude', dir: join(home, '.openclaude'), match: /^settings\.json$/ },
    { agent: 'vibe', dir: envDir(process.env.VIBE_HOME) || join(home, '.vibe'), match: /^config\.toml$/ },
    // Grok Build: its settings, and each session's summary (each turn, /model, /effort).
    { agent: 'grok', dir: grokHomeDir(home), match: /^(config\.toml|settings_cache\.json)$/ },
    { agent: 'grok', dir: join(grokHomeDir(home), 'sessions'), match: /^summary\.json$/, recursive: true }
  ]
  return out
}

export function _clearModelSourceCachesForTest() {
  located.clear()
  missed.clear()
  parsed.clear()
}
