// @vitest-environment node
// remoteFs.js on a slow host (mocked transport): repeated reads share one
// request, a long operation shows as slow, a refresh that fails because
// the host did not answer says so (transient), readers wait behind the
// user's requests, and git status counts the lines of a bounded number of
// new files.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRemoteFs, REMOTE_UNTRACKED_COUNTS } from '../remoteFs'
import { remoteRoot } from '../../shared/remotePath'

const HOST = 'ssh-slow1'
const ROOT = remoteRoot(HOST, '/home/me/app')

// A host whose answers the test controls: handler(fn, line) -> { rc, out }
// | a Promise of it | null (never answers).
function fakeHost(handler) {
  const seen = []
  const children = []
  const spawnImpl = () => {
    const child = new EventEmitter()
    children.push(child)
    let nonce = ''
    const reply = (id, { rc = 0, out = '' } = {}) => {
      child.stdout.emit('data', Buffer.from(`@@T ${nonce} ${id} ${rc}\n${Buffer.from(out).toString('base64')}\n@@T ${nonce} ${id} e\n\n@@T ${nonce} ${id} z\n`))
    }
    child.stdin = Object.assign(new EventEmitter(), {
      write(text) {
        const s = String(text)
        const m = /__T_N=([0-9a-f]{32})/.exec(s)
        if (m) {
          nonce = m[1]
          setImmediate(() => child.stdout.emit('data', Buffer.from(`@@R ${nonce} ok\n`)))
          return true
        }
        for (const line of s.split('\n')) {
          const q = /^__t_q (\d+) \d+ \d+ (\S+)(.*)$/.exec(line)
          if (!q) continue
          seen.push({ fn: q[2], line })
          Promise.resolve(handler(q[2], line)).then((r) => {
            if (r) reply(Number(q[1]), r)
          })
        }
        return true
      },
      end() {}
    })
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => setImmediate(() => child.emit('exit', null))
    return child
  }
  return { spawnImpl, seen, children }
}

function service(handler, extra = {}) {
  const host = fakeHost(handler)
  const sent = []
  const hosts = {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box' }),
    get: () => ({ id: HOST, label: 'Box' }),
    sharedConnected: () => true,
    paneStarted() {},
    paneConnected() {},
    paneClosing() {},
    paneExited() {}
  }
  const rfs = createRemoteFs({ hosts, spawnImpl: host.spawnImpl, send: (c, p) => sent.push([c, p]), env: {}, ...extra })
  rfs.setRoots([ROOT])
  rfs.allow(HOST)
  return { rfs, sent, seen: host.seen, children: host.children }
}
const later = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms))

