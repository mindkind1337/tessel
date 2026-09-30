// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createUsagePoller,
  retryAfterMs,
  failureBackoffMs,
  normalizePollingInterval,
  DEFAULT_POLL_MS,
  MIN_REFETCH_MS,
  LIVE_INGEST_DEDUPE_MS,
  liveWindows
} from '../usagePoller'

// Most cases run with the former 15-min interval; the 2-min default has its own.
const FIFTEEN = 15 * 60 * 1000

class FakeWindow extends EventEmitter {
  constructor() {
    super()
    this.visible = true
    this.minimized = false
    this.focused = true
  }
  isDestroyed() {
    return false
  }
  isVisible() {
    return this.visible
  }
  isMinimized() {
    return this.minimized
  }
  isFocused() {
    return this.focused
  }
}

const ok = (provider, used = 50) => ({
  ok: true,
  provider,
  accountId: null,
  source: 'live',
  observedAt: Date.now(),
  windows: [{ label: '5h', usedPct: used, resetsAt: Date.now() + 3600000 }],
  resetToken: provider === 'codex' ? 'ticket' : undefined
})
const fail = (provider, extra = {}) => ({
  ok: false,
  provider,
  accountId: null,
  code: 'upstream',
  error: 'down',
  ...extra
})

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setup({ providers = ['claude', 'kimi'], read } = {}) {
  const win = new FakeWindow()
  const sent = []
  const reader = vi.fn(read || (async ({ provider }) => ok(provider)))
  const targets = vi.fn(async (hidden) =>
    providers.filter((p) => !hidden.includes(p)).map((provider) => ({ provider, accountId: null }))
  )
  const poller = createUsagePoller({
    read: reader,
    targets,
    send: (r) => sent.push(r),
    getWindow: () => win
  })
  return { win, sent, reader, targets, poller }
}

