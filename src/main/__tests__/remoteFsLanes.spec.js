// @vitest-environment node
// A host's lanes (remoteFs.js LANES): what a terminal opening there waits for
// (the shim install, the agent check, whether its conversation is there) and
// Live Share guests' requests run on sessions of their own over the same
// signed-in ssh2 connection, so the host's Files session (a git status, a
// search, the change poll of a big project) can never hold them, and guests
// can never hold it.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRemoteFs, LANES, LANE_RETRY_MS } from '../remoteFs'
import { remoteRoot } from '../../shared/remotePath'

const HOST = 'ssh-lanes1'
const ROOT = remoteRoot(HOST, '/srv/app')

// A fake host: each spawned child is one session; it answers the prelude,
// then every request after a turn of the event loop (or never: hang).
function fakeHost({ hang = new Set(), out = {}, hangFirst = new Set() } = {}) {
  const children = []
  const hungOnce = new Set()
  const spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.ran = []
    child.killed = false
    let nonce = null
    child.stdin = Object.assign(new EventEmitter(), {
      write(text) {
        const s = String(text)
        const n = /__T_N=([0-9a-f]{32})/.exec(s)
        if (n) {
          nonce = n[1]
          setImmediate(() => child.stdout.emit('data', Buffer.from(`@@R ${nonce} ok\n`)))
        }
        for (const m of s.matchAll(/__t_q (\d+) \d+ \d+ (__t_\w+)/g)) {
          child.ran.push(m[2])
          if (hang.has(m[2])) continue
          // Only its first run never answers (the next one, elsewhere, does).
          if (hangFirst.has(m[2]) && !hungOnce.has(m[2])) {
            hungOnce.add(m[2])
            continue
          }
          const body = Buffer.from(out[m[2]] || '').toString('base64')
          setImmediate(() => child.stdout.emit('data', Buffer.from(`@@T ${nonce} ${m[1]} 0\n${body}\n@@T ${nonce} ${m[1]} e\n\n@@T ${nonce} ${m[1]} z\n`)))
        }
        return true
      },
      end() {}
    })
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('exit', null))
    }
    children.push(child)
    return child
  }
  return { spawn, children }
}

function setup({ connected = true, mode = 'ssh2', hang, out, timers, onlyLive = true, now, hangFirst } = {}) {
  const host = fakeHost({ hang, out, hangFirst })
  const spawnOpts = []
  const state = { connected, onlyLive, failLane: false }
  const ssh = {
    modeFor: async () => (mode === 'ssh2' ? { mode: 'ssh2', spec: { host: 'box' } } : { mode: 'system' }),
    // The running terminal host keeps an exec channel to a live connection.
    onlyLiveSupported: () => state.onlyLive,
    spawnFor: (_hostId, _spec, opts) => {
      spawnOpts.push(opts || null)
      // A lane's channel refused (the server's MaxSessions): it exits at once.
      if (opts && opts.onlyLive && state.failLane)
        return () => {
          const c = host.spawn()
          c.stdin.write = () => true
          setImmediate(() => {
            c.failCode = 'ssh'
            c.emit('exit', 255)
          })
          return c
        }
      return host.spawn
    }
  }
  const hosts = {
    get: () => ({ id: HOST, label: 'Box' }),
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box' }),
    sharedConnected: () => state.connected,
    paneStarted() {},
    paneConnected() {},
    paneClosing() {},
    paneExited() {}
  }
  const warned = []
  const rfs = createRemoteFs({ hosts, ssh, spawnImpl: host.spawn, log: { warn: (_area, m) => warned.push(m) }, ...(timers ? { timers } : {}), ...(now ? { now } : {}) })
  rfs.setRoots([ROOT])
  return { rfs, host, spawnOpts, state, warned }
}
const tick = () => new Promise((r) => setImmediate(r))

