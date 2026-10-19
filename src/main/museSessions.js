// Muse Code's own files, read-only: where it keeps them and what its session
// logs say (the model and reasoning effort a conversation runs, its folder,
// its first prompt, what you and it said). After Muse Code's documentation
// (dev.meta.ai/docs/muse-code and its developer guides,
// meta-models.github.io/muse-code-sdk) and Orca's
// src/shared/muse-session-log.ts and its Muse session and usage parsers, MIT,
// Copyright (c) 2026 Lovecast Inc.
//
//   settings  <XDG_CONFIG_HOME or ~/.config>/muse/settings.json, on every
//             platform (MCP servers, hooks, skills next to it in skills/)
//   sessions  <XDG_DATA_HOME or ~/.local/share>/muse/sessions/YYYY/MM/DD/<id>/
//             session.jsonl: the id is a UUIDv7, the folder the local day the
//             session started. A sub-agent's log (and a background
//             reminder's) is subagent/<child id>/session.jsonl inside it.
//
// A log line is one record { record_type, payload_type, recorded_at (µs),
// payload }, or a batch whose children[].record_json carry records as JSON
// text. The records read here:
//   runtime.session.metadata             record { workspace_root, model_id }
//   runtime.session.route_facts          record { cwd }
//   run.model.configured                 record { model_id }: a turn's model
//   runtime.model_reconfigure.completed  record { effective: { model_id } }: /models
//   runtime.reasoning_effort_reconfigure record { reasoning_effort }: /effort
//   runtime.user_intent.accepted         { refill_blocks: [{ text }] }: your prompt
//   runtime.session                      { event: { kind: started (prompt),
//                                          assistant_message_committed (text),
//                                          model_completed (model, usage) } }
// An effort is only ever one of Muse's eight tiers, read under the names its
// session protocol gives it (reasoning_effort, effective.reasoning_effort).
import fs from 'fs'
import os from 'os'
import { isAbsolute, join, relative, sep, win32 } from 'path'

const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
const DAY = 24 * 60 * 60 * 1000

// An XDG folder of the environment: it belongs to the real home only (not a
// test's or another account's home).
function envDir(env, name, home) {
  if (home !== os.homedir()) return ''
  const v = env && typeof env[name] === 'string' ? env[name].trim() : ''
  return v && isAbsolute(v) ? v : ''
}

// --- Where its files are -----------------------------------------------------

export function museConfigDir(home = os.homedir(), env = process.env) {
  return join(envDir(env, 'XDG_CONFIG_HOME', home) || join(home, '.config'), 'muse')
}
export function museSettingsFile(home = os.homedir(), env = process.env) {
  return join(museConfigDir(home, env), 'settings.json')
}
// Its sign-in, where its launcher looks for it: MUSE_AUTH_PATH, else
// auth.json next to its settings ({ schema_version, providers: { meta: {
// access_token, api_key, api_base_url, subs_active, user_email, ... } } }).
export function museAuthFile(home = os.homedir(), env = process.env) {
  const own = envDir(env, 'MUSE_AUTH_PATH', home)
  return own || join(museConfigDir(home, env), 'auth.json')
}
export function museDataDir(home = os.homedir(), env = process.env) {
  return join(envDir(env, 'XDG_DATA_HOME', home) || join(home, '.local', 'share'), 'muse')
}
export function museSessionsDir(home = os.homedir(), env = process.env) {
  return join(museDataDir(home, env), 'sessions')
}

// Is `file` (after links) inside `root` (after links)?
function inside(root, file) {
  try {
    const r = fs.realpathSync.native(root)
    const f = fs.realpathSync.native(file)
    const rel = relative(r, f)
    return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  } catch {
    return false
  }
}
function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

// --- Session ids and their logs --------------------------------------------------

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const museSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id)

// When a session started, from its UUIDv7 id (ms), else 0.
export function museSessionStart(id) {
  const m = typeof id === 'string' ? UUID_V7.exec(id) : null
  return m ? parseInt(`${m[1]}${m[2]}`, 16) : 0
}

function dayParts(date, utc) {
  const y = utc ? date.getUTCFullYear() : date.getFullYear()
  const mo = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const d = utc ? date.getUTCDate() : date.getDate()
  return [String(y), String(mo).padStart(2, '0'), String(d).padStart(2, '0')]
}

