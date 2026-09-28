// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseCimProcesses, parsePsProcesses, buildSnapshot, collectSubtree, createResourceCollector } from '../resourceUsage'

const CIM = [
  '100\t1\t200000000\t1000\t2000\t150000', // main (Browser)
  '101\t100\t300000000\t0\t0\t250000', // renderer
  '102\t100\t50000000\t0\t0\t40000', // GPU
  '900\t1\t40000000\t0\t0\t30000', // terminal host
  '1000\t900\t60000000\t0\t0\t50000', // pane shell A
  '1001\t1000\t500000000\t0\t0\t400000', // its node dev server
  '2000\t900\t60000000\t0\t0\t50000', // pane shell B
  '3000\t1\t999999999\t0\t0\t1' // unrelated
].join('\r\n')

describe('process sweep parsers', () => {
  it('reads the CIM rows (working set, ticks, page file in KB)', () => {
    const rows = parseCimProcesses(CIM)
    expect(rows[0]).toEqual({ pid: 100, ppid: 1, memory: 200000000, privateMemory: 150000 * 1024, ticks: 3000 })
    expect(rows).toHaveLength(8)
  })
  it('reads ps rows (rss in KB)', () => {
    expect(parsePsProcesses(' 10 1 2.5 1024\n 11 10 0.0 2048\n')).toEqual([
      { pid: 10, ppid: 1, pcpu: 2.5, memory: 1024 * 1024 },
      { pid: 11, ppid: 10, pcpu: 0, memory: 2048 * 1024 }
    ])
  })
})

describe('snapshot', () => {
  const procs = parseCimProcesses(CIM)
  const appMetrics = [
    { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1 } },
    { pid: 101, type: 'Tab', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 1 } },
    { pid: 102, type: 'GPU', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 1 } }
  ]

  it('sums Tessel (main, renderer, other with the terminal host) and each terminal tree once', () => {
    const snap = buildSnapshot({
      procs,
      appMetrics,
      ptys: [
        { id: 'a', pid: 1000 },
        { id: 'b', pid: 2000 },
        { id: 'gone', pid: 4242 }
      ],
      hostPids: [900],
      platform: 'win32'
    })
    expect(snap.app.main.memory).toBe(200000000)
    expect(snap.app.renderer.memory).toBe(300000000)
    expect(snap.app.other.memory).toBe(50000000 + 40000000)
    expect(snap.sessions.a).toMatchObject({ memory: 560000000, processCount: 2 })
    expect(snap.sessions.b).toMatchObject({ memory: 60000000, processCount: 1 })
    expect(snap.sessions.gone).toBeUndefined()
    expect(snap.totalMemory).toBe(200000000 + 300000000 + 90000000 + 560000000 + 60000000)
    expect(snap.processMemoryMetric).toBe('working-set')
    expect(snap.totalPrivateMemory).toBeGreaterThan(0)
  })

  it('never counts a process twice across terminals', () => {
    const children = new Map([
      [1, [2, 3]],
      [2, [3]]
    ])
    const claimed = new Set()
    expect(collectSubtree(1, children, claimed).sort()).toEqual([1, 2, 3])
    expect(collectSubtree(2, children, claimed)).toEqual([])
  })

  it('derives CPU from tick deltas between sweeps', async () => {
    let t = 1000
    let ticks = 0
    const collector = createResourceCollector({
      now: () => t,
      sweepFn: async () => [{ pid: 100, ppid: 1, memory: 1, ticks }]
    })
    await collector.snapshot({ appMetrics: [{ pid: 100, type: 'Browser' }] })
    t += 1000
    ticks += 5e6 // 0.5 s of CPU in 1 s
    const snap = await collector.snapshot({ appMetrics: [{ pid: 100, type: 'Browser' }] })
    expect(snap.ok).toBe(true)
    expect(snap.totalCpu).toBeCloseTo(50)
  })
})
