// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import {
  aggregateCodexUsage,
  consumeCodexUsageLine,
  createCodexUsageReport,
  newCodexUsageState,
  validCodexUsageState
} from '../codexUsageReport'

const NOW = Date.parse('2026-09-28T16:00:00Z')
const at = (seconds = 0) => new Date(NOW + seconds * 1000).toISOString()
const raw = (input = 100, cached = 30, output = 20, reasoning = 4) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output
})
const meta = (id = 'session-a', extra = {}) => ({
  type: 'session_meta',
  timestamp: at(-1000),
  payload: { id, cwd: 'C:/Project A', ...extra }
})
const context = (model = 'gpt-test', cwd = 'C:/Project A') => ({
  type: 'turn_context',
  timestamp: at(-1),
  payload: { model, cwd }
})
const count = (total = raw(), last = raw(), seconds = 0, extra = {}) => ({
  type: 'event_msg',
  timestamp: at(seconds),
  payload: {
    type: 'token_count',
    info: { total_token_usage: total, last_token_usage: last },
    ...extra
  }
})
const rows = (values) =>
  values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n') + '\n'
function state(values, file = 'rollout-test.jsonl') {
  const value = newCodexUsageState(file)
  for (const row of values)
    consumeCodexUsageLine(typeof row === 'string' ? row : JSON.stringify(row), value)
  return value
}
const file = (state, path = '/rollout-a.jsonl') => ({ path, state })
const aggregate = (files, query = {}) =>
  aggregateCodexUsage(files, query, { now: NOW, timezone: 'America/Toronto' })