// A session's log from its id: its folder is the day its id's time names,
// in Muse's own time zone (which may not be ours): that day, the one before
// and the one after, local and UTC. Only a log inside the sessions folder.
export function museSessionLog(id, sessionsDir = museSessionsDir()) {
  const start = museSessionStart(id)
  if (!start) return null
  const seen = new Set()
  for (const offset of [0, -DAY, DAY]) {
    for (const utc of [false, true]) {
      const file = join(sessionsDir, ...dayParts(new Date(start + offset), utc), id, 'session.jsonl')
      if (seen.has(file)) continue
      seen.add(file)
      if (isFile(file) && inside(sessionsDir, file)) return file
    }
  }
  return null
}

function folders(dir, re) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && re.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

// The session logs, newest day first (and newest first within a day: a
// UUIDv7 sorts by its time): [{ id, file, dir }], at most `max`, none from a
// day well before `since`. The folder's own order is never relied on.
export function museSessionFolders(root = museSessionsDir(), { since = 0, max = 400 } = {}) {
  const out = []
  const oldest = since ? since - 2 * DAY : 0
  for (const y of folders(root, /^\d{4}$/)) {
    for (const mo of folders(join(root, y), /^\d{2}$/)) {
      for (const d of folders(join(root, y, mo), /^\d{2}$/)) {
        // That whole day is older than wanted: so is every day after it.
        if (oldest && new Date(Number(y), Number(mo) - 1, Number(d) + 1).getTime() < oldest) return out
        for (const id of folders(join(root, y, mo, d), SESSION_ID)) {
          const dir = join(root, y, mo, d, id)
          out.push({ id, dir, file: join(dir, 'session.jsonl') })
          if (out.length >= max) return out
        }
      }
    }
  }
  return out
}

// --- Its records ---------------------------------------------------------------

