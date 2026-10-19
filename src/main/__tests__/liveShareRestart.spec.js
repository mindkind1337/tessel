// @vitest-environment node
// Live Share kept across restarts and reboots (liveShare.js): a share comes
// back by itself until Stop sharing, on its old tunnel when it still runs or
// on a new one; it says its address on the rendezvous relay, and guests find
// it there. Real WebSockets on 127.0.0.1; Cloudflare's tunnel and the relay
// (ntfy.sh) are faked.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import net from 'net'
import { join } from 'path'
import { registerLiveShare } from '../liveShare'
import { decodeInvite, encodeInvite, newSigningKey } from '../liveShare/shareCrypto'
import { rendezvousKeys, newestAddress } from '../liveShare/shareRendezvous'
import { NO_RIGHTS } from '../../shared/liveShareRights'

// The tunnel is the server itself (no cloudflared); its PID 4242 runs while
// `tunnel.alive` (a reboot: it does not).
const tunnel = vi.hoisted(() => ({ alive: true, startError: null, starts: 0 }))
vi.mock('../liveShare/shareTunnel.js', () => ({
  ensureCloudflared: vi.fn(async () => 'cloudflared.exe'),
  startTunnel: vi.fn(async ({ port }) => {
    tunnel.starts++
    if (tunnel.startError) throw tunnel.startError
    return { url: `ws://127.0.0.1:${port}/`, stop: vi.fn(), pid: 4242 }
  }),
  waitReachable: vi.fn(async () => true),
  waitRegistered: vi.fn(async () => true),
  tunnelLogTail: vi.fn(() => ''),
  endLeftoverTunnel: vi.fn(async () => false),
  tunnelState: vi.fn(async (pid) => (pid === 4242 && tunnel.alive ? 'ours' : 'gone')),
  stopTunnelPid: vi.fn(async () => true),
  stopTunnelLater: vi.fn(),
  processState: vi.fn(async () => null)
}))

const dataDirs = []
const newDataDir = () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsr-'))
  dataDirs.push(dir)
  return dir
}
const mains = []
afterEach(() => {
  for (const m of mains.splice(0)) m.api.stopAll()
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  tunnel.alive = true
  tunnel.startError = null
  tunnel.starts = 0
})

// The relay: what each topic holds (like ntfy.sh's cache), shared by every
// Tessel of a test.
function fakeRelay() {
  const topics = new Map()
  return {
    topics,
    publish: vi.fn(async (topic, text) => {
      if (!topics.has(topic)) topics.set(topic, [])
      topics.get(topic).push(text)
      return true
    }),
    latest: vi.fn(async (topic) => [...(topics.get(topic) || [])])
  }
}

const FAST = { portWaitMs: 1500, relaunchDelays: [200], lookupDelays: [100], firstLookups: [0, 100, 200] }

function fakeMain({ dataDir = newDataDir(), resume = false, relay = null, timing = FAST } = {}) {
  const m = {
    handle: {},
    on: {},
    sent: [],
    logs: [],
    ipcMain: { handle: (name, fn) => (m.handle[name] = fn), on: (name, fn) => (m.on[name] = fn) },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: {
      request: vi.fn(async (op, body, _timeout, onReply) => {
        const msg = op === 'attach' ? { ok: true, buffer: `screen of ${body.id}` } : { ok: false }
        onReply?.(msg)
        return msg
      }),
      send: vi.fn()
    },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1)
  }
  m.api = registerLiveShare({
    ipcMain: m.ipcMain,
    send: m.send,
    host: m.host,
    dataDir,
    queueData: () => {},
    sendExit: () => {},
    log: { info: (_tag, line) => m.logs.push(line), warn: (_tag, line) => m.logs.push(line) },
    kill: vi.fn(),
    pidRunning: () => tunnel.alive,
    resume,
    rendezvous: relay,
    timing
  })
  m.dataDir = dataDir
  mains.push(m)
  return m
}

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('timed out')
}
const leaf = (id) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell' })
const showLayout = (m, id = 'ws-1') => m.on['liveShare:layouts'](null, [{ id, layout: { project: 'site', tree: leaf('pane-1-ps'), activeId: 'pane-1-ps' } }])
const hostFile = (m) => join(m.dataDir, 'liveshare-host.json')
const guestFile = (m) => join(m.dataDir, 'liveshare-guest.json')
const codeOf = (status) => status.invites[0].code

