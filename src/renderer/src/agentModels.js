// The models each agent offers in Tessel's pickers (Settings > Agents, the
// new pane menu, a pane's … menu): Orca's catalog seed, completed by what
// the agent's own CLI listed the last time you asked (Refresh models; the
// list is kept by the main process, agentModelList.js). Nothing is probed
// on its own: a probe may use the CLI's sign-in and network.
import { reactive } from 'vue'
import { catalogModelsFor, getAgentSessionOptionCatalog } from '../../shared/agentSessionOptions'
import { listedToCatalogModels, validListedModels, canProbeModels } from '../../shared/agentModelProbe'

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
  const models = validListedModels(e && e.models)
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
  loaded = null
}
