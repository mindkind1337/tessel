// Which model an agent pane uses, for the pane header.
//
// Best first:
// 1. The running session (Claude Code, OpenClaude, Qoder, Codex, Copilot,
//    Antigravity CLI, Muse Code, Gemini CLI, Qwen Code, Kimi Code, Pi, OMP,
//    Droid: its conversation file; Cline, OpenCode, Kilo, ZCode: their
//    database; OpenClaw: its sessions index), so a change with /model shows up.
// 2. A --model / -m option in the agent's command (and its --effort,
//    --reasoning-effort or --thinking).
// 3. What the agent remembers or its settings file (OpenCode's and Kilo's last
//    picked model, Cline's provider settings, the folder's settings, the
//    user's: agentModelSources.js has the other agents').
// Nothing found: null (the header shows nothing rather than a guess).
// watchModelFiles tells when one of these files changes.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { isUuid, qoderDir, qoderTranscriptIn } from './agentSessions'
import { clineDataDir } from './jsonAgents'
import { normDir, readHead, readRows, readTail as readTailBytes, readText } from './fileRead'
import { latestInFile } from './latestInFile'
import { antigravityLabelParts } from '../shared/antigravityModels'
import { effortLevel } from '../shared/modelLabel'
import { museConfigDir, museEffort, museModelFromText, museModelId, museSessionLog, museSessionsDir, museSettingsFile } from './museSessions'
import { ampModeFromCommand, effortFlag, modelWatchTargets, opencodePicked, sessionModelOf, settingsModelOf } from './agentModelSources'

const TAIL = 256 * 1024
const readTail = (file) => readTailBytes(file, TAIL)

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
  const turn = claudeTurnFromText(text)
  return turn ? turn.model : null
}
// { model, effort } of the latest answer: Claude Code writes the effort the
// turn ran with next to each answer (perTurnEffort, else effort), so a
// session-only /model or /effort pick shows too. effort: null when absent.
// A /model or /effort run in the session after that answer (its command line
// and Claude Code's "Set model to …" / "Set effort level to …" after it) is
// newer: that model or effort, from then (at: when it ran).
export function claudeTurnFromText(text) {
  const lines = String(text || '').split('\n')
  // Newest first: the command's result line comes before its command line.
  let result = null // { kind: 'model' | 'effort', family? } | null: the line after this one
  let picked = null // { model?, effort?, at }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const isCommand = line.includes('<local-command-stdout>') || line.includes('<command-name>')
    if (!line.includes('"model"') && !isCommand) {
      if (line.trim()) result = null
      continue
    }
    try {
      const o = JSON.parse(line)
      if (isCommand && o.type === 'user') {
        const command = claudeCommandLine(o, result)
        result = command.result
        if (command.model && !(picked && picked.model)) picked = { ...picked, model: command.model, at: (picked && picked.at) || command.at }
        if (command.effort && !(picked && picked.effort)) picked = { ...picked, effort: command.effort, at: (picked && picked.at) || command.at }
        continue
      }
      result = null
      const m = o && o.message && o.message.model
      if (o.type !== 'assistant' || o.isSidechain === true || typeof m !== 'string' || !m || m.startsWith('<')) continue
      const e = [o.perTurnEffort, o.effort].find((x) => CLAUDE_EFFORTS.includes(x))
      const at = Date.parse(o.timestamp)
      if (picked) return pickedTurn(picked, m, e || null)
      return { model: m, effort: e || null, ...(Number.isFinite(at) ? { at } : {}) }
    } catch {
      /* a line cut by the tail read */
    }
  }
  return picked ? pickedTurn(picked, null, null) : null
}
// A /model with no effort of its own: Haiku has none; another keeps it.
function pickedTurn(picked, model, effort) {
  const next = picked.model || model
  if (!next) return null
  const kept = picked.effort || (picked.model && /haiku/i.test(picked.model) ? null : effort)
  return { model: next, effort: kept || null, ...(Number.isFinite(picked.at) ? { at: picked.at } : {}) }
}
const CLAUDE_FAMILIES = /^(opus|sonnet|haiku|fable)\b/i
// One user line of a slash command Claude Code ran: its result
// (<local-command-stdout>Set model to `Haiku 4.5`…) or its command
// (<command-name>/model</command-name>…<command-args>haiku</command-args>).
// after: what the next line said ({ kind, family? } | null).
// -> { result, model?, effort?, at }
function claudeCommandLine(o, after) {
  const content = o.message && o.message.content
  const body = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' ? b.text : '')).join('\n') : ''
  const at = Date.parse(o.timestamp)
  const stdout = /<local-command-stdout>([\s\S]{0,400})/.exec(body)
  if (stdout) {
    const m = /^\s*Set model to\s+`?([^`\n]{1,80})/.exec(stdout[1])
    if (m) return { result: { kind: 'model', family: (CLAUDE_FAMILIES.exec(m[1].trim()) || [])[1] } }
    // "Set effort level to medium (saved as your default…)": the level it says
    // is the one in force, whether the command line had it as an argument or
    // came from the /effort picker (no argument: only this line names it).
    const level = /^\s*Set effort level to\s+(low|medium|high|xhigh|max)\b/i.exec(stdout[1])
    return level ? { result: { kind: 'effort' }, effort: level[1].toLowerCase(), at } : { result: null }
  }
  const name = (/<command-name>\/?([\w:.-]{1,40})<\/command-name>/.exec(body) || [])[1]
  const args = ((/<command-args>([^<]{0,100})<\/command-args>/.exec(body) || [])[1] || '').trim()
  if (name === 'model' && after && after.kind === 'model') {
    // A bare /model (its picker): the family Claude Code printed.
    const model = /^[\w.[\]-]{1,80}$/.test(args) ? args : after.family ? after.family.toLowerCase() : null
    return { result: null, model, at }
  }
  if (name === 'effort' && after && after.kind === 'effort' && CLAUDE_EFFORTS.includes(args.toLowerCase())) return { result: null, effort: args.toLowerCase(), at }
  return { result: null }
}

