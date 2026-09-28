import { describe, it, expect, afterEach } from 'vitest'
import net from 'net'
import { createPtyClient } from '../ptyClient'
import { PROTOCOL } from '../ptyProtocol'

// A terminal host that takes the pipe but answers nobody (stuck closing its
// terminals): the app ends it and starts a new one, once (2026-09-28).
const log = { info() {}, warn() {}, error() {} }
let n = 0
const newPipe = () => `\\\\.\\pipe\\tessel-stuck-host-test-${process.pid}-${Date.now()}-${++n}`
let servers = []

// A fake host; close() also cuts its connections (a pipe server only really
// closes once they are gone).
function listen(pipe, onLine) {
  const socks = new Set()
  const server = net.createServer((sock) => {
    socks.add(sock)
    sock.on('close', () => socks.delete(sock))
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (c) => {
      buf += c
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line && onLine) onLine(JSON.parse(line), sock)
      }
    })
    sock.on('error', () => {})
  })
  const host = {
    close: () =>
      new Promise((r) => {
        for (const s of socks) s.destroy()
        server.close(() => r())
      })
  }
  servers.push(host)
  return new Promise((r) => server.listen(pipe, () => r(host)))
}
const healthy = (msg, sock) => {
  if (msg.op === 'hello') sock.write(JSON.stringify({ req: msg.req, ok: true, protocol: PROTOCOL, pid: 42, ptys: [] }) + '\n')
}

afterEach(async () => {
  for (const s of servers) await s.close()
  servers = []
})

describe('a terminal host that no longer answers', () => {
  it('is ended and replaced by a new one, once', async () => {
    const pipe = newPipe()
    const stuck = await listen(pipe, null) // accepts, never answers
    let ended = 0
    const client = createPtyClient({
      pipe,
      token: 't',
      log,
      startHost() {},
      async endStuckHost() {
        ended++
        await stuck.close()
        servers = servers.filter((s) => s !== stuck)
        await listen(pipe, healthy)
        return true
      },
      onData() {},
      onExit() {}
    })
    const hello = await client.ensure()
    expect(ended).toBe(1)
    expect(hello).toMatchObject({ ok: true, pid: 42 })
  }, 20000)

  it('when it cannot be ended, says so instead of retrying forever', async () => {
    const pipe = newPipe()
    await listen(pipe, null)
    let ended = 0
    const client = createPtyClient({
      pipe,
      token: 't',
      log,
      startHost() {},
      async endStuckHost() {
        ended++
        return false
      },
      onData() {},
      onExit() {}
    })
    await expect(client.ensure()).rejects.toThrow(/did not answer hello/)
    expect(ended).toBe(1)
  }, 20000)
})
