// @vitest-environment node
// The remote session's queue on a slow or stalled host: bounded waits,
// bounded length, the user's requests before background ones, cancel while
// waiting, and uploads written in slices (the main process never blocks
// on one big write).
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRemoteSession, requestScript, MAX_BG_QUEUED } from '../remoteShell'

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.written = []
  child.stdin.write = (s) => {
    child.stdin.written.push(String(s))
    return true
  }
  child.stdin.end = () => {}
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => child.emit('exit', null)
  return child
}
const NONCE = 'b'.repeat(32)
const b64 = (s) => Buffer.from(s).toString('base64')
const answer = (child, id, text = '') => child.stdout.emit('data', Buffer.from(`@@T ${NONCE} ${id} 0\n${b64(text)}\n@@T ${NONCE} ${id} e\n\n@@T ${NONCE} ${id} z\n`))
const idOf = (line) => Number(/^__t_q (\d+) /m.exec(line)[1])

async function ready(opts = {}) {
  const child = fakeChild()
  const s = createRemoteSession({ file: 'ssh', args: [], spawnImpl: () => child, randomHex: () => NONCE, ...opts })
  const started = s.start()
  child.stdout.emit('data', Buffer.from(`@@R ${NONCE} ok\n`))
  await started
  child.stdin.written.length = 0
  return { s, child }
}