// The model (and reasoning effort) of the latest turn in a Codex rollout,
// and when that turn ran (at: a pick made in Tessel before it gives way).
export function codexModelFromText(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"model"')) continue
    try {
      const o = JSON.parse(line)
      const p = o && o.payload
      if (!p) continue
      const at = Date.parse(o.timestamp)
      const when = Number.isFinite(at) ? { at } : {}
      if (o.type === 'turn_context' && typeof p.model === 'string' && p.model) {
        // Its effort: on the turn, else in its collaboration mode's settings.
        const mode = p.collaboration_mode && p.collaboration_mode.settings
        const effort = p.effort || p.reasoning_effort || (mode && mode.reasoning_effort)
        return { model: p.model, effort: typeof effort === 'string' ? effort : null, ...when }
      }
      const s = p.type === 'thread_settings_applied' && p.thread_settings
      if (s && typeof s.model === 'string' && s.model) {
        const effort = s.reasoning_effort || s.effort
        return { model: s.model, effort: typeof effort === 'string' ? effort : null, ...when }
      }
    } catch {
      /* a line cut by the tail read */
    }
  }
  return null
}

// The model of a Codex rollout file: its latest model line, wherever it is
// (a turn's web results and tool outputs can write megabytes after it), read
// back in chunks and remembered per file (latestInFile.js).
export const codexModelFromFile = latestInFile(codexModelFromText)

const fileCache = new Map() // folder + session id -> transcript path

// The Claude transcript of a session in a Claude folder (~/.claude or a
// CLAUDE_CONFIG_DIR): <dir>/projects/<project>/<id>.jsonl.
export function claudeTranscriptIn(claudeDir, id) {
  const key = `claude|${claudeDir}|${id}`
  const hit = fileCache.get(key)
  if (hit && fs.existsSync(hit)) return hit
  const root = join(claudeDir, 'projects')
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
      fileCache.set(key, f)
      return f
    }
  }
  return null
}

export function claudeTranscript(id, home = os.homedir()) {
  return claudeTranscriptIn(join(home, '.claude'), id)
}

function dayFolder(root, d) {
  return join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
}

