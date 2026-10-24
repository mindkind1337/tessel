// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createStatusMemo, statusMemoKey, STATUS_MEMO_MS } from '../agentStatusMemo'

const ok = { ok: true, supported: true, changed: true, needsReview: true }

describe('agent status hooks prepared twice a moment apart', () => {
  it('the second preparation for the same agent and folder is answered from the first', async () => {
    let clock = 0
    const run = vi.fn(async () => ok)
    const prepare = createStatusMemo({ run, now: () => clock })
    expect(await prepare('codex', { CODEX_HOME: 'C:/a' }, {})).toEqual(ok)
    clock += 2000
    // Told once already: nothing to review again.
    expect(await prepare('codex', { codex_home: 'C:/a' }, {})).toEqual({ ok: true, supported: true, changed: false, needsReview: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('another configuration folder, agent or opt-in prepares again', async () => {
    const run = vi.fn(async () => ok)
    const prepare = createStatusMemo({ run })
    await prepare('claude', { CLAUDE_CONFIG_DIR: 'C:/a' }, {})
    await prepare('claude', { CLAUDE_CONFIG_DIR: 'C:/b' }, {})
    await prepare('claude', {}, {})
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('the node found on the PATH of the pane is part of the key', async () => {
    const run = vi.fn(async () => ok)
    const prepare = createStatusMemo({ run, nodeOf: (env) => env.NODE_AT })
    await prepare('codex', { NODE_AT: 'C:/n1/node.exe' }, {})
    await prepare('codex', { NODE_AT: 'C:/n2/node.exe' }, {})
    await prepare('codex', { NODE_AT: 'C:/n1/node.exe' }, {})
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('agents with several config variables (Grok, Kimi, Pi...) are prepared every time', async () => {
    const run = vi.fn(async () => ok)
    const prepare = createStatusMemo({ run })
    for (const p of ['grok', 'kimi', 'pi', 'muse', 'cursor']) {
      await prepare(p, { GROK_HOME: 'A' }, { cursor: true })
      await prepare(p, { GROK_HOME: 'B' }, { cursor: true })
    }
    expect(run).toHaveBeenCalledTimes(10)
  })

  it('prepares again after the wait, and never keeps a failure or an unsupported agent', async () => {
    let clock = 0
    const run = vi.fn(async (p) => (p === 'bad' ? { ok: false, error: 'x' } : p === 'none' ? { ok: true, supported: false } : ok))
    const prepare = createStatusMemo({ run, now: () => clock })
    await prepare('claude', {}, {})
    clock += STATUS_MEMO_MS + 1
    await prepare('claude', {}, {})
    await prepare('bad', {}, {})
    await prepare('bad', {}, {})
    await prepare('none', {}, {})
    await prepare('none', {}, {})
    expect(run).toHaveBeenCalledTimes(6)
  })

  it('keys by provider and folder', () => {
    expect(statusMemoKey('claude', { Claude_Config_Dir: 'D' }, {})).toBe('claude|D|0|')
    expect(statusMemoKey('gemini', { CLAUDE_CONFIG_DIR: 'D' }, { cursor: true })).toBeNull()
  })
})