describe('remote session queue', () => {
  it("runs the user's requests before background ones", async () => {
    const { s, child } = await ready()
    const first = s.run('__t_nop', [])
    const bg = s.run('__t_nop', ['bg'], { background: true })
    const user = s.run('__t_nop', ['user'])
    answer(child, idOf(child.stdin.written.pop()), 'one')
    await first
    // Next written: the user's request (id 3), not the background one (id 2).
    const next = child.stdin.written.pop()
    expect(next).toContain("'user'")
    answer(child, idOf(next))
    await user
    const last = child.stdin.written.pop()
    expect(last).toContain("'bg'")
    answer(child, idOf(last))
    await expect(bg).resolves.toMatchObject({ rc: 0 })
  })

  it('a background request a terminal waits for (first) goes before the other background ones', async () => {
    const { s, child } = await ready()
    const running = s.run('__t_nop', [])
    const guest = s.run('__t_nop', ['guest'], { background: true })
    const check = s.run('__t_nop', ['check'], { background: true, first: true })
    answer(child, idOf(child.stdin.written.pop()), 'one')
    await running
    const next = child.stdin.written.pop()
    expect(next).toContain("'check'")
    answer(child, idOf(next))
    await check
    const last = child.stdin.written.pop()
    expect(last).toContain("'guest'")
    answer(child, idOf(last))
    await expect(guest).resolves.toMatchObject({ rc: 0 })
  })

  it("the Files panel's git work (low) runs after every other background request", async () => {
    const { s, child } = await ready()
    const running = s.run('__t_nop', [])
    const git = s.run('__t_nop', ['git'], { background: true, low: true })
    const reader = s.run('__t_nop', ['reader'], { background: true })
    const check = s.run('__t_nop', ['check'], { background: true, first: true })
    const order = []
    answer(child, idOf(child.stdin.written.pop()), 'one')
    await running
    for (let i = 0; i < 3; i++) {
      const next = child.stdin.written.pop()
      order.push(/'(\w+)'/.exec(next)[1])
      answer(child, idOf(next))
      await new Promise((r) => setImmediate(r))
    }
    expect(order).toEqual(['check', 'reader', 'git'])
    await expect(Promise.all([git, reader, check])).resolves.toHaveLength(3)
  })

  it('a reader held only by low git work is not given up at its wait limit: it waits for that run to end, once', async () => {
    const pending = []
    const timers = {
      setTimeout: (fn, ms) => {
        const h = { fn, ms, cleared: false }
        pending.push(h)
        return h
      },
      clearTimeout: (h) => {
        if (h) h.cleared = true
      }
    }
    let now = 1000
    const { s, child } = await ready({ timers, clock: () => now })
    const git = s.run('__t_nop', ['git'], { background: true, low: true, timeoutMs: 8000 })
    const reader = s.run('__t_nop', ['reader'], { background: true, queueWaitMs: 20_000 })
    const fire = (ms) => {
      const h = pending.find((p) => !p.cleared && !p.fired && p.ms === ms)
      h.fired = true
      h.fn()
      return h
    }
    now += 20_000
    fire(20_000)
    // Not given up: a new wait, until the git run's own limit (8 s + the
    // session's margin, 20 s of it gone).
    const again = pending.filter((p) => !p.cleared && !p.fired && p.ms !== 8000 + 15_000)
    expect(again.map((p) => p.ms)).toEqual([3000])
    answer(child, idOf(child.stdin.written.find((l) => l.includes("'git'"))))
    await git
    const next = child.stdin.written.pop()
    expect(next).toContain("'reader'")
    answer(child, idOf(next))
    await expect(reader).resolves.toMatchObject({ rc: 0 })
  })

  it('a reader held by other work is still given up at its wait limit', async () => {
    const { s } = await ready()
    void s.run('__t_nop', [], { background: true }).catch(() => {})
    const reader = s.run('__t_nop', ['reader'], { background: true, queueWaitMs: 20 })
    await expect(reader).rejects.toMatchObject({ code: 'busy' })
    s.close('cancelled')
  })

  it('low git work has a queue bound of its own: a full one never refuses a reader', async () => {
    const { s } = await ready()
    s.run('__t_nop', []).catch(() => {})
    const waiting = []
    for (let i = 0; i < MAX_BG_QUEUED; i++) waiting.push(s.run('__t_nop', [], { background: true, low: true }).catch(() => {}))
    await expect(s.run('__t_nop', [], { background: true, low: true })).rejects.toMatchObject({ code: 'busy' })
    const reader = s.run('__t_nop', ['reader'], { background: true })
    s.close('cancelled')
    await expect(reader).rejects.toMatchObject({ code: 'cancelled' })
    await Promise.all(waiting)
  })

  it('a first request waits as long as a user request (not the short background wait)', async () => {
    const { s } = await ready()
    void s.run('__t_nop', []).catch(() => {})
    const check = s.run('__t_nop', ['check'], { background: true, first: true, queueWaitMs: 20 })
    await expect(check).rejects.toMatchObject({ code: 'busy' })
  })

  it('a request that waits too long for its turn fails as busy; the session goes on', async () => {
    const { s, child } = await ready()
    const first = s.run('__t_nop', [])
    const waiting = s.run('__t_nop', ['late'], { queueWaitMs: 20 })
    await expect(waiting).rejects.toMatchObject({ code: 'busy' })
    expect(s.state).toBe('ready')
    answer(child, idOf(child.stdin.written.pop()), 'ok')
    await expect(first).resolves.toMatchObject({ rc: 0 })
    // The late one was never sent.
    expect(child.stdin.written.join('')).not.toContain("'late'")
  })

  it('too many background requests waiting: the next one is refused at once', async () => {
    const { s } = await ready()
    s.run('__t_nop', []).catch(() => {})
    const waiting = []
    for (let i = 0; i < MAX_BG_QUEUED; i++) waiting.push(s.run('__t_nop', [], { background: true }).catch(() => {}))
    await expect(s.run('__t_nop', [], { background: true })).rejects.toMatchObject({ code: 'busy' })
    // The user's own requests still get in.
    const user = s.run('__t_nop', ['user'])
    s.close('cancelled')
    await expect(user).rejects.toMatchObject({ code: 'cancelled' })
    await Promise.all(waiting)
  })

  it('a session keeps its own queue bounds and wait (a guest\'s lane)', async () => {
    const { s } = await ready({ maxQueued: 1, queueWait: 20 })
    s.run('__t_nop', []).catch(() => {})
    const second = s.run('__t_nop', ['second'])
    await expect(s.run('__t_nop', ['third'])).rejects.toMatchObject({ code: 'busy' })
    // Its own wait, not the module's 90 s.
    await expect(second).rejects.toMatchObject({ code: 'busy' })
    s.close('cancelled')
  })

  it('says what held the session: a slow request (wait and run) and one given up as busy', async () => {
    let now = 1000
    const said = []
    const { s, child } = await ready({ clock: () => now, onSlow: (i) => said.push(i), maxQueued: 1 })
    const first = s.run('__t_fp', [])
    const second = s.run('__t_tread', [])
    // The queue is full: refused at once, with what runs and what waits.
    await expect(s.run('__t_agents', [])).rejects.toMatchObject({ code: 'busy' })
    expect(said[0]).toMatchObject({ kind: 'busy', fn: '__t_agents', why: 'full', running: { fn: '__t_fp', ms: 0 }, waiting: 1, queued: '__t_tread' })
    now += 9000
    answer(child, idOf(child.stdin.written.find((l) => l.includes('__t_fp'))))
    await first
    expect(said[1]).toMatchObject({ kind: 'slow', fn: '__t_fp', runMs: 9000, waitMs: 0, rc: 0 })
    now += 100
    answer(child, idOf(child.stdin.written.find((l) => l.includes('__t_tread'))))
    await second
    // It waited 9 s, ran 0.1 s: slow too (its wait).
    expect(said[2]).toMatchObject({ kind: 'slow', fn: '__t_tread', waitMs: 9000, runMs: 100 })
    expect(said).toHaveLength(3)
  })

  it('an aborted request is dropped while it waits', async () => {
    const { s, child } = await ready()
    const first = s.run('__t_nop', [])
    const ac = new AbortController()
    const p = s.run('__t_nop', ['gone'], { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    answer(child, idOf(child.stdin.written.pop()))
    await first
    expect(child.stdin.written.join('')).not.toContain("'gone'")
  })

  it('writes an upload in slices with the event loop free between them; same bytes as one script', async () => {
    const { s, child } = await ready()
    const data = Buffer.alloc(5 * 1024 * 1024 + 7, 0x61)
    const p = s.run('__t_write', ['/a', '/a/f', '', '', ''], { upload: data })
    // Only the first slices are written synchronously.
    const writesNow = child.stdin.written.length
    expect(writesNow).toBeLessThan(3)
    // Let the slices go out.
    for (let i = 0; i < 20 && !child.stdin.written.join('').includes('__t_q '); i++) await new Promise((r) => setImmediate(r))
    const all = child.stdin.written.join('')
    expect(child.stdin.written.length).toBeGreaterThan(3)
    expect(all).toBe(requestScript(1, 4194304, '__t_write', ['/a', '/a/f', '', '', ''], data))
    answer(child, 1)
    await expect(p).resolves.toMatchObject({ rc: 0 })
  })
})
