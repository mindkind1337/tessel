import { describe, it, expect } from 'vitest'
import {
  summarize,
  cardsFor,
  parseJournal,
  authorMatches,
  trimEvents,
  formatDuration,
  MAX_EVENTS
} from '../../../shared/activity'

const MIN = 60 * 1000
const T0 = Date.parse('2026-09-24T12:00:00Z')
const claude = { title: 'Claude Code', agentId: 'claude' }
const codex = { title: 'Codex CLI', agentId: 'codex' }
const st = (min, paneId, state, agent, extra = {}) => ({
  t: T0 + min * MIN,
  type: 'agent.state',
  paneId,
  state,
  agent,
  ...extra
})

const events = [
  st(0, 'p1', 'working', claude),
  st(10, 'p1', 'idle', claude),
  st(0, 'p2', 'working', codex),
  st(5, 'p2', 'approval', codex),
  st(9, 'p2', 'working', codex),
  st(20, 'p2', 'limited', codex, { reset: '8:47 PM' }),
  { t: T0 + 12 * MIN, type: 'message', paneId: 'p1', agent: claude, status: 'sent', source: 'you', scope: 'team', preview: 'hi' },
  { t: T0 + 12 * MIN, type: 'message', paneId: 'p2', agent: codex, status: 'held', source: 'you', scope: 'team', preview: 'hi' },
  { t: T0 + 13 * MIN, type: 'message', paneId: 'p2', agent: codex, status: 'delivered', source: 'you', scope: 'team', preview: 'hi' },
  { t: T0 + 25 * MIN, type: 'message', paneId: 'p2', agent: codex, status: 'skipped', source: 'tessel', scope: 'team-change', preview: 'x' },
  { t: T0 + 1 * MIN, type: 'team', action: 'created', teamId: 't1', name: 'Team 1' }
]
const live = { p1: { state: 'idle', ...claude }, p2: { state: 'limited', ...codex } }

describe('summarize', () => {
  const s = summarize(events, { now: T0 + 30 * MIN, from: T0 - 60 * MIN, live })

  it('adds up time in each state, open spans running until now', () => {
    const p1 = s.rows.find((r) => r.paneId === 'p1')
    expect(p1.ms.working).toBe(10 * MIN)
    expect(p1.ms.idle).toBe(20 * MIN)
    const p2 = s.rows.find((r) => r.paneId === 'p2')
    expect(p2.ms.working).toBe(5 * MIN + 11 * MIN)
    expect(p2.ms.approval).toBe(4 * MIN)
    expect(p2.ms.limited).toBe(10 * MIN)
  })

  it('counts approvals, limits and messages per agent', () => {
    const p2 = s.rows.find((r) => r.paneId === 'p2')
    expect(p2.approvals).toBe(1)
    expect(p2.limits).toBe(1)
    expect(p2.received).toBe(1) // held then delivered counts once as received
    expect(p2.held).toBe(1)
    expect(p2.skipped).toBe(1)
    expect(s.cards.messages).toEqual({ received: 2, held: 1, skipped: 1 })
  })

  it('reports the approval wait and what is going on now', () => {
    expect(s.cards.approvalWait).toEqual({ median: 4 * MIN, count: 1 })
    expect(s.cards.working).toBe(0)
    expect(s.cards.openAgents).toBe(2)
    const p2 = s.rows.find((r) => r.paneId === 'p2')
    expect(p2.state).toBe('limited')
    expect(p2.since).toBe(T0 + 20 * MIN)
  })

  it('builds a newest-first timeline without the working/idle churn', () => {
    const kinds = s.timeline.map((x) => x.kind)
    expect(kinds[0]).toBe('message') // the skipped one at +25
    expect(kinds).toContain('approval')
    expect(kinds).toContain('approval-end')
    expect(kinds).toContain('limit')
    expect(kinds).toContain('team')
    expect(s.timeline.filter((x) => x.kind === 'message')).toHaveLength(3) // delivered is not a new row
  })

  it('clips spans to the period', () => {
    const late = summarize(events, { now: T0 + 30 * MIN, from: T0 + 5 * MIN, live })
    expect(late.rows.find((r) => r.paneId === 'p1').ms.working).toBe(5 * MIN)
  })

  it('shows closed agents as closed, and says when there is nothing', () => {
    const closed = summarize(events, { now: T0 + 30 * MIN, from: T0 - 60 * MIN, live: {} })
    expect(closed.rows.every((r) => r.state === 'closed' && !r.open)).toBe(true)
    expect(summarize([], { now: T0 }).empty).toBe(true)
  })
})