describe('the pane lane', () => {
  it('the agent check and the shim install answer while the host\'s Files session is held', async () => {
    const { rfs, host, spawnOpts } = setup({ hang: new Set(['__t_ls']), out: { __t_agents: 'claude /usr/bin/claude\n', __t_ragent: '{"ok":true}\n' } })
    // The Files panel of a big project: its listing never ends here.
    const held = rfs.listDir({ root: ROOT })
    held.catch(() => {})
    await tick()
    await tick()
    const tools = await rfs.agentTools(HOST, ['claude'], { first: true })
    expect(tools.claude).toBe('/usr/bin/claude')
    const shim = await rfs.installAgentShim(HOST, { version: '1.0.0', source: 'x' })
    expect(shim.rc).toBe(0)
    expect(host.children).toHaveLength(2)
    expect(host.children[0].ran).toEqual(['__t_ls'])
    expect(host.children[1].ran).toEqual(['__t_agents', '__t_ragent'])
    // The lane's channel: only on the connection that is up, never a new one.
    expect(spawnOpts).toEqual([null, { onlyLive: true }])
    expect(rfs.lanesOpen()).toEqual([`${HOST} pane`])
    rfs.close()
  })

  it('whether a conversation is there is asked on it too (lane: pane)', async () => {
    const { rfs, host } = setup({ hang: new Set(['__t_ls']), out: { __t_tread: '12 1700000000\n' } })
    rfs.listDir({ root: ROOT }).catch(() => {})
    await tick()
    const res = await rfs.readAgentFile(HOST, { agent: 'codex', id: '01a16f50-626f-7a13-9795-0e1e34414ed7', cap: 1, lane: 'pane' })
    expect(res.ok).toBe(true)
    expect(host.children[1].ran).toEqual(['__t_tread'])
    rfs.close()
  })

  it('a connection not signed in yet: in the host\'s session, as before (nothing asked twice)', async () => {
    const { rfs, host, spawnOpts } = setup({ connected: false, out: { __t_agents: 'claude -\n' } })
    rfs.allow(HOST)
    const tools = await rfs.agentTools(HOST, ['claude'], { first: true })
    expect(tools.error).toBeUndefined()
    expect(host.children).toHaveLength(1)
    expect(host.children[0].ran).toEqual(['__t_agents'])
    expect(spawnOpts).toEqual([null])
    expect(rfs.lanesOpen()).toEqual([])
    rfs.close()
  })

  it('the system ssh: the host\'s session too (a second ssh.exe could ask a password again)', async () => {
    const { rfs, host } = setup({ mode: 'system', out: { __t_agents: 'claude -\n' } })
    rfs.allow(HOST)
    await rfs.agentTools(HOST, ['claude'], { first: true })
    expect(host.children).toHaveLength(1)
    rfs.close()
  })
})

describe('the guest lane', () => {
  it('never falls back to the host\'s session', async () => {
    const { rfs, host, state } = setup({ out: { __t_ls: '' } })
    await rfs.listDir({ root: ROOT })
    state.connected = false
    expect(await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })).toEqual({ ok: false, code: 'not-connected' })
    expect(host.children).toHaveLength(1)
    expect(host.children[0].ran).toEqual(['__t_ls'])
    rfs.close()
  })

  it('a small queue of its own: past it, busy at once, said in the log; the host\'s session goes on', async () => {
    const { rfs, host, warned } = setup({ hang: new Set(['__t_gst']), out: { __t_ls: '' } })
    const waiting = []
    for (let i = 0; i < 1 + LANES.guest.maxQueued; i++) waiting.push(rfs.guest.stat({ root: ROOT, rel: `f${i}.txt` }))
    await tick()
    await tick()
    expect(await rfs.guest.stat({ root: ROOT, rel: 'late.txt' })).toEqual({ ok: false, code: 'busy' })
    expect(warned.some((m) => /^busy on ssh-lanes1 \(guest\): __t_gst given up at once, the queue is full; running __t_gst/.test(m))).toBe(true)
    // The host's own listing is not behind them.
    expect((await rfs.listDir({ root: ROOT })).ok).toBe(true)
    const files = host.children.find((c) => c.ran.includes('__t_ls'))
    expect(files.ran).toEqual(['__t_ls'])
    rfs.close()
    await Promise.all(waiting)
  })

  it('a guest\'s chat view reads on it (lane: guest)', async () => {
    const { rfs, host } = setup({ out: { __t_tread: '3 1700000000\nabc' } })
    const res = await rfs.readAgentFile(HOST, { agent: 'claude', id: 'abcdef12-3456', lane: 'guest' })
    expect(res.ok).toBe(true)
    expect(host.children).toHaveLength(1)
    expect(rfs.lanesOpen()).toEqual([`${HOST} guest`])
    rfs.close()
  })
})

