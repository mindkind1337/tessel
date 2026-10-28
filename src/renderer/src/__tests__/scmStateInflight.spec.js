// The Changes status of a folder: one request at a time, and refreshes
// asked meanwhile share one more (a slow remote host never gets a pile of
// git status requests from focus events, polls and change notices).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { refreshStatus, statusOf, forgetStatus, SLOW_STATUS_MS } from '../scmState'

let calls
let releases
beforeEach(() => {
  calls = 0
  releases = []
  window.shellApi = {
    scm: {
      status: () => {
        calls++
        const n = calls
        return new Promise((r) => releases.push(() => r({ ok: true, repo: true, entries: [], n })))
      }
    }
  }
})
afterEach(() => {
  forgetStatus('C:\\proj')
  delete window.shellApi
})
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('refreshStatus while one runs', () => {
  it('five refreshes during a slow status: two requests in all, the last answer wins', async () => {
    const first = refreshStatus('C:\\proj')
    const more = [1, 2, 3, 4].map(() => refreshStatus('C:\\proj'))
    expect(calls).toBe(1)
    releases.shift()()
    await first
    await tick()
    expect(calls).toBe(2)
    releases.shift()()
    const answers = await Promise.all(more)
    expect(answers.every((a) => a && a.n === 2)).toBe(true)
    expect(calls).toBe(2)
    expect(statusOf('C:\\proj').data.n).toBe(2)
  })

  it('after it settles, the next refresh is a new request', async () => {
    const a = refreshStatus('C:\\proj')
    releases.shift()()
    await a
    const b = refreshStatus('C:\\proj')
    expect(calls).toBe(2)
    releases.shift()()
    await expect(b).resolves.toMatchObject({ n: 2 })
  })
})

describe('after a slow status', () => {
  afterEach(() => vi.useRealTimers())
  it('a read by itself (a change notice) waits three times as long as it took; one the person asks for runs now', async () => {
    vi.useFakeTimers()
    const first = refreshStatus('C:\proj', { background: true })
    vi.advanceTimersByTime(SLOW_STATUS_MS * 2)
    releases.shift()()
    await first
    expect(calls).toBe(1)
    // A file changed on the server: put off, and several share one read.
    const a = refreshStatus('C:\proj', { background: true })
    const b = refreshStatus('C:\proj', { background: true })
    await vi.advanceTimersByTimeAsync(SLOW_STATUS_MS * 2 * 3 - 100)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toBe(2)
    releases.shift()()
    expect((await a).n).toBe(2)
    expect((await b).n).toBe(2)
    // The person opens the tab or stages: no wait.
    const c = refreshStatus('C:\proj')
    expect(calls).toBe(3)
    releases.shift()()
    await c
  })
  it('a fast status puts nothing off', async () => {
    const a = refreshStatus('C:\proj', { background: true })
    releases.shift()()
    await a
    refreshStatus('C:\proj', { background: true })
    expect(calls).toBe(2)
    releases.shift()()
  })
})
