// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  usageDateRange,
  usageLocalDay,
  validUsageDay,
  normalizeUsageReport,
  buildUsageOverview,
  filterUsageSessions
} from '../usageStats'

const NOW = Date.parse('2026-09-28T02:30:00Z')
const ZONE = 'America/Toronto'
const range = { from: null, to: null }
const claudeCounts = {
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  cacheWrite1h: 15,
  turns: 2,
  cost: 1.5,
  unpriced: 0,
  sessions: 1,
  zeroCacheReadTurns: 1
}
const codexCounts = {
  input: 100,
  output: 40,
  cached: 70,
  reasoning: 25,
  total: 140,
  turns: 3,
  sessions: 1
}
const report = (provider, counts, extra = {}) => ({
  ok: true,
  provider,
  range,
  timezone: ZONE,
  generatedAt: new Date(NOW).toISOString(),
  totals: counts,
  byDay: [{ day: '2026-09-27', ...counts }],
  byModel: [{ model: `${provider}-model`, ...counts }],
  byProject: [{ cwd: 'C:\\work\\project', ...counts }],
  sessions: [
    {
      id: 'same-id',
      cwd: 'C:\\work\\project',
      model: `${provider}-model`,
      first: '2026-09-27T02:00:00Z',
      last: '2026-09-27T03:00:00Z',
      ...(provider === 'codex' ? { tokens: counts } : counts)
    }
  ],
  ...extra
})
const normalized = (provider, counts, extra) =>
  normalizeUsageReport(provider, report(provider, counts, extra))

describe('usage calendar ranges', () => {
  it('uses the local calendar day, not the UTC date, including both endpoints', () => {
    expect(usageLocalDay(NOW, ZONE)).toBe('2026-09-27')
    expect(usageDateRange('7d', { now: NOW, timezone: ZONE })).toEqual({
      from: '2026-09-21',
      to: '2026-09-27'
    })
    expect(usageDateRange('30d', { now: NOW, timezone: ZONE })).toEqual({
      from: '2026-08-29',
      to: '2026-09-27'
    })
    expect(usageDateRange('90d', { now: NOW, timezone: ZONE })).toEqual({
      from: '2026-06-30',
      to: '2026-09-27'
    })
  })

  it('does calendar arithmetic across both DST transitions and leap days', () => {
    expect(
      usageDateRange('7d', { now: Date.parse('2026-03-10T04:30:00Z'), timezone: ZONE })
    ).toEqual({ from: '2026-03-04', to: '2026-03-10' })
    expect(
      usageDateRange('7d', { now: Date.parse('2026-11-03T05:30:00Z'), timezone: ZONE })
    ).toEqual({ from: '2026-10-28', to: '2026-11-03' })
    expect(
      usageDateRange('7d', { now: Date.parse('2024-03-02T12:00:00Z'), timezone: ZONE })
    ).toEqual({ from: '2024-02-25', to: '2024-03-02' })
  })

  it('leaves all time unbounded and validates custom dates without rolling invalid days', () => {
    expect(usageDateRange('all')).toEqual({ from: null, to: null })
    expect(usageDateRange('custom', { from: '2024-02-29', to: '2024-02-29' })).toEqual({
      from: '2024-02-29',
      to: '2024-02-29'
    })
    expect(validUsageDay('2026-02-29')).toBe(false)
    expect(() => usageDateRange('custom', { from: '2026-02-30', to: '2026-03-02' })).toThrow(
      RangeError
    )
    expect(() => usageDateRange('custom', { from: '2026-03-02', to: '2026-03-01' })).toThrow(
      RangeError
    )
    expect(() => usageDateRange('forever')).toThrow(RangeError)
  })
})

