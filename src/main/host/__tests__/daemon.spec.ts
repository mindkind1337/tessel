// @vitest-environment node
// tessel-host put on a host and joined from the app: the version check, the
// install sequence (upload, digest, activate) with its abort on a mismatch,
// a machine it has no program for, a host not signed in, and the connection
// over a shell channel.
import { describe, it, expect } from 'vitest'
import { type BundledHost } from '../bundled'
import { type DaemonDeps, type RunResult, type ShellChannel, createHostDaemons, pipeFromShellChannel, RETRY_MS } from '../daemon'
import { sha256Hex } from '../install'
import { pipePair } from '../pipe'
import { FakeHost } from './fakeHost'

const PROGRAM = Buffer.from('#!/bin/sh\necho tessel-host\n')
const SHA = sha256Hex(PROGRAM)
const bundle = (): BundledHost => ({
  version: '0.1.1',
  dir: '/bundle',
  manifest: { version: '0.1.1', artifacts: [{ arch: 'x86_64', target: 'x86_64-unknown-linux-musl', file: 'tessel-host-x86_64-unknown-linux-musl', size: PROGRAM.length, sha256: SHA }] },
  artifact: (arch) => (arch === 'x86_64' ? { arch, target: 'x86_64-unknown-linux-musl', file: 'tessel-host-x86_64-unknown-linux-musl', size: PROGRAM.length, sha256: SHA } : null),
  read: (arch) => (arch === 'x86_64' ? PROGRAM : null)
})
const VERSION_LINE = '{"name":"tessel-host","version":"0.1.1","arch":"x86_64","protocol":[1]}\n'
const ok = (out: string): RunResult => ({ rc: 0, out: Buffer.from(out), err: '' })
const fail = (rc: number): RunResult => ({ rc, out: Buffer.alloc(0), err: '' })

/** A fake /bin/sh exec channel: the connect line starts a fake daemon on the channel. */
function shellChannel(epoch: string): { channel: ShellChannel; hosts: FakeHost[] } {
  const hosts: FakeHost[] = []
  const [daemonEnd, hostEnd] = pipePair()
  const listeners: Array<(chunk: Buffer) => void> = []
  const exits: Array<(code: number | null, signal: string | null) => void> = []
  let started = false
  let killed = false
  daemonEnd.onData((chunk) => listeners.forEach((l) => l(chunk)))
  daemonEnd.onEnd(() => exits.forEach((l) => l(0, null)))
  const channel: ShellChannel = {
    stdout: { on: (_e, l) => listeners.push(l) },
    stdin: {
      write(data) {
        if (!started) {
          const line = String(data)
          if (!line.endsWith(' connect --stdio\n') || !line.startsWith('exec "$HOME/.tessel-server/host/bin/tessel-host-0.1.1-x86_64"')) throw new Error(`bad connect line ${line}`)
          started = true
          hosts.push(new FakeHost(hostEnd, epoch, () => ({ error: 'unsupported_kind' })))
          return true
        }
        daemonEnd.write(Buffer.isBuffer(data) ? data : Buffer.from(data))
        return true
      },
      end() {}
    },
    on: (_e, l) => exits.push(l),
    kill() {
      killed = true
      daemonEnd.close()
    }
  }
  return { channel, hosts, get killed() { return killed } } as never
}

function deps(script: (command: string, upload?: Buffer) => RunResult | Promise<RunResult>, extra: Partial<DaemonDeps> = {}): { deps: DaemonDeps; ran: Array<{ command: string; upload?: Buffer }>; channels: ReturnType<typeof shellChannel>[] } {
  const ran: Array<{ command: string; upload?: Buffer }> = []
  const channels: ReturnType<typeof shellChannel>[] = []
  return {
    ran,
    channels,
    deps: {
      bundle: bundle(),
      run: async (_hostId, command, { upload }) => {
        ran.push(upload ? { command, upload } : { command })
        return script(command, upload)
      },
      channel: async () => {
        const c = shellChannel('a'.repeat(32))
        channels.push(c)
        return c.channel
      },
      connected: () => true,
      ...extra
    }
  }
}

const VERSION_CMD = '"$HOME/.tessel-server/host/bin/tessel-host-0.1.1-x86_64" version'

