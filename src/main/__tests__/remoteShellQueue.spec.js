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