let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-usage-report-'))
})
afterEach(() => {
  const target = resolve(home)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-usage-report-'))
    throw new Error('Unexpected cleanup target')
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
function put(relative, contents) {
  const path = join(home, relative)
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, contents)
  return path
}
const reportReader = (extra = {}) =>
  createCodexUsageReport({
    home,
    env: {},
    userData: join(home, 'data'),
    now: () => NOW,
    timezone: 'America/Toronto',
    ...extra
  })

describe('Codex observed request accounting', () => {
  it('counts last usage rather than cumulative totals and does not double-add cached/reasoning', () => {
    const parsed = state([
      meta(),
      context(),
      count(raw(100000, 60000, 5000, 2000), raw(50, 40, 10, 7))
    ])
    expect(parsed.events[0]).toMatchObject({
      input: 50,
      cached: 40,
      output: 10,
      reasoning: 7,
      total: 60,
      turns: 1
    })
    expect(validCodexUsageState(parsed)).toBe(true)
  })
  it('ignores rate-limit re-emissions, including a later timestamp, and info:null', () => {
    const parsed = state([
      meta(),
      context(),
      count(),
      count(raw(), raw(), 1),
      {
        type: 'event_msg',
        timestamp: at(2),
        payload: { type: 'token_count', info: null, rate_limits: {} }
      },
      context()
    ])
    expect(parsed.events).toHaveLength(1)
    expect(parsed.malformed).toBe(0)
  })
  it('counts a real last request when cumulative counters reset, without a regression heuristic', () => {
    const parsed = state([
      meta(),
      count(raw(1000, 900, 100, 40)),
      count(raw(990, 890, 99, 39), raw(10, 5, 2, 1), 1)
    ])
    expect(parsed.events).toHaveLength(2)
    expect(parsed.events[1].total).toBe(12)
    expect(parsed.previous.input).toBe(990)
  })
  it('uses cumulative differences only without last and resets the baseline on a decline', () => {
    const parsed = state([
      meta(),
      count(raw(100, 30, 20, 4), null),
      count(raw(160, 50, 30, 6), null, 1),
      count(raw(10, 0, 1, 0), null, 2),
      count(raw(15, 2, 3, 1), null, 3)
    ])
    expect(parsed.events.map((e) => e.total)).toEqual([120, 70, 7])
  })
  it('does not charge synthetic context estimates as model usage', () => {
    const parsed = state([
      meta(),
      count(),
      count(raw(200, 60, 40, 8), { total_tokens: 200000 }, 1),
      count(
        { ...raw(0, 0, 0, 0), total_tokens: 258400 },
        { ...raw(0, 0, 0, 0), total_tokens: 258400 },
        2
      ),
      count(raw(50, 20, 3, 1), raw(50, 20, 3, 1), 3)
    ])
    expect(parsed.events.map((e) => e.total)).toEqual([120, 53])
  })
  it('treats a first inherited/partial total-only observation as a baseline', () => {
    const inherited = state([
      meta('fork', { forked_from_id: 'session-a' }),
      count(raw(10000, 5000, 3000, 1000), null),
      count(raw(10050, 5020, 3010, 1005), null, 1)
    ])
    expect(inherited.events.map((e) => e.total)).toEqual([60])
    expect(inherited.baselines).toBe(1)
    expect(state([count(raw(), null)]).events).toHaveLength(0)
  })
  it('still accounts for copied historical rows predating a fork when its original file is absent', () => {
    const historical = count(raw(), null)
    historical.timestamp = at(-2000)
    const fork = state([meta('fork', { forked_from_id: 'missing-original' }), historical])
    expect(fork.events[0].total).toBe(120)
  })
  it('does not add the newer token_usage_record a second time', () => {
    const parsed = state([
      meta(),
      { type: 'token_usage_record', timestamp: at(), payload: { usage: raw(), turn_id: 'turn-a' } },
      count()
    ])
    expect(parsed.events).toHaveLength(1)
  })
  it('uses thread id, turn model/cwd and explicit usage model without inferring from quotas', () => {
    const parsed = state([
      meta('child', { session_id: 'root-id', parent_thread_id: 'parent' }),
      context('model-a'),
      count(),
      context('model-b', '/home/project-b'),
      count(raw(200), raw(50), 1, {
        info: {
          total_token_usage: raw(200),
          last_token_usage: raw(50),
          metadata: { model: 'model-c' }
        },
        rate_limits: { normal_model_slug: 'wrong' }
      })
    ])
    expect(parsed.id).toBe('child')
    expect(parsed.events.map((e) => [e.model, e.cwd])).toEqual([
      ['model-a', 'C:/Project A'],
      ['model-c', '/home/project-b']
    ])
  })
  it('does not persist prompts, tool output or credentials, and tolerates malformed/blank lines', () => {
    const parsed = state([
      meta(),
      'not-json',
      '',
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'PRIVATE_PROMPT' }
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', output: 'PRIVATE_SECRET' }
      },
      count(null, { input_tokens: -10, output_tokens: 5 }),
      count()
    ])
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE_')
    expect(parsed.events).toHaveLength(1)
    expect(parsed.malformed).toBe(2)
    expect(validCodexUsageState({ ...parsed, events: [{ ...parsed.events[0], total: -10 }] })).toBe(
      false
    )
  })
})