describe('journal of the shared notes', () => {
  const notes = `# Project notes

## Who does what

- not a journal line

## Journal

- 2026-09-24 Tessel: notes created.
- 2026-09-24 Codex (read-only review of a1): changes requested.
- 2026-09-24 Claude: fixed both review points.
`
  it('reads dated lines under "## Journal"', () => {
    const j = parseJournal(notes)
    expect(j.map((x) => x.author)).toEqual(['Tessel', 'Codex', 'Claude'])
    expect(j[1].text).toBe('changes requested.')
  })

  it('matches authors to agents by kind or title', () => {
    expect(authorMatches('Codex', codex)).toBe(true)
    expect(authorMatches('Claude', claude)).toBe(true)
    expect(authorMatches('Claude', codex)).toBe(false)
    const s = summarize([], {
      now: Date.parse('2026-09-25T10:00:00Z'),
      from: Date.parse('2026-09-20T00:00:00Z'),
      live: { p1: { state: 'idle', ...claude }, p2: { state: 'idle', ...codex } },
      journal: parseJournal(notes)
    })
    expect(s.rows.find((r) => r.paneId === 'p2').journal).toBe(1)
    expect(s.timeline.filter((x) => x.kind === 'journal')).toHaveLength(3)
  })
})

describe('log housekeeping', () => {
  it('drops events older than 30 days and caps the count', () => {
    const now = T0
    const old = { t: now - 31 * 24 * 3600 * 1000, type: 'message' }
    const many = Array.from({ length: MAX_EVENTS + 10 }, (_, i) => ({ t: now - i, type: 'message' }))
    expect(trimEvents([old, ...many], now)).toHaveLength(MAX_EVENTS)
    expect(trimEvents([old], now)).toHaveLength(0)
  })

  it('formats durations compactly', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(42 * 1000)).toBe('42 s')
    expect(formatDuration(4 * MIN)).toBe('4 min')
    expect(formatDuration(125 * MIN)).toBe('2 h 05')
    expect(formatDuration(28 * 60 * MIN)).toBe('1 d 4 h')
  })
})

