import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createUsageFileCache } from '../jobCostUsage'
import { createJobCost, cardWindows, attribute, summarize } from '../jobCost'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const CX = '33333333-3333-4333-8333-333333333333'
const T0 = Date.parse('2026-10-01T10:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

function claudeLine({ id, at, model = 'claude-opus-4-8', input = 10, output = 20, cacheRead = 0, cacheWrite = 0, requestId = 'req' }) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    requestId: `${requestId}-${id}`,
    uuid: `${id}-${Math.random()}`,
    message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } }
  })
}
const userLine = (at) => JSON.stringify({ type: 'user', timestamp: iso(at), message: { role: 'user', content: 'hi' } })
function tokenCount(at, total, last) {
  const u = (x) => ({ input_tokens: x[0], cached_input_tokens: x[1], output_tokens: x[2], reasoning_output_tokens: 0, total_tokens: x[0] + x[2] })
  return JSON.stringify({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u(total), last_token_usage: last ? u(last) : null } } })
}

// A priced fake: Claude Opus at $1 per million of each kind, others unknown.
const estimate = ({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) =>
  /opus|gpt-5/.test(model || '')
    ? { usd: (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) / 1e6, known: true, perMillion: null }
    : { usd: null, known: false, perMillion: null }

let dir
let claudeHome
let codexHome
let userData
let sessions
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'jobcost-'))
  claudeHome = join(dir, '.claude')
  codexHome = join(dir, '.codex')
  userData = join(dir, 'userData')
  sessions = join(dir, 'sessions')
  for (const d of [join(claudeHome, 'projects', 'proj'), join(codexHome, 'sessions', '2026', '10', '01'), userData, sessions]) fs.mkdirSync(d, { recursive: true })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const claudeFile = (id) => join(claudeHome, 'projects', 'proj', `${id}.jsonl`)
const write = (file, lines) => fs.writeFileSync(file, lines.map((l) => l + '\n').join(''))
const append = (file, lines) => fs.appendFileSync(file, lines.map((l) => l + '\n').join(''))
const report = (paneId, agent, sessionId, transcriptPath) =>
  fs.writeFileSync(join(sessions, `${paneId}.json`), JSON.stringify({ agent, sessionId, transcriptPath, at: T0 }))
const service = (extra = {}) =>
  createJobCost({ userDataDir: userData, sessionsDir: () => sessions, homes: async (a) => [a === 'codex' ? codexHome : claudeHome], estimate, now: () => T0 + 3600000, pollMs: 0, ...extra })