describe('report projections and filters', () => {
  it('counts unique sessions per model/project across turns, models, projects and filters', () => {
    const first = state([
      meta('shared'),
      context('model-a', 'C:/Repo/A'),
      count(),
      context('model-a', 'c:\\REPO\\a\\'),
      count(raw(200), raw(50), 1),
      context('model-b', 'C:/Repo/B'),
      count(raw(300), raw(50), 2)
    ])
    const second = state([meta('second'), context('model-b', 'C:/Repo/A'), count(raw(), raw(), 3)])
    const oldCount = count()
    oldCount.timestamp = '2026-01-01T12:00:00Z'
    const old = state([meta('old'), context('model-a', 'C:/Repo/A'), oldCount])
    const files = [file(first, '/first'), file(second, '/second'), file(old, '/old')]
    const result = aggregate(files)
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
    const scoped = aggregate(files, { roots: ['C:/Repo/A'], model: 'model-b' })
    expect(scoped.totals.sessions).toBe(1)
    expect(scoped.byModel).toHaveLength(1)
    expect(scoped.byModel[0].sessions).toBe(1)
    expect(scoped.byProject).toHaveLength(1)
    expect(scoped.byProject[0].sessions).toBe(1)
    expect(
      aggregate(files, { from: null, to: null }).byModel.find((entry) => entry.model === 'model-a')
        .sessions
    ).toBe(2)
    expect(JSON.parse(JSON.stringify(result)).byModel[0].sessions).toEqual(expect.any(Number))
  })

  it('filters worktree roots with path boundaries, Windows aliases and POSIX case preserved', () => {
    const paths = [
      'C:/Repo/tree',
      'c:\\REPO\\tree\\nested',
      'C:/Repo/tree-other',
      'C:/Repo/tree/../outside',
      '/work/Repo',
      '/work/repo',
      '\\\\SERVER\\Share\\tree'
    ]
    const files = paths.map((cwd, i) =>
      file(
        state([
          meta(`session-${i}`),
          context('m', cwd),
          count(raw(10, 0, 0, 0), raw(10, 0, 0, 0), i)
        ]),
        `/file-${i}`
      )
    )
    expect(aggregate(files, { roots: ['C:\\repo\\TREE\\'] })).toMatchObject({
      scope: 'tessel-worktrees',
      totals: { input: 20, turns: 2, sessions: 2 }
    })
    expect(aggregate(files, { roots: ['C:/Repo/tree'], cwd: 'c:/repo/TREE' }).totals.input).toBe(10)
    expect(aggregate(files, { roots: ['C:/Repo/tree'], model: 'other' }).totals.input).toBe(0)
    expect(aggregate(files, { roots: ['/work/Repo'] }).totals.input).toBe(10)
    expect(aggregate(files, { roots: ['//server/share'] }).totals.input).toBe(10)
    expect(aggregate(files, { roots: [] })).toMatchObject({
      scope: 'tessel-worktrees',
      totals: { total: 0 }
    })
    expect(aggregate(files).scope).toBe('all')
  })

  it('deduplicates before root filtering so copied prefixes cannot change attribution', () => {
    const original = state([meta(), context('m', 'C:/outside'), count()])
    const forkMeta = meta('fork', { forked_from_id: 'session-a' })
    forkMeta.timestamp = at(5)
    const fork = state([forkMeta, context('m', 'C:/tree'), count(), count(raw(200), raw(50), 10)])
    const result = aggregate([file(fork, '/fork'), file(original, '/original')], {
      roots: ['C:/tree']
    })
    expect(result.totals).toMatchObject({ input: 50, turns: 1, sessions: 1 })
    expect(result.scan.duplicated).toBe(1)
  })

  it('keeps POSIX project names case-sensitive while matching Windows aliases', () => {
    const upper = state([
      meta('upper'),
      context('m', '/workspace/Repo'),
      count(raw(10, 0, 0, 0), raw(10, 0, 0, 0))
    ])
    const lower = state([
      meta('lower'),
      context('m', '/workspace/repo'),
      count(raw(20, 0, 0, 0), raw(20, 0, 0, 0), 1)
    ])
    const files = [file(upper, '/upper'), file(lower, '/lower')]
    expect(aggregate(files).byProject).toHaveLength(2)
    expect(aggregate(files, { cwd: '/workspace/Repo' }).totals.input).toBe(10)
  })

  it('ignores an exact old row replay before it can rewind a cumulative-only baseline', () => {
    const first = count(raw(100, 0, 0, 0), raw(100, 0, 0, 0))
    const parsed = state([
      meta(),
      first,
      count(raw(200, 0, 0, 0), raw(100, 0, 0, 0), 1),
      first,
      count(raw(300, 0, 0, 0), null, 2)
    ])
    expect(aggregate([file(parsed)]).totals.input).toBe(300)
    expect(parsed.events).toHaveLength(3)
  })

  it('deduplicates copied fork records globally, including after the original disappears', () => {
    const original = state([meta(), context(), count()])
    const forkMeta = meta('fork', { forked_from_id: 'session-a' })
    forkMeta.timestamp = at(5)
    const fork = state([forkMeta, context(), count(), count(raw(200), raw(50), 10)])
    const both = aggregate([file(fork, '/aaa-fork.jsonl'), file(original, '/zzz-original.jsonl')])
    expect(both.totals).toMatchObject({ input: 150, output: 40, total: 190, turns: 2, sessions: 2 })
    expect(both.scan.duplicated).toBe(1)
    expect(aggregate([file(fork)]).totals.total).toBe(190)
  })
  it('aggregates per-day/model/project and exposes mixed session attribution', () => {
    const parsed = state([
      meta(),
      context(),
      count(),
      context('model-b', 'D:/Project B'),
      count(raw(200), raw(50, 20, 10, 3), 1)
    ])
    const result = aggregate([file(parsed)])
    expect(result.totals).toMatchObject({
      input: 150,
      cached: 50,
      output: 30,
      reasoning: 7,
      total: 180,
      turns: 2
    })
    for (const rows of [result.byDay, result.byModel, result.byProject])
      expect(rows.reduce((n, r) => n + r.total, 0)).toBe(180)
    expect(result.sessions[0]).toMatchObject({
      model: 'mixed',
      models: ['gpt-test', 'model-b'],
      tokens: { total: 180 }
    })
    expect(aggregate([file(parsed)], { model: 'model-b' }).totals.total).toBe(60)
    expect(aggregate([file(parsed)], { cwd: 'c:\\PROJECT a\\' }).totals.total).toBe(120)
  })
  it('uses local dates near UTC midnight and inclusive date filters', () => {
    const first = count()
    first.timestamp = '2026-09-28T02:30:00Z' // Sep 27 in Toronto
    const second = count(raw(200), raw(50), 1)
    second.timestamp = '2026-09-28T04:30:00Z'
    const parsed = state([meta(), first, second])
    const result = aggregate([file(parsed)], { from: '2026-09-27', to: '2026-09-27' })
    expect(result.timezone).toBe('America/Toronto')
    expect(result.byDay.map((r) => r.day)).toEqual(['2026-09-27'])
    expect(result.totals.turns).toBe(1)
  })
  it('defaults to 30 calendar days and supports an explicit open range', () => {
    const older = count()
    older.timestamp = '2026-08-29T16:00:00Z'
    const included = count(raw(200), raw(50), 1)
    included.timestamp = '2026-08-30T16:00:00Z'
    const parsed = state([meta(), older, included])
    expect(aggregate([file(parsed)]).range).toEqual({ from: '2026-08-30', to: '2026-09-28' })
    expect(aggregate([file(parsed)]).totals.turns).toBe(1)
    expect(aggregate([file(parsed)], { from: null, to: null }).totals.turns).toBe(2)
  })
  it('does not collapse two repeated local clock hours across daylight saving time', () => {
    const first = count()
    first.timestamp = '2026-11-01T05:30:00Z'
    const second = count(raw(200), raw(50), 1)
    second.timestamp = '2026-11-01T06:30:00Z'
    const result = aggregate([file(state([meta(), first, second]))], { from: null, to: null })
    expect(result.byDay).toHaveLength(1)
    expect(result.byDay[0]).toMatchObject({ day: '2026-11-01', turns: 2 })
  })
  it('rejects malformed filters and returns an honest empty report with no dollar estimate', () => {
    for (const query of [
      { from: '2026-02-30' },
      { from: '2026-10-01', to: '2026-09-01' },
      { model: [] },
      { roots: null },
      { roots: ['relative/path'] },
      { roots: ['C:relative'] },
      { roots: ['/root\nother'] }
    ])
      expect(() => aggregate([], query)).toThrow()
    const empty = aggregate([])
    expect(empty.totals).toMatchObject({ total: 0, turns: 0, sessions: 0 })
    expect(empty.byDay).toEqual([])
    expect(empty).not.toHaveProperty('cost')
    expect(empty.totals).not.toHaveProperty('cost')
  })
})

