// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  createUsagePoller,
  retryAfterMs,
  failureBackoffMs,
  normalizePollingInterval,
  DEFAULT_POLL_MS,
  MIN_REFETCH_MS
} from '../usagePoller'

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
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(reader).not.toHaveBeenCalled()
  })

  it('refreshes shortly after startup, then every 15 min, pushing results', async () => {
    const { poller, reader, sent } = setup()
    poller.configure({ hidden: [] })
    await vi.advanceTimersByTimeAsync(999)
    expect(reader).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(sent.map((r) => r.provider).sort()).toEqual(['claude', 'kimi'])
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
    expect(reader).toHaveBeenCalledTimes(4)
    poller.stop()
  })

  it('does not poll while the window is unfocused, minimized or hidden', async () => {
    const { poller, reader, win } = setup()
    win.focused = false
    poller.configure({})
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 3)
    expect(reader).not.toHaveBeenCalled()
    win.focused = true
    win.minimized = true
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
    win.minimized = false
    win.visible = false
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
    expect(reader).not.toHaveBeenCalled()
    poller.stop()
  })

  it('refreshes on focus only when the reading is older than 5 min', async () => {
    const { poller, reader, win } = setup({ providers: ['claude'] })
    win.focused = false
    poller.configure({})
    await vi.advanceTimersByTimeAsync(2000)
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
    poller.configure({ hidden: ['kimi'] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(targets).toHaveBeenCalledWith(['kimi'])
    expect(reader.mock.calls.map(([q]) => q.provider)).toEqual(['claude'])
    poller.configure({ hidden: [], intervalMs: 0 })
    expect(poller.pollMs).toBe(0)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 4)
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
    poller.configure({})
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
    poller.configure({})
    await vi.advanceTimersByTimeAsync(1000)
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 3)
    win.emit('focus')
    await flush()
    expect(reader).toHaveBeenCalledTimes(1)
    answer = ok
    // The poll at 60 min is still inside the hour; the one at 75 min reads.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
    expect(reader).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
    expect(reader).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('keeps a recent reading through a failure, not an old one', async () => {
    let answer = ok
    const { poller, sent } = setup({
      providers: ['codex'],
      read: async ({ provider }) => answer(provider)
    })
    poller.configure({})
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.at(-1)).toMatchObject({ ok: true, provider: 'codex' })
    answer = fail
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
    const kept = sent.at(-1)
    expect(kept).toMatchObject({ ok: true, kept: true, stale: true, error: 'down' })
    expect(kept.windows).toHaveLength(1)
    expect(kept.resetToken).toBeUndefined()
    // 30 min after the last success the reading is dropped.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
    expect(sent.at(-1)).toMatchObject({ ok: false, code: 'upstream' })
    poller.stop()
  })

  it('keeps a reading up to a day while rate-limited', async () => {
    let answer = ok
    const { poller, sent } = setup({
      providers: ['claude'],
      read: async ({ provider }) => answer(provider)
    })
    poller.configure({})
    await vi.advanceTimersByTimeAsync(1000)
    vi.setSystemTime(Date.now() + 2 * 3600000)
    answer = (p) => fail(p, { code: 'rate-limited' })
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS)
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
    poller.configure({})
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
    poller.configure({})
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(0)
    expect(poller.entry('claude')).toBe(null)
    poller.forget('claude')
    poller.stop()
  })

  it('removes its window listeners when the window closes', async () => {
    const { poller, win, reader } = setup()
    poller.configure({})
    expect(win.listenerCount('focus')).toBe(1)
    win.emit('closed')
    expect(win.listenerCount('focus')).toBe(0)
    expect(win.listenerCount('closed')).toBe(0)
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS * 2)
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
