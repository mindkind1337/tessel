import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { createClaudeUsageReport, parseClaudeLine } from '../claudeUsageReport'
import { turnCostUsd, pricingModel } from '../../shared/claudePricing'

let dir
afterEach(() => {
  if (!dir) return
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-claude-usage-'))
    throw new Error('Unexpected fixture cleanup target')
  fs.rmSync(target, { recursive: true, force: true })
  dir = undefined
})

const row = (o) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: o.session || 's1',
    requestId: o.req,
    timestamp: o.at || new Date().toISOString(),
    cwd: o.cwd || 'C:\\Proj',
    gitBranch: 'main',
    message: {
      id: o.id,
      model: o.model || 'claude-opus-5-5',
      usage: {
        input_tokens: o.input || 0,
        output_tokens: o.output || 0,
        cache_read_input_tokens: o.cacheRead || 0,
        cache_creation_input_tokens: o.cacheWrite || 0,
        cache_creation: { ephemeral_1h_input_tokens: o.cacheWrite1h || 0 }
      }
    }
  })

describe('Claude pricing (from Orca)', () => {
  it('maps model ids and prices a turn', () => {
    expect(pricingModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(pricingModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(pricingModel('claude-3-5-haiku-20241022')).toBe('claude-haiku-3-5')
    expect(pricingModel('gpt-5')).toBe(null)
    // Opus 5.5: $4 in, $20 out, $0.2 cache read, $5 cache write, $8 1-hour write, per million.
    expect(
      turnCostUsd('claude-opus-5-5', {
        input: 1e6,
        output: 1e6,
        cacheRead: 1e6,
        cacheWrite: 2e6,
        cacheWrite1h: 1e6
      })
    ).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 6)
    expect(turnCostUsd('unknown-model', { input: 1 })).toBe(null)
  })
})

describe('Claude usage report', () => {
  it('one turn per message and request (largest counts), by day, model, project and conversation', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-claude-usage-'))
    fs.mkdirSync(join(dir, 'C--Proj'))
    fs.writeFileSync(
      join(dir, 'C--Proj', 'a.jsonl'),
      [
        row({ id: 'm1', req: 'r1', input: 10, output: 5 }),
        row({ id: 'm1', req: 'r1', input: 10, output: 500 }), // same reply, fuller
        row({
          id: 'm2',
          req: 'r2',
          input: 1000,
          cacheRead: 2000,
          model: 'claude-sonnet-5',
          cwd: 'C:\\Other'
        }),
        '{"type":"user","message":{"content":"hi"}}',
        'not json'
      ].join('\n')
    )
    // A resumed conversation copies an earlier turn into a new file: counted once.
    fs.writeFileSync(
      join(dir, 'C--Proj', 'b.jsonl'),
      row({ id: 'm1', req: 'r1', input: 10, output: 500, session: 's2' })
    )
    const report = createClaudeUsageReport({ dir })
    const r = await report()
    expect(r.totals).toMatchObject({
      turns: 2,
      input: 1010,
      output: 500,
      cacheRead: 2000,
      unpriced: 0,
      zeroCacheReadTurns: 1
    })
    expect(r.byModel.map((m) => m.model).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5'])
    expect(r.byProject.map((p) => p.label).sort()).toEqual(['Other', 'Proj'])
    expect(r.byDay).toHaveLength(1)
    expect(r.totals.cost).toBeCloseTo((10 * 4 + 500 * 20) / 1e6 + (1000 * 2 + 2000 * 0.2) / 1e6, 9)
    // Parsed again only when a file changes.
    fs.appendFileSync(
      join(dir, 'C--Proj', 'a.jsonl'),
      '\n' + row({ id: 'm3', req: 'r3', output: 7 })
    )
    expect((await report()).totals.turns).toBe(3)
  })

  it('ignores lines without usage', () => {
    expect(parseClaudeLine('{"type":"user"}')).toBe(null)
  })
})

describe('Claude local calendar and project filters', () => {
  const NOW = Date.parse('2026-09-28T16:00:00Z')
  function fixture(entries, options = {}) {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-claude-usage-'))
    fs.writeFileSync(
      join(dir, 'fixture.jsonl'),
      entries
        .map((entry, i) =>
          row({
            id: `m${i}`,
            req: `r${i}`,
            session: `s${i}`,
            at: '2026-09-28T16:00:00Z',
            input: 10,
            ...entry
          })
        )
        .join('\n')
    )
    return createClaudeUsageReport({ dir, now: () => NOW, timezone: 'America/Toronto', ...options })
  }

  it('defaults to 30 inclusive local days and keeps historical totals separate', async () => {
    const read = fixture([
      { at: '2026-08-30T03:59:59Z', input: 100 }, // Aug 29 local
      { at: '2026-08-30T04:00:00Z', input: 20 },
      { at: '2026-09-29T03:59:59Z', input: 30 }, // Sep 28 local
      { at: '2026-09-29T04:00:00Z', input: 400 }
    ])
    const result = await read()
    expect(result).toMatchObject({
      provider: 'claude',
      timezone: 'America/Toronto',
      scope: 'all',
      generatedAt: new Date(NOW).toISOString(),
      days: 30,
      range: { from: '2026-08-30', to: '2026-09-28' },
      totals: { input: 50, turns: 2, sessions: 2 },
      allTotals: { input: 550, turns: 4, sessions: 4 }
    })
    expect(result.lastDays).toEqual(result.totals)
    expect((await read({ from: null, to: null })).totals.input).toBe(550)
    expect((await read({ from: '2026-09-28', to: '2026-09-28' })).totals.input).toBe(30)
  })

  it('keeps both DST clock hours and supports 7/90 day ranges without truncating sessions', async () => {
    const entries = Array.from({ length: 61 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 8, 28, 16, 0, i)).toISOString()
    }))
    entries.push({ at: '2026-07-01T16:00:00Z', input: 100 })
    entries.push({ at: '2026-09-20T16:00:00Z', input: 200 })
    entries.push({ at: '2026-11-01T05:30:00Z' }, { at: '2026-11-01T06:30:00Z' })
    const read = fixture(entries)
    expect((await read()).sessions).toHaveLength(62)
    expect((await read({ from: '2026-09-22', to: '2026-09-28' })).totals.turns).toBe(61)
    expect((await read({ from: '2026-07-01', to: '2026-09-28' })).totals.turns).toBe(63)
    const dst = await read({ from: '2026-11-01', to: '2026-11-01' })
    expect(dst.byDay).toHaveLength(1)
    expect(dst.byDay[0]).toMatchObject({ day: '2026-11-01', turns: 2 })
    expect((await read()).sessions[0].id).toBe('s60')
  })

  it('intersects roots with exact cwd/model filters and counts cache misses after deduplication', async () => {
    const read = fixture([
      { cwd: 'C:\\Repo\\worktree', cacheRead: 0, model: 'claude-sonnet-4-5-20250929' },
      { cwd: 'c:/REPO/worktree/nested', cacheRead: 50, model: 'claude-sonnet-4-5-20250929' },
      { cwd: 'C:/Repo/worktree-other', input: 1000 },
      { cwd: 'C:/Repo/worktree/../outside', input: 2000 }
    ])
    const result = await read({ roots: ['c:/repo/worktree/'], model: 'claude-sonnet-4-5' })
    expect(result).toMatchObject({
      scope: 'tessel-worktrees',
      totals: { input: 20, turns: 2, zeroCacheReadTurns: 1 }
    })
    for (const rows of [result.byDay, result.byModel, result.byProject, result.sessions])
      expect(rows.reduce((sum, entry) => sum + entry.zeroCacheReadTurns, 0)).toBe(1)
    expect(
      (await read({ roots: ['C:/Repo/worktree'], cwd: 'C:/REPO/WORKTREE' })).totals.turns
    ).toBe(1)
    expect((await read({ roots: [] })).totals.turns).toBe(0)
    expect((await read({ roots: [] })).scope).toBe('tessel-worktrees')
  })

  it('keeps POSIX case distinct while grouping Windows path aliases and matching UNC roots', async () => {
    const read = fixture([
      { cwd: '/workspace/Repo', input: 10 },
      { cwd: '/workspace/repo', input: 20 },
      { cwd: 'C:/Work', input: 30 },
      { cwd: 'c:\\WORK\\', input: 40 },
      { cwd: '\\\\SERVER\\Share\\Project', input: 50 }
    ])
    expect((await read()).byProject).toHaveLength(4)
    expect((await read({ roots: ['/workspace/Repo'] })).totals.input).toBe(10)
    expect((await read({ cwd: 'C:/WORK/' })).totals.input).toBe(70)
    expect((await read({ roots: ['//server/share'] })).totals.input).toBe(50)
  })

  it('counts distinct sessions in each model/project after filtering, not once per turn', async () => {
    const read = fixture([
      { session: 'shared', cwd: 'C:/Repo/A', model: 'model-a' },
      { session: 'shared', cwd: 'c:\\REPO\\a\\', model: 'model-a' },
      { session: 'shared', cwd: 'C:/Repo/B', model: 'model-b' },
      { session: 'second', cwd: 'C:/Repo/A', model: 'model-b' },
      { session: 'old', cwd: 'C:/Repo/A', model: 'model-a', at: '2026-01-01T12:00:00Z' }
    ])
    const result = await read()
    expect(result.totals).toMatchObject({ turns: 4, sessions: 2 })
    expect(result.byModel.find((entry) => entry.model === 'model-a')).toMatchObject({
      turns: 2,
      sessions: 1
    })
    expect(result.byModel.find((entry) => entry.model === 'model-b')).toMatchObject({
      turns: 2,
      sessions: 2
    })
    expect(result.byProject.find((entry) => entry.cwd === 'C:/Repo/A')).toMatchObject({
      turns: 3,
      sessions: 2
    })
    expect(result.byProject.find((entry) => entry.cwd === 'C:/Repo/B')).toMatchObject({
      turns: 1,
      sessions: 1
    })
    const scoped = await read({ roots: ['C:/Repo/A'], model: 'model-b' })
    expect(scoped.totals.sessions).toBe(1)
    expect(scoped.byModel).toHaveLength(1)
    expect(scoped.byModel[0].sessions).toBe(1)
    expect(scoped.byProject).toHaveLength(1)
    expect(scoped.byProject[0].sessions).toBe(1)
    expect(
      (await read({ from: null, to: null })).byModel.find((entry) => entry.model === 'model-a')
        .sessions
    ).toBe(2)
    expect(JSON.parse(JSON.stringify(result)).byModel[0].sessions).toEqual(expect.any(Number))
  })

  it('rejects malformed filters and preserves unknown pricing honestly', async () => {
    const read = fixture([{ model: 'unknown-model', output: 20 }])
    for (const query of [
      null,
      [],
      { from: '2026-02-30' },
      { from: '2026-10-01', to: '2026-09-01' },
      { cwd: [] },
      { model: {} },
      { roots: null },
      { roots: ['relative/path'] },
      { roots: ['C:relative'] },
      { roots: ['C:/root\nsecret'] }
    ])
      await expect(read(query)).rejects.toThrow()
    expect((await read()).totals).toMatchObject({ turns: 1, cost: 0, unpriced: 1 })
  })
})