// A UUID v7 starts with its creation time (ms): the day its rollout is in.
function uuidV7Time(id) {
  const s = String(id)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return null
  const ms = parseInt(s.slice(0, 8) + s.slice(9, 13), 16)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

// The rollout of a Codex thread in a Codex home (~/.codex or a CODEX_HOME):
// <home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. The days around the
// thread's creation first (a UUID v7 says when), then the last 30 days.
export function codexRolloutIn(codexDir, id, now = Date.now()) {
  const key = `codex|${codexDir}|${id}`
  const hit = fileCache.get(key)
  if (hit && fs.existsSync(hit)) return hit
  const root = join(codexDir, 'sessions')
  const days = []
  const born = uuidV7Time(id)
  if (born) for (const delta of [0, -1, 1]) days.push(new Date(born + delta * 86400000))
  const d = new Date(now)
  // Newest day first, at most 30 days back.
  for (let i = 0; i < 31; i++) {
    days.push(new Date(d))
    d.setDate(d.getDate() - 1)
  }
  const seen = new Set()
  for (const day of days) {
    const dir = dayFolder(root, day)
    if (seen.has(dir)) continue
    seen.add(dir)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    const f = files.find((n) => n.startsWith('rollout-') && n.endsWith(`${id}.jsonl`))
    if (f) {
      fileCache.set(key, join(dir, f))
      return join(dir, f)
    }
  }
  return null
}

function codexRollout(id, home, now = Date.now()) {
  return codexRolloutIn(join(home, '.codex'), id, now)
}

// The model of the latest answer (or /model change) in a Copilot session's
// events.jsonl. "auto" until the first answer says which model it picked.
// Its effort: the one the latest /model set (session.model_change
// reasoningEffort), which the answers after it run with (they do not say).
export function copilotModelFromText(text) {
  return copilotFinish(copilotRecords(text))
}
// -> { answer, change } of a text: its newest /model (change: { model,
// effort, at }) and the newest answer after it (answer: { model, at }), or null.
function copilotRecords(text) {
  const lines = String(text || '').split('\n')
  let answer = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // An answer names "model"; a /model is a "session.model_change" (newModel).
    if (!(line.includes('"model"') || line.includes('"session.model_change"')) || !line.includes('"type":"')) continue
    try {
      const o = JSON.parse(line)
      const d = o && o.data
      if (!d) continue
      const at = Date.parse(o.timestamp)
      const when = Number.isFinite(at) ? { at } : {}
      if (o.type === 'assistant.message' && typeof d.model === 'string' && d.model) {
        if (!answer) answer = { model: d.model, ...when }
        continue
      }
      if (o.type === 'session.model_change' && typeof d.newModel === 'string' && d.newModel) {
        return { answer, change: { model: d.newModel, effort: effortLevel(d.reasoningEffort), ...when } }
      }
    } catch {
      /* a line cut by the tail read */
    }
  }
  return answer ? { answer, change: null } : null
}
// A newer part's /model is what holds; else its answer, at the effort of the
// older part's /model.
const copilotMerge = (newer, older) => {
  if (!newer || newer.change || !older) return newer || older
  return { answer: newer.answer || older.answer, change: older.change }
}
function copilotFinish(r) {
  if (!r) return null
  const { answer, change } = r
  if (answer) return { model: answer.model, effort: change ? change.effort : null, ...(answer.at ? { at: answer.at } : {}) }
  return change ? { model: change.model, effort: change.effort, ...(change.at ? { at: change.at } : {}) } : null
}
const copilotFromFile = latestInFile(copilotRecords, { merge: copilotMerge, done: (r) => !!r.change, finish: copilotFinish })

// The pane's own session (its id found after it started), when it has one.
function copilotSessionFile(id, home) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null
  const file = join(home, '.copilot', 'session-state', id, 'events.jsonl')
  return fs.existsSync(file) ? file : null
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}


// Copilot keeps each session in ~/.copilot/session-state/<id>/, with an
// inuse.<pid>.lock file while a Copilot process has it open. The pane's
// session: one open by a running Copilot, in the pane's folder if any,
// the most recently written first.
function copilotLiveSession(cwd, home) {
  const root = join(home, '.copilot', 'session-state')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return null
  }
  const want = normDir(cwd)
  let best = null
  for (const d of dirs) {
    const dir = join(root, d.name)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    const open = files.some((f) => {
      const m = /^inuse\.(\d+)\.lock$/.exec(f)
      return m && pidAlive(Number(m[1]))
    })
    if (!open || !files.includes('events.jsonl')) continue
    let mtime = 0
    try {
      mtime = fs.statSync(join(dir, 'events.jsonl')).mtimeMs
    } catch {
      continue
    }
    const ws = /^cwd:\s*(.+?)\s*$/m.exec(readText(join(dir, 'workspace.yaml')))
    const here = !!(want && ws && normDir(ws[1]) === want)
    if (!best || here > best.here || (here === best.here && mtime > best.mtime)) {
      best = { file: join(dir, 'events.jsonl'), here, mtime }
    }
  }
  return best ? best.file : null
}

// The Antigravity CLI (agy) notes the model in its conversation's transcript
// (~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
// transcript.jsonl): the prompt after a change says so, the first prompt
// included: <USER_SETTINGS_CHANGE>The user changed setting `Model Selection`
// from None to Gemini 4 Argon (High). …</USER_SETTINGS_CHANGE>. Only agy's
// own note counts, never the user's request beside it.
// -> { model: label, name, effort, at } of the latest change, or null.
export function antigravityModelFromText(text) {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('Model Selection')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue // a line cut by the tail read
    }
    if (!o || o.type !== 'USER_INPUT' || typeof o.content !== 'string') continue
    const notes = o.content.replace(/<USER_REQUEST>[\s\S]*?<\/USER_REQUEST>/g, '')
    const changes = [...notes.matchAll(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/g)]
    for (let j = changes.length - 1; j >= 0; j--) {
      const m = /setting `Model Selection` from .{1,120}? to (.{1,120}?)\.(?: |$)/.exec(changes[j][1].replace(/\s+/g, ' ').trim())
      const parts = m && antigravityLabelParts(m[1])
      if (!parts) continue
      const at = Date.parse(o.created_at)
      return { model: m[1].trim(), name: parts.name, effort: parts.effort, ...(Number.isFinite(at) ? { at } : {}) }
    }
  }
  return null
}

