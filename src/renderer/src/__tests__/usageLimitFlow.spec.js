import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectLimit } from '../agentLimit'
import {
  limits,
  setLimit,
  clearLimit,
  sweepLimits,
  limitSpent,
  forgetSpentLimit,
  applyAgentStates,
  clearAgentStatus,
  createAgentActivityMonitor,
  agentScreenObservation
} from '../agentStatus'
import { pickReplacement, otherAccounts, leadLimitText, limitUntilEn, handOverText, limitClock } from '../limitFlow'

// Screens as the agents print them (anonymised from this computer's own
// transcripts and session files).
const CLAUDE_WEEKLY = "⏺ You've hit your weekly limit · resets Oct 17, 11pm (America/Toronto)\n  /upgrade to increase your usage limit."
const CLAUDE_SHORT = "You've hit your limit · resets 3pm\n❯ "
const CODEX = '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:47 PM.\n› '
const MUSE = 'API error 429 [request_id=00000000-0000-0000-0000-000000000000]: Subscription quota exhausted. Your usage window resets at 2026-10-19T15:13:21Z. (rate_limit_error)'

describe('detectLimit on real limit screens', () => {
  it("spots Claude Code's newer wording, with its day and zone", () => {
    const at = Date.UTC(2026, 9, 14, 3, 17)
    expect(detectLimit(CLAUDE_WEEKLY, 'claude')).toEqual({ reset: 'Oct 17, 11pm' })
    expect(detectLimit(CLAUDE_WEEKLY, 'claude', { at })).toEqual({ reset: 'Oct 17, 11pm', resetAt: Date.UTC(2026, 9, 18, 3, 0) })
    expect(detectLimit(CLAUDE_SHORT, 'claude')).toEqual({ reset: '3pm' })
  })
  it("spots Codex's and Muse's, with their reset", () => {
    expect(detectLimit(CODEX, 'codex')).toEqual({ reset: '8:47 PM' })
    expect(detectLimit(MUSE, 'muse', { at: Date.UTC(2026, 9, 19, 14, 0) })).toEqual({ reset: '2026-10-19T15:13:21Z', resetAt: Date.UTC(2026, 9, 19, 15, 13, 21) })
  })
  it('an agent talking about limits is not at its limit', () => {
    expect(detectLimit('When you hit your limit, Tessel tells the team.', 'claude')).toBeNull()
    expect(detectLimit('the subscription quota is shown in Settings', 'muse')).toBeNull()
  })
})

