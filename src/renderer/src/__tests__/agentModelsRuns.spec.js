import { describe, it, expect } from 'vitest'
import { paneModelsFor, sentModelId, resetModelListsForTests, modelLists, modelsFor } from '../agentModels'

describe('the exact model of a Claude alias row', () => {
  it('is sent on this computer, never on an SSH host (its own Claude resolves the alias)', () => {
    resetModelListsForTests()
    modelLists.claude = {
      fetchedAt: 1,
      models: [
        { id: 'fable', label: 'Fable 5.2', runs: 'claude-fable-5-2' },
        { id: 'claude-fable-5-1', label: 'Fable 5.1' }
      ]
    }
    const local = paneModelsFor('claude', false)
    expect(local).toBe(modelsFor('claude'))
    expect(sentModelId(local, 'fable')).toBe('claude-fable-5-2')
    expect(sentModelId(local, 'claude-fable-5-1')).toBe('claude-fable-5-1')
    expect(sentModelId(local, 'unknown')).toBe('unknown')
    const host = paneModelsFor('claude', true)
    expect(host.map((m) => m.id)).toEqual(['fable', 'claude-fable-5-1'])
    expect(host.some((m) => m.runs)).toBe(false)
    expect(sentModelId(host, 'fable')).toBe('fable')
    // Same list each time (a computed's dependency stays stable).
    expect(paneModelsFor('claude', true)).toBe(host)
    resetModelListsForTests()
  })
})
