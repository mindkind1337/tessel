import { describe, expect, it } from 'vitest'
import { agentNewlineKey } from '../agentKeys'

describe('Shift+Enter in an agent', () => {
  it('Claude Code: Alt+Enter, everywhere', () => {
    expect(agentNewlineKey('claude')).toBe('\x1b\r')
    expect(agentNewlineKey('claude', { remote: true, windows: true })).toBe('\x1b\r')
  })

  it('Codex in a local Windows pane: Alt+Enter, it ignores Ctrl+J there', () => {
    expect(agentNewlineKey('codex', { windows: true })).toBe('\x1b\r')
  })

  it('Codex on an SSH host or on another system keeps Ctrl+J', () => {
    expect(agentNewlineKey('codex', { windows: true, remote: true })).toBe('\n')
    expect(agentNewlineKey('codex', { windows: false })).toBe('\n')
  })

  it('the other agents keep Ctrl+J', () => {
    expect(agentNewlineKey('gemini', { windows: true })).toBe('\n')
    expect(agentNewlineKey('antigravity', { windows: true })).toBe('\n')
  })
})