// Each model agy noted, oldest first: [{ t, model, effort }] (Conversations:
// the model each line ran with, as its model list names it).
export function antigravityModelTimeline(lines) {
  const out = []
  for (const line of lines || []) {
    if (!String(line).includes('Model Selection')) continue
    const m = antigravityModelFromText(line)
    if (m && m.at) out.push({ t: m.at, model: m.name, effort: m.effort || null })
  }
  return out
}

export function antigravityTranscript(id, home = os.homedir()) {
  if (!isUuid(id)) return null
  const f = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl')
  return fs.existsSync(f) ? f : null
}

// Its latest change, else (a long conversation) the one its first prompt notes.
function antigravitySession(id, home) {
  const f = antigravityTranscript(id, home)
  if (!f) return null
  return antigravityModelFromText(readTail(f)) || antigravityModelFromText(readHead(f, TAIL))
}

// agy saves the model picked last (/model, /effort, in any agy) as its label:
// ~/.gemini/antigravity-cli/settings.json { "model": "Gemini 4 Argon (High)" }.
function antigravitySettings(home) {
  const label = jsonModel(join(home, '.gemini', 'antigravity-cli', 'settings.json'), plainModel)
  const parts = label && antigravityLabelParts(label)
  return parts ? { model: label, name: parts.name, effort: parts.effort } : null
}

// Muse Code notes the model and effort in its session log (museSessions.js):
// the model of each turn, each /models switch, each /effort. A long session's
// latest change is in its tail; else its start says what it opened with.
export function museSession(id, home = os.homedir()) {
  const f = museSessionLog(id, museSessionsDir(home))
  if (!f) return null
  const tail = museModelFromText(readTail(f))
  if (tail && tail.effort) return tail
  const head = museModelFromText(readHead(f, TAIL))
  if (!tail) return head
  return head && head.effort ? { ...tail, effort: head.effort } : tail
}

// --reasoning-effort <level> (or its alias --effort) on Muse's command line:
// its eight tiers.
export function museEffortFromCommand(command) {
  const m = /(?:^|\s)--(?:reasoning-)?effort(?:=|\s+)["']?([a-z]+)/i.exec(String(command || ''))
  return (m && museEffort(m[1])) || null
}

// Muse's model defaults in its settings.json. Their keys are not documented:
// only the names its own flags and session records use (model / model_id,
// reasoning_effort), at the top or under "model", and only a plain model id
// or one of its eight tiers.
export function museSettingsModel(home = os.homedir()) {
  let o
  try {
    o = JSON.parse(readText(museSettingsFile(home)))
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const nested = o.model && typeof o.model === 'object' ? o.model : {}
  const model = museModelId(o.model) || museModelId(o.model_id) || museModelId(o.default_model) || museModelId(nested.id) || museModelId(nested.model_id) || museModelId(nested.default)
  if (!model) return null
  const effort = museEffort(o.reasoning_effort) || museEffort(nested.reasoning_effort) || museEffort(nested.effort)
  return { model, effort: effort || null }
}

// Cline 3 lists its sessions in <data>/db/sessions.db (SQLite), each with
// the process running it, its folder, provider and model. The pane's: one
// still open whose process runs, in the pane's folder first.
export function clineSessionModel(rows, cwd, alive = pidAlive) {
  const want = normDir(cwd)
  let best = null
  for (const r of rows || []) {
    if (!r || r.ended_at || r.is_subagent || !r.model || !alive(Number(r.pid))) continue
    const here = !!(want && normDir(r.cwd) === want)
    const at = Date.parse(r.updated_at || '') || 0
    if (!best || here > best.here || (here === best.here && at > best.at)) best = { here, at, model: r.model }
  }
  return best ? { model: best.model, at: best.at } : null
}

function clineLive(cwd, home) {
  const rows = readRows(
    join(clineDataDir(home), 'db', 'sessions.db'),
    'SELECT pid, model, cwd, ended_at, is_subagent, updated_at FROM sessions WHERE ended_at IS NULL ORDER BY updated_at DESC LIMIT 50'
  )
  return rows.length ? clineSessionModel(rows, cwd) : null
}

// Cline's provider settings: the provider in use, its model (none set: the
// provider's own default, which is not written anywhere) and its reasoning
// effort ({ reasoning: { enabled, effort } }; turned off: none).
function clineSettings(home) {
  const file = join(clineDataDir(home), 'settings', 'providers.json')
  const o = parseLoose(readText(file))
  const p = o && o.lastUsedProvider && o.providers && o.providers[o.lastUsedProvider]
  const m = p && p.settings && p.settings.model
  if (typeof m !== 'string' || !m) return null
  const r = p.settings.reasoning && typeof p.settings.reasoning === 'object' ? p.settings.reasoning : null
  const effort = r ? (r.enabled === false ? 'none' : effortLevel(r.effort)) : null
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    /* read just above */
  }
  return { model: m, effort, mtime }
}

// --- 2. The command's own option ----------------------------------------------

export function modelFromCommand(command) {
  const text = String(command || '')
  const m = /(?:^|\s)(?:--model|-m)(?:=|\s+)("([^"]+)"|'([^']+)'|([^\s"']+))/.exec(text)
  if (m) return m[2] || m[3] || m[4]
  // ollama run <model>: the first word after "run" that is not an option
  // (nor the value of one).
  const words = []
  const re = /"([^"]*)"|(\S+)/g
  let w
  while ((w = re.exec(text))) words.push(w[1] !== undefined ? w[1] : w[2])
  for (let i = 0; i < words.length - 1; i++) {
    if (!/(^|[\\/])ollama(\.exe)?$/i.test(words[i]) || words[i + 1] !== 'run') continue
    for (let j = i + 2; j < words.length; j++) {
      const t = words[j]
      if (/^--(format|keepalive|dimensions|think)$/.test(t)) j++
      else if (!t.startsWith('-')) return t
    }
  }
  return null
}

