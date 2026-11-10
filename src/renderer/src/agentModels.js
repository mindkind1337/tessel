// The models each agent offers in Tessel's pickers (Settings > Agents, the
// new pane menu, a pane's … menu): Orca's catalog seed, completed by what
// the agent's own CLI listed (the list is kept by the main process,
// agentModelList.js). As in Orca's model catalog store
// (agent-model-catalog-store.ts, MIT, Copyright (c) 2026 Lovecast Inc.), a
// model menu you open refreshes a list that is missing or a day old in the
// background; a failure waits 30 s before the next try. Never on a timer.
// A list younger than that is read again too when the agent's program changed
// since (an update of the CLI: main looks at its files, at most once a minute
// per agent).
import { reactive } from 'vue'
import { settings } from './settings'
import { catalogModelsFor, getAgentSessionOptionCatalog } from '../../shared/agentSessionOptions'
import { listedToCatalogModels, validListedModels, canProbeModels, openCodeModelLabel } from '../../shared/agentModelProbe'

// agent -> { models: listed rows, fetchedAt }
export const modelLists = reactive({})
// agent -> { busy, error: { reason, detail } | null }
export const modelProbes = reactive({})

let loaded = null
export function loadModelLists() {
  if (loaded) return loaded
  loaded = (async () => {
    if (typeof window === 'undefined' || !window.shellApi || !window.shellApi.agentModelLists) return
    try {
      const lists = await window.shellApi.agentModelLists()
      for (const [agent, e] of Object.entries(lists || {})) setList(agent, e)
    } catch {
      /* the seed lists stay */
    }
  })()
  return loaded
}

function setList(agent, e) {
  let models = validListedModels(e && e.models)
  // A list kept from before: OpenCode's names without the provider prefix.
  if (agent === 'opencode') models = models.map((m) => ({ ...m, label: openCodeModelLabel(m.id) }))
  if (models.length) modelLists[agent] = { models, fetchedAt: Number(e.fetchedAt) || 0 }
}

export { canProbeModels }

// Ask the agent's CLI again. -> the result ({ ok, … }).
export async function refreshModels(agent, command = '') {
  if (!canProbeModels(agent) || !window.shellApi || !window.shellApi.probeAgentModels) return { ok: false, reason: 'unsupported' }
  if (modelProbes[agent] && modelProbes[agent].busy) return { ok: false, reason: 'busy' }
  modelProbes[agent] = { busy: true, error: null }
  let res
  try {
    res = await window.shellApi.probeAgentModels({ agent, command })
  } catch (err) {
    res = { ok: false, reason: 'failed', detail: String((err && err.message) || err) }
  }
  if (res && res.ok) setList(agent, res)
  modelProbes[agent] = { busy: false, error: res && res.ok ? null : { reason: (res && res.reason) || 'failed', detail: (res && res.detail) || '' } }
  return res
}

const built = new Map() // agent -> { key, models }
// The catalog rows (with options) a picker lists for this agent.
export const MODEL_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const MODEL_PROBE_FAILURE_TTL_MS = 30_000
const lastFailure = new Map() // agent -> time of the last failed background refresh
export const PROGRAM_CHECK_MS = 60_000
const lastProgramCheck = new Map() // agent -> time main was last asked whether the program changed

// A model menu opened: a missing or old list gets one background refresh
// (never two at once).
export function refreshIfStale(agent, now = Date.now()) {
  if (!canProbeModels(agent) || typeof window === 'undefined' || !window.shellApi || !window.shellApi.probeAgentModels) return
  if (modelProbes[agent] && modelProbes[agent].busy) return
  const list = modelLists[agent]
  const failed = lastFailure.get(agent)
  if (failed != null && now - failed < MODEL_PROBE_FAILURE_TTL_MS) return
  const young = (kept) => kept && Date.now() - kept.fetchedAt < MODEL_LIST_MAX_AGE_MS
  let ask = false
  if (list && now - list.fetchedAt < MODEL_LIST_MAX_AGE_MS) {
    // Young: only when the program changed, asked at most once a minute.
    if (typeof window.shellApi.agentModelListChanged !== 'function') return
    const last = lastProgramCheck.get(agent)
    if (last != null && now - last < PROGRAM_CHECK_MS) return
    lastProgramCheck.set(agent, now)
    ask = true
  }
  const command = (settings.agentPrefs && settings.agentPrefs[agent] && settings.agentPrefs[agent].command) || ''
  Promise.resolve(loadModelLists())
    .then(async () => {
      if (ask) return (await window.shellApi.agentModelListChanged(agent)) === true ? refreshModels(agent, command) : null
      if (young(modelLists[agent])) return null
      return refreshModels(agent, command)
    })
    .then((res) => {
      if (res && !res.ok) lastFailure.set(agent, Date.now())
      else if (res) lastFailure.delete(agent)
    })
    .catch(() => lastFailure.set(agent, Date.now()))
}

export function modelsFor(agent) {
  if (!getAgentSessionOptionCatalog(agent)) return []
  const list = modelLists[agent]
  const key = list ? list.fetchedAt + ':' + list.models.length : 'seed'
  const hit = built.get(agent)
  if (hit && hit.key === key) return hit.models
  const models = catalogModelsFor(agent, list ? listedToCatalogModels(agent, list.models) : null)
  built.set(agent, { key, models })
  return models
}

// Tests.
export function resetModelListsForTests() {
  for (const k of Object.keys(modelLists)) delete modelLists[k]
  for (const k of Object.keys(modelProbes)) delete modelProbes[k]
  built.clear()
  lastFailure.clear()
  lastProgramCheck.clear()
  loaded = null
}
