import { describe, it, expect, vi } from 'vitest'
import { parseWhere, createCommandLookup } from '../commandLookup'

const OUT = [
  'C:\\Users\\me\\AppData\\Roaming\\npm\\claude',
  'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
  'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode2.cmd',
  'C:\\tools\\Codex.EXE',
  'C:\\Python\\Scripts\\kimi.exe',
  'C:\\other\\kimi.exe',
  ''
].join('\r\n')

describe('parseWhere', () => {
  it('takes the first line that is each command (its name or name + one extension)', () => {
    const found = parseWhere(OUT, ['claude', 'codex', 'kimi', 'opencode', 'gemini'])
    expect(found.get('claude')).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude')
    expect(found.get('codex')).toBe('C:\\tools\\Codex.EXE')
    expect(found.get('kimi')).toBe('C:\\Python\\Scripts\\kimi.exe')
    // opencode2.cmd is not opencode
    expect(found.has('opencode')).toBe(false)
    expect(found.has('gemini')).toBe(false)
  })
  it('reads nothing from empty output', () => {
    expect(parseWhere('', ['claude']).size).toBe(0)
    expect(parseWhere(undefined, ['claude']).size).toBe(0)
  })
})

describe('createCommandLookup', () => {
  it('answers lookups made together with one run', async () => {
    const run = vi.fn(async () => ({ stdout: OUT }))
    const lookup = createCommandLookup(run)
    const [a, b, c, d] = await Promise.all([lookup('claude'), lookup('codex'), lookup('gemini'), lookup('claude')])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toEqual(['claude', 'codex', 'gemini'])
    expect(a).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude')
    expect(b).toBe('C:\\tools\\Codex.EXE')
    expect(c).toBe('')
    expect(d).toBe(a)
  })
  it('splits a long list into several runs', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    const lookup = createCommandLookup(run, { max: 2 })
    await Promise.all(['a', 'b', 'c'].map(lookup))
    expect(run.mock.calls.map((c) => c[0])).toEqual([['a', 'b'], ['c']])
  })
  it('a later lookup starts a new run; a failed run finds nothing', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('no where.exe')).mockResolvedValue({ stdout: OUT })
    const lookup = createCommandLookup(run)
    expect(await lookup('claude')).toBe('')
    expect(await lookup('claude')).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude')
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('never runs for an invalid name', async () => {
    const run = vi.fn(async () => ({ stdout: OUT }))
    const lookup = createCommandLookup(run)
    expect(await lookup('a b')).toBe('')
    expect(await lookup('')).toBe('')
    expect(run).not.toHaveBeenCalled()
  })
})
