// The models an agent on an SSH host can run (Codex): what its own CLI there
// was told, read from the catalog it keeps (models_cache.json in its Codex
// folder: the host's sign-in, or one account folder Tessel made there), over
// the host's connection (remoteFs.js readCodexModels). This computer's list
// (agentModelList.js) says what this computer's Codex can run: the host's is
// another version, maybe another account, so a model listed here (GPT-6.2
// Astra with Codex 0.172) was refused there on every message (Codex 0.160:
// "model_not_in_accessible_catalog", 2026-11-26).
//
// Nothing is started on the host and nothing is written there. A list read
// is kept (userData/agent-host-models.json) so a pane has it when Tessel
// starts; a read that fails, or a host without the file, changes nothing.
import fs from 'fs'
import { join } from 'path'
import { parseCodexModelList, validListedModels } from '../shared/agentModelProbe'
import { writeFileAtomic } from './safeJson'

const FILE = 'agent-host-models.json'
export const HOST_MODEL_AGENTS = ['codex']
export const MAX_HOST_LISTS = 60
const HOST = /^[\w-]{1,80}$/
const ACCOUNT = /^[0-9a-z]{1,40}$/
const KEY = /^[\w-]{1,80}\|codex\|[0-9a-z]{0,40}$/

// The same key the window uses (agentModels.js hostModelKey).
export const hostModelKey = (hostId, agent, account) => `${hostId}|${agent}|${typeof account === 'string' ? account : ''}`

export function loadHostModelLists(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(join(dir, FILE), 'utf8'))
    const out = {}
    if (!data || typeof data !== 'object') return out
    for (const key of Object.keys(data).slice(0, MAX_HOST_LISTS * 2)) {
      const e = data[key]
      if (!KEY.test(key) || !e || typeof e !== 'object') continue
      const models = validListedModels(e.models)
      if (models.length) out[key] = { models, fetchedAt: Number.isFinite(e.fetchedAt) ? e.fetchedAt : 0 }
    }
    return out
  } catch {
    return {}
  }
}

// read(hostId, { account }) -> { ok: true, text } | { ok: false, notConnected? }
export function createHostModelLister(dir, { read, now = Date.now } = {}) {
  let lists = loadHostModelLists(dir)
  const running = new Map() // key -> promise

  const list = () => JSON.parse(JSON.stringify(lists))

  function keep(key, models) {
    const entry = { models, fetchedAt: now() }
    const next = { ...lists, [key]: entry }
    // The oldest go first.
    const keys = Object.keys(next).sort((a, b) => next[b].fetchedAt - next[a].fetchedAt)
    lists = Object.fromEntries(keys.slice(0, MAX_HOST_LISTS).map((k) => [k, next[k]]))
    try {
      fs.mkdirSync(dir, { recursive: true })
      writeFileAtomic(join(dir, FILE), JSON.stringify(lists, null, 2))
    } catch {
      /* kept in memory */
    }
    return entry
  }

  // -> { ok: true, key, models, fetchedAt } | { ok: false, reason }
  // reason: 'unsupported' | 'not-connected' | 'missing' | 'empty' | 'failed'
  function refresh(q = {}) {
    const hostId = q && typeof q.hostId === 'string' ? q.hostId : ''
    const agent = q && typeof q.agent === 'string' ? q.agent : ''
    const account = q && typeof q.account === 'string' ? q.account : null
    if (!HOST_MODEL_AGENTS.includes(agent) || !HOST.test(hostId) || (account !== null && !ACCOUNT.test(account)) || typeof read !== 'function')
      return Promise.resolve({ ok: false, reason: 'unsupported' })
    const key = hostModelKey(hostId, agent, account)
    if (running.has(key)) return running.get(key)
    const run = (async () => {
      let r = null
      try {
        r = await read(hostId, { account })
      } catch {
        r = null
      }
      if (!r || !r.ok) return { ok: false, reason: r && r.notConnected ? 'not-connected' : 'failed' }
      if (typeof r.text !== 'string' || !r.text.trim()) return { ok: false, reason: 'missing' }
      const models = validListedModels(parseCodexModelList(r.text))
      if (!models.length) return { ok: false, reason: 'empty' }
      return { ok: true, key, ...keep(key, models) }
    })().finally(() => running.delete(key))
    running.set(key, run)
    return run
  }

  return { list, refresh }
}
