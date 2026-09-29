// The status bar's logic (Orca's formatters, keep-awake words, Resource
// Manager tree, Ports counts), the port scanner's schedule, and the
// sub-agents feed shared by the sidebar rows.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import {
  formatMemory,
  formatCpu,
  awakeCopy,
  resourceTree,
  portsSummary,
  sparklinePoints,
  createResourceHistory,
  APP_HISTORY_KEY,
  HISTORY_CAPACITY,
  HISTORY_STALE_MS
} from '../statusBarModel'
import { createPortScanner, addressForPort, browserUrlForPort } from '../portScanner'
import { acquireChildren, splitChildren, childDotState, _resetFeedsForTest } from '../agentChildrenFeed'

describe('Resource Manager sparklines (Orca)', () => {
  it('points: a flat midline under two samples, else min-max scaled into 48 x 14', () => {
    expect(sparklinePoints([])).toBe('0,7.0 48,7.0')
    expect(sparklinePoints([5])).toBe('0,7.0 48,7.0')
    expect(sparklinePoints(null)).toBe('0,7.0 48,7.0')
    expect(sparklinePoints([10, 20, 30])).toBe('0.0,14.0 24.0,7.0 48.0,0.0')
    expect(sparklinePoints([30, 10])).toBe('0.0,0.0 48.0,14.0')
    // Equal samples: range 1, the line lies on the bottom.
    expect(sparklinePoints([4, 4, 4])).toBe('0.0,14.0 24.0,14.0 48.0,14.0')
    expect(sparklinePoints([0, 1], 10, 4)).toBe('0.0,4.0 10.0,0.0')
  })

  it('history: one memory sample per snapshot for Tessel and each workspace, bounded to 60', () => {
    const h = createResourceHistory()
    const terminals = [
      { id: 'a', group: 'Shop', groupKey: 'k1' },
      { id: 'b', group: 'Shop', groupKey: 'k1' },
      { id: 'c', group: 'Blog', groupKey: 'k2' }
    ]
    const snap = (i) => ({
      app: { main: {}, renderer: {}, total: { memory: 100 + i, cpu: 0 } },
      sessions: { a: { memory: i, cpu: 0 }, b: { memory: 10, cpu: 0 }, c: { memory: 2 * i, cpu: 0 } }
    })
    h.record(snap(1), terminals, 1000)
    h.record(snap(2), terminals, 3000)
    expect(h.read(APP_HISTORY_KEY)).toEqual([101, 102])
    expect(h.read('k1')).toEqual([11, 12])
    expect(h.read('k2')).toEqual([2, 4])
    expect(h.read('nope')).toEqual([])
    // A copy: the caller cannot change the ring.
    h.read('k1').push(99)
    expect(h.read('k1')).toEqual([11, 12])
    for (let i = 3; i <= 100; i++) h.record(snap(i), terminals, 1000 + i * 2000)
    expect(h.read('k2')).toHaveLength(HISTORY_CAPACITY)
    expect(h.read('k2')[HISTORY_CAPACITY - 1]).toBe(200)
    expect(h.read('k2')[0]).toBe(2 * 41)
  })

  it('history: a workspace not sampled for 10 minutes is forgotten', () => {
    const h = createResourceHistory()
    const snap = { app: { total: { memory: 1 } }, sessions: {} }
    h.record(snap, [{ id: 'a', group: 'Shop', groupKey: 'k1' }], 0)
    h.record(snap, [], HISTORY_STALE_MS)
    expect(h.read('k1')).toEqual([0])
    h.record(snap, [], HISTORY_STALE_MS + 1)
    expect(h.read('k1')).toEqual([])
    expect(h.read(APP_HISTORY_KEY)).toHaveLength(3)
    expect(h.size()).toBe(1)
  })
})

describe('status bar model', () => {
  it("formats memory and CPU like Orca's formatMemory / formatCpu", () => {
    expect(formatMemory(512 * 1024)).toBe('512 KB')
    expect(formatMemory(300 * 1024 * 1024)).toBe('300.0 MB')
    expect(formatMemory(1.44 * 1024 * 1024 * 1024)).toBe('1.44 GB')
    expect(formatCpu(12.345)).toBe('12.3%')
  })

  it("keep awake: Tessel's modes with Orca's words", () => {
    expect(awakeCopy('agents', false)).toMatchObject({ modeLabel: 'Agent', statusText: 'Agent · Inactive' })
    expect(awakeCopy('on', true).ariaLabel).toBe('Keep computer awake, On · Active')
    expect(awakeCopy('off', false).modeLabel).toBe('Off')
  })

  it('groups terminal sessions per workspace, the heaviest first', () => {
    const snap = {
      sessions: { a: { memory: 100, cpu: 1 }, b: { memory: 900, cpu: 0 } },
      app: { main: { memory: 1, cpu: 0 }, renderer: { memory: 2, cpu: 0 }, other: { memory: 0, cpu: 0 } }
    }
    const tree = resourceTree(snap, [
      { id: 'a', label: '#1 Claude', group: 'Shop / repo', groupKey: 'k1' },
      { id: 'b', label: '#2 pwsh', group: 'Shop / fix', groupKey: 'k2' },
      { id: 'c', label: '#3 new', group: 'Shop / fix', groupKey: 'k2' }
    ])
    expect(tree.groups.map((g) => [g.name, g.memory, g.sessions.map((s) => s.id)])).toEqual([
      ['Shop / fix', 900, ['b', 'c']],
      ['Shop / repo', 100, ['a']]
    ])
    expect(tree.groups[0].sessions[1].bound).toBe(false)
    expect(tree.app.map((a) => a.label)).toEqual(['Main', 'Renderer'])
  })

  it('counts workspace ports (shown even at 0) and external ones', () => {
    expect(portsSummary([], [])).toMatchObject({ workspaceCount: 0, externalCount: 0 })
    expect(portsSummary([{ key: 'k', ports: [{}, {}] }, { key: 'e', ports: [] }], [{}])).toMatchObject({
      workspaceCount: 2,
      externalCount: 1,
      totalCount: 3
    })
  })

  it("port addresses and URLs (Orca's workspace-port-urls)", () => {
    expect(addressForPort({ connectHost: 'localhost', port: 5173 })).toBe('localhost:5173')
    expect(addressForPort({ connectHost: '::1', port: 3000 })).toBe('[::1]:3000')
    expect(browserUrlForPort({ connectHost: 'localhost', port: 8443, protocol: 'https' })).toBe('https://localhost:8443')
    expect(browserUrlForPort({ connectHost: '127.0.0.1', port: 9229, protocol: 'unknown' })).toBe('http://127.0.0.1:9229')
  })
})