describe('the background lane and the badge', () => {
  it('a refresh, the git colours, a poll: on the background lane, never in front of a click', async () => {
    const { rfs, host } = setup({ hang: new Set(['__t_gitin', '__t_top']), out: { __t_ls: 'f a.txt\0' } })
    rfs.listDir({ root: ROOT, background: true }).catch(() => {})
    rfs.projectStatus({ root: ROOT, ignored: true, background: true }).catch(() => {})
    await tick()
    await tick()
    // A click: the host's session answers it at once, the colours still running.
    const res = await rfs.listDir({ root: ROOT })
    expect(res.ok).toBe(true)
    const files = host.children.find((c) => c.ran.length === 1 && c.ran[0] === '__t_ls')
    expect(files).toBeTruthy()
    expect(rfs.lanesOpen()).toContain(`${HOST} bg`)
    rfs.close()
  })

  it('the system ssh: background work in the host\'s session, never "busy" or "slow" in the badge', async () => {
    const host = fakeHost({ hang: new Set(['__t_top']) })
    const sent = []
    const slowTimers = []
    const timers = {
      setTimeout: (fn, ms) => {
        // The badge's "slow to answer" (SLOW_MS): fired at once here.
        if (ms === 12_000) {
          slowTimers.push(fn)
          return setTimeout(fn, 0)
        }
        return setTimeout(fn, ms)
      },
      clearTimeout: (h) => clearTimeout(h),
      setInterval: (...a) => setInterval(...a),
      clearInterval: (h) => clearInterval(h)
    }
    const rfs = createRemoteFs({
      hosts: { get: () => ({ id: HOST, label: 'Box' }), launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box' }), sharedConnected: () => true, paneStarted() {}, paneConnected() {}, paneClosing() {}, paneExited() {} },
      spawnImpl: host.spawn,
      send: (c, p) => sent.push([c, p]),
      timers
    })
    rfs.setRoots([ROOT])
    rfs.projectStatus({ root: ROOT, ignored: true, background: true }).catch(() => {})
    await tick()
    await tick()
    await new Promise((r) => setTimeout(r, 5))
    const states = sent.filter(([c]) => c === 'remoteFs:activity').map(([, p]) => p)
    expect(states.some((s) => s.state === 'busy' || s.slow)).toBe(false)
    expect(slowTimers).toHaveLength(0)
    rfs.close()
  })
})

describe('a lane\'s life', () => {
  it('closes when idle (its channel freed), and with the host (Disconnect)', async () => {
    const idle = []
    const timers = {
      setTimeout: (fn, ms) => {
        if (ms === LANES.guest.idleMs || ms === LANES.pane.idleMs) {
          const h = { fn, cleared: false, unref() {} }
          idle.push(h)
          return h
        }
        return setTimeout(fn, ms)
      },
      clearTimeout: (h) => {
        if (h && typeof h === 'object' && 'cleared' in h) h.cleared = true
        else clearTimeout(h)
      },
      setInterval: (...a) => setInterval(...a),
      clearInterval: (h) => clearInterval(h)
    }
    const { rfs, host } = setup({ timers, out: { __t_gst: '-\n', __t_agents: 'claude -\n' } })
    await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })
    expect(rfs.lanesOpen()).toEqual([`${HOST} guest`])
    const armed = idle.filter((h) => !h.cleared)
    expect(armed).toHaveLength(1)
    armed[0].fn()
    expect(rfs.lanesOpen()).toEqual([])
    await tick()
    expect(host.children[0].killed).toBe(true)
    // Opened again when needed; Disconnect ends it with the host's session.
    await rfs.agentTools(HOST, ['claude'], { first: true })
    expect(rfs.lanesOpen()).toEqual([`${HOST} pane`])
    // The badge's Cancel (or the Files session's idle close) leaves it alone.
    rfs.closeHost(HOST, 'cancelled')
    rfs.closeHost(HOST, 'idle')
    expect(rfs.lanesOpen()).toEqual([`${HOST} pane`])
    rfs.closeHost(HOST, 'disconnect')
    expect(rfs.lanesOpen()).toEqual([])
    rfs.close()
  })

  it('a guest\'s save on its way is not cut by the Files session\'s Cancel', async () => {
    const { rfs, host } = setup({ hang: new Set(['__t_gst']), out: { __t_ls: '' } })
    await rfs.listDir({ root: ROOT })
    const saving = rfs.guest.stat({ root: ROOT, rel: 'a.txt' })
    await tick()
    await tick()
    rfs.closeHost(HOST, 'cancelled')
    const lane = host.children.find((c) => c.ran.includes('__t_gst'))
    expect(lane.killed).toBe(false)
    expect(rfs.lanesOpen()).toEqual([`${HOST} guest`])
    rfs.close()
    await saving
  })
})

