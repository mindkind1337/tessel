// The models each agent's own CLI lists (Settings > Agents > Refresh models),
// after Orca's model discovery (src/main/text-generation/
// commit-message-model-discovery.ts and src/main/native-chat/
// agent-model-catalog/agent-model-catalog-store.ts, MIT, Copyright (c) 2026
// Lovecast Inc.).
//
// A probe runs only when asked: the CLI is started directly (argument array,
// no shell), non-interactively, with Orca's listing arguments
// (shared/agentModelProbe.js), stdin closed or carrying Claude's one
// list_models request, stopped after 60 s or 4 MB. Success only is kept
// (userData/agent-models.json), so a failed probe never replaces a good list;
// the window reads the kept list at start without running anything.
// The files of the program a probe ran are noted with the list (their size
// and time): an agent updated since (npm install -g, its own updater) says so
// by a look at them, nothing started, and its menu reads the list again: a
// new model (Fable 5.2) was missing for a day after Claude Code's update
// (2026-11-10).
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawn as nodeSpawn } from 'child_process'
import { MODEL_PROBES, MODEL_PROBE_TIMEOUT_MS, MODEL_PROBE_MAX_OUTPUT, finalizeProbeOutput, validListedModels } from '../shared/agentModelProbe'
import { writeFileAtomic } from './safeJson'
import { findMuse, museServe } from './museServe'
import { museCatalogModelList } from './museCatalog'

const FILE = 'agent-models.json'
// An agent's command that is only a program: a name or a path (Windows short
// names like RUNNER~1 included), never a shell line.
const COMMAND = /^[\w.\-\\/:~ ]{1,300}$/

// { [agent]: { models, fetchedAt } } from disk; {} when absent or damaged.
export function loadModelLists(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(join(dir, FILE), 'utf8'))
    const out = {}
    if (!data || typeof data !== 'object') return out
    for (const agent of Object.keys(MODEL_PROBES)) {
      const e = data[agent]
      if (!e || typeof e !== 'object') continue
      const models = validListedModels(e.models)
      if (!models.length) continue
      out[agent] = { models, fetchedAt: Number.isFinite(e.fetchedAt) ? e.fetchedAt : 0 }
      const files = Array.isArray(e.programFiles) ? e.programFiles.filter((p) => typeof p === 'string' && p && p.length <= 1024).slice(0, 8) : null
      if (files && typeof e.programSig === 'string') {
        out[agent].programFiles = files
        out[agent].programSig = e.programSig.slice(0, 4000)
      }
    }
    return out
  } catch {
    return {}
  }
}

function saveModelLists(dir, lists) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    writeFileAtomic(join(dir, FILE), JSON.stringify(lists, null, 2))
  } catch {
    /* kept in memory until the next success */
  }
}

// The files of a resolved program (the executable, or node and its script):
// those that exist as files. -> [path]
export function programFiles(prog, stat = fs.statSync) {
  if (!prog || typeof prog.file !== 'string') return []
  const out = []
  for (const p of [prog.file, ...(Array.isArray(prog.pre) ? prog.pre : [])]) {
    if (typeof p !== 'string' || !p || p.startsWith('-') || p.length > 1024 || out.includes(p)) continue
    try {
      if (stat(p).isFile()) out.push(p)
    } catch {
      /* not a file (a bare name, an argument) */
    }
  }
  return out.slice(0, 8)
}
// Their size and time, as one string ('' when none can be read).
export function filesSig(files, stat = fs.statSync) {
  const parts = []
  for (const p of files || []) {
    try {
      const st = stat(p)
      parts.push(`${p}:${st.size}:${Math.round(st.mtimeMs)}`)
    } catch {
      parts.push(`${p}:gone`)
    }
  }
  return parts.join('|').slice(0, 4000)
}