// The four points of Codex's review.
describe('scopes and visibility', () => {
  it('counts a pane for a team only while it is a member', () => {
    const ev = [
      st(0, 'p2', 'working', codex, { teamId: 't1', wsId: 'w1' }),
      { t: T0 + 10 * MIN, type: 'agent.team', paneId: 'p2', agent: codex, teamId: null, wsId: 'w1' },
      { t: T0 + 12 * MIN, type: 'message', paneId: 'p2', agent: codex, status: 'sent', source: 'you', scope: 'workspace', preview: 'x' },
      st(15, 'p2', 'approval', codex, { teamId: null, wsId: 'w1' })
    ]
    const live = { p2: { state: 'approval', ...codex, teamId: null, wsId: 'w1' } }
    const team = summarize(ev, { now: T0 + 30 * MIN, from: T0 - MIN, teamId: 't1', live })
    const r = team.rows.find((x) => x.paneId === 'p2')
    expect(r.ms.working).toBe(10 * MIN) // not the 5 min after it left
    expect(r.received).toBe(0)
    expect(r.approvals).toBe(0)
    expect(r.open).toBe(false) // open now, but no longer in the team
    const ws = summarize(ev, { now: T0 + 30 * MIN, from: T0 - MIN, wsId: 'w1', live })
    expect(ws.rows.find((x) => x.paneId === 'p2').ms.working).toBe(15 * MIN)
  })

  it('shows team changes of this workspace only', () => {
    const ev = [
      { t: T0, type: 'team', action: 'created', teamId: 't1', wsId: 'w1', name: 'Here' },
      { t: T0, type: 'team', action: 'created', teamId: 't2', wsId: 'w2', name: 'Elsewhere' }
    ]
    const s1 = summarize(ev, { now: T0 + MIN, from: T0 - MIN, wsId: 'w1' })
    expect(s1.timeline.map((x) => x.name)).toEqual(['Here'])
  })

  it('does not list an agent closed before the period', () => {
    const ev = [st(0, 'p9', 'working', codex, { wsId: 'w1' }), st(5, 'p9', 'closed', codex, { wsId: 'w1' })]
    const s1 = summarize(ev, { now: T0 + 3 * 24 * 60 * MIN, from: T0 + 2 * 24 * 60 * MIN, wsId: 'w1' })
    expect(s1.rows).toHaveLength(0)
    expect(s1.empty).toBe(true)
  })

  it('computes the cards for the agents shown', () => {
    const rows = summarize(events, { now: T0 + 30 * MIN, from: T0 - 60 * MIN, live }).rows
    const onlyCodex = cardsFor(rows.filter((r) => r.paneId === 'p2'))
    expect(onlyCodex.messages).toEqual({ received: 1, held: 1, skipped: 1 })
    expect(onlyCodex.openAgents).toBe(1)
    const onlyClaude = cardsFor(rows.filter((r) => r.paneId === 'p1'))
    expect(onlyClaude.approvalWait.count).toBe(0)
  })
})

describe('tasks in the timeline', () => {
  it('shows a task started and finished, in its workspace only', () => {
    const ev = [
      st(0, 'p1', 'working', claude, { wsId: 'w1' }),
      { t: T0 + MIN, type: 'task', action: 'started', taskId: 'k1', title: 'Fix login', paneId: 'p1', agent: claude, wsId: 'w1', branch: 'agent/fix-login' },
      { t: T0 + 9 * MIN, type: 'task', action: 'review', taskId: 'k1', title: 'Fix login', paneId: 'p1', agent: claude, wsId: 'w1' }
    ]
    const here = summarize(ev, { now: T0 + 10 * MIN, from: T0 - MIN, wsId: 'w1' })
    expect(here.timeline.filter((x) => x.kind === 'task').map((x) => x.action)).toEqual(['review', 'started'])
    expect(here.timeline.find((x) => x.action === 'started').branch).toBe('agent/fix-login')
    const other = summarize(ev, { now: T0 + 10 * MIN, from: T0 - MIN, wsId: 'w2' })
    expect(other.timeline.filter((x) => x.kind === 'task')).toHaveLength(0)
  })
})

describe('timeline row keys', () => {
  it('gives every row its own key, even for look-alike rows', () => {
    const ev = [
      { t: T0, type: 'message', paneId: 'p1', agent: claude, status: 'sent', source: 'you', scope: 'team', preview: 'first' },
      { t: T0, type: 'message', paneId: 'p1', agent: claude, status: 'sent', source: 'tessel', scope: 'team-change', preview: 'second' }
    ]
    const journal = parseJournal(`## Journal
- 2026-09-24 Codex: one.
- 2026-09-24 Codex: two.
`)
    const s = summarize(ev, { now: T0 + MIN, from: Date.parse('2026-09-20T00:00:00Z'), journal })
    const keys = s.timeline.map((x) => x.key)
    expect(keys).toHaveLength(4)
    expect(new Set(keys).size).toBe(4)
    // Stable: the same log gives the same keys.
    const again = summarize(ev, { now: T0 + MIN, from: Date.parse('2026-09-20T00:00:00Z'), journal })
    expect(again.timeline.map((x) => x.key)).toEqual(keys)
  })
})
