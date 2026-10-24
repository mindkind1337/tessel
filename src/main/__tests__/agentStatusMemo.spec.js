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
    await prepare('cursor', {}, { cursor: true })
    await prepare('cursor', {}, {})
    expect(run).toHaveBeenCalledTimes(5)
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
    expect(statusMemoKey('claude', { Claude_Config_Dir: 'D' }, {})).toBe('claude|D|0')
    expect(statusMemoKey('gemini', { CLAUDE_CONFIG_DIR: 'D' }, { cursor: true })).toBe('gemini||1')
  })
})
