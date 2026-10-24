import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { disposeTerminal, FRESH_MS, DISPOSE_DELAY_MS } from '../terminalDispose'

describe('disposeTerminal', () => {
  it('disposes at once a terminal opened long ago', () => {
    const term = { dispose: vi.fn() }
    const later = vi.fn()
    expect(disposeTerminal(term, 1000, { now: () => 1000 + FRESH_MS + 1, later })).toBe('now')
    expect(term.dispose).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
  })

  it('waits for the work xterm scheduled when the terminal was opened a moment ago', () => {
    const term = { dispose: vi.fn() }
    const later = vi.fn()
    expect(disposeTerminal(term, 1000, { now: () => 1005, later })).toBe('later')
    expect(term.dispose).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledWith(expect.any(Function), DISPOSE_DELAY_MS)
    later.mock.calls[0][0]()
    expect(term.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes at once a terminal that was never opened, and survives a dispose that throws', () => {
    const term = { dispose: vi.fn(() => { throw new Error('gone') }) }
    expect(disposeTerminal(term, 0)).toBe('now')
    expect(term.dispose).toHaveBeenCalledTimes(1)
    expect(disposeTerminal(null, 0)).toBe('now')
  })

  it('is what TerminalPane uses when it unmounts', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../components/TerminalPane.vue'), 'utf8')
    expect(src).toMatch(/termOpenedAt = Date\.now\(\)/)
    expect(src).toMatch(/disposeTerminal\(term, termOpenedAt\)/)
    expect(src).not.toMatch(/if \(term\) term\.dispose\(\)/)
  })
})
