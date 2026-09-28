// The status bar's logic (Orca's formatters, keep-awake words, Resource
// Manager tree, Ports counts), the port scanner's schedule, and the
// sub-agents feed shared by the sidebar rows.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { formatMemory, formatCpu, awakeCopy, resourceTree, portsSummary } from '../statusBarModel'
import { createPortScanner, addressForPort, browserUrlForPort } from '../portScanner'
import { acquireChildren, splitChildren, childDotState, _resetFeedsForTest } from '../agentChildrenFeed'

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
    expect(acquireChildren({ agent: 'codex', sessionId: 'S1' }, { api: { agentChildren }, doc })).toBeNull()
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