describe('usage report normalization', () => {
  it('adds Claude cache buckets once and leaves one-hour writes inside all writes', () => {
    const result = normalized('claude', claudeCounts)
    expect(result.summary).toMatchObject({
      totalTokens: 100,
      newInputTokens: 10,
      cacheTokens: 70,
      cacheWrite1hTokens: 15,
      activityCount: 2,
      turns: 2,
      events: null,
      estimatedCostUsd: 1.5,
      zeroCacheReadTurns: 1,
      cacheReuseRate: 0.75,
      sessions: 1
    })
    expect(result.metrics).toBe(result.summary)
    for (const row of [result.byDay[0], result.byModel[0], result.byProject[0], result.sessions[0]])
      expect(row.totalTokens).toBe(100)
  })

  it('uses Codex cached/reasoning as subsets and never fabricates a price', () => {
    const result = normalized('codex', { ...codexCounts, cost: 999 })
    expect(result.summary).toMatchObject({
      totalTokens: 140,
      newInputTokens: 30,
      inputTokens: 100,
      outputTokens: 40,
      cacheTokens: 70,
      reasoningTokens: 25,
      estimatedCostUsd: null,
      activityCount: 3,
      events: 3,
      turns: null,
      cacheReuseRate: 0.7,
      zeroCacheReadTurns: null
    })
    expect(
      result.summary.newInputTokens + result.summary.outputTokens + result.summary.cacheTokens
    ).toBe(result.summary.totalTokens)
    expect(result.sessions[0].totalTokens).toBe(140)
    expect(result.turnsMeaning).toContain('not user prompts')
  })

  it('distinguishes fully unknown cost from partially priced activity and known zero', () => {
    expect(normalized('claude', { ...claudeCounts, unpriced: 2, cost: 0 }).summary).toMatchObject({
      estimatedCostUsd: null,
      hasUnpricedModels: true,
      hasPartialCost: false
    })
    expect(normalized('claude', { ...claudeCounts, unpriced: 1 }).summary).toMatchObject({
      estimatedCostUsd: 1.5,
      hasPartialCost: true
    })
    expect(normalized('claude', { ...claudeCounts, cost: 0 }).summary.estimatedCostUsd).toBe(0)
    expect(normalized('claude', { ...claudeCounts, cost: NaN }).summary.estimatedCostUsd).toBeNull()
  })

  it('does not substitute an all-time Claude total for its legacy recent window', () => {
    const result = normalizeUsageReport('claude', {
      ok: true,
      totals: { ...claudeCounts, cost: 10000 },
      lastDays: claudeCounts,
      sessions: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, ...claudeCounts }))
    })
    expect(result.summary.estimatedCostUsd).toBe(1.5)
    expect(result.warnings.join(' ')).toContain('incomplete')
    const unknownCount = normalizeUsageReport('claude', {
      ok: true,
      totals: { turns: 500 },
      lastDays: { turns: 50 },
      sessions: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}` }))
    })
    expect(unknownCount.summary.sessions).toBeNull()
  })

  it('uses new filtered totals, never lastDays/allTotals, and retains complete session count', () => {
    const result = normalized(
      'claude',
      { ...claudeCounts, sessions: 73 },
      { lastDays: { cost: 9999 }, allTotals: { cost: 8888 } }
    )
    expect(result.summary.estimatedCostUsd).toBe(1.5)
    expect(result.summary.sessions).toBe(73)
  })

  it('keeps local scope/account provenance and unavailable metrics explicit', () => {
    const claude = normalized('claude', claudeCounts, { accountId: 'must-not-attribute' })
    expect(claude).toMatchObject({
      accountId: null,
      accountScoped: false,
      scopeLabel: 'Shared Claude history on this computer'
    })
    const codex = normalized('codex', codexCounts, {
      accountId: 'selected-account',
      scope: 'tessel-worktrees'
    })
    expect(codex).toMatchObject({
      accountId: 'selected-account',
      accountScoped: true,
      scopeLabel: 'Tessel worktrees only'
    })
    const error = normalizeUsageReport('codex', {
      ok: false,
      error: 'Unavailable',
      totals: codexCounts
    })
    expect(error).toMatchObject({
      status: 'error',
      hasData: false,
      error: 'Unavailable',
      summary: { totalTokens: 0, estimatedCostUsd: null }
    })
    expect(error.byDay).toEqual([])
    expect(normalizeUsageReport('claude', null).status).toBe('unavailable')
  })

  it('normalizes mixed timestamp types and does not invent titles, branches or precise metrics', () => {
    const result = normalized('codex', codexCounts)
    expect(result.sessions[0]).toMatchObject({
      first: Date.parse('2026-09-27T02:00:00Z'),
      last: Date.parse('2026-09-27T03:00:00Z'),
      title: '',
      branch: '',
      projectLabel: 'project'
    })
    const raw = report('claude', { ...claudeCounts, zeroCacheReadTurns: undefined })
    raw.sessions[0].last = 12345
    const adapted = normalizeUsageReport('claude', raw)
    expect(adapted.sessions[0].last).toBe(12345)
    expect(adapted.summary.zeroCacheReadTurns).toBeNull()
  })

  it('is immutable and has deterministic breakdown labels', () => {
    const raw = report('claude', claudeCounts)
    const before = JSON.stringify(raw)
    const result = normalizeUsageReport('claude', raw)
    expect(result.byProject[0].label).toBe('project')
    expect(result.topProject).toBe('project')
    expect(result.sessions[0].key).toBe('claude:same-id')
    expect(JSON.stringify(raw)).toBe(before)
  })

  it('ranks Claude models and projects by input/output while keeping cache-inclusive totals', () => {
    const cached = {
      ...claudeCounts,
      input: 10,
      output: 0,
      cacheRead: 1000,
      cacheWrite: 0,
      cost: 5
    }
    const fresh = { ...claudeCounts, input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 }
    const raw = report('claude', claudeCounts, {
      byModel: [
        { model: 'cached', ...cached },
        { model: 'fresh', ...fresh }
      ],
      byProject: [
        { cwd: 'C:/cached', ...cached },
        { cwd: 'C:/fresh', ...fresh }
      ]
    })
    const before = JSON.stringify(raw)
    const result = normalizeUsageReport('claude', raw)
    expect(result.byModel.map((row) => row.key)).toEqual(['fresh', 'cached'])
    expect(result.byProject.map((row) => row.label)).toEqual(['fresh', 'cached'])
    expect(result.topModel).toBe('fresh')
    expect(result.topProject).toBe('fresh')
    expect(result.byModel[1]).toMatchObject({ breakdownTokens: 10, totalTokens: 1010, sessions: 1 })
    expect(result.summary.totalTokens).toBe(100)
    expect(result.byDay[0].totalTokens).toBe(100)
    expect(buildUsageOverview({ claude: result }, { now: NOW }).totalTokens).toBe(100)
    expect(JSON.stringify(raw)).toBe(before)
  })
})

describe('combined usage overview', () => {
  it('sums normalized provider buckets and marks a known cost incomplete for unpriced Codex use', () => {
    const overview = buildUsageOverview(
      { claude: normalized('claude', claudeCounts), codex: normalized('codex', codexCounts) },
      { now: NOW, timezone: ZONE }
    )
    expect(overview).toMatchObject({
      totalTokens: 240,
      newInputTokens: 40,
      outputTokens: 60,
      cacheTokens: 140,
      reasoningTokens: 25,
      activityCount: 5,
      sessions: 2,
      estimatedCostUsd: 1.5,
      hasPartialCost: true,
      activeDays: 1,
      dataProviderCount: 2
    })
    expect(overview.cacheShare).toBe(140 / 180)
    expect(overview.daily).toHaveLength(42)
    expect(overview.daily.at(-1)).toMatchObject({
      day: '2026-09-27',
      totalTokens: 240,
      claudeTokens: 100,
      codexTokens: 140,
      intensity: 4
    })
    expect(overview.bestDay.day).toBe('2026-09-27')
    expect(overview.providers[1].totalTokens).toBe(140)
  })

  it('does not turn unknown prices into $0 when an empty priced provider is available', () => {
    const emptyClaude = normalized('claude', {
      input: 0,
      output: 0,
      turns: 0,
      cost: 0,
      sessions: 0
    })
    const overview = buildUsageOverview(
      { claude: emptyClaude, codex: normalized('codex', codexCounts) },
      { now: NOW }
    )
    expect(overview.estimatedCostUsd).toBeNull()
    expect(overview.hasPartialCost).toBe(false)
    expect(buildUsageOverview({}, { now: NOW }).bestDay).toBeNull()
  })

  it('counts unique active days across providers and preserves missing days/DST calendar continuity', () => {
    const data = normalized('codex', codexCounts, {
      byDay: [
        { day: '2026-03-07', ...codexCounts },
        { day: '2026-03-09', ...codexCounts }
      ]
    })
    const overview = buildUsageOverview(
      { codex: data },
      { now: Date.parse('2026-03-10T04:30:00Z'), timezone: ZONE, dayCount: 4 }
    )
    expect(overview.daily.map((d) => d.day)).toEqual([
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10'
    ])
    expect(overview.daily[1].totalTokens).toBe(0)
    expect(overview.activeDays).toBe(2)
    expect(overview.bestDay.day).toBe('2026-03-07')
  })

  it('excludes unavailable/disabled reports and does not deduplicate unrelated provider session ids', () => {
    const off = normalizeUsageReport('claude', report('claude', claudeCounts, { enabled: false }))
    const result = buildUsageOverview(
      { claude: off, codex: normalized('codex', codexCounts) },
      { now: NOW }
    )
    expect(result.totalTokens).toBe(140)
    expect(result.sessions).toBe(1)
    expect(result.enabledProviderCount).toBe(1)
  })
})

describe('usage conversation table', () => {
  it('searches title/project/branch/model and paginates without changing report totals or source ordering', () => {
    const list = [
      {
        id: 'a',
        key: 'a',
        title: 'Fix',
        cwd: 'C:/Project',
        branch: 'feature',
        model: 'model-a',
        last: 10,
        totalTokens: 5,
        estimatedCostUsd: null
      },
      {
        id: 'b',
        key: 'b',
        title: 'Fix again',
        cwd: 'C:/Other',
        branch: 'main',
        model: 'model-b',
        last: 20,
        totalTokens: 50,
        estimatedCostUsd: 1
      },
      { id: 'c', key: 'c', title: 'Unrelated', last: 30, totalTokens: 8, estimatedCostUsd: 2 }
    ]
    const copy = JSON.stringify(list)
    expect(filterUsageSessions(list, { search: 'fix', limit: 1, offset: 1 })).toEqual({
      rows: [list[0]],
      total: 2
    })
    expect(filterUsageSessions(list, { search: 'FEATURE' }).rows.map((r) => r.id)).toEqual(['a'])
    expect(
      filterUsageSessions(list, { sortBy: 'estimatedCostUsd', sortDir: 'asc' }).rows.map(
        (r) => r.id
      )
    ).toEqual(['b', 'c', 'a'])
    expect(
      filterUsageSessions(list, { sortBy: 'totalTokens', sortDir: 'desc' }).rows.map((r) => r.id)
    ).toEqual(['b', 'c', 'a'])
    expect(JSON.stringify(list)).toBe(copy)
  })
})