describe('a limit goes at its reset time', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    clearAgentStatus('p1')
    clearAgentStatus('p2')
  })

  it('keeps the moment first read while the agent says the same time', () => {
    const now = Date.now()
    setLimit('p1', { reset: '3pm', resetAt: now + 60000 }, now)
    setLimit('p1', { reset: '3pm', resetAt: now + 86400000 }, now + 1000)
    expect(limits.p1).toEqual({ reset: '3pm', resetAt: now + 60000 })
    // A read with no reset time keeps what is known.
    setLimit('p1', { reset: '' }, now + 2000)
    expect(limits.p1.reset).toBe('3pm')
  })

  it('is cleared by its timer, and its old message no longer counts', () => {
    const now = Date.now()
    setLimit('p1', { reset: '3pm', resetAt: now + 60000 }, now)
    vi.advanceTimersByTime(59000)
    expect(limits.p1).toBeTruthy()
    vi.advanceTimersByTime(2000)
    expect(limits.p1).toBeUndefined()
    expect(limitSpent('p1', { reset: '3pm' })).toBe(true)
    expect(limitSpent('p1', { reset: '9pm' })).toBe(false)
    // Main still says limited with the same words: not brought back.
    applyAgentStates({ p1: { paneId: 'p1', launchToken: 'tok', provider: 'claude', state: 'limited', reset: '3pm', hookSeen: true, confirmed: true } })
    expect(limits.p1).toBeUndefined()
    // Working again by its hooks: its old words still on screen stay old.
    applyAgentStates({ p1: { paneId: 'p1', launchToken: 'tok', provider: 'claude', state: 'working', source: 'hook', hookSeen: true, confirmed: true } })
    expect(limitSpent('p1', { reset: '3pm' })).toBe(true)
  })

  it('a limit ended by new work (UserPromptSubmit) leaves its words old until the screen shows no limit', () => {
    const base = { paneId: 'p2', launchToken: 'tok2', provider: 'claude', hookSeen: true, confirmed: true }
    applyAgentStates({ p2: { ...base, state: 'limited', reset: '3pm', resetAt: Date.now() + 3600000 } })
    expect(limits.p2).toMatchObject({ reset: '3pm' })
    applyAgentStates({ p2: { ...base, state: 'working', source: 'hook' } })
    expect(limits.p2).toBeUndefined()
    expect(limitSpent('p2', { reset: '3pm' })).toBe(true)
  })

  it('a limit read already over is never shown; sweepLimits catches up after sleep', () => {
    const now = Date.now()
    setLimit('p1', { reset: '9am', resetAt: now - 1 }, now)
    expect(limits.p1).toBeUndefined()
    setLimit('p2', { reset: 'in 1 hour', resetAt: now + 3600000 }, now)
    sweepLimits(now + 3600001)
    expect(limits.p2).toBeUndefined()
    forgetSpentLimit('p2')
    expect(limitSpent('p2', { reset: 'in 1 hour' })).toBe(false)
  })

  it("the screen's old limit message after its reset reads as no limit", () => {
    const now = Date.now()
    const node = { id: 'p1', agentId: 'gemini' }
    let screen = { screen: 'x', limit: { reset: '3pm', resetAt: now + 1000 }, approval: false, ready: false, busy: false }
    const onLimit = vi.fn()
    const monitor = createAgentActivityMonitor({
      getNode: () => node,
      readScreen: () => screen,
      onStatus: () => {},
      onWorking: () => {},
      onCompleted: () => {},
      onApproval: () => {},
      onLimit: (hit) => {
        onLimit(hit)
        setLimit('p1', hit)
      }
    })
    monitor.output()
    vi.advanceTimersByTime(1500)
    expect(onLimit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(limits.p1).toBeUndefined()
    // Same message still shown, read again with a new moment: ignored.
    screen = { ...screen, limit: { reset: '3pm', resetAt: Date.now() + 86400000 } }
    monitor.output()
    vi.advanceTimersByTime(1500)
    expect(onLimit).toHaveBeenCalledTimes(1)
    // The message gone, then a new one: counted.
    screen = { ...screen, limit: null }
    monitor.output()
    vi.advanceTimersByTime(1500)
    screen = { ...screen, limit: { reset: '3pm', resetAt: Date.now() + 86400000 } }
    monitor.output()
    vi.advanceTimersByTime(1500)
    expect(onLimit).toHaveBeenCalledTimes(2)
    monitor.dispose()
    clearLimit('p1')
  })
})

describe('which screen limits count', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    clearAgentStatus('p3')
  })

  it('only in the last rows, never a limit message quoted higher up', () => {
    const quoted = [CODEX, ...Array.from({ length: 12 }, (_, i) => `line ${i}`)].join('\n')
    expect(agentScreenObservation(null, 'codex', quoted).limit).toBeNull()
    expect(agentScreenObservation(null, 'codex', `line\n${CODEX}\n\n\n`).limit).toMatchObject({ reset: '8:47 PM' })
  })

  it("an agent that reports its limit itself: its screen counts only once its report confirms", () => {
    const node = { id: 'p3', agentId: 'claude', agentLaunchToken: 'tok3' }
    const base = { paneId: 'p3', launchToken: 'tok3', provider: 'claude', hookSeen: true, confirmed: true }
    const screen = { screen: 'x', limit: { reset: '3pm', resetAt: Date.now() + 3600000 }, approval: false, ready: true, waiting: true, busy: false }
    const onLimit = vi.fn()
    const report = vi.fn()
    const monitor = createAgentActivityMonitor({ getNode: () => node, readScreen: () => screen, report, onStatus: () => {}, onWorking: () => {}, onCompleted: () => {}, onApproval: () => {}, onLimit })
    // A turn its hooks opened is under way (a file quoting a limit message).
    applyAgentStates({ p3: { ...base, state: 'working', source: 'hook', reason: 'processing' } })
    monitor.output()
    vi.advanceTimersByTime(1500)
    expect(onLimit).not.toHaveBeenCalled()
    expect(report.mock.calls.map((c) => c[0].event)).not.toContain('ScreenLimit')
    // Its turn failed (its StopFailure): now the screen's limit counts.
    applyAgentStates({ p3: { ...base, state: 'unknown', source: 'hook', reason: 'error' } })
    monitor.output()
    vi.advanceTimersByTime(1500)
    expect(onLimit).toHaveBeenCalled()
    expect(report.mock.calls.map((c) => c[0].event)).toContain('ScreenLimit')
    monitor.dispose()
  })

  it('tells main when the screen shows no limit at all', () => {
    const node = { id: 'p3', agentId: 'claude', agentLaunchToken: 'tok3' }
    applyAgentStates({ p3: { paneId: 'p3', launchToken: 'tok3', provider: 'claude', hookSeen: true, confirmed: true, state: 'idle', reason: 'ready' } })
    const report = vi.fn()
    const monitor = createAgentActivityMonitor({ getNode: () => node, readScreen: () => ({ screen: '', limit: null, approval: false, ready: true, waiting: true, busy: false }), report, onStatus: () => {}, onWorking: () => {}, onCompleted: () => {}, onApproval: () => {}, onLimit: () => {} })
    monitor.output()
    vi.advanceTimersByTime(1500)
    expect(report.mock.calls.find((c) => c[0].event === 'ScreenReady')[0]).toMatchObject({ noLimit: true })
    monitor.dispose()
  })
})