// deps (tests): resolve(exe) -> { file, pre, path } | null; spawn like
// child_process.spawn; now(); findMsp(env) -> the program a protocol probe
// runs (Muse: museServe.js findMuse).
export function createModelLister(dir, deps = {}) {
  const resolve = deps.resolve
  const spawn = deps.spawn || nodeSpawn
  const now = deps.now || Date.now
  const timeoutMs = deps.timeoutMs || MODEL_PROBE_TIMEOUT_MS
  const stat = deps.stat || fs.statSync
  let lists = loadModelLists(dir)
  const running = new Map() // agent -> promise

  // The window's copy: the models and when (the program's files stay here).
  function list() {
    const out = {}
    for (const [agent, e] of Object.entries(lists)) out[agent] = { models: e.models, fetchedAt: e.fetchedAt }
    return JSON.parse(JSON.stringify(out))
  }

  // -> { ok: true, models, fetchedAt } | { ok: false, reason, detail }
  // reason: 'unsupported' | 'not-found' | 'failed' | 'timeout' | 'too-much' | 'empty'
  function probe(agent, command = '') {
    if (!Object.prototype.hasOwnProperty.call(MODEL_PROBES, agent)) return Promise.resolve({ ok: false, reason: 'unsupported', detail: '' })
    if (running.has(agent)) return running.get(agent)
    const run = runProbe(agent, command).finally(() => running.delete(agent))
    running.set(agent, run)
    return run
  }

  // An agent asked over its own protocol (Muse Code: `muse serve`, its
  // model/list query): its answer is parsed like a listing.
  async function runProtocolProbe(agent, spec) {
    // Muse Code: the catalog it keeps on this computer first (museCatalog.js),
    // so its binary is only started when it has none yet.
    try {
      const catalog = await (deps.museCatalog || museCatalogModelList)()
      if (catalog) return finalizeProbeOutput(agent, JSON.stringify(catalog), '', 0)
    } catch {
      // unreadable: ask Muse itself
    }
    const env = { ...(deps.env || process.env) }
    const file = (deps.findMsp || ((e) => findMuse({ env: e })))(env)
    if (!file) return { ok: false, reason: 'not-found', detail: spec.exe }
    const res = await museServe(file, [{ method: spec.msp }], { spawn, env, cwd: os.homedir(), timeoutMs })
    if (!res.ok) return { ok: false, reason: res.reason === 'timeout' ? 'timeout' : res.reason === 'missing' ? 'not-found' : 'failed', detail: '' }
    const answer = res.results[spec.msp]
    if (!answer || answer.error) return { ok: false, reason: 'failed', detail: answer && answer.error ? `${answer.error.code}: ${answer.error.message}`.slice(0, 300) : '' }
    return finalizeProbeOutput(agent, JSON.stringify(answer.result), '', 0)
  }

  async function runProbe(agent, command) {
    const spec = MODEL_PROBES[agent]
    if (spec.msp) return keep(agent, await runProtocolProbe(agent, spec))
    // The agent's own command (Settings > Agents) when it is only a program.
    const exe = typeof command === 'string' && COMMAND.test(command.trim()) && !/\s/.test(command.trim()) ? command.trim() : spec.exe
    let prog = null
    try {
      prog = resolve ? await resolve(exe) : null
    } catch {
      prog = null
    }
    if (!prog) return { ok: false, reason: 'not-found', detail: exe }
    const files = programFiles(prog, stat)
    const program = { programFiles: files, programSig: filesSig(files, stat) }
    const env = { ...(deps.env || process.env) }
    if (prog.path) {
      for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k]
      env.Path = prog.path
    }
    const result = await new Promise((done) => {
      let out = ''
      let err = ''
      let finished = false
      let child
      const end = (res) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        done(res)
      }
      const stop = () => {
        try {
          child.kill()
        } catch {
          /* gone */
        }
      }
      try {
        child = spawn(prog.file, [...(prog.pre || []), ...spec.args], {
          cwd: os.homedir(),
          env,
          windowsHide: true,
          stdio: [spec.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
        })
      } catch (e) {
        return done({ ok: false, reason: 'failed', detail: String((e && e.message) || e).slice(0, 300) })
      }
      const timer = setTimeout(() => {
        stop()
        end({ ok: false, reason: 'timeout', detail: '' })
      }, timeoutMs)
      const onData = (append) => (chunk) => {
        const text = String(chunk)
        if (out.length + err.length + text.length > MODEL_PROBE_MAX_OUTPUT) {
          stop()
          return end({ ok: false, reason: 'too-much', detail: '' })
        }
        append(text)
      }
      if (child.stdout) child.stdout.on('data', onData((t) => (out += t)))
      if (child.stderr) child.stderr.on('data', onData((t) => (err += t)))
      child.on('error', (e) =>
        end({ ok: false, reason: e && e.code === 'ENOENT' ? 'not-found' : 'failed', detail: String((e && e.message) || e).slice(0, 300) })
      )
      child.on('close', (code) => end(finalizeProbeOutput(agent, out, err, code)))
      if (spec.stdin !== null && child.stdin) {
        child.stdin.on('error', () => {})
        child.stdin.end(spec.stdin)
      }
    })
    return keep(agent, result, program)
  }

  // A probe's success kept (on disk too); a failure changes nothing.
  function keep(agent, result, program = null) {
    if (!result.ok) return result
    const models = validListedModels(result.models)
    if (!models.length) return { ok: false, reason: 'empty', detail: '' }
    const entry = { models, fetchedAt: now() }
    lists = { ...lists, [agent]: program ? { ...entry, ...program } : entry }
    saveModelLists(dir, lists)
    return { ok: true, ...entry }
  }

  // Whether the agent's program changed since its kept list was read: its
  // files looked at again (nothing started). A list kept before Tessel
  // noted them: true, once (the next probe notes them). No list, a protocol
  // agent (Muse), or a program whose files are not known (a bare name on
  // Linux): false.
  function changed(agent) {
    const spec = Object.prototype.hasOwnProperty.call(MODEL_PROBES, agent) ? MODEL_PROBES[agent] : null
    const entry = lists[agent]
    if (!spec || spec.msp || !entry) return false
    if (!Array.isArray(entry.programFiles)) return true
    if (!entry.programFiles.length) return false
    return filesSig(entry.programFiles, stat) !== entry.programSig
  }

  return { list, probe, changed }
}
