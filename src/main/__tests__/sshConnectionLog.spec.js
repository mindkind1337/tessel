// @vitest-environment node
// What a lost SSH connection leaves in the log: one line with what ended it, the
// local port to match against the server's own log, the connection's age, the
// time since a byte last moved, the keepalive in force and how late this process's
// timers were; and whether the server answers right after. No secret in any of it.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createSshManager } from '../ssh/sshManager'

const fakeClient = (localPort = 51234) => {
  const c = new EventEmitter()
  c._sock = { bytesRead: 0, bytesWritten: 0, localPort }
  c.end = () => queueMicrotask(() => c.emit('close', false))
  return c
}
const setup = (client) => {
  const lines = []
  const queued = []
  const now = { t: 1_000_000 }
  const m = createSshManager({
    ask: async () => null,
    connect: async () => client,
    log: (level, text) => lines.push([level, text]),
    timers: { setTimeout: (fn) => (queued.push(fn), {}), clearTimeout: () => {} },
    now: () => now.t
  })
  return { m, lines, now }
}
const spec = { host: '127.0.0.1', port: 1, username: 'u' } // a closed local port: the probe fails at once
const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

describe('the connection log', () => {
  it('says how it opened: the local port and the keepalive in force', async () => {
    const { m, lines } = setup(fakeClient(40001))
    await m.connectHost('h1', spec)
    const open = lines.find(([, t]) => t.startsWith('ssh connection opened'))
    expect(open[1]).toContain('localPort=40001')
    expect(open[1]).toContain('keepalive=15s x12')
    expect(open[1]).toContain('account=h1')
  })

  it('a link that drops: the event that ended it, the port, the times, and a probe of the server', async () => {
    const client = fakeClient(40002)
    const { m, lines, now } = setup(client)
    await m.connectHost('h1', spec)
    client._sock.bytesRead = 5000
    now.t += 400_000
    const err = new Error('Keepalive timeout\nsecond line')
    err.level = 'client-timeout'
    client.emit('error', err)
    client.emit('close', true)
    const ended = lines.find(([, t]) => t.startsWith('ssh connection ended'))
    expect(ended[0]).toBe('warn')
    expect(ended[1]).toContain('localPort=40002')
    expect(ended[1]).toContain('by=link')
    expect(ended[1]).toContain('error(client-timeout/client-timeout: Keepalive timeout second line)')
    expect(ended[1]).toContain('close(hadError)')
    expect(ended[1]).toContain('age=400s')
    expect(ended[1]).toContain('sinceLastRx=0s sinceLastTx=400s')
    expect(ended[1]).toContain('keepalive=15s x12')
    expect(ended[1]).toMatch(/loopLagMax60s=\d+ms/)
    expect(ended[1].includes('\n')).toBe(false)
    await waitFor(() => lines.some(([, t]) => t.startsWith('ssh probe now')))
    const probe = lines.find(([, t]) => t.startsWith('ssh probe now'))
    expect(probe[1]).toMatch(/failed \(ECONNREFUSED\)|no answer/)
    expect(probe[1]).toContain('localPort=40002')
  })

  it('a close Tessel asked for says so and does not probe the server', async () => {
    const client = fakeClient(40003)
    const { m, lines } = setup(client)
    await m.connectHost('h1', spec)
    m.disconnect('h1')
    await new Promise((r) => setTimeout(r, 50))
    const ended = lines.find(([, t]) => t.startsWith('ssh connection ended'))
    expect(ended[0]).toBe('info')
    expect(ended[1]).toContain('by=tessel(disconnect)')
    expect(lines.some(([, t]) => t.startsWith('ssh probe'))).toBe(false)
  })

  it('a client without a socket (a fake, or ssh2 changing) still logs, with unknowns', async () => {
    const client = new EventEmitter()
    client.end = () => {}
    const { m, lines } = setup(client)
    await m.connectHost('h1', spec)
    client.emit('close', false)
    const ended = lines.find(([, t]) => t.startsWith('ssh connection ended'))
    expect(ended[1]).toContain('localPort=?')
    expect(ended[1]).toContain('bytesRx=?')
  })
})