describe('host daemons', () => {
  it('a host that has this release: the version checked, then connected over a shell channel (no install)', async () => {
    const d = deps((command) => (command === 'uname -m' ? ok('x86_64\n') : command === VERSION_CMD ? ok(VERSION_LINE) : fail(127)))
    const daemons = createHostDaemons(d.deps)
    const status = await daemons.ensure('h1')
    if (!status.ok) throw new Error(`not ok: ${status.reason} ${status.detail ?? ''}`)
    expect(status.source).toBe('had')
    expect(d.ran.map((r) => r.command)).toEqual(['uname -m', VERSION_CMD])
    expect(d.channels[0]!.hosts[0]!.seen.map((s) => s.kind)).toEqual(['hello', 'host.info'])
    expect(d.channels[0]!.hosts[0]!.seen[0]!.body).toMatchObject({ capabilities: ['tree', 'git'] })
    expect(daemons.client('h1')).toBe(status.client)
    expect(daemons.status('h1')).toEqual({ daemon: true })
    // Asked again: the same client, nothing run.
    expect(await daemons.ensure('h1')).toMatchObject({ ok: true, client: status.client })
    expect(d.ran).toHaveLength(2)
    daemons.close('h1')
    expect(daemons.client('h1')).toBeNull()
    expect(status.client.closed).toBe(true)
  })

  it('a host without it: upload with the program on stdin, digest compared with the manifest, activate, then connect', async () => {
    let installed = false
    const d = deps((command, upload) => {
      if (command === 'uname -m') return ok('x86_64\n')
      if (command === VERSION_CMD) return installed ? ok(VERSION_LINE) : fail(127)
      if (command.startsWith('umask 077 && ') && command.includes('cat > "$HOME/.tessel-server/host/bin/.tessel-host-0.1.1-x86_64.')) {
        expect(upload).toEqual(PROGRAM)
        return ok('')
      }
      if (command.startsWith('if command -v sha256sum')) return ok(`${SHA}  /home/u/.tessel-server/host/bin/.part\n`)
      if (command.startsWith('chmod 700 ')) {
        installed = true
        return ok(VERSION_LINE)
      }
      return fail(1)
    })
    const daemons = createHostDaemons(d.deps)
    const status = await daemons.ensure('h2')
    if (!status.ok) throw new Error(`not ok: ${status.reason} ${status.detail ?? ''}`)
    expect(status.source).toBe('installed')
    const kinds = d.ran.map((r) => r.command.split(' ')[0])
    expect(kinds).toEqual(['uname', '"$HOME/.tessel-server/host/bin/tessel-host-0.1.1-x86_64"', 'umask', 'if', 'chmod'])
    // One nonce for the whole install, 16 hex digits.
    const part = /\.tessel-host-0\.1\.1-x86_64\.([0-9a-f]{16})\.part/
    const nonces = new Set(d.ran.map((r) => part.exec(r.command)?.[1]).filter(Boolean))
    expect(nonces.size).toBe(1)
    daemons.close('h2')
  })

  it('a digest that differs from the manifest: the part is removed, nothing activated, tried again only after a while', async () => {
    let t = 1_000_000
    const d = deps(
      (command) => {
        if (command === 'uname -m') return ok('x86_64\n')
        if (command === VERSION_CMD) return fail(127)
        if (command.startsWith('umask 077 && ')) return ok('')
        if (command.startsWith('if command -v sha256sum')) return ok(`${'0'.repeat(64)}  part\n`)
        if (command.startsWith('rm -f ')) return ok('')
        throw new Error(`unexpected ${command}`)
      },
      { now: () => t }
    )
    const daemons = createHostDaemons(d.deps)
    expect(await daemons.ensure('h3')).toEqual({ ok: false, reason: 'checksum' })
    await new Promise((r) => setTimeout(r, 0))
    expect(d.ran.some((r) => r.command.startsWith('rm -f '))).toBe(true)
    expect(d.ran.some((r) => r.command.startsWith('chmod 700'))).toBe(false)
    expect(daemons.status('h3')).toEqual({ daemon: false, reason: 'checksum' })
    const runs = d.ran.length
    expect(await daemons.ensure('h3')).toEqual({ ok: false, reason: 'checksum' })
    expect(d.ran).toHaveLength(runs)
    t += RETRY_MS + 1
    expect(await daemons.ensure('h3')).toEqual({ ok: false, reason: 'checksum' })
    expect(d.ran.length).toBeGreaterThan(runs)
  })

  it('another kind of machine: unsupported, settled for the run; no bundle: no-bundle; not signed in: nothing run, asked again later', async () => {
    const arm = deps((command) => (command === 'uname -m' ? ok('armv7l\n') : fail(1)))
    const daemons = createHostDaemons(arm.deps)
    expect(await daemons.ensure('h4')).toEqual({ ok: false, reason: 'unsupported', detail: 'armv7l' })
    expect(await daemons.ensure('h4')).toEqual({ ok: false, reason: 'unsupported', detail: 'armv7l' })
    expect(arm.ran).toHaveLength(1)
    const none = createHostDaemons(deps(() => fail(1), { bundle: null }).deps)
    expect(await none.ensure('h5')).toEqual({ ok: false, reason: 'no-bundle' })
    let connected = false
    const off = deps((command) => (command === 'uname -m' ? ok('x86_64\n') : command === VERSION_CMD ? ok(VERSION_LINE) : fail(1)), { connected: () => connected })
    const later = createHostDaemons(off.deps)
    expect(await later.ensure('h6')).toEqual({ ok: false, reason: 'not-connected' })
    expect(off.ran).toHaveLength(0)
    connected = true
    expect((await later.ensure('h6')).ok).toBe(true)
    later.closeAll()
  })

  it('the host closed during the install: the work gives up at its next step, nothing more reaches the host, no client', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let connected = true
    const d = deps(
      async (command) => {
        if (command === 'uname -m') return ok('x86_64\n')
        if (command === VERSION_CMD) return fail(127)
        if (command.startsWith('umask 077 && ')) {
          await gate
          return ok('')
        }
        throw new Error(`unexpected ${command}`)
      },
      { connected: () => connected }
    )
    const daemons = createHostDaemons(d.deps)
    const pending = daemons.ensure('h8')
    await new Promise((r) => setTimeout(r, 20))
    expect(d.ran.map((r) => r.command.split(' ')[0])).toEqual(['uname', '"$HOME/.tessel-server/host/bin/tessel-host-0.1.1-x86_64"', 'umask'])
    daemons.close('h8')
    connected = false
    release()
    expect(await pending).toEqual({ ok: false, reason: 'not-connected' })
    expect(d.ran).toHaveLength(3)
    expect(daemons.client('h8')).toBeNull()
    // Not held as a failure: connected again, it starts over.
    connected = true
    const again = daemons.ensure('h8')
    await new Promise((r) => setTimeout(r, 20))
    expect(d.ran.length).toBeGreaterThan(3)
    daemons.close('h8')
    await again
  })

  it('the daemon not answering its hello in time: connect-failed, the channel closed', async () => {
    const d = deps((command) => (command === 'uname -m' ? ok('x86_64\n') : command === VERSION_CMD ? ok(VERSION_LINE) : fail(1)), {
      channel: async () => {
        let killed = false
        const channel: ShellChannel = {
          stdout: { on: () => {} },
          stdin: { write: () => true, end: () => {} },
          on: () => {},
          kill: () => {
            killed = true
          }
        }
        setTimeout(() => expect(killed).toBe(true), 400)
        return channel
      }
    })
    const daemons = createHostDaemons(d.deps)
    // (The client's connect timeout is 20 s: a dead channel is left to it in
    // the real app; here the hello never comes and the channel is a stub.)
    const pending = daemons.ensure('h7')
    const status = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 300))])
    expect(status).toBeNull()
    daemons.close('h7')
  })

  it('pipeFromShellChannel: the connect line first, then bytes both ways, closed with the channel', () => {
    const written: string[] = []
    const out: Array<(chunk: Buffer) => void> = []
    let killed = false
    const channel: ShellChannel = {
      stdout: { on: (_e, l) => out.push(l) },
      stdin: { write: (d) => (written.push(String(d)), true), end: () => {} },
      on: () => {},
      kill: () => (killed = true)
    }
    const pipe = pipeFromShellChannel(channel, '"$HOME/x" connect --stdio')
    expect(written).toEqual(['exec "$HOME/x" connect --stdio\n'])
    const got: Buffer[] = []
    pipe.onData((c) => got.push(c))
    out[0]!(Buffer.from('hi'))
    expect(got.map(String)).toEqual(['hi'])
    pipe.write(Buffer.from('yo'))
    expect(written[1]).toBe('yo')
    let ended = false
    pipe.onEnd(() => (ended = true))
    pipe.close()
    expect(killed).toBe(true)
    expect(ended).toBe(true)
    expect(() => pipe.write(Buffer.from('x'))).toThrow()
  })
})