// recorded_at: microseconds (Muse's own), milliseconds, seconds or a date.
export function museTime(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v >= 1e14 ? Math.floor(v / 1000) : v < 1e11 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return museTime(Number(v))
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

// One parsed log line -> its records [{ type, at, payload }] (a batch's
// children unwrapped).
export function museRecords(line) {
  if (!object(line)) return []
  const raw = Array.isArray(line.children)
    ? line.children.map((c) => {
        const j = object(c) ? c.record_json : null
        if (typeof j !== 'string') return j
        try {
          return JSON.parse(j)
        } catch {
          return null
        }
      })
    : [line]
  return raw.filter(object).map((r) => ({ type: str(r.payload_type), at: museTime(r.recorded_at), payload: object(r.payload) ? r.payload : {} }))
}

// Every record of some log text, in order. keep(line): only the lines worth
// parsing (most are big model or tool records). A line cut by a partial read
// is skipped.
export function museTextRecords(text, keep = null) {
  const out = []
  for (const l of String(text || '').split('\n')) {
    const line = l.trim()
    if (!line.startsWith('{') || (keep && !keep(line))) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    for (const r of museRecords(o)) out.push(r)
  }
  return out
}

// --- Model and effort ---------------------------------------------------------------

export const MUSE_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export const museModelId = (v) => (typeof v === 'string' && /^[\w.:/@[\]+-]{1,120}$/.test(v.trim()) ? v.trim() : '')
export const museEffort = (v) => (typeof v === 'string' && MUSE_EFFORTS.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : '')
const effortOf = (r) => (object(r) ? museEffort(r.reasoning_effort) || museEffort(r.reasoningEffort) || museEffort(r.effort) : '')
const EFFORT_SET = /^runtime\.reasoning_effort_reconfigure(\.completed)?$/

// What one record says of the model or effort in force: { model, effort },
// { used } (a model a request was answered with), or null.
function modelFact(rec) {
  const p = rec.payload
  const r = object(p.record) ? p.record : {}
  const eff = object(r.effective) ? r.effective : {}
  if (rec.type === 'runtime.session.metadata' || rec.type === 'run.model.configured') return { model: museModelId(r.model_id), effort: effortOf(r) }
  if (rec.type === 'runtime.model_reconfigure.completed') return { model: museModelId(eff.model_id) || museModelId(r.model_id), effort: effortOf(eff) || effortOf(r) }
  if (EFFORT_SET.test(rec.type)) return { model: '', effort: effortOf(eff) || effortOf(r) }
  if (rec.type === 'runtime.session' && object(p.event) && p.event.kind === 'model_completed') return { used: museModelId(p.event.model) }
  return null
}

// Each change of the model or effort in a log's text, in order: [{ t, model,
// effort }] (both in force from t; effort null until the log names one).
export function museModelTimeline(text) {
  const out = []
  let model = ''
  let effort = ''
  for (const rec of museTextRecords(text, (l) => l.includes('model') || l.includes('effort'))) {
    const f = modelFact(rec)
    if (!f || f.used !== undefined || !rec.at) continue
    const nextModel = f.model || model
    const nextEffort = f.effort || effort
    if (!nextModel || (nextModel === model && nextEffort === effort)) continue
    model = nextModel
    effort = nextEffort
    out.push({ t: rec.at, model, effort: effort || null })
  }
  return out
}

// { model, effort, at } in force at the end of a log's text, or null. The
// model a turn was configured with, or a /models switch, wins over the model
// a request came back from (the only one in an older log); effort: null when
// the log never names one.
export function museModelFromText(text) {
  let model = ''
  let effort = ''
  let used = ''
  let at = 0
  for (const rec of museTextRecords(text, (l) => l.includes('model') || l.includes('effort'))) {
    const f = modelFact(rec)
    if (!f) continue
    if (f.used !== undefined) {
      if (f.used) used = f.used
      continue
    }
    if (f.model) model = f.model
    if (f.effort) effort = f.effort
    if ((f.model || f.effort) && rec.at) at = rec.at
  }
  const m = model || used
  if (!m) return null
  return { model: m, effort: effort || null, ...(at ? { at } : {}) }
}

// --- Prompts, answers, folder ------------------------------------------------------

// eslint-disable-next-line no-control-regex
const folder = (v) => (typeof v === 'string' && (isAbsolute(v) || win32.isAbsolute(v)) && !/[\x00-\x1f]/.test(v) ? v : '')
function firstText(blocks) {
  if (!Array.isArray(blocks)) return ''
  for (const b of blocks) {
    const t = object(b) ? str(b.text) : ''
    if (t) return t
  }
  return ''
}

// The text you typed, from one record ('' when it is not a prompt).
// accepted: Muse took the prompt in (its first, fullest record of it).
export function musePromptOf(rec) {
  const p = rec.payload
  if (rec.type === 'runtime.user_intent.accepted') {
    const t = firstText(p.refill_blocks)
    if (t) return t
    for (const m of Array.isArray(p.model_messages) ? p.model_messages : []) {
      const c = object(m) ? firstText(m.content) : ''
      if (c) return c
    }
    return ''
  }
  if (rec.type === 'runtime.session' && object(p.event) && p.event.kind === 'started') return str(p.event.prompt)
  return ''
}
// An answer Muse committed ('' for any other record, and for what it says
// between its tool calls when the record marks it as commentary).
export function museAnswerOf(rec) {
  const p = rec.payload
  const e = object(p.event) ? p.event : null
  if (rec.type !== 'runtime.session' || !e || e.kind !== 'assistant_message_committed') return ''
  if ([e.phase, e.message_phase, e.messagePhase].includes('commentary')) return ''
  return str(e.text)
}

// A session log's start: { cwd, started, prompt, promptAt, model } from its
// first records (prompt: the first one that is really yours).
export function parseMuseHead(text, isPrompt = (t) => !!t) {
  let cwd = ''
  let started = 0
  let prompt = ''
  let promptAt = 0
  let model = ''
  for (const rec of museTextRecords(text)) {
    if (!started && rec.at) started = rec.at
    const r = object(rec.payload.record) ? rec.payload.record : {}
    if (rec.type === 'runtime.session.metadata') {
      cwd = cwd || folder(r.workspace_root)
      model = model || museModelId(r.model_id)
    } else if (rec.type === 'runtime.session.route_facts') cwd = cwd || folder(r.cwd)
    else if (!prompt) {
      const t = musePromptOf(rec)
      if (t && isPrompt(t)) {
        prompt = t
        promptAt = rec.at
      }
    }
    if (cwd && prompt && model) break
  }
  return { cwd, started, prompt, promptAt: promptAt || started, model }
}

// The conversation in a log, in order: [{ role: 'user' | 'assistant', text,
// at }]. Muse notes a prompt twice (taken in, then its turn started): the
// second is left out when it repeats the one before within a minute.
export function museConversation(text) {
  const out = []
  let last = null // { text, at } of the latest prompt
  for (const rec of museTextRecords(text, (l) => l.includes('user_intent') || l.includes('"started') || l.includes('assistant_message_committed') || l.includes('record_json'))) {
    const prompt = musePromptOf(rec)
    if (prompt) {
      const again = rec.type === 'runtime.session' && last && last.text === prompt && (!rec.at || !last.at || Math.abs(rec.at - last.at) < 60000)
      last = { text: prompt, at: rec.at }
      if (!again) out.push({ role: 'user', text: prompt, at: rec.at })
      continue
    }
    const answer = museAnswerOf(rec)
    if (answer) out.push({ role: 'assistant', text: answer, at: rec.at })
  }
  return out
}
