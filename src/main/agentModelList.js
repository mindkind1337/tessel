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
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { spawn as nodeSpawn } from 'child_process'
import { MODEL_PROBES, MODEL_PROBE_TIMEOUT_MS, MODEL_PROBE_MAX_OUTPUT, finalizeProbeOutput, validListedModels } from '../shared/agentModelProbe'
import { writeFileAtomic } from './safeJson'

const FILE = 'agent-models.json'
const COMMAND = /^[\w.\-\\/: ]{1,300}$/

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
      if (models.length) out[agent] = { models, fetchedAt: Number.isFinite(e.fetchedAt) ? e.fetchedAt : 0 }
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

// deps (tests): resolve(exe) -> { file, pre, path } | null; spawn like
// child_process.spawn; now().
export function createModelLister(dir, deps = {}) {
  const resolve = deps.resolve
  const spawn = deps.spawn || nodeSpawn
  const now = deps.now || Date.now
  const timeoutMs = deps.timeoutMs || MODEL_PROBE_TIMEOUT_MS
  let lists = loadModelLists(dir)
  const running = new Map() // agent -> promise

  function list() {
    return JSON.parse(JSON.stringify(lists))
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

  async function runProbe(agent, command) {
    const spec = MODEL_PROBES[agent]
    // The agent's own command (Settings > Agents) when it is only a program.
    const exe = typeof command === 'string' && COMMAND.test(command.trim()) && !/\s/.test(command.trim()) ? command.trim() : spec.exe
    let prog = null
    try {
      prog = resolve ? await resolve(exe) : null
    } catch {
      prog = null
    }
    if (!prog) return { ok: false, reason: 'not-found', detail: exe }
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
    if (!result.ok) return result
    const models = validListedModels(result.models)
    if (!models.length) return { ok: false, reason: 'empty', detail: '' }
    const entry = { models, fetchedAt: now() }
    lists = { ...lists, [agent]: entry }
    saveModelLists(dir, lists)
    return { ok: true, ...entry }
  }

  return { list, probe }
}
