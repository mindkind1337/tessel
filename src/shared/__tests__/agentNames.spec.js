import { describe, it, expect } from 'vitest'
import { AGENT_NAMES, ensureAgentNames, renameAgentName, resolveAgentAddress, agentProgramLabel } from '../agentNames'

describe('persistent agent addresses', () => {
  it('keeps the program label separate from old custom titles and the unique name', () => {
    const pane = { paneName: 'Ada', title: 'Fix the cart', agentId: 'claude' }
    expect(agentProgramLabel(pane, [{ id: 'claude', name: 'Claude Code' }])).toBe('Claude Code')
    expect(agentProgramLabel(pane)).toBe('claude')
  })
  it('allocates across workspaces, skips used names regardless of case and suffixes after exhaustion', () => {
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(60)
    const panes = Array.from({ length: AGENT_NAMES.length + 2 }, (_, i) => ({ id: String(i), kind: i % 2 ? 'chat' : 'agent' }))
    panes[0].paneName = 'aDA'
    ensureAgentNames(panes)
    expect(panes[0].paneName).toBe('aDA')
    expect(new Set(panes.map((p) => p.paneName.toLowerCase())).size).toBe(panes.length)
    expect(panes.at(-2).paneName).toBe('Ada 2')
    expect(panes.at(-1).paneName).toBe('Bohr 2')
  })
  it('migrates duplicate and missing names, preserves saved names, and never names plain panes', () => {
    const panes = [{ id: 'a', kind: 'agent', paneName: 'Grace' }, { id: 'b', kind: 'chat', paneName: 'grace' }, { id: 'c', kind: 'agent' }, ...['shell', 'browser', 'editor'].map((kind) => ({ kind, paneName: 'Old' }))]
    ensureAgentNames(panes)
    expect(panes.slice(0, 3).map((p) => p.paneName)).toEqual(['Grace', 'Ada', 'Bohr'])
    expect(panes.slice(3).every((p) => !p.paneName)).toBe(true)
    const saved = JSON.parse(JSON.stringify(panes))
    saved[0].kind = 'chat'
    ensureAgentNames(saved)
    expect(saved).toEqual(panes.map((p, i) => i === 0 ? { ...p, kind: 'chat' } : p))
  })
  it('refuses a duplicate rename without changing either pane; accepts its own case change', () => {
    const panes = [{ id: 'a', kind: 'agent', paneName: 'Ada' }, { id: 'b', kind: 'chat', paneName: 'Bohr' }]
    expect(renameAgentName(panes, 'b', ' ADA ')).toBe('taken')
    expect(panes[1].paneName).toBe('Bohr')
    expect(renameAgentName(panes, 'a', 'ADA')).toBeNull()
    for (const bad of ['', 'team', '@idle', '#3', '42', 'a\nb', 'x'.repeat(61)]) expect(renameAgentName(panes, 'a', bad)).toBe('invalid')
  })
  it('resolves exact names and hidden aliases, rejecting unknown, partial and ambiguous names', () => {
    const panes = [{ paneName: 'Ada', num: 1 }, { paneName: 'Ada 2', num: 2 }]
    expect(resolveAgentAddress(panes, 'aDA')).toBe(panes[0])
    expect(resolveAgentAddress(panes, '#2')).toBe(panes[1])
    expect(resolveAgentAddress(panes, 'Ad')).toBeNull()
    expect(resolveAgentAddress([...panes, { paneName: 'ADA' }], 'ada')).toBeNull()
  })
})