describe('usage file cache', () => {
  it('counts a streamed Claude reply once (same message id), keeping the largest counts', async () => {
    const f = claudeFile(S1)
    write(f, [claudeLine({ id: 'm1', at: T0, output: 5 }), claudeLine({ id: 'm1', at: T0 + 1, output: 50 }), claudeLine({ id: 'm2', at: T0 + 2 })])
    const r = await createUsageFileCache().read(f, 'claude')
    expect(r.events).toHaveLength(2)
    expect(r.events[0]).toMatchObject({ input: 10, output: 50, provider: 'anthropic' })
  })

  it('reads only what was appended, and again from the start when the file shrank', async () => {
    const f = claudeFile(S1)
    const reads = []
    const spy = { ...fs.promises, open: async (p, m) => { const h = await fs.promises.open(p, m); const read = h.read.bind(h); h.read = (b, o, l, pos) => { reads.push(pos); return read(b, o, l, pos) }; return h } }
    const cache = createUsageFileCache({ fs: spy })
    write(f, [claudeLine({ id: 'm1', at: T0 })])
    expect((await cache.read(f, 'claude')).events).toHaveLength(1)
    const size = fs.statSync(f).size
    append(f, [claudeLine({ id: 'm2', at: T0 + 1000 })])
    expect((await cache.read(f, 'claude')).events).toHaveLength(2)
    expect(reads.at(-1)).toBe(size)
    const count = reads.length
    expect((await cache.read(f, 'claude')).events).toHaveLength(2)
    expect(reads.length).toBe(count) // unchanged file: not read
    write(f, [claudeLine({ id: 'x', at: T0 })])
    const again = await cache.read(f, 'claude')
    expect(again.events.map((e) => e.key)).toEqual(['c:x'])
  })

  it('keeps a line still being written for the next read', async () => {
    const f = claudeFile(S1)
    const line = claudeLine({ id: 'm1', at: T0 })
    fs.writeFileSync(f, line.slice(0, 40))
    const cache = createUsageFileCache()
    expect((await cache.read(f, 'claude')).events).toHaveLength(0)
    fs.appendFileSync(f, line.slice(40) + '\n')
    expect((await cache.read(f, 'claude')).events).toHaveLength(1)
  })

  it('stops at the byte budget and goes on next time', async () => {
    const f = claudeFile(S1)
    write(f, [claudeLine({ id: 'm1', at: T0 }), claudeLine({ id: 'm2', at: T0 })])
    const cache = createUsageFileCache()
    const r = await cache.read(f, 'claude', { bytes: 50 })
    expect(r.done).toBe(false)
    const r2 = await cache.read(f, 'claude')
    expect(r2.done).toBe(true)
    expect(r2.events).toHaveLength(2)
  })

  it('Codex token_count: increments, cached input apart from input, replays skipped', async () => {
    const f = join(codexHome, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${CX}.jsonl`)
    write(f, [
      JSON.stringify({ timestamp: iso(T0), type: 'turn_context', payload: { model: 'gpt-5.5', cwd: 'C:\\p' } }),
      tokenCount(T0 + 1000, [100, 40, 10], [100, 40, 10]),
      tokenCount(T0 + 1000, [100, 40, 10], [100, 40, 10]), // replay
      tokenCount(T0 + 2000, [300, 140, 30], [200, 100, 20])
    ])
    const r = await createUsageFileCache().read(f, 'codex')
    expect(r.events).toHaveLength(2)
    expect(r.events[0]).toMatchObject({ model: 'gpt-5.5', provider: 'openai', input: 60, cacheRead: 40, output: 10, cacheWrite: 0 })
    expect(r.events[1]).toMatchObject({ input: 100, cacheRead: 100, output: 20 })
  })

  it('a chat journal: turnEnd usage with the model of the latest init and the reported cost', async () => {
    const f = join(userData, 'j.jsonl')
    write(f, [
      JSON.stringify({ seq: 1, at: T0, event: { type: 'init', model: 'openrouter/some-model' } }),
      JSON.stringify({ seq: 2, at: T0 + 10, event: { type: 'assistant', text: 'x' } }),
      JSON.stringify({ seq: 3, at: T0 + 20, event: { type: 'turnEnd', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3 }, costUsd: 0.25 } })
    ])
    const r = await createUsageFileCache().read(f, 'journal', undefined, { agent: 'opencode' })
    expect(r.events).toEqual([expect.objectContaining({ provider: 'openrouter', model: 'some-model', input: 5, output: 7, cacheRead: 3, reportedUsd: 0.25 })])
    expect(r.last - r.first).toBe(20)
  })
})

describe('card windows and attribution', () => {
  it('uses the work periods, an open one up to now', () => {
    const c = { column: 'doing', paneId: 'p', workPeriods: [{ start: 10, end: 20, paneId: 'a' }, { start: 30, end: null, paneId: 'b' }] }
    expect(cardWindows(c, 100)).toEqual([{ start: 10, end: 20, paneId: 'a' }, { start: 30, end: 100, paneId: 'b' }])
  })

  it('an older card: startedAt to doneAt, or to now while open', () => {
    expect(cardWindows({ column: 'done', paneId: 'p', startedAt: 10, doneAt: 50 }, 100)).toEqual([{ start: 10, end: 50, paneId: 'p' }])
    expect(cardWindows({ column: 'doing', paneId: 'p', startedAt: 10 }, 100)).toEqual([{ start: 10, end: 100, paneId: 'p' }])
    expect(cardWindows({ column: 'todo', paneId: 'p' }, 100)).toEqual([])
  })

  it('splits an event equally between the cards in Doing at its time', () => {
    const ev = (at) => ({ key: String(at), at, model: 'claude-opus-4-8', provider: 'anthropic', input: 100, output: 0, cacheRead: 0, cacheWrite: 0 })
    const res = attribute([ev(5), ev(15), ev(25)], [
      { id: 'A', windows: [{ start: 0, end: 20 }] },
      { id: 'B', windows: [{ start: 10, end: 30 }] }
    ])
    const a = summarize(res.get('A'), 20, estimate)
    const b = summarize(res.get('B'), 20, estimate)
    expect(a.inputTokens).toBe(150) // 100 + 50
    expect(b.inputTokens).toBe(150) // 50 + 100
  })

  it('model switches: one cost per model; an unknown price leaves known=false and usd the known part', () => {
    const res = attribute(
      [
        { key: '1', at: 1, model: 'claude-opus-4-8', provider: 'anthropic', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 },
        { key: '2', at: 2, model: 'mystery-1', provider: 'x', input: 5e6, output: 0, cacheRead: 0, cacheWrite: 0 }
      ],
      [{ id: 'A', windows: [{ start: 0, end: 10 }] }]
    )
    const s = summarize(res.get('A'), 10, estimate)
    expect(s.models).toHaveLength(2)
    expect(s.usd).toBeCloseTo(1)
    expect(s.known).toBe(false)
    expect(s.model).toBe('mystery-1') // the most tokens
    expect(s.estimated).toBe(true)
  })
})

describe('job cost service', () => {
  it('a pane: its current session, sub-agents included, and its duration', async () => {
    const f = claudeFile(S1)
    write(f, [userLine(T0), claudeLine({ id: 'm1', at: T0 + 1000 }), claudeLine({ id: 'm1', at: T0 + 1500 }), claudeLine({ id: 'm2', at: T0 + 60000, input: 5, output: 5 })])
    const subDir = join(claudeHome, 'projects', 'proj', S1, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    write(join(subDir, 'agent-a1.jsonl'), [claudeLine({ id: 's1', at: T0 + 2000, input: 1, output: 1 })])
    report('pane-1', 'claude', S1, f)
    const r = await service().forPanes(['pane-1', 'bad/id', 'pane-none'])
    expect(Object.keys(r).sort()).toEqual(['pane-1', 'pane-none'])
    expect(r['pane-1']).toMatchObject({ status: 'ok', inputTokens: 16, outputTokens: 26, durationMs: 60000, estimated: true, known: true, model: 'claude-opus-4-8', provider: 'anthropic' })
    expect(r['pane-1'].subagents).toEqual([expect.objectContaining({ id: 'agent-a1', inputTokens: 1, outputTokens: 1 })])
    expect(r['pane-none']).toMatchObject({ status: 'unavailable', reason: 'no-session', usd: null })
  })

  it('a reported transcript outside every account folder is not read', async () => {
    const outside = join(dir, 'elsewhere.jsonl')
    write(outside, [claudeLine({ id: 'm1', at: T0 })])
    report('pane-1', 'claude', S1, outside)
    const r = await service().forPanes(['pane-1'])
    expect(r['pane-1']).toMatchObject({ status: 'unavailable', reason: 'missing-file' })
  })

  it('cards: the pane usage in their periods, overlaps split, other sessions of the pane kept', async () => {
    const f1 = claudeFile(S1)
    write(f1, [claudeLine({ id: 'a', at: T0 + 1000, input: 100, output: 0 })])
    report('pane-1', 'claude', S1, f1)
    const svc = service()
    await svc.forPanes(['pane-1']) // the pane's first session is remembered
    const f2 = claudeFile(S2)
    write(f2, [claudeLine({ id: 'b', at: T0 + 20000, input: 100, output: 0 }), claudeLine({ id: 'c', at: T0 + 40000, input: 100, output: 0 })])
    report('pane-1', 'claude', S2, f2)
    fs.writeFileSync(
      join(userData, 'task-board.json'),
      JSON.stringify({
        version: 2,
        appliedRequests: [],
        tasks: [
          { id: 'card-A', column: 'done', paneId: 'pane-1', workPeriods: [{ start: T0, end: T0 + 30000, paneId: 'pane-1' }] },
          { id: 'card-B', column: 'doing', paneId: 'pane-1', workPeriods: [{ start: T0 + 10000, end: null, paneId: 'pane-1' }] },
          { id: 'card-C', column: 'todo', paneId: null }
        ]
      })
    )
    const r = await svc.forCards(['card-A', 'card-B', 'card-C', 'card-gone'])
    expect(r['card-A'].inputTokens).toBe(150) // a + half of b
    expect(r['card-B'].inputTokens).toBe(150) // half of b + c
    expect(r['card-A'].durationMs).toBe(30000)
    expect(r['card-B'].durationMs).toBe(3600000 - 10000)
    expect(r['card-A'].usd).toBeCloseTo(150 / 1e6)
    expect(r['card-C']).toMatchObject({ status: 'unavailable', reason: 'not-started' })
    expect(r['card-gone']).toMatchObject({ status: 'unavailable', reason: 'no-card' })
    await svc.close()
    const saved = JSON.parse(fs.readFileSync(join(userData, 'job-cost-panes.json'), 'utf8'))
    expect(saved.panes['pane-1'].map((s) => s.sessionId)).toEqual([S1, S2])
  })

  it('a Codex pane found by its session id in the account folder', async () => {
    const f = join(codexHome, 'sessions', '2026', '10', '01', `rollout-2026-10-01T10-00-00-${CX}.jsonl`)
    write(f, [JSON.stringify({ timestamp: iso(T0), type: 'turn_context', payload: { model: 'gpt-5.5' } }), tokenCount(T0 + 1000, [100, 40, 10], [100, 40, 10])])
    report('pane-x', 'codex', CX, null)
    const r = await service({ now: () => Date.parse('2026-10-01T12:00:00Z') }).forPanes(['pane-x'])
    expect(r['pane-x']).toMatchObject({ status: 'ok', inputTokens: 60, cacheReadTokens: 40, outputTokens: 10, provider: 'openai', model: 'gpt-5.5', known: true })
  })

  it('an agent with no file Tessel reads: unavailable with a reason', async () => {
    report('pane-g', 'gemini', 'abcdef-123', null)
    const r = await service().forPanes(['pane-g'])
    expect(r['pane-g']).toMatchObject({ status: 'unavailable', reason: 'unsupported-agent' })
  })

  it('an OpenCode chat pane: its journal, priced from what it reported', async () => {
    const chat = join(userData, 'chats', 'pane-o')
    fs.mkdirSync(chat, { recursive: true })
    fs.writeFileSync(join(chat, 'meta.json'), JSON.stringify({ sessionId: 'ses_abcdef123', agent: 'opencode', cwd: 'C:\\p' }))
    write(join(chat, 'journal.jsonl'), [
      JSON.stringify({ seq: 1, at: T0, event: { type: 'init', model: 'zen/unknown-model' } }),
      JSON.stringify({ seq: 2, at: T0 + 5000, event: { type: 'turnEnd', usage: { input_tokens: 10, output_tokens: 2 }, costUsd: 0.5 } })
    ])
    const r = await service().forPanes(['pane-o'])
    expect(r['pane-o']).toMatchObject({ status: 'ok', inputTokens: 10, outputTokens: 2, usd: 0.5, known: true, durationMs: 5000 })
  })

  it('tells the window when a file it asked about changed (debounced)', async () => {
    const f = claudeFile(S1)
    write(f, [claudeLine({ id: 'm1', at: T0 })])
    report('pane-1', 'claude', S1, f)
    const sent = []
    const svc = service({ send: (ch) => sent.push(ch), debounceMs: 1 })
    await svc.forPanes(['pane-1'])
    await svc.poll()
    append(f, [claudeLine({ id: 'm2', at: T0 + 1 })])
    await svc.poll()
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual(['jobCost:changed'])
    await svc.close()
  })
})