describe('complete incremental report', () => {
  it('reuses memory and persisted cache, then counts only appended requests', async () => {
    const path = put(
      '.codex/sessions/2026/09/28/rollout-a.jsonl',
      rows([meta(), context(), count()])
    )
    const reader = reportReader()
    expect((await reader()).totals.total).toBe(120)
    const repeated = await reader()
    expect(repeated.scan).toMatchObject({ files: 1, read: 0, reused: 1, bytesRead: 0 })
    const restarted = await reportReader()()
    expect(restarted.scan).toMatchObject({ read: 0, reused: 1, bytesRead: 0 })
    fs.appendFileSync(path, rows([count(raw(200), raw(50, 20, 10, 3), 1)]))
    const appended = await reader()
    expect(appended.scan.appended).toBe(1)
    expect(appended.totals).toMatchObject({ total: 180, turns: 2 })
    expect(fs.existsSync(join(home, 'data/codex-usage-report-v1.json'))).toBe(true)
  })
  it('handles a split append and a replacement without duplicating old counters', async () => {
    const path = put('.codex/sessions/rollout-a.jsonl', rows([meta(), count()]))
    const reader = reportReader()
    await reader()
    const next = rows([count(raw(200), raw(50), 1)])
    fs.appendFileSync(path, next.slice(0, 30))
    expect((await reader()).totals.turns).toBe(1)
    fs.appendFileSync(path, next.slice(30))
    expect((await reader()).totals.turns).toBe(2)
    fs.writeFileSync(path, rows([meta(), count(raw(10), raw(10))]))
    expect((await reader()).totals.total).toBe(30)
  })
  it('keeps copied usage counted once after a cache restart and deletion of the original', async () => {
    const original = put('.codex/sessions/rollout-a.jsonl', rows([meta(), count()]))
    const forkMeta = meta('fork', { forked_from_id: 'session-a' })
    forkMeta.timestamp = at(5)
    put('.codex/sessions/rollout-b.jsonl', rows([forkMeta, count(), count(raw(200), raw(50), 10)]))
    expect((await reportReader()()).totals.total).toBe(190)
    fs.unlinkSync(original)
    const reclaimed = await reportReader()()
    expect(reclaimed.totals).toMatchObject({ total: 190, turns: 2, sessions: 1 })
  })
  it('uses renamed session-index titles and never caches raw prompts or secrets', async () => {
    put(
      '.codex/sessions/rollout-a.jsonl',
      rows([
        meta(),
        { type: 'event_msg', payload: { type: 'user_message', message: 'PRIVATE_PROMPT_MARKER' } },
        count()
      ])
    )
    const index = put(
      '.codex/session_index.jsonl',
      rows([
        { id: 'session-a', thread_name: 'Old name' },
        { id: 'session-a', thread_name: 'Renamed session' }
      ])
    )
    const reader = reportReader()
    expect((await reader()).sessions[0].title).toBe('Renamed session')
    fs.appendFileSync(index, rows([{ id: 'session-a', thread_name: 'Newest name' }]))
    expect((await reader()).sessions[0].title).toBe('Newest name')
    expect(fs.readFileSync(join(home, 'data/codex-usage-report-v1.json'), 'utf8')).not.toContain(
      'PRIVATE_PROMPT_MARKER'
    )
  })
  it('honors CODEX_HOME and never modifies the source logs or auth file', async () => {
    const root = join(home, 'custom')
    const path = put('custom/sessions/rollout-a.jsonl', rows([meta(), count()]))
    const auth = put('custom/auth.json', 'PRIVATE_AUTH_MARKER')
    const before = [path, auth].map((p) => [fs.readFileSync(p, 'utf8'), fs.statSync(p).mtimeMs])
    const report = await reportReader({ env: { CODEX_HOME: root } })()
    expect(report.totals.total).toBe(120)
    expect(JSON.stringify(report)).not.toContain('PRIVATE_AUTH_MARKER')
    expect([path, auth].map((p) => [fs.readFileSync(p, 'utf8'), fs.statSync(p).mtimeMs])).toEqual(
      before
    )
  })
})