// The models Ollama has loaded now (its local API), newest first. Only one:
// that one; several: unknown (which pane uses which is not told).
export async function ollamaRunningModel(fetchImpl = globalThis.fetch) {
  if (!fetchImpl) return null
  try {
    const res = await fetchImpl('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const data = await res.json()
    const models = Array.isArray(data && data.models) ? data.models : []
    return models.length === 1 && typeof models[0].name === 'string' ? models[0].name : null
  } catch {
    return null // Ollama not running
  }
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

// Claude Code's effort from its settings: modelSettings[<model id>].effortLevel
// for that model, else the top-level effortLevel; local, project, then user
// settings, the first that says. model: the full id in use, or null.
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export function claudeSettingsEffort(model, cwd, home) {
  const files = []
  if (cwd) files.push(join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'))
  files.push(join(home, '.claude', 'settings.json'))
  const id = typeof model === 'string' ? model.replace(/\[1m\]$/i, '').toLowerCase() : ''
  let general = null
  for (const f of files) {
    const o = parseLoose(readText(f))
    if (!o || typeof o !== 'object') continue
    const per = o.modelSettings && typeof o.modelSettings === 'object' ? o.modelSettings : null
    if (id && per) {
      for (const [key, value] of Object.entries(per)) {
        const level = value && typeof value === 'object' ? value.effortLevel : null
        const k = key.toLowerCase()
        // An alias (fable, opus…) matches its full id (claude-fable-5-1).
        const hit = k === id || (/^[a-z]+$/.test(id) && k.includes(`-${id}-`))
        if (hit && CLAUDE_EFFORTS.includes(level)) return level
      }
    }
    if (!general && CLAUDE_EFFORTS.includes(o.effortLevel)) general = o.effortLevel
  }
  return general
}

// Cursor keeps its last pick (its /model picker, --model) in cli-config.json:
// { model: { modelId: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna 272K Medium' } }.
// -> { model, name: 'GPT-5.6 Luna', effort: 'medium' }: the full name, so the
// header never shows only "GPT-5.6" when Cursor has several of them.
const CURSOR_EFFORT_WORDS = [['extra high', 'xhigh'], ['minimal', 'minimal'], ['medium', 'medium'], ['high', 'high'], ['low', 'low'], ['max', 'max'], ['none', 'none']]
export function cursorConfigModel(text) {
  let m = null
  try {
    m = JSON.parse(text || '').model
  } catch {
    return null
  }
  const id = m && typeof m.modelId === 'string' && /^[\w.-]{1,80}$/.test(m.modelId) ? m.modelId : null
  if (!id) return null
  let name = typeof m.displayName === 'string' ? m.displayName.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  let effort = null
  for (const [word, value] of CURSOR_EFFORT_WORDS) {
    const re = new RegExp(`\\s${word}(?=\\s|$)`, 'i') // i18n-ignore
    if (re.test(name)) {
      effort = value
      name = name.replace(re, '')
      break
    }
  }
  // The context size ("272K") is not part of its name.
  name = name.replace(/\s\d+(?:\.\d+)?[KM]\b/g, '').trim()
  return { model: id, ...(name ? { name } : {}), ...(effort ? { effort } : {}) }
}

function settingsModel(agentId, cwd, home, codexDir = null) {
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
  if (agentId === 'openclaude') {
    // A Claude Code fork: its own settings.json { model, effortLevel }.
    const o = parseLoose(readText(join(home, '.openclaude', 'settings.json')))
    const m = o && typeof o.model === 'string' && o.model.trim() ? o.model.trim() : null
    return m ? { model: m, effort: CLAUDE_EFFORTS.includes(o.effortLevel) ? o.effortLevel : null } : null
  }
  if (agentId === 'codex') return codexModelFromToml(readText(join(codexDir || join(home, '.codex'), 'config.toml')))
  if (agentId === 'cursor') return cursorConfigModel(readText(join(home, '.cursor', 'cli-config.json')))
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
    for (const f of [join(home, '.copilot', 'settings.json'), join(home, '.copilot', 'config.json')]) {
      const m = jsonModel(f, plainModel)
      if (m) return { model: m }
    }
    return null
  }
  return null
}

// { model, effort, source: 'session' | 'command' | 'picked' | 'settings' } or null.
// launchedAt (ms): when the pane started, so a model picked in OpenCode
// since then beats its settings file.
export function agentModel(query = {}, home = os.homedir()) {
  const res = agentModelFound(query, home)
  // The pane's own model choice (launched with it): its effort from Claude's
  // settings, for the header when the pane chose no effort itself.
  const chosen = typeof query.chosenModel === 'string' && /^[\w.[\]-]{1,80}$/.test(query.chosenModel) ? query.chosenModel : null
  if (query.agentId !== 'claude') return res
  // Claude Code: an effort always, whatever gave the model (its --effort
  // flag, else its settings for that model, else its general effortLevel).
  const flagEffort = effortFromCommand(query.command)
  const withEffort = res && !res.effort ? { ...res, effort: flagEffort || claudeSettingsEffort(res.model, query.cwd, home) } : res
  if (chosen) {
    // The session runs the chosen model: the effort its latest answer used.
    const sameModel = withEffort && withEffort.source === 'session' && sameClaudeModel(withEffort.model, chosen)
    const chosenEffort = (sameModel && withEffort.effort) || flagEffort || claudeSettingsEffort(chosen, query.cwd, home)
    return withEffort ? { ...withEffort, chosenEffort } : { model: null, effort: null, source: null, chosenEffort }
  }
  return withEffort
}
// Same model: a full id and its alias ("claude-fable-5-1", "fable"), [1m] aside.
export function sameClaudeModel(a, b) {
  const x = String(a || '').replace(/\[1m\]$/i, '').toLowerCase()
  const y = String(b || '').replace(/\[1m\]$/i, '').toLowerCase()
  if (!x || !y) return false
  const alias = (full, short) => /^[a-z]+$/.test(short) && full.includes(`-${short}-`)
  return x === y || alias(x, y) || alias(y, x)
}
// --effort <level> on an agent's command line.
export function effortFromCommand(command) {
  const m = /(?:^|\s)--effort(?:=|\s+)["']?(low|medium|high|xhigh|max)\b/i.exec(String(command || ''))
  return m ? m[1].toLowerCase() : null
}
// codexDir: the Codex home of the pane's account (main resolves it from the
// account; never a path from the window).
function agentModelFound({ agentId, sessionId, command, cwd, launchedAt = 0, codexDir = null } = {}, home = os.homedir()) {
  if (!agentId) return null
  if (agentId === 'copilot') {
    // The pane's own session, else one a running Copilot has open (in the
    // pane's folder first).
    const f = copilotSessionFile(sessionId, home) || copilotLiveSession(cwd, home)
    const m = f && copilotFromFile(f)
    if (m) return { ...m, effort: m.effort || effortFlag(command), source: 'session' }
  }
  if (agentId === 'cline') {
    const live = clineLive(cwd, home)
    const set = clineSettings(home)
    // Its effort: the provider's reasoning setting, for the model set there.
    const effortOf = (model) => (set && set.model === model ? set.effort : null)
    // A model picked in Cline after its session was written: that one.
    if (live && !(set && set.mtime > live.at)) return { model: live.model, effort: effortOf(live.model), source: 'session' }
    const flag = modelFromCommand(command)
    if (flag) return { model: flag, effort: effortFlag(command) || effortOf(flag), source: 'command' }
    return set ? { model: set.model, effort: set.effort, source: 'settings' } : null
  }
  if (agentId === 'antigravity') {
    // Its conversation (a /model or /effort shows with the next prompt; the
    // pane reads agy's footer for at once), its --model / --effort, then the
    // model agy saved last.
    const session = isUuid(sessionId) ? antigravitySession(sessionId, home) : null
    if (session) return { ...session, source: 'session' }
    const flag = modelFromCommand(command)
    const flagEffort = effortFromCommand(command)
    const saved = antigravitySettings(home)
    if (flag) return { model: flag, effort: flagEffort, source: 'command' }
    // --effort alone: the saved model at that effort.
    if (flagEffort && saved) return { model: saved.name, name: saved.name, effort: flagEffort, source: 'command' }
    return saved ? { ...saved, source: 'settings' } : null
  }
  if (agentId === 'muse') {
    // Its session log (a /models or /effort shows with its next record), its
    // --model / --reasoning-effort, then its settings' defaults. The effort
    // of a flag or the settings fills in a log that names none.
    const flagEffort = museEffortFromCommand(command)
    const saved = museSettingsModel(home)
    const session = isUuid(sessionId) ? museSession(sessionId, home) : null
    if (session) return { ...session, effort: session.effort || flagEffort || (saved && saved.model === session.model ? saved.effort : null), source: 'session' }
    const flag = modelFromCommand(command)
    if (flag) return { model: flag, effort: flagEffort || (saved && saved.model === flag ? saved.effort : null), source: 'command' }
    return saved ? { model: saved.model, effort: flagEffort || saved.effort, source: 'settings' } : null
  }
  if (isUuid(sessionId)) {
    if (agentId === 'claude') {
      const f = claudeTranscript(sessionId, home)
      const turn = f && claudeTurnFromText(readTail(f))
      const m = turn && turn.model
      if (m) {
        // The transcript never says 1M context; the settings do (opus[1m]).
        const set = settingsModel('claude', cwd, home)
        const big = set && /^(\w+)\[1m\]$/i.exec(set.model)
        const same = big && m.toLowerCase().includes(big[1].toLowerCase())
        return { model: same ? m + '[1m]' : m, effort: turn.effort || claudeSettingsEffort(m, cwd, home), source: 'session', ...(turn.at ? { at: turn.at } : {}) }
      }
    } else if (agentId === 'openclaude' || agentId === 'qoder') {
      // Claude Code's transcript format, in their own folders (the effort as
      // Claude Code writes it on each answer, when they do).
      const f = agentId === 'openclaude' ? claudeTranscriptIn(join(home, '.openclaude'), sessionId) : qoderTranscriptIn(qoderDir(home), sessionId)
      const turn = f && claudeTurnFromText(readTail(f))
      if (turn && turn.model) return { model: turn.model, effort: turn.effort || effortFlag(command), source: 'session', ...(turn.at ? { at: turn.at } : {}) }
    } else if (agentId === 'codex') {
      const f = codexDir ? codexRolloutIn(codexDir, sessionId) : codexRollout(sessionId, home)
      const m = f && codexModelFromFile(f)
      if (m) return { ...m, source: 'session' }
    }
  }
  // The other agents' own session (agentModelSources.js: Gemini, Qwen, Kimi,
  // Pi, OMP, Droid, OpenCode, Kilo, ZCode, OpenClaw). A model picked in
  // OpenCode's or Kilo's model list after the session's latest message is
  // newer; one picked since the pane started beats even its --model.
  const flagEffort = effortFlag(command)
  const picked = agentId === 'opencode' || agentId === 'kilo' ? opencodePicked(home, agentId) : null
  const session = sessionModelOf(agentId, { sessionId, cwd, launchedAt }, home)
  if (session && session.model && !(picked && session.at && picked.mtime > session.at + 1000)) return { ...session, effort: session.effort || flagEffort, source: 'session' }
  if (picked && launchedAt && picked.mtime >= launchedAt) return { model: picked.model, effort: picked.effort, source: 'picked' }
  // Amp runs a mode (smart, rush, large, deep) rather than a model.
  const flag = (agentId === 'amp' && ampModeFromCommand(command)) || modelFromCommand(command)
  if (flag) return { model: flag, effort: flagEffort, source: 'command' }
  const s = settingsModel(agentId, cwd, home, codexDir) || settingsModelOf(agentId, cwd, home)
  if (s) {
    const effort = flagEffort || s.effort || (agentId === 'claude' ? claudeSettingsEffort(s.model, cwd, home) : null)
    return { model: s.model, effort, source: 'settings', ...(s.name ? { name: s.name } : {}) }
  }
  return picked ? { model: picked.model, effort: picked.effort, source: 'picked' } : null
}

// --- Watching: a model change shows right away ---------------------------------
// The files where agents keep their model are watched; a change calls
// onChange(agentId) (at most about once a second per agent), so the panes of
// that agent read it again. A folder that does not exist yet is tried again
// every minute (an agent installed later).
export function watchModelFiles(onChange, home = os.homedir()) {
  const state = process.env.XDG_STATE_HOME || join(home, '.local', 'state')
  const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  const cline = clineDataDir(home)
  const targets = [
    { agent: 'claude', dir: join(home, '.claude'), match: /^settings\.json$/ },
    { agent: 'codex', dir: join(home, '.codex'), match: /^config\.toml$/ },
    { agent: 'gemini', dir: join(home, '.gemini'), match: /^settings\.json$/ },
    { agent: 'qwen', dir: join(home, '.qwen'), match: /^settings\.json$/ },
    { agent: 'copilot', dir: join(home, '.copilot'), match: /^(settings|config)\.json$/ },
    { agent: 'copilot', dir: join(home, '.copilot', 'session-state'), match: /events\.jsonl$/, recursive: true },
    { agent: 'opencode', dir: join(state, 'opencode'), match: /^model\.json$/ },
    { agent: 'opencode', dir: join(cfg, 'opencode'), match: /^opencode\.jsonc?$/ },
    { agent: 'cline', dir: join(cline, 'settings'), match: /^providers\.json$/ },
    { agent: 'cline', dir: join(cline, 'db'), match: /^sessions\.db/ },
    // Cursor writes its last pick there (its /model picker, --model): its
    // panes read their status line again.
    { agent: 'cursor', dir: join(home, '.cursor'), match: /^cli-config\.json$/ },
    // The Antigravity CLI saves each /model and /effort there: its panes read
    // their footer again.
    { agent: 'antigravity', dir: join(home, '.gemini', 'antigravity-cli'), match: /^settings\.json$/ },
    // Muse Code: its settings' defaults, and its session logs (each /models
    // and /effort is a record there).
    { agent: 'muse', dir: museConfigDir(home), match: /^settings\.json$/ },
    { agent: 'muse', dir: museSessionsDir(home), match: /^session\.jsonl$/, recursive: true },
    // The other agents' sessions and settings (agentModelSources.js): Gemini,
    // Qwen, Kimi, Pi, OMP, Droid, OpenCode's and Kilo's databases, ZCode,
    // OpenClaw, Continue, OpenClaude, Mistral Vibe.
    ...modelWatchTargets(home)
  ]
  const watchers = new Map() // target -> fs.FSWatcher
  const timers = new Map() // agent -> timeout
  const last = new Map() // agent -> last call (ms)
  let closed = false
  // every: the least time between two calls for that file (a database being
  // written while its agent streams an answer: every 5 s).
  const fire = (agent, every = 1000) => {
    if (closed || timers.has(agent)) return
    const wait = Math.max(300, every - (Date.now() - (last.get(agent) || 0)))
    timers.set(
      agent,
      setTimeout(() => {
        timers.delete(agent)
        last.set(agent, Date.now())
        if (!closed) onChange(agent)
      }, wait)
    )
  }
  const attach = () => {
    for (const t of targets) {
      if (watchers.has(t) || !fs.existsSync(t.dir)) continue
      try {
        const w = fs.watch(t.dir, { recursive: !!t.recursive, persistent: false }, (_ev, name) => {
          if (!name || t.match.test(String(name).replace(/\\/g, '/').split('/').pop())) fire(t.agent, t.every)
        })
        w.on('error', () => {
          // The folder went away: watch it again when it is back.
          try {
            w.close()
          } catch {
            /* closed */
          }
          watchers.delete(t)
        })
        watchers.set(t, w)
      } catch {
        /* not watchable now: next minute */
      }
    }
  }
  attach()
  const retry = setInterval(attach, 60000)
  if (retry.unref) retry.unref()
  return () => {
    closed = true
    clearInterval(retry)
    for (const w of watchers.values()) {
      try {
        w.close()
      } catch {
        /* closed */
      }
    }
    watchers.clear()
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }
}

// agentModel, plus what needs asking a running program (Ollama's API).
export async function agentModelLive(q = {}, home = os.homedir(), fetchImpl = globalThis.fetch) {
  const found = agentModel(q, home)
  if (found || q.agentId !== 'ollama') return found
  const running = await ollamaRunningModel(fetchImpl)
  return running ? { model: running, effort: null, source: 'running' } : null
}
