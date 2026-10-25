// @vitest-environment node
// A remote Files lane's channel (remoteFs.js LANES, ssh-exec onlyLive): only
// on a connection that is up, never a new connection, so never a question
// (a guest's request can never make the host's computer ask a password).
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createSshManager } from '../ssh/sshManager'
import { startSshServer } from './fixtures/sshServer'

const PASSWORD = 'lane-pass'
let dir = null
let srv = null
afterEach(async () => {
  if (srv) await srv.close()
  srv = null
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})
const spec = (port) => ({ host: '127.0.0.1', port, username: 'me', identityFiles: [], knownHostsFiles: [join(dir, 'known_hosts')], strictHostKeyChecking: 'ask' })

describe('an exec channel on a live connection only (onlyLive)', () => {
  it('no connection: refused, nothing asked, nothing connected; once signed in: opened', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-live-'))
    srv = await startSshServer({ auth: { password: PASSWORD, methods: ['password'] } })
    const asked = []
    const m = createSshManager({ ask: async (_h, p) => (asked.push(p.kind), p.kind === 'hostkey' ? 'yes' : PASSWORD) })
    await expect(m.open('h', spec(srv.port), 'exec', { command: 'exec /bin/sh', onlyLive: true })).rejects.toMatchObject({ code: 'channel' })
    expect(asked).toEqual([])
    expect(srv.events.connections).toBe(0)
    await m.connectHost('h', spec(srv.port))
    const ch = await m.open('h', spec(srv.port), 'exec', { command: 'exec /bin/sh', onlyLive: true })
    expect(ch.stream).toBeTruthy()
    ch.stream.close()
    m.closeAll()
  }, 30000)

  it('a connection full (MaxSessions): refused, never a second connection', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-live-'))
    // Its channels stay open (like the Files session's shell).
    srv = await startSshServer({ auth: { password: PASSWORD, methods: ['password'] }, maxSessions: 1, onExec: () => {} })
    const m = createSshManager({ ask: async (_h, p) => (p.kind === 'hostkey' ? 'yes' : PASSWORD) })
    const first = await m.open('h', spec(srv.port), 'exec', { command: 'exec /bin/sh' })
    await expect(m.open('h', spec(srv.port), 'exec', { command: 'exec /bin/sh', onlyLive: true })).rejects.toMatchObject({ code: 'channel' })
    expect(srv.events.connections).toBe(1)
    // Without it (the host's own session): a spare connection, as before.
    const spare = await m.open('h', spec(srv.port), 'exec', { command: 'exec /bin/sh' })
    expect(srv.events.connections).toBe(2)
    first.stream.close()
    spare.stream.close()
    m.closeAll()
  }, 30000)
})