describe('a lane that cannot be had', () => {
  it('an older terminal host (no onlyLive): the pane\'s and background work go in the Files session; guests are served in the Files session', async () => {
    const { rfs, host, spawnOpts } = setup({ onlyLive: false, out: { __t_agents: 'claude -\n', __t_ls: '' } })
    rfs.allow(HOST)
    await rfs.agentTools(HOST, ['claude'], { first: true })
    await rfs.listDir({ root: ROOT, background: true })
    expect(host.children).toHaveLength(1)
    expect(spawnOpts.every((o) => !o || !o.onlyLive)).toBe(true)
    expect(await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })).toMatchObject({ ok: true })
    expect(host.children[0].ran).toEqual(['__t_agents', '__t_ls', '__t_gst'])
    rfs.close()
  })

  it('refused (no slot): not tried again for a while, said once; the work goes on in the Files session', async () => {
    let clock = 1_000_000
    const { rfs, host, spawnOpts, state, warned } = setup({ now: () => clock, out: { __t_ls: '', __t_agents: 'claude -\n' } })
    state.failLane = true
    rfs.allow(HOST)
    for (let i = 0; i < 3; i++) expect((await rfs.listDir({ root: ROOT, background: true })).ok).toBe(true)
    // One lane try only; the rest went straight to the Files session.
    expect(spawnOpts.filter((o) => o && o.onlyLive)).toHaveLength(1)
    expect(warned.filter((m) => /bg lane .* could not open/.test(m))).toHaveLength(1)
    const files = host.children.find((c) => c.ran.length)
    expect(files.ran).toEqual(['__t_ls', '__t_ls', '__t_ls'])
    // A guest meanwhile: no lane, so in the Files session (the host's open one).
    expect(await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })).toMatchObject({ ok: true })
    expect(files.ran).toEqual(['__t_ls', '__t_ls', '__t_ls', '__t_gst'])
    // Later: tried again.
    state.failLane = false
    clock += LANE_RETRY_MS + 1
    await rfs.listDir({ root: ROOT, background: true })
    expect(rfs.lanesOpen()).toContain(`${HOST} bg`)
    rfs.close()
  })

  it('the pane\'s lane full: in the Files session, first in its turn (a pane never fails to start for it)', async () => {
    const { rfs, host } = setup({ hang: new Set(['__t_agents']), out: { __t_tread: '3 1700000000\nabc' } })
    rfs.allow(HOST)
    const held = []
    for (let i = 0; i < 1 + LANES.pane.maxBgQueued; i++) held.push(rfs.agentTools(HOST, ['claude'], { first: true }))
    await tick()
    await tick()
    // The pane's lane is full: whether its conversation is there is asked
    // in the Files session instead, and answered.
    const res = await rfs.readAgentFile(HOST, { agent: 'claude', id: 'abcdef12-3456', lane: 'pane' })
    expect(res.ok).toBe(true)
    const files = host.children.find((c) => c.ran.includes('__t_tread'))
    expect(files.ran).toEqual(['__t_tread'])
    rfs.close()
    await Promise.all(held)
  })

  it('the server refuses the guest channel (MaxSessions): the guest is served in the host session, none open: not connected', async () => {
    const { rfs, state } = setup({ out: { __t_ls: '', __t_gst: '4 1700000000 9 644\n' } })
    state.failLane = true
    expect(await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })).toEqual({ ok: false, code: 'not-connected' })
    rfs.allow(HOST)
    await rfs.listDir({ root: ROOT })
    expect(await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })).toMatchObject({ ok: true, exists: true, size: 4 })
    rfs.close()
  })

  it('the system ssh: a guest in the host\'s open session as before, never a new connection; none open: not connected', async () => {
    const { rfs, host } = setup({ mode: 'system', out: { __t_ls: '', __t_gst: '4 1700000000 9 644\n' } })
    expect(await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })).toEqual({ ok: false, code: 'not-connected' })
    expect(host.children).toHaveLength(0)
    rfs.allow(HOST)
    await rfs.listDir({ root: ROOT })
    expect(await rfs.guest.stat({ root: ROOT, rel: 'a.txt' })).toMatchObject({ ok: true, exists: true, size: 4 })
    expect(host.children).toHaveLength(1)
    expect(host.children[0].ran).toEqual(['__t_ls', '__t_gst'])
    expect(rfs.lanesOpen()).toEqual([])
    rfs.close()
  })
})