describe('port scanner schedule', () => {
  afterEach(() => vi.useRealTimers())

  function fakeDoc(state = 'visible') {
    const listeners = {}
    return {
      visibilityState: state,
      addEventListener: (t, fn) => (listeners[t] = fn),
      removeEventListener: (t) => delete listeners[t],
      fire(t) {
        listeners[t] && listeners[t]()
      }
    }
  }

  it('scans at once, every 30 s while visible, not while hidden, and again when visible', async () => {
    vi.useFakeTimers()
    const scanPorts = vi.fn(async () => ({ ok: true, ports: { k: [{ port: 1 }] }, external: [], scannedAt: 1 }))
    const doc = fakeDoc()
    const s = createPortScanner({ getProbes: () => [{ id: 'k', pids: [1] }], api: { scanPorts }, doc })
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(scanPorts).toHaveBeenCalledTimes(1)
    expect(s.state.byCard.k).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(scanPorts).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    await vi.advanceTimersByTimeAsync(120000)
    expect(scanPorts).toHaveBeenCalledTimes(2)
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    await vi.advanceTimersByTimeAsync(0)
    expect(scanPorts).toHaveBeenCalledTimes(3)
    s.stop()
  })

  it('rescans shortly after the panes change, and keeps the last ports when a scan fails', async () => {
    vi.useFakeTimers()
    let fail = false
    const scanPorts = vi.fn(async () => (fail ? { ok: false, unavailableReason: 'netstat failed' } : { ok: true, ports: { k: [1] } }))
    const source = ref('a')
    const s = createPortScanner({ getProbes: () => [], api: { scanPorts }, doc: fakeDoc() })
    s.start(() => source.value)
    await vi.advanceTimersByTimeAsync(0)
    fail = true
    source.value = 'b'
    await nextTick()
    await vi.advanceTimersByTimeAsync(1600)
    expect(scanPorts).toHaveBeenCalledTimes(2)
    expect(s.state.byCard.k).toEqual([1])
    expect(s.state.unavailableReason).toBe('netstat failed')
    s.stop()
  })
})

describe('sub-agents feed', () => {
  afterEach(() => _resetFeedsForTest())

  it('one poll per conversation, dropped answers after release, running first', async () => {
    let resolve
    const agentChildren = vi.fn(() => new Promise((r) => (resolve = r)))
    const doc = { visibilityState: 'visible' }
    const args = { agent: 'claude', sessionId: 'S1' }
    const a = acquireChildren(args, { api: { agentChildren }, doc })
    const b = acquireChildren(args, { api: { agentChildren }, doc })
    expect(agentChildren).toHaveBeenCalledTimes(1)
    expect(a.state).toBe(b.state)
    a.release()
    b.release()
    resolve([{ id: 'x', state: 'running' }])
    await Promise.resolve()
    expect(a.state.list).toEqual([])
    expect(acquireChildren({ agent: 'gemini', sessionId: 'S1' }, { api: { agentChildren }, doc })).toBeNull()
    const codex = acquireChildren({ agent: 'codex', sessionId: 'S1', accountId: 'acc' }, { api: { agentChildren }, doc })
    expect(codex).not.toBeNull()
    expect(agentChildren).toHaveBeenLastCalledWith({ agent: 'codex', sessionId: 'S1', accountId: 'acc' })
    codex.release()
  })

  it('folds children finished over 30 min ago under "N more"', () => {
    const now = 10_000_000
    const { shown, older } = splitChildren(
      [
        { id: 'old', state: 'done', startedAt: 1, endedAt: now - 3600000 },
        { id: 'recent', state: 'done', startedAt: 5, endedAt: now - 60000 },
        { id: 'quiet', state: 'quiet', startedAt: 3 },
        { id: 'run', state: 'running', startedAt: 2 }
      ],
      now
    )
    expect(shown.map((c) => c.id)).toEqual(['run', 'quiet', 'recent'])
    expect(older.map((c) => c.id)).toEqual(['old'])
    expect(childDotState({ state: 'running' })).toBe('working')
    expect(childDotState({ state: 'quiet' })).toBe('unverifiable')
  })
})