describe('usage poller', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-29T12:00:00Z') }))
  afterEach(() => vi.useRealTimers())

  it('reads nothing until the renderer configures it', async () => {
    const { reader } = setup()
    await vi.advanceTimersByTimeAsync(FIFTEEN * 2)
    expect(reader).not.toHaveBeenCalled()
  })

  it('refreshes shortly after startup, then every 15 min, pushing results', async () => {
    const { poller, reader, sent } = setup()
    poller.configure({ hidden: [], intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(999)
    expect(reader).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(sent.map((r) => r.provider).sort()).toEqual(['claude', 'kimi'])
    await vi.advanceTimersByTimeAsync(FIFTEEN)
    expect(reader).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('does not poll while the window is unfocused, minimized or hidden', async () => {
    const { poller, reader, win } = setup({ providers: ['claude'] })
    win.focused = false
    poller.configure({ intervalMs: FIFTEEN })
    // The startup read still happens: the window is shown, not yet focused.
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FIFTEEN * 3)
    expect(reader).toHaveBeenCalledTimes(1)
    win.focused = true
    win.minimized = true
    await vi.advanceTimersByTimeAsync(FIFTEEN)
    win.minimized = false
    win.visible = false
    await vi.advanceTimersByTimeAsync(FIFTEEN)
    expect(reader).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('reads once at startup when configured before the window is focused', async () => {
    const { poller, reader, win, sent } = setup()
    win.focused = false
    poller.configure({ hidden: [] })
    await vi.advanceTimersByTimeAsync(999)
    expect(reader).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(2)
    // Unfocused: no poll after that.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 3)
    expect(reader).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('a window hidden at startup reads at its first show, once', async () => {
    const { poller, reader, win } = setup({ providers: ['claude'] })
    win.visible = false
    win.focused = false
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(5000)
    expect(reader).not.toHaveBeenCalled()
    win.visible = true
    win.emit('show')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    win.emit('show')
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('polls every 2 min by default, though focus waits 5 min', async () => {
    const { poller, reader, win } = setup({ providers: ['claude'] })
    expect(poller.configure({}).intervalMs).toBe(2 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(1)
    // A focus 1 min later: debounced.
    await vi.advanceTimersByTimeAsync(59000)
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    // The poll at 2 min reads (the startup read was 1 min 59 s ago: timer slack).
    await vi.advanceTimersByTimeAsync(60000)
    expect(reader).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(reader).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(reader).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('the 2-min poll still backs off a failing provider and respects Retry-After', async () => {
    const { poller, reader } = setup({
      providers: ['claude'],
      read: async ({ provider }) => fail(provider, { code: 'rate-limited', retryAfterMs: 10 * 60 * 1000 })
    })
    poller.configure({ intervalMs: 2 * 60 * 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(1)
    // Polls at 2, 4, 6, 8 and 10 min are inside the 10-min Retry-After.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1000)
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    expect(reader).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('refreshes on focus only when the reading is older than 5 min', async () => {
    const { poller, reader, win } = setup({ providers: ['claude'] })
    win.visible = false
    win.focused = false
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(2000)
    win.visible = true
    win.focused = true
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60000)
    win.emit('focus')
    win.emit('restore')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(MIN_REFETCH_MS)
    win.emit('show')
    await flush()
    expect(reader).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('skips hidden providers and can be turned off', async () => {
    const { poller, reader, targets } = setup()
    poller.configure({ hidden: ['kimi'], intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(targets).toHaveBeenCalledWith(['kimi'])
    expect(reader.mock.calls.map(([q]) => q.provider)).toEqual(['claude'])
    poller.configure({ hidden: [], intervalMs: 0 })
    expect(poller.pollMs).toBe(0)
    await vi.advanceTimersByTimeAsync(FIFTEEN * 4)
    expect(reader).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('backs off a failing provider: 30 s, doubling, at most 15 min', async () => {
    expect([1, 2, 3, 4, 5, 6, 8].map(failureBackoffMs)).toEqual([
      30000, 60000, 120000, 240000, 480000, 900000, 900000
    ])
    const { poller, reader, win } = setup({
      providers: ['claude'],
      read: async ({ provider }) => fail(provider)
    })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29000)
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(2)
    // Second failure: 60 s.
    await vi.advanceTimersByTimeAsync(45000)
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(15000)
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(3)
    expect(poller.entry('claude').streak).toBe(3)
    poller.stop()
  })

  it('respects Retry-After on a 429, even at the poll', async () => {
    let answer = (provider) => fail(provider, { code: 'rate-limited', retryAfterMs: 3600000 })
    const { poller, reader, win } = setup({
      providers: ['claude'],
      read: async ({ provider }) => answer(provider)
    })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FIFTEEN * 3)
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    answer = ok
    // The poll at 60 min is still inside the hour; the one at 75 min reads.
    await vi.advanceTimersByTimeAsync(FIFTEEN)
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FIFTEEN)
    expect(reader).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('keeps a recent reading through a failure, not an old one', async () => {
    let answer = ok
    const { poller, sent } = setup({
      providers: ['codex'],
      read: async ({ provider }) => answer(provider)
    })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.at(-1)).toMatchObject({ ok: true, provider: 'codex' })
    answer = fail
    await vi.advanceTimersByTimeAsync(FIFTEEN)
    const kept = sent.at(-1)
    expect(kept).toMatchObject({ ok: true, kept: true, stale: true, error: 'down' })
    expect(kept.windows).toHaveLength(1)
    expect(kept.resetToken).toBeUndefined()
    // 30 min after the last success the reading is dropped.
    await vi.advanceTimersByTimeAsync(FIFTEEN * 2)
    expect(sent.at(-1)).toMatchObject({ ok: false, code: 'upstream' })
    poller.stop()
  })

  it('keeps a reading up to a day while rate-limited', async () => {
    let answer = ok
    const { poller, sent } = setup({
      providers: ['claude'],
      read: async ({ provider }) => answer(provider)
    })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    vi.setSystemTime(Date.now() + 2 * 3600000)
    answer = (p) => fail(p, { code: 'rate-limited' })
    await vi.advanceTimersByTimeAsync(FIFTEEN)
    expect(sent.at(-1)).toMatchObject({ kept: true, code: 'rate-limited' })
    poller.stop()
  })

  it('never reads one provider twice at once: a manual read shares the automatic one', async () => {
    let release
    const { poller, reader, sent } = setup({
      providers: ['claude'],
      read: ({ provider }) =>
        new Promise((resolve) => {
          release = () => resolve(ok(provider))
        })
    })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(1)
    const manual = poller.read({ provider: 'claude', accountId: null })
    await poller.refresh('poll')
    expect(reader).toHaveBeenCalledTimes(1)
    release()
    expect(await manual).toMatchObject({ ok: true, provider: 'claude' })
    await flush()
    expect(sent).toHaveLength(1)
    poller.stop()
  })

  it('manual reads stay as today: always read, returned as is, not pushed', async () => {
    const { poller, reader, sent } = setup({ providers: ['claude'] })
    const first = await poller.read({ provider: 'claude', accountId: null })
    const second = await poller.read({ provider: 'claude', accountId: null })
    expect(first.ok && second.ok).toBe(true)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(0)
  })

  it('ignores a read made stale by an account switch and forgets the old account', async () => {
    const { poller, sent } = setup({
      providers: ['claude'],
      read: async () => ({ ok: false, code: 'stale', error: 'changed' })
    })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(0)
    expect(poller.entry('claude')).toBe(null)
    poller.forget('claude')
    poller.stop()
  })

  it('removes its window listeners when the window closes', async () => {
    const { poller, win, reader } = setup()
    poller.configure({ intervalMs: FIFTEEN })
    expect(win.listenerCount('focus')).toBe(1)
    win.emit('closed')
    expect(win.listenerCount('focus')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
    await vi.advanceTimersByTimeAsync(FIFTEEN * 2)
    expect(reader).not.toHaveBeenCalled()
  })

  it('parses Retry-After and bounds the interval', () => {
    const now = Date.parse('2026-09-29T12:00:00Z')
    const h = (v) => ({ get: (name) => (name === 'retry-after' ? v : null) })
    expect(retryAfterMs(h('120'), now)).toBe(120000)
    expect(retryAfterMs(h('Tue, 29 Sep 2026 12:10:00 GMT'), now)).toBe(600000)
    expect(retryAfterMs(h(null), now)).toBe(null)
    expect(retryAfterMs(h('soon'), now)).toBe(null)
    expect(retryAfterMs(h('999999999'), now)).toBe(24 * 3600000)
    expect(normalizePollingInterval(Number.NaN)).toBe(DEFAULT_POLL_MS)
    expect(normalizePollingInterval(10)).toBe(30000)
  })
})

describe('usage poller live readings', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-09-29T12:00:00Z') }))
  afterEach(() => vi.useRealTimers())
  const nowS = () => Math.floor(Date.now() / 1000)

  it('maps utilization (0-1 or 0-100) and resets (s or ms), rejecting bad values', () => {
    const at = Date.now()
    expect(
      liveWindows({
        fiveHour: { utilization: 0.42, resetsAt: Math.floor(at / 1000) + 60 },
        sevenDay: { utilization: 55, resetsAt: at + 120000 }
      })
    ).toEqual([
      { label: '5-hour', usedPct: 42, resetsAt: Math.floor(at / 1000) * 1000 + 60000 },
      { label: 'Weekly', usedPct: 55, resetsAt: at + 120000 }
    ])
    for (const bad of [Number.NaN, Infinity, -1, 101, '50', null, undefined])
      expect(liveWindows({ fiveHour: { utilization: bad } })).toEqual([])
    expect(liveWindows({ fiveHour: { utilization: 0.1, resetsAt: -5 } })[0].resetsAt).toBe(null)
    expect(liveWindows({ fiveHour: { utilization: 0.1, resetsAt: 1e20 } })[0].resetsAt).toBe(null)
    expect(liveWindows({ fiveHour: { utilization: 1 } })[0].usedPct).toBe(100)
    expect(liveWindows(null)).toEqual([])
    expect(liveWindows('x')).toEqual([])
  })

  it('pushes a live reading, merged over the last read, marked live', async () => {
    const { poller, sent } = setup({
      providers: ['claude'],
      read: async ({ provider }) => ({
        ...ok(provider),
        plan: 'Max 20x',
        windows: [
          { label: '5-hour', usedPct: 10, resetsAt: Date.now() + 3600000 },
          { label: 'Weekly', usedPct: 20, resetsAt: Date.now() + 86400000 },
          { label: 'Sonnet weekly', usedPct: 5, resetsAt: null }
        ]
      })
    })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(1)
    const pushed = poller.ingest('claude', null, { fiveHour: { utilization: 0.3, resetsAt: nowS() + 600 } })
    expect(pushed).toMatchObject({ ok: true, provider: 'claude', accountId: null, source: 'live', live: true, plan: 'Max 20x' })
    expect(pushed.windows.map((w) => [w.label, w.usedPct])).toEqual([
      ['5-hour', 30],
      ['Weekly', 20],
      ['Sonnet weekly', 5]
    ])
    expect(sent.at(-1)).toBe(pushed)
    poller.stop()
  })

  it('dedupes an identical live reading for 30 s, not a changed one', () => {
    const { poller, sent } = setup({ providers: ['codex'] })
    const rl = { fiveHour: { utilization: 0.5, resetsAt: nowS() + 600 }, sevenDay: { utilization: 0.1, resetsAt: nowS() + 9000 } }
    expect(poller.ingest('codex', null, rl)).toBeTruthy()
    vi.advanceTimersByTime(10000)
    expect(poller.ingest('codex', null, rl)).toBe(null)
    expect(poller.ingest('codex', null, { ...rl, fiveHour: { utilization: 0.51, resetsAt: rl.fiveHour.resetsAt } })).toBeTruthy()
    vi.advanceTimersByTime(LIVE_INGEST_DEDUPE_MS)
    expect(poller.ingest('codex', null, { ...rl, fiveHour: { utilization: 0.51, resetsAt: rl.fiveHour.resetsAt } })).toBeTruthy()
    expect(sent).toHaveLength(3)
  })

  it('never overwrites a newer reading, and ignores invalid input', async () => {
    const { poller, sent } = setup({ providers: ['claude'] })
    poller.configure({ intervalMs: FIFTEEN })
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(1)
    // An event observed before the read ended.
    expect(poller.ingest('claude', null, { fiveHour: { utilization: 0.9 } }, Date.now() - 500)).toBe(null)
    expect(poller.ingest('kimi', null, { fiveHour: { utilization: 0.9 } })).toBe(null)
    expect(poller.ingest('claude', 5, { fiveHour: { utilization: 0.9 } })).toBe(null)
    expect(poller.ingest('claude', null, { fiveHour: { utilization: 900 } })).toBe(null)
    expect(sent).toHaveLength(1)
    poller.stop()
  })

  it('a fresh live Claude reading covering every window lets the poll wait; Codex still polls', async () => {
    const { poller, reader } = setup({
      providers: ['claude', 'codex'],
      read: async ({ provider }) => ({
        ...ok(provider),
        windows: [{ label: '5-hour', usedPct: 10, resetsAt: null }]
      })
    })
    poller.configure({ intervalMs: 2 * 60 * 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60000)
    poller.ingest('claude', null, { fiveHour: { utilization: 0.2 } })
    poller.ingest('codex', null, { fiveHour: { utilization: 0.2 } })
    await vi.advanceTimersByTimeAsync(60000)
    expect(reader.mock.calls.map(([q]) => q.provider)).toEqual(['claude', 'codex', 'codex'])
    // Once the live reading is 5 min old, Claude is read again.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)
    expect(reader.mock.calls.filter(([q]) => q.provider === 'claude').length).toBe(2)
    poller.stop()
  })

  it('a live reading keeps the Retry-After of a 429', async () => {
    const { poller, reader } = setup({
      providers: ['codex'],
      read: async ({ provider }) => fail(provider, { code: 'rate-limited', retryAfterMs: 3600000 })
    })
    poller.configure({ intervalMs: 2 * 60 * 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    poller.ingest('codex', null, { fiveHour: { utilization: 0.2 } })
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(reader).toHaveBeenCalledTimes(1)
    expect(poller.entry('codex').snapshot.windows[0].usedPct).toBe(20)
    poller.stop()
  })
})