async function shareAndJoin(relay) {
  const host = fakeMain({ relay })
  const guest = fakeMain({ relay })
  const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'], invite: { label: 'Team', lifetime: 'never', maxUses: 5 } })
  showLayout(host)
  await guest.handle['liveShare:join'](null, { invite: codeOf(started), name: 'Alex' })
  const ask = await until(() => host.last('liveShare:ask'))
  await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], rights: { ...NO_RIGHTS, type: true } })
  await until(() => guest.last('liveShare:guest')?.state === 'joined' && guest.last('liveShare:guest').panes.length)
  return { host, guest, started }
}

// The share's relay messages for a code: its newest address, checked with
// the share's key.
function relayAddress(relay, code) {
  const c = decodeInvite(code)
  return newestAddress(relay.topics.get(rendezvousKeys(c.secret).topic) || [], { secret: c.secret, hostKey: c.hostKey })
}

describe('a share kept across restarts', () => {
  it('codes are TS2 (the share’s key in them), and the address is said on the relay for each code, never in clear', async () => {
    const relay = fakeRelay()
    const host = fakeMain({ relay })
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const code = codeOf(started)
    expect(code.startsWith('TS2.')).toBe(true)
    const c = decodeInvite(code)
    await until(() => relay.publish.mock.calls.length >= 1)
    const said = relayAddress(relay, code)
    expect(said.url).toBe(new URL(c.url).origin.replace(/^http/, 'ws') + '/')
    for (const [topic, text] of relay.publish.mock.calls) {
      expect(topic).toBe(rendezvousKeys(c.secret).topic)
      expect(text).not.toContain('127.0.0.1')
    }
    // A new invitation's code is said too, at once.
    const made = await host.handle['liveShare:createInvite'](null, { label: 'More' })
    await until(() => relayAddress(relay, made.invite.code))
    for (const line of host.logs) expect(line).not.toContain(c.secret.toString('base64url'))
  })

  it('quitting Tessel only pauses the share: the next Tessel takes its tunnel back (same codes), the guest comes back without a question', async () => {
    const relay = fakeRelay()
    const { host, guest, started } = await shareAndJoin(relay)
    host.api.stopAll()
    await until(() => guest.last('liveShare:guest').state === 'reconnecting')
    expect(fs.existsSync(hostFile(host))).toBe(true)
    // (The tunnel still runs: Windows could not end it in time.)
    const next = fakeMain({ dataDir: host.dataDir, resume: true, relay })
    expect(await next.api.resumed).toEqual([true, false])
    const back = next.last('liveShare:host')
    expect(back.state).toBe('sharing')
    expect(codeOf(back)).toBe(codeOf(started))
    showLayout(next)
    await until(() => next.last('liveShare:host').guests.some((g) => g.name === 'Alex' && g.state === 'joined'), 15000)
    expect(next.events('liveShare:ask')).toEqual([])
  }, 20000)

  it('a reboot (the tunnel gone): a new tunnel, the same invitations, secrets, key and people; the guest finds the new address on the relay', async () => {
    const relay = fakeRelay()
    const { host, guest, started } = await shareAndJoin(relay)
    const before = started.invites[0]
    host.api.stopAll()
    tunnel.alive = false
    await until(() => guest.last('liveShare:guest').state === 'reconnecting')
    const next = fakeMain({ dataDir: host.dataDir, resume: true, relay })
    expect(await next.api.resumed).toEqual([true, false])
    const back = next.last('liveShare:host')
    expect(back.state).toBe('sharing')
    expect(back.invites).toHaveLength(1)
    expect(back.invites[0]).toMatchObject({ id: before.id, label: 'Team', lifetime: 'never', maxUses: 5, uses: 1, expiresAt: null })
    const oldCode = decodeInvite(before.code)
    const newCode = decodeInvite(back.invites[0].code)
    expect(newCode.secret.equals(oldCode.secret)).toBe(true)
    expect(newCode.hostKey.equals(oldCode.hostKey)).toBe(true)
    expect(newCode.url).not.toBe(oldCode.url)
    // The new address on the relay, signed with the same key.
    await until(() => relayAddress(relay, before.code)?.url === new URL(newCode.url).origin.replace(/^http/, 'ws') + '/')
    showLayout(next)
    // The guest: its old address dead, the relay asked, back in at the new one.
    const rejoined = await until(() => guest.events('liveShare:guest').find((s, i, all) => s.state === 'joined' && all.slice(0, i).some((x) => x.state === 'reconnecting') && s.panes.length), 15000)
    expect(rejoined.rights).toEqual({ ...NO_RIGHTS, type: true })
    expect(next.events('liveShare:ask')).toEqual([])
    expect(guest.logs.some((l) => /new address/.test(l))).toBe(true)
    // Its saved session has the new address (a restart of the guest goes there).
    expect(JSON.parse(fs.readFileSync(guestFile(guest), 'utf8')).url).toBe(newCode.url)
  }, 25000)

  it('a first join with a code whose address is dead finds the share on the relay', async () => {
    const relay = fakeRelay()
    const host = fakeMain({ relay })
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'], invite: { lifetime: 'day' } })
    showLayout(host)
    const oldCode = codeOf(started)
    host.api.stopAll()
    tunnel.alive = false
    const next = fakeMain({ dataDir: host.dataDir, resume: true, relay })
    await next.api.resumed
    expect(decodeInvite(codeOf(next.last('liveShare:host'))).url).not.toBe(decodeInvite(oldCode).url)
    await until(() => relay.publish.mock.calls.length >= 2)
    showLayout(next)
    const late = fakeMain({ relay })
    await late.handle['liveShare:join'](null, { invite: oldCode, name: 'Late' })
    await until(() => next.events('liveShare:ask').some((a) => a.name === 'Late'), 10000)
    // Without the relay, the same code just fails.
    const lone = fakeMain()
    await lone.handle['liveShare:join'](null, { invite: oldCode, name: 'Lone' })
    await until(() => lone.last('liveShare:guest')?.state === 'ended')
    expect(next.events('liveShare:ask').some((a) => a.name === 'Lone')).toBe(false)
  }, 20000)

  it('a TS2 code whose key is not the share’s: the host’s welcome is refused', async () => {
    const host = fakeMain()
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const c = decodeInvite(codeOf(started))
    const wrong = encodeInvite({ url: c.url, secret: c.secret, hostKey: newSigningKey().publicRaw })
    const guest = fakeMain()
    await guest.handle['liveShare:join'](null, { invite: wrong, name: 'Alex' })
    // (The welcome, signed, comes once the host says yes.)
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'] })
    await until(() => guest.last('liveShare:guest')?.state === 'ended')
    expect(guest.last('liveShare:guest').reason).toBe('host-unverified')
    expect(guest.events('liveShare:guest').some((s) => s.state === 'joined')).toBe(false)
  })

  it('its port still taken: waited for, then taken back once free (same codes)', async () => {
    const host = fakeMain()
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const port = Number(new URL(decodeInvite(codeOf(started)).url).port)
    host.api.stopAll()
    // Another program holds the port for a while.
    const busy = net.createServer()
    await new Promise((r) => busy.listen(port, '127.0.0.1', r))
    setTimeout(() => busy.close(), 600)
    const next = fakeMain({ dataDir: host.dataDir, resume: true })
    expect(await next.api.resumed).toEqual([true, false])
    expect(next.last('liveShare:host').state).toBe('sharing')
    expect(codeOf(next.last('liveShare:host'))).toBe(codeOf(started))
    expect(tunnel.starts).toBe(1)
  })

  it('its port taken for good: a new port and a new tunnel (the old one ended), the same invitations', async () => {
    const host = fakeMain()
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const port = Number(new URL(decodeInvite(codeOf(started)).url).port)
    host.api.stopAll()
    const busy = net.createServer()
    await new Promise((r) => busy.listen(port, '127.0.0.1', r))
    try {
      const next = fakeMain({ dataDir: host.dataDir, resume: true })
      expect(await next.api.resumed).toEqual([true, false])
      const back = next.last('liveShare:host')
      expect(back.state).toBe('sharing')
      expect(back.invites[0].id).toBe(started.invites[0].id)
      expect(Number(new URL(decodeInvite(codeOf(back)).url).port)).not.toBe(port)
      const { stopTunnelPid } = await import('../liveShare/shareTunnel.js')
      expect(stopTunnelPid).toHaveBeenCalledWith(host.dataDir, 4242, expect.anything())
    } finally {
      busy.close()
    }
  })

  it('a tunnel that can’t start after a reboot (no network yet): the share is kept and tried again until it starts', async () => {
    const host = fakeMain()
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    host.api.stopAll()
    tunnel.alive = false
    tunnel.startError = new Error('no network')
    const next = fakeMain({ dataDir: host.dataDir, resume: true })
    expect(await next.api.resumed).toEqual([true, false])
    const waiting = next.last('liveShare:host')
    expect(waiting).toMatchObject({ state: 'starting', restarting: true })
    expect(waiting.retry.error).toContain('no network')
    expect(fs.existsSync(hostFile(host))).toBe(true)
    tunnel.startError = null
    await until(() => next.last('liveShare:host').state === 'sharing')
    expect(next.last('liveShare:host').invites[0].id).toBe(started.invites[0].id)
    expect(next.last('liveShare:host').retry).toBe(null)
  })

  it('a tunnel that stops while sharing: a new one starts, the share goes on', async () => {
    const relay = fakeRelay()
    const host = fakeMain({ relay })
    const started = await host.handle['liveShare:start'](null, { name: 'Ada', projects: ['ws-1'] })
    const { startTunnel } = await import('../liveShare/shareTunnel.js')
    const onExit = startTunnel.mock.calls.at(-1)[0].onExit
    const sharedBefore = relay.publish.mock.calls.length
    onExit(1)
    await until(() => tunnel.starts === 2 && host.last('liveShare:host').state === 'sharing')
    expect(host.last('liveShare:host').invites[0].id).toBe(started.invites[0].id)
    await until(() => relay.publish.mock.calls.length > sharedBefore)
  })

  it('Stop sharing ends it for good: nothing comes back at the next start, guests are told it ended', async () => {
    const relay = fakeRelay()
    const { host, guest } = await shareAndJoin(relay)
    await host.handle['liveShare:stop']()
    await until(() => guest.last('liveShare:guest').state === 'ended')
    expect(guest.last('liveShare:guest').reason).toBe('stopped')
    expect(fs.existsSync(hostFile(host))).toBe(false)
    expect(fs.existsSync(guestFile(guest))).toBe(false)
    const next = fakeMain({ dataDir: host.dataDir, resume: true, relay })
    expect(await next.api.resumed).toEqual([false, false])
    expect((await next.handle['liveShare:state']()).host.state).toBe('off')
  })

  it('a person the host removed stays out after a restart on a new tunnel (its reconnect refused)', async () => {
    const relay = fakeRelay()
    const { host, guest } = await shareAndJoin(relay)
    // The guest's Tessel quits: offline on the host's side, its session kept.
    guest.api.stopAll()
    expect(fs.existsSync(guestFile(guest))).toBe(true)
    const offline = await until(() => host.last('liveShare:host').offline?.find((g) => g.name === 'Alex'))
    expect(await host.handle['liveShare:removeGuest'](null, { guestId: offline.id })).toEqual({ ok: true })
    // The host reboots: a new tunnel.
    host.api.stopAll()
    tunnel.alive = false
    const next = fakeMain({ dataDir: host.dataDir, resume: true, relay })
    await next.api.resumed
    expect(next.last('liveShare:host').offline).toEqual([])
    // The guest's Tessel starts again: it finds the new address, and is refused.
    const again = fakeMain({ dataDir: guest.dataDir, resume: true, relay })
    await again.api.resumed
    await until(() => again.last('liveShare:guest')?.state === 'ended', 15000)
    expect(again.last('liveShare:guest').reason).toBe('rejoin-refused')
    expect(next.events('liveShare:ask')).toEqual([])
  }, 20000)

  it('the guest’s Tessel quits and starts again: it joins the session again by itself, without a question', async () => {
    const relay = fakeRelay()
    const { host, guest } = await shareAndJoin(relay)
    guest.api.stopAll()
    await until(() => host.last('liveShare:host').guests.length === 0)
    const next = fakeMain({ dataDir: guest.dataDir, resume: true, relay })
    expect(await next.api.resumed).toEqual([false, true])
    await until(() => next.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    expect(host.events('liveShare:ask')).toHaveLength(1)
  })
})