describe('a lane whose channel goes away under its request (it gave its slot to a terminal)', () => {
  it('the pane\'s check runs again in the Files session, first in its turn', async () => {
    const { rfs, host } = setup({ hangFirst: new Set(['__t_agents']), out: { __t_agents: 'claude /usr/bin/claude\n' } })
    rfs.allow(HOST)
    const asked = rfs.agentTools(HOST, ['claude'], { first: true })
    await tick()
    await tick()
    host.children[0].emit('exit', 255)
    const tools = await asked
    expect(tools.claude).toBe('/usr/bin/claude')
    expect(host.children).toHaveLength(2)
    expect(host.children[1].ran).toEqual(['__t_agents'])
    rfs.close()
  })

  it('background work runs again in the Files session too', async () => {
    const { rfs, host } = setup({ hangFirst: new Set(['__t_ls']), out: { __t_ls: 'f a.txt\0' } })
    rfs.allow(HOST)
    const listed = rfs.listDir({ root: ROOT, background: true })
    await tick()
    await tick()
    host.children[0].emit('exit', 255)
    expect((await listed).ok).toBe(true)
    rfs.close()
  })

  it('a guest\'s request is never run again by itself: a "try again" answer, nothing in the host\'s session', async () => {
    const { rfs, host } = setup({ hangFirst: new Set(['__t_gwr']) })
    const saving = rfs.guest.write({ root: ROOT, rel: 'a.txt', data: Buffer.from('x'), createOnly: true })
    await tick()
    await tick()
    host.children[0].emit('exit', 255)
    expect(await saving).toEqual({ ok: false, code: 'not-connected' })
    expect(host.children).toHaveLength(1)
    rfs.close()
  })

  it('a pane call that may not run twice (a new account folder) is not run again', async () => {
    const { rfs, host } = setup({ hangFirst: new Set(['__t_acctmk']) })
    const made = rfs.accountCall(HOST, '__t_acctmk', ['claude', 'abc123', 'new'], { user: true })
    await tick()
    await tick()
    host.children[0].emit('exit', 255)
    expect((await made).error).toBeTruthy()
    expect(host.children.every((c) => c.ran.filter((f) => f === '__t_acctmk').length <= 1)).toBe(true)
    expect(host.children.slice(1).some((c) => c.ran.includes('__t_acctmk'))).toBe(false)
    rfs.close()
  })
})

describe('what the host says back', () => {
  it('git too old to tell what it ignores: old-git (nothing given)', async () => {
    const { rfs } = setup({ out: { __t_glsm: '/@@D 0\0f a.txt\0/@@I y\0/@@I o\0' } })
    const res = await rfs.guest.list({ root: ROOT, dirs: [''] })
    expect(res.results[0]).toEqual({ rel: '', ok: false, code: 'old-git' })
    rfs.close()
  })

  it('a grep without --null: one file per marker line, a name never taken from a matched line', async () => {
    const { rfs } = setup({ out: { __t_ggrep: 'L\n/@@F ./a.txt\n3:hello x/.env:4:SECRET\n/@@F ./b/c.txt\n1:hello\n' } })
    const res = await rfs.guest.searchContent({ root: ROOT, query: 'hello' })
    expect(res.results.map((r) => [r.rel, r.line])).toEqual([['a.txt', 3], ['b/c.txt', 1]])
    rfs.close()
  })

  it('a guest\'s plain grep with --null is read strictly', async () => {
    const { rfs } = setup({ out: { __t_ggrep: 'P\n./cfg\x001:x/.env:3:SECRET=1\n./d/e.txt\x002:ok\n' } })
    const res = await rfs.guest.searchContent({ root: ROOT, query: 'x' })
    expect(res.results.map((r) => [r.rel, r.line])).toEqual([['cfg', 1], ['d/e.txt', 2]])
    rfs.close()
  })
})
