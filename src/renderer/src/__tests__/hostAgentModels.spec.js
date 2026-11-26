// A pane on an SSH host lists the models its own agent there can run
// (agentModels.js: hostModelLists, refreshHostModels, paneModelsFor).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withoutMissingModel } from '../agentModels'
import { modelLists, hostModelLists, hostModelKey, hostModelsFor, paneModelsFor, refreshHostModels, loadModelLists, resetModelListsForTests, HOST_LIST_MAX_AGE_MS, HOST_LIST_RETRY_MS } from '../agentModels'

const row = (id) => ({ id, label: id, effortLevels: ['low', 'medium'] })
const ids = (models) => models.map((m) => m.id)

let previous
beforeEach(() => {
  previous = window.shellApi
  resetModelListsForTests()
})
afterEach(() => {
  window.shellApi = previous
})

describe('the model list of an agent on an SSH host', () => {
  it('a Codex pane on a host lists what the host’s Codex lists, not this computer’s', async () => {
    modelLists.codex = { models: [row('gpt-6.2-astra'), row('gpt-6-sol')], fetchedAt: 1 }
    const host = { hostId: 'ssh-box', account: null }
    // Not known yet: this computer's.
    expect(ids(paneModelsFor('codex', true, host))).toEqual(['gpt-6.2-astra', 'gpt-6-sol'])
    hostModelLists[hostModelKey('ssh-box', 'codex', null)] = { models: [row('gpt-6-sol'), row('gpt-5.6-sol')], fetchedAt: 2 }
    expect(ids(paneModelsFor('codex', true, host))).toEqual(['gpt-6-sol', 'gpt-5.6-sol'])
    // Another account folder there, another host, a pane on this computer: not that list.
    expect(hostModelsFor('ssh-box', 'codex', 'ab12')).toBe(null)
    expect(hostModelsFor('ssh-other', 'codex', null)).toBe(null)
    expect(ids(paneModelsFor('codex', false))).toEqual(['gpt-6.2-astra', 'gpt-6-sol'])
    // Only Codex has a host list.
    expect(hostModelsFor('ssh-box', 'claude', null)).toBe(null)
  })

  it('reads the host’s list when asked, at most every ten minutes, sooner after a read that gave nothing', async () => {
    const refresh = vi.fn(async () => ({ ok: false, reason: 'not-connected' }))
    window.shellApi = { refreshHostAgentModels: refresh }
    await refreshHostModels('ssh-box', 'codex', 'ab12', 1000)
    expect(refresh).toHaveBeenCalledWith({ hostId: 'ssh-box', agent: 'codex', account: 'ab12' })
    expect(refreshHostModels('ssh-box', 'codex', 'ab12', 1000 + HOST_LIST_RETRY_MS - 1)).toBe(null)
    refresh.mockResolvedValue({ ok: true, models: [row('gpt-6-sol')], fetchedAt: 5 })
    await refreshHostModels('ssh-box', 'codex', 'ab12', 1000 + HOST_LIST_RETRY_MS)
    expect(ids(hostModelsFor('ssh-box', 'codex', 'ab12'))).toEqual(['gpt-6-sol'])
    const t = 1000 + HOST_LIST_RETRY_MS
    expect(refreshHostModels('ssh-box', 'codex', 'ab12', t + HOST_LIST_MAX_AGE_MS - 1)).toBe(null)
    expect(refresh).toHaveBeenCalledTimes(2)
    await refreshHostModels('ssh-box', 'codex', 'ab12', t + HOST_LIST_MAX_AGE_MS)
    expect(refresh).toHaveBeenCalledTimes(3)
    // Not an agent with a host list, no host: nothing asked.
    expect(refreshHostModels('ssh-box', 'claude', null)).toBe(null)
    expect(refreshHostModels('', 'codex', null)).toBe(null)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('a model the host does not have is taken out of what a pane starts with; the rest stays', () => {
    const models = [{ id: 'gpt-6-sol' }, { id: 'gpt-5.6-sol' }]
    expect(withoutMissingModel({ model: 'gpt-6.2-astra', effort: 'high' }, models)).toEqual({ effort: 'high' })
    const kept = { model: 'gpt-6-sol', effort: 'high' }
    expect(withoutMissingModel(kept, models)).toBe(kept)
    // No list known, nothing chosen: as they were.
    expect(withoutMissingModel(kept, null)).toBe(kept)
    expect(withoutMissingModel(null, models)).toBe(null)
    expect(withoutMissingModel({ effort: 'low' }, models)).toEqual({ effort: 'low' })
  })

  it('two panes asking at once make one read; a read that throws is asked again a minute later', async () => {
    let fail = true
    const refresh = vi.fn(async () => {
      if (fail) throw new Error('gone')
      return { ok: true, models: [row('gpt-6-sol')], fetchedAt: 1 }
    })
    window.shellApi = { refreshHostAgentModels: refresh }
    const a = refreshHostModels('ssh-box', 'codex', null, 0)
    expect(refreshHostModels('ssh-box', 'codex', null, 0)).toBe(null)
    expect(await a).toBe(null)
    expect(refresh).toHaveBeenCalledTimes(1)
    fail = false
    expect((await refreshHostModels('ssh-box', 'codex', null, HOST_LIST_RETRY_MS)).ok).toBe(true)
  })

  it('the lists kept by main are there when Tessel starts', async () => {
    window.shellApi = {
      agentModelLists: async () => ({}),
      hostAgentModelLists: async () => ({ 'ssh-box|codex|': { models: [row('gpt-6-sol')], fetchedAt: 9 } })
    }
    await loadModelLists()
    expect(ids(hostModelsFor('ssh-box', 'codex', null))).toEqual(['gpt-6-sol'])
  })
})
