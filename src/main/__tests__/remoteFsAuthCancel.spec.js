// @vitest-environment node
// A cancelled sign-in is not asked again by what runs on its own (the agent
// check, the shim install, the Files panel): each of them used to open a new
// session, so the question came back every 1-2 s. The user's own action
// (Connect, a terminal opened on the host) ends the wait.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRemoteFs, AUTH_CANCEL_COOLDOWN_MS } from '../remoteFs'

const HOST = 'ssh-cancel1'

function setup() {
  let clock = 1_000_000
  let spawned = 0
  let cancelNext = true
  const spawnImpl = () => {
    spawned++
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = Object.assign(new EventEmitter(), { write: () => true, end() {} })
    child.kill = () => {}
    if (cancelNext) {
      setImmediate(() => {
        child.failCode = 'auth-cancelled'
        child.emit('exit', 1)
      })
    }
    return child
  }
  const hosts = {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box' }),
    get: () => ({ id: HOST, label: 'Box' }),
    sharedConnected: () => false,
    paneStarted() {},
    paneConnected() {},
    paneClosing() {},
    paneExited() {}
  }
  const sent = []
  const rfs = createRemoteFs({ hosts, spawnImpl, send: (c, p) => sent.push([c, p]), env: {}, now: () => clock })
  return {
    rfs,
    sent,
    spawned: () => spawned,
    advance: (ms) => (clock += ms),
    noMoreCancel: () => (cancelNext = false)
  }
}

describe('a cancelled sign-in', () => {
  it('is not asked again at once by an automatic call', async () => {
    const s = setup()
    s.rfs.userAllow(HOST)
    const first = await s.rfs.agentTools(HOST, ['claude'])
    expect(first.error).toBeTruthy()
    expect(s.spawned()).toBe(1)
    // The shim install, the agent check, a poll: no new session, no new question.
    for (let i = 0; i < 3; i++) {
      const again = await s.rfs.agentTools(HOST, ['claude'])
      // Said as "not connected" with Connect offered (needsConnect), not as an error to act on.
      expect(again.error).toMatch(/not connected|Connect/i)
    }
    expect(s.sent.some(([c, p]) => c === 'remoteFs:activity' && p.needsConnect === true)).toBe(true)
    expect(s.spawned()).toBe(1)
    s.rfs.close()
  })

  it('may ask again after the cooldown', async () => {
    const s = setup()
    s.rfs.userAllow(HOST)
    await s.rfs.agentTools(HOST, ['claude'])
    s.advance(AUTH_CANCEL_COOLDOWN_MS + 1)
    await s.rfs.agentTools(HOST, ['claude'])
    expect(s.spawned()).toBe(2)
    s.rfs.close()
  })

  it('may ask again as soon as the user acts (a terminal opened on the host, Connect)', async () => {
    const s = setup()
    s.rfs.userAllow(HOST)
    await s.rfs.agentTools(HOST, ['claude'])
    expect(s.spawned()).toBe(1)
    s.rfs.userAllow(HOST)
    await s.rfs.agentTools(HOST, ['claude'])
    expect(s.spawned()).toBe(2)
    const connect = await s.rfs.connect(HOST)
    expect(connect.ok).toBe(false)
    expect(connect.cancelled).toBe(true)
    expect(s.spawned()).toBe(3)
    s.rfs.close()
  })
})
