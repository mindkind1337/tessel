// @vitest-environment node
// A host's lanes (remoteFs.js LANES): what a terminal opening there waits for
// (the shim install, the agent check, whether its conversation is there) and
// Live Share guests' requests run on sessions of their own over the same
// signed-in ssh2 connection, so the host's Files session (a git status, a
// search, the change poll of a big project) can never hold them, and guests
// can never hold it.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRemoteFs, LANES } from '../remoteFs'
import { remoteRoot } from '../../shared/remotePath'

const HOST = 'ssh-lanes1'
const ROOT = remoteRoot(HOST, '/srv/app')

// A fake host: each spawned child is one session; it answers the prelude,
// then every request after a turn of the event loop (or never: hang).
function fakeHost({ hang = new Set(), out = {} } = {}) {
  const children = []
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

function setup({ connected = true, mode = 'ssh2', hang, out, timers } = {}) {
  const host = fakeHost({ hang, out })
  const spawnOpts = []
  const state = { connected }
  const ssh = {
    modeFor: async () => (mode === 'ssh2' ? { mode: 'ssh2', spec: { host: 'box' } } : { mode: 'system' }),
    spawnFor: (_hostId, _spec, opts) => {
      spawnOpts.push(opts || null)
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
  const rfs = createRemoteFs({ hosts, ssh, spawnImpl: host.spawn, log: { warn: (_area, m) => warned.push(m) }, ...(timers ? { timers } : {}) })
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
    rfs.closeHost(HOST)
    expect(rfs.lanesOpen()).toEqual([])
    rfs.close()
  })
})
