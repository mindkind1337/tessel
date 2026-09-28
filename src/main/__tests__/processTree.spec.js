// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { treeOf, waitForExit, pidRunning, stillRunning, listProcesses, killPids } from '../processTree'

function fakeClock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms }, advance: (ms) => { t += ms } }
}

describe('waitForExit (fake clock and probe)', () => {
  it('resolves once every process has ended', async () => {
    const clock = fakeClock()
    const endsAt = { 1: 500, 2: 1200 }
    const alive = async (list) => list.filter((e) => clock.now() < endsAt[e.pid])
    const r = await waitForExit({ entries: [{ pid: 1 }, { pid: 2 }], alive, verify: async (l) => l, now: clock.now, sleep: clock.sleep })
    expect(r).toEqual({ ok: true, left: [] })
    expect(clock.now()).toBeGreaterThanOrEqual(1200)
    expect(clock.now()).toBeLessThan(1500)
  })

  it('returns what is still running at the timeout, never earlier', async () => {
    const clock = fakeClock()
    const alive = async (list) => list.filter((e) => e.pid === 7)
    const r = await waitForExit({ entries: [{ pid: 7 }, { pid: 8 }], alive, verify: async (l) => l, timeoutMs: 15000, now: clock.now, sleep: clock.sleep })
    expect(r.ok).toBe(false)
    expect(r.left.map((e) => e.pid)).toEqual([7])
    expect(clock.now()).toBeGreaterThanOrEqual(15000)
  })

  it('a PID reused by another program is not taken for the old process', async () => {
    const clock = fakeClock()
    // The cheap check still sees PID 9 (another program took it); the exact
    // check (creation time) says the recorded one ended.
    const r = await waitForExit({
      entries: [{ pid: 9, created: 111 }],
      alive: async (l) => l,
      verify: async () => [],
      force: async () => { throw new Error('must not kill another program') },
      timeoutMs: 15000,
      forceAfterMs: 3000,
      now: clock.now,
      sleep: clock.sleep
    })
    expect(r.ok).toBe(true)
    expect(clock.now()).toBeLessThan(4000)
  })

  it('forces what is left once, after forceAfterMs, then keeps waiting', async () => {
    const clock = fakeClock()
    let killedAt = null
    const forced = []
    const alive = async (l) => (killedAt === null ? l : clock.now() - killedAt < 400 ? l : [])
    const r = await waitForExit({
      entries: [{ pid: 3 }],
      alive,
      verify: async (l) => l,
      force: async (l) => { forced.push(...l.map((e) => e.pid)); killedAt = clock.now() },
      forceAfterMs: 3000,
      now: clock.now,
      sleep: clock.sleep
    })
    expect(r.ok).toBe(true)
    expect(forced).toEqual([3])
    expect(killedAt).toBeGreaterThanOrEqual(3000)
  })

  it('nothing to wait for: done at once', async () => {
    const r = await waitForExit({ entries: [], sleep: async () => { throw new Error('no wait') } })
    expect(r.ok).toBe(true)
  })
})

describe('treeOf', () => {
  const procs = [
    { pid: 10, ppid: 1, created: 100 }, // the shell
    { pid: 11, ppid: 10, created: 110 }, // the agent
    { pid: 12, ppid: 11, created: 120 }, // its node child
    { pid: 13, ppid: 10, created: 50 }, // older than 10: its real parent died, PID 10 reused
    { pid: 14, ppid: 2, created: 130 } // unrelated
  ]
  it('keeps the shell and every program under it', () => {
    expect(treeOf(procs, [{ pid: 10 }]).map((p) => p.pid).sort()).toEqual([10, 11, 12])
  })
  it('a recorded process started at another time is another program', () => {
    expect(treeOf(procs, [{ pid: 10, created: 99 }])).toEqual([])
    expect(treeOf(procs, [{ pid: 11, created: 110 }]).map((p) => p.pid).sort()).toEqual([11, 12])
  })
})

describe('real processes', () => {
  it('a throwaway child is running, then gone once killed by its own PID', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore', windowsHide: true })
    try {
      await new Promise((r) => child.once('spawn', r))
      const pid = child.pid
      expect(pidRunning(pid)).toBe(true)
      const procs = await listProcesses()
      expect(procs).not.toBeNull()
      const mine = treeOf(procs, [{ pid: process.pid }])
      const entry = mine.find((e) => e.pid === pid)
      expect(entry).toBeTruthy() // found under this test process
      expect(await stillRunning([entry])).toEqual(expect.arrayContaining([expect.objectContaining({ pid })]))

      const exited = new Promise((r) => child.once('exit', r))
      process.kill(pid, 'SIGKILL')
      await exited
      const r = await waitForExit({ entries: [entry], timeoutMs: 5000 })
      expect(r.ok).toBe(true)
      expect(pidRunning(pid)).toBe(false)
      expect(await stillRunning([entry])).toEqual([])
    } finally {
      try { child.kill('SIGKILL') } catch { /* gone */ }
    }
  }, 30000)

  it('one that does not end by itself is ended after forceAfterMs', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore', windowsHide: true })
    try {
      await new Promise((r) => child.once('spawn', r))
      const entry = treeOf(await listProcesses(), [{ pid: child.pid }])[0]
      expect(entry && entry.pid).toBe(child.pid)
      const r = await waitForExit({ entries: [entry], force: killPids, forceAfterMs: 300, timeoutMs: 10000 })
      expect(r.ok).toBe(true)
      expect(pidRunning(child.pid)).toBe(false)
    } finally {
      try { child.kill('SIGKILL') } catch { /* gone */ }
    }
  }, 30000)
})

describe('runningWork (closing a terminal with a program running)', () => {
  it('reads the process listing', async () => {
    const { parseProcessNames } = await import('../processTree')
    expect(parseProcessNames('10\t4\tpwsh.exe\r\n11\t10\tnode.exe\r\njunk\n')).toEqual([
      { pid: 10, ppid: 4, name: 'pwsh.exe' },
      { pid: 11, ppid: 10, name: 'node.exe' }
    ])
  })
  it('an idle shell has nothing; console helpers do not count; a launcher is looked through', async () => {
    const { runningWork } = await import('../processTree')
    const procs = [
      { pid: 10, ppid: 4, name: 'pwsh.exe' },
      { pid: 12, ppid: 10, name: 'conhost.exe' },
      { pid: 20, ppid: 4, name: 'bash.exe' },
      { pid: 21, ppid: 20, name: 'bash.exe' },
      { pid: 30, ppid: 4, name: 'cmd.exe' },
      { pid: 31, ppid: 30, name: 'npm.cmd' },
      { pid: 32, ppid: 30, name: 'node.exe' }
    ]
    expect(runningWork(procs, 10)).toEqual([])
    expect(runningWork(procs, 20)).toEqual([])
    expect(runningWork([...procs, { pid: 22, ppid: 21, name: 'vim.exe' }], 20)).toEqual(['vim.exe'])
    expect(runningWork(procs, 30)).toEqual(['npm.cmd', 'node.exe'])
    expect(runningWork(procs, 99)).toEqual([])
  })
})
