// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createUsageReader, getUsage, parseClaudeUsage, parseCodexUsage } from '../agentUsage'

const NOW = Date.parse('2026-09-28T00:00:00Z')
const stamp = (ms = NOW) => new Date(ms).toISOString()
const quota = (used = 23, minutes = 300, reset = NOW + 3600000) => ({
  used_percent: used,
  window_minutes: minutes,
  resets_at: reset / 1000
})
const event = (raw, time = NOW, extra = {}) =>
  JSON.stringify({
    type: 'event_msg',
    timestamp: stamp(time),
    payload: { type: 'token_count', rate_limits: raw },
    ...extra
  })
const raw = (primary = quota(), secondary = quota(56, 10080)) => ({
  limit_id: 'codex',
  primary,
  secondary
})
let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-quota-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  const target = resolve(home)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-quota-'))
    throw new Error('Unexpected cleanup path')
  fs.rmSync(target, { recursive: true, force: true })
})
function put(rel, content, time = NOW) {
  const file = join(home, rel)
  fs.mkdirSync(join(file, '..'), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  fs.utimesSync(file, new Date(time), new Date(time))
  return file
}
const read = () => getUsage({ home, env: {}, now: NOW })
const byId = (result, id) => result.agents.find((a) => a.id === id)

describe('subscription quota observations', () => {
  it('reads Codex windows, converting epoch seconds to ISO without copying session content', () => {
    const result = parseCodexUsage(event(raw(), NOW, { secret: 'DO NOT EXPOSE' }), NOW)
    expect(result).toMatchObject({
      id: 'codex',
      source: 'codex-session',
      observedAt: stamp(),
      stale: false,
      windows: [
        { label: '5h', usedPct: 23, resetsAt: stamp(NOW + 3600000), stale: false },
        { label: 'week', usedPct: 56, stale: false }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('DO NOT EXPOSE')
  })
  it('classifies a primary weekly window correctly, including older off-by-one durations', () => {
    expect(parseCodexUsage(event(raw(quota(12, 10079), null)), NOW).windows).toMatchObject([
      { label: 'week', usedPct: 12 }
    ])
    expect(parseCodexUsage(event(raw(quota(9, 299), null)), NOW).windows[0].label).toBe('5h')
  })
  it('selects by event timestamp and ignores model-specific buckets and prompt-shaped data', () => {
    const text = [
      event(raw(), NOW - 1000),
      event(raw(quota(99)), NOW - 5000),
      event({ ...raw(quota(0)), limit_id: 'codex_model_other' }),
      event(raw(quota(100)), NOW, { type: 'response_item' })
    ].join('\n')
    expect(parseCodexUsage(text, NOW).windows[0].usedPct).toBe(23)
  })
  it('does not mix a missing window with a previous snapshot', () => {
    const text = [event(raw(), NOW - 1000), event(raw(quota(11, 10080), null))].join('\n')
    expect(parseCodexUsage(text, NOW).windows).toMatchObject([{ label: 'week', usedPct: 11 }])
  })
  it('handles truncated/concurrent JSON lines and absent rate limits', () => {
    const text = 'broken first line\n' + event(raw()) + '\n' + event(null) + '\n{"payload":'
    expect(parseCodexUsage(text, NOW).windows).toHaveLength(2)
    expect(parseCodexUsage('broken\n' + event(null), NOW)).toBeNull()
  })
  it('marks old observations and elapsed resets stale without inventing a reset to zero', () => {
    const old = parseCodexUsage(event(raw(quota(100)), NOW - 16 * 60000), NOW)
    expect(old).toMatchObject({
      stale: true,
      windows: [{ usedPct: 100, stale: true }, { stale: true }]
    })
    const elapsed = parseCodexUsage(event(raw(quota(100, 300, NOW - 1), quota(40, 10080))), NOW)
    expect(elapsed.windows).toMatchObject([
      { usedPct: 100, stale: true },
      { usedPct: 40, stale: false }
    ])
  })
  it('rejects invalid percentages, timestamps and unknown durations without mislabelling them', () => {
    for (const invalid of [null, '50', -1, 101]) {
      expect(parseCodexUsage(event(raw(quota(invalid), null)), NOW).windows).toEqual([])
    }
    expect(parseCodexUsage(event(raw(quota(20, 60), null)), NOW).windows).toEqual([])
    expect(parseCodexUsage(event(raw(), NOW + 120000), NOW)).toBeNull()
    expect(parseCodexUsage(event(raw(), NOW, { timestamp: 'bad' }), NOW)).toBeNull()
    expect(
      parseCodexUsage(event(raw({ ...quota(), resets_at: 1e30 }, null)), NOW).windows[0].resetsAt
    ).toBeNull()
  })
  it('reads only explicit Claude subscription fields, preserving zero and unavailable windows', () => {
    const data = {
      observedAt: stamp(),
      rate_limits: {
        five_hour: { used_percentage: 0, resets_at: (NOW + 3600000) / 1000 },
        seven_day: { used_percentage: 42, resets_at: (NOW + 86400000) / 1000 }
      },
      context_window: { used_percentage: 99 }
    }
    expect(parseClaudeUsage(data, NOW).windows).toMatchObject([
      { label: '5h', usedPct: 0 },
      { label: 'week', usedPct: 42 }
    ])
    expect(
      parseClaudeUsage({ observedAt: stamp(), context_window: data.context_window }, NOW)
    ).toBeNull()
    expect(parseClaudeUsage({ ...data, observedAt: undefined }, NOW)).toBeNull()
  })
})

describe('read-only local discovery', () => {
  it('uses the latest observation across session tails, including an old resumed session', async () => {
    put('.codex/sessions/2025/01/01/rollout-resumed.jsonl', event(raw(quota(55))), NOW)
    put(
      '.codex/sessions/2026/09/28/rollout-recent.jsonl',
      event(raw(quota(33)), NOW - 1000),
      NOW + 1
    )
    const result = byId(await read(), 'codex')
    expect(result.windows[0].usedPct).toBe(55)
    expect(result.observedAt).toBe(stamp())
  })
  it('reads a bounded tail and ignores giant unrelated conversation data', async () => {
    put('.codex/sessions/2026/09/28/rollout-large.jsonl', 'x'.repeat(700000) + '\n' + event(raw()))
    expect(byId(await read(), 'codex').windows).toHaveLength(2)
  })
  it('returns honest empty states, never token-count estimates, when local quotas are missing', async () => {
    put('.claude/stats-cache.json', { totalTokens: 1234567, totalCostUsd: 100 })
    put('.codex/sessions/2026/09/28/rollout-tokens.jsonl', event(null, NOW, { totalTokens: 99999 }))
    const result = await read()
    for (const agent of result.agents) {
      expect(agent.windows).toEqual([])
      expect(agent.error).toBeTruthy()
    }
    expect(byId(result, 'claude').source).toBe('unavailable')
  })
  it('honors provider home overrides and reads an optional explicit Claude snapshot', async () => {
    put('custom-codex/sessions/2026/09/28/rollout-custom.jsonl', event(raw(quota(11))))
    put('.codex/sessions/2026/09/28/rollout-default.jsonl', event(raw(quota(99))))
    put('custom-claude/tessel-usage.json', {
      observedAt: stamp(),
      rate_limits: {
        seven_day: { used_percentage: 75, resets_at: (NOW + 3600000) / 1000 }
      }
    })
    const result = await getUsage({
      home,
      env: {
        CODEX_HOME: join(home, 'custom-codex'),
        CLAUDE_CONFIG_DIR: join(home, 'custom-claude')
      },
      now: NOW
    })
    expect(byId(result, 'codex').windows[0].usedPct).toBe(11)
    expect(byId(result, 'claude')).toMatchObject({
      source: 'claude-statusline',
      windows: [{ label: 'week', usedPct: 75 }]
    })
  })
  it('never reads credentials or mutates files', async () => {
    const content = event(raw())
    const file = put('.codex/sessions/2026/09/28/rollout-one.jsonl', content)
    const auth = put('.codex/auth.json', 'PRIVATE')
    const claudeAuth = put('.claude/.credentials.json', 'PRIVATE')
    const before = [file, auth, claudeAuth].map((p) => ({
      text: fs.readFileSync(p, 'utf8'),
      time: fs.statSync(p).mtimeMs
    }))
    const fsp = await import('fs/promises')
    const open = vi.spyOn(fsp.default, 'open')
    const output = JSON.stringify(await read())
    expect(output).not.toContain('PRIVATE')
    expect(open.mock.calls.every(([p]) => ![auth, claudeAuth].includes(p))).toBe(true)
    expect(
      [file, auth, claudeAuth].map((p) => ({
        text: fs.readFileSync(p, 'utf8'),
        time: fs.statSync(p).mtimeMs
      }))
    ).toEqual(before)
  })
  it('does not traverse directory junctions to unrelated logs', async () => {
    put('outside/rollout-external.jsonl', event(raw(quota(100))))
    fs.mkdirSync(join(home, '.codex/sessions'), { recursive: true })
    fs.symlinkSync(
      join(home, 'outside'),
      join(home, '.codex/sessions/2026'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    expect(byId(await read(), 'codex').windows).toEqual([])
  })
  it('gracefully handles a truncated Claude snapshot without modifying it', async () => {
    const f = put('.claude/tessel-usage.json', '{')
    expect(byId(await read(), 'claude').source).toBe('unavailable')
    expect(fs.readFileSync(f, 'utf8')).toBe('{')
  })
})

describe('poll coalescing', () => {
  it('shares concurrent scans and expires cached observations', async () => {
    let now = 1000,
      finish
    const scan = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const reader = createUsageReader({ read: scan, clock: () => now, ttl: 100 })
    const a = reader(),
      b = reader()
    await Promise.resolve()
    expect(scan).toHaveBeenCalledTimes(1)
    finish({ agents: [] })
    expect(await a).toEqual(await b)
    await reader()
    expect(scan).toHaveBeenCalledTimes(1)
    now += 101
    const next = reader()
    await Promise.resolve()
    expect(scan).toHaveBeenCalledTimes(2)
    finish({ agents: [] })
    await next
  })
  it('retries a failed scan instead of caching the rejected promise', async () => {
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue({ agents: [] })
    const reader = createUsageReader({ read: scan })
    await expect(reader()).rejects.toThrow('temporary')
    await expect(reader()).resolves.toEqual({ agents: [] })
  })
})
