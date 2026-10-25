// @vitest-environment node
// The window's page growing out of bounds, in the log (2026-10-25: +7 GB in a
// minute while a remote project was shown; the log only said "renderer
// unresponsive"). Ticks are run by hand with a hand-moved clock.
import { describe, it, expect } from 'vitest'
import { watchWindowMemory } from '../windowMemoryWatch'

function setup(opts = {}) {
  let clock = 0
  let pid = 100
  let mb = 500
  const lines = []
  const w = watchWindowMemory({
    pid: () => pid,
    metrics: () => [{ pid: 7, memory: { privateBytes: 99999 * 1024 } }, { pid, memory: { privateBytes: mb * 1024, workingSetSize: 1 } }],
    log: (m) => lines.push(m),
    context: () => 'project shown: AFTERLIFE LIVE',
    now: () => clock,
    setTimer: () => 0,
    clearTimer: () => {},
    ...opts
  })
  const step = (newMb, secs = 15) => {
    clock += secs * 1000
    mb = newMb
    w.tick()
  }
  return { lines, step, setPid: (p) => (pid = p) }
}

describe('watchWindowMemory', () => {
  it('says nothing while the page stays small and steady', () => {
    const { lines, step } = setup()
    for (const m of [500, 520, 610, 700, 650, 900]) step(m)
    expect(lines).toEqual([])
  })

  it('reports a rise of 1 GB within a minute, with the project shown', () => {
    const { lines, step } = setup()
    step(600)
    step(900)
    step(1700)
    expect(lines).toEqual(["the window's page holds 1700 MB (+1100 MB in 60 s), project shown: AFTERLIFE LIVE"])
  })

  it('reports a page over 2 GB even when it grew slowly, then stays quiet for 5 minutes', () => {
    const { lines, step } = setup()
    for (let m = 1500; m <= 2100; m += 100) step(m, 60)
    expect(lines).toEqual(["the window's page holds 2100 MB (+100 MB in 60 s), project shown: AFTERLIFE LIVE"])
    for (let i = 0; i < 4; i++) step(2200, 60)
    expect(lines).toHaveLength(1)
    step(2300, 60)
    expect(lines).toHaveLength(2)
  })

  it('a new page process (a reload) starts its own history', () => {
    const { lines, step, setPid } = setup()
    step(1500)
    setPid(200)
    step(600)
    step(1200)
    expect(lines).toEqual([])
  })

  it('no window, no metrics, or a failing log: nothing breaks', () => {
    const a = setup({ pid: () => 0 })
    a.step(5000)
    expect(a.lines).toEqual([])
    const b = setup({
      metrics: () => {
        throw new Error('not ready')
      }
    })
    expect(() => b.step(5000)).not.toThrow()
    const c = setup({
      log: () => {
        throw new Error('disk full')
      }
    })
    expect(() => c.step(5000)).not.toThrow()
  })
})