describe('remote files on a slow host', () => {
  it('the same listing asked three times while it runs: one request, one answer', async () => {
    const { rfs, seen } = service((fn) => (fn === '__t_ls' ? later(30, { out: 'f a.txt\0d src\0' }) : { rc: 0 }))
    const [a, b, c] = await Promise.all([rfs.listDir({ root: ROOT }), rfs.listDir({ root: ROOT }), rfs.listDir({ root: ROOT })])
    expect(a.ok).toBe(true)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(seen.filter((s) => s.fn === '__t_ls')).toHaveLength(1)
    // Asked again once it is done: a new request.
    await rfs.listDir({ root: ROOT })
    expect(seen.filter((s) => s.fn === '__t_ls')).toHaveLength(2)
    rfs.close()
  })

  it('a listing that fails because the host did not answer is transient (the window keeps what it showed)', async () => {
    const { rfs } = service((fn) => (fn === '__t_ls' ? null : { rc: 0 }))
    const p = rfs.listDir({ root: ROOT })
    await later(20)
    rfs.closeHost(HOST, 'timeout')
    const res = await p
    expect(res).toMatchObject({ ok: false, transient: true })
    rfs.close()
  })

  it('an operation with no answer after SLOW_MS shows as slow, and not after', async () => {
    const pending = []
    const timers = {
      setTimeout: (fn, ms) => (ms === 12_000 ? (pending.push(fn), pending.length) : setTimeout(fn, ms)),
      clearTimeout: (id) => (typeof id === 'number' && id <= pending.length ? (pending[id - 1] = null) : clearTimeout(id)),
      setInterval,
      clearInterval
    }
    let release
    const { rfs, sent } = service((fn) => (fn === '__t_ls' ? new Promise((r) => (release = r)) : { rc: 0 }), { timers })
    const p = rfs.listDir({ root: ROOT })
    for (let i = 0; i < 20 && !release; i++) await later(5)
    expect(sent.filter(([c, a]) => c === 'remoteFs:activity' && a.slow)).toHaveLength(0)
    pending.filter(Boolean).forEach((fn) => fn())
    expect(sent.filter(([c, a]) => c === 'remoteFs:activity' && a.slow).length).toBeGreaterThan(0)
    expect(rfs.snapshot()[HOST].slow).toBe(true)
    release({ out: '' })
    await p
    const last = sent.filter(([c]) => c === 'remoteFs:activity').pop()[1]
    expect(last.slow).toBe(false)
    rfs.close()
  })

  it("an agent file read waits behind the user's listing, not the other way round", async () => {
    const order = []
    let releaseFirst
    const { rfs } = service((fn) => {
      order.push(fn)
      if (fn === '__t_stats') return new Promise((r) => (releaseFirst = r))
      if (fn === '__t_tread') return { out: '5 1700000000\nhello' }
      return { out: '' }
    })
    const first = rfs.statForEdit(`${ROOT}/a.txt`)
    for (let i = 0; i < 40 && !releaseFirst; i++) await later(5)
    const bg = rfs.readAgentFile(HOST, { agent: 'claude', id: 'abcdef12-3456', cap: 64 })
    const user = rfs.listDir({ root: ROOT })
    await later(10)
    releaseFirst({ rc: 1 })
    await Promise.all([first, bg, user])
    expect(order).toEqual(['__t_stats', '__t_ls', '__t_tread'])
    rfs.close()
  })

  it('after a dropped connection, the read in flight and the one waiting run again on a new session', async () => {
    let n = 0
    const { rfs, children } = service((fn) => {
      if (fn === '__t_stats' && n++ === 0) return null
      if (fn === '__t_ls') return { out: 'f a.txt\0' }
      return { rc: 0, out: '' }
    })
    const inFlight = rfs.statForEdit(`${ROOT}/a.txt`)
    for (let i = 0; i < 40 && n === 0; i++) await later(5)
    const waiting = rfs.listDir({ root: ROOT })
    await later(10)
    children[0].emit('exit', 255)
    const [a, b] = await Promise.all([inFlight, waiting])
    expect(a).toMatchObject({ ok: true, exists: false })
    expect(b).toMatchObject({ ok: true, entries: [{ name: 'a.txt' }] })
    expect(children).toHaveLength(2)
    rfs.close()
  })

  it('a connection that died after a long silence (a stalled link) is not retried: the error comes now', async () => {
    let clock = 1000
    let n = 0
    const { rfs, children } = service(
      (fn) => {
        if (fn === '__t_stats' && n++ === 0) return null
        return { rc: 0, out: '' }
      },
      { now: () => clock }
    )
    const p = rfs.statForEdit(`${ROOT}/a.txt`)
    for (let i = 0; i < 40 && n === 0; i++) await later(5)
    clock += 60_000
    children[0].emit('exit', 255)
    const res = await p
    expect(res.ok).toBe(false)
    expect(children).toHaveLength(1)
    rfs.close()
  })

  it('a save in flight when the connection drops is never sent again', async () => {
    const { rfs, seen, children } = service((fn) => (fn === '__t_write' ? null : { rc: 0, out: '' }))
    const p = rfs.writeForEdit({ file: `${ROOT}/a.txt`, text: 'x' })
    for (let i = 0; i < 40 && !seen.some((x) => x.fn === '__t_write'); i++) await later(5)
    children[0].emit('exit', 255)
    const res = await p
    expect(res.ok).toBe(false)
    expect(seen.filter((x) => x.fn === '__t_write')).toHaveLength(1)
    rfs.close()
  })

  it(`git status counts the lines of at most ${REMOTE_UNTRACKED_COUNTS} new files, in one request`, async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `new${i}.txt`)
    const { rfs, seen } = service((fn, line) => {
      if (fn === '__t_top') return { rc: 0, out: '/home/me/app\n/home/me/app\n' }
      if (fn === '__t_gitin' && line.includes("'status'")) return { out: `# branch.oid abc\0# branch.head main\0${many.map((p) => `? ${p}`).join('\0')}\0` }
      if (fn === '__t_gitin') return { rc: line.includes('--get-regexp') ? 1 : 0, out: '' }
      if (fn === '__t_hooks') return { out: '' }
      if (fn === '__t_wcl') return { out: Array.from({ length: (line.match(/'new/g) || []).length }, () => '3').join('\n') }
      return { out: '' }
    })
    const res = await rfs.scm.scmStatus({ root: ROOT })
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(1000)
    const counted = seen.filter((s) => s.fn === '__t_wcl')
    expect(counted).toHaveLength(1)
    expect(res.entries.filter((e) => e.added === 3)).toHaveLength(REMOTE_UNTRACKED_COUNTS)
    rfs.close()
  })
})