describe('limitFlow', () => {
  it('picks a free agent of the same team first, then of the project; same kind first', () => {
    const limited = { id: 'a', agentId: 'claude', team: 't1', wsId: 'w1' }
    const c = (id, extra) => ({ id, agentId: 'codex', team: null, wsId: 'w1', free: true, ...extra })
    expect(pickReplacement(limited, [c('b'), c('c', { team: 't1' }), c('d', { team: 't1', agentId: 'claude' })]).id).toBe('d')
    // A team's card stays in its team.
    expect(pickReplacement(limited, [c('b'), c('c', { team: 't1', free: false })])).toBeNull()
    const loose = { id: 'a', agentId: 'claude', team: null, wsId: 'w1' }
    expect(pickReplacement(loose, [c('b', { wsId: 'w2' }), c('a'), c('e')]).id).toBe('e')
  })

  it('offers another account, never the current one nor one at its limit', () => {
    const choices = [{ id: null, name: 'me' }, { id: 'acc-1', name: 'work' }, { id: 'acc-2', name: 'spare' }]
    expect(otherAccounts(null, choices).map((c) => c.id)).toEqual(['acc-1', 'acc-2'])
    expect(otherAccounts('acc-1', choices, ['acc-2']).map((c) => c.id)).toEqual([null])
    expect(otherAccounts(undefined, choices, ['acc-1', 'acc-2'])).toEqual([])
  })

  it('tells the lead what was under way and who is free', () => {
    const text = leadLimitText({ name: 'Ada', until: ' until 15:00', cards: [{ id: 'T3', title: 'API' }], free: ['Bob'] })
    expect(text).toContain('Ada hit its usage limit until 15:00')
    expect(text).toContain('T3 "API"')
    expect(text).toContain('Free now: Bob.')
    expect(leadLimitText({ name: 'Ada', until: '', cards: [], free: [] })).toContain('No teammate is free right now.')
  })

  it('says until when in plain English for agents, and a short time for people', () => {
    const now = new Date(2026, 9, 19, 10, 0).getTime()
    expect(limitUntilEn({ reset: '3pm', resetAt: new Date(2026, 9, 19, 15, 0).getTime() }, now)).toBe(' until 15:00')
    expect(limitUntilEn({ reset: 'in 2 hours', resetAt: null }, now)).toBe(' for the next 2 hours')
    expect(limitUntilEn({ reset: '', resetAt: null }, now)).toBe('')
    expect(limitClock({ reset: 'in 2 hours', resetAt: null })).toBe('in 2 hours')
    expect(limitClock(null)).toBe('')
  })

  it('hands a card over with its brief and its copy', () => {
    const text = handOverText({ card: { id: 'T3', title: 'API', brief: 'Add the route', worktree: { path: 'C:/p/t3', branch: 'claude/t3' } }, from: 'Ada' })
    expect(text).toContain('Card T3 "API" is yours now: Ada hit its usage limit')
    expect(text).toContain('Its brief: Add the route')
    expect(text).toContain('C:/p/t3 (branch claude/t3)')
  })
})
