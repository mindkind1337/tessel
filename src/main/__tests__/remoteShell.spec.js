import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { sq, remotePathArg, rawArg, requestScript, sessionArgs, prelude, createRemoteSession, RC } from '../remoteShell'
import { gitSh, fakeSshLaunch, fakeSpawn } from './fixtures/fakeSsh'

describe('quoting', () => {
  it('single-quotes and escapes quotes', () => {
    expect(sq("a b")).toBe("'a b'")
    expect(sq("it's")).toBe(`'it'\\''s'`)
    expect(sq('$(rm -rf ~) `x` "y" ;&|')).toBe(`'$(rm -rf ~) \`x\` "y" ;&|'`)
  })
  it('refuses NUL and control characters (a request is one line)', () => {
    expect(() => sq('a\nb')).toThrow()
    expect(() => sq('a\u0000b')).toThrow()
    expect(() => sq('a\rb')).toThrow()
    expect(() => sq('a\u007fb')).toThrow()
  })
  it('keeps ~ outside the quotes only as $HOME', () => {
    expect(remotePathArg('~')).toBe('"$HOME"')
    expect(remotePathArg("~/it's")).toBe(`"$HOME"'/it'\\''s'`)
    expect(remotePathArg('/srv/a b')).toBe("'/srv/a b'")
    expect(() => remotePathArg('rel/path')).toThrow()
    expect(() => remotePathArg('~user/x')).toThrow()
  })
  it('a pre-quoted argument cannot be forged by a plain object (IPC data)', () => {
    expect(requestScript(1, 10, '__t_ls', [rawArg('"$HOME"'), { raw: '$(reboot)' }])).toBe(`__t_q 1 10 30 __t_ls "$HOME" '[object Object]'\n`)
  })
  it('builds one request line from a known function only', () => {
    expect(requestScript(3, 10, '__t_ls', ['/a', "b'c", '5'])).toBe(`__t_q 3 10 30 __t_ls '/a' 'b'\\''c' '5'\n`)
    expect(() => requestScript(1, 10, 'rm', ['-rf', '/'])).toThrow()
    expect(() => requestScript(1, 10, '__t_ls; rm -rf /', [])).toThrow()
  })
  it('sends contents as base64 lines, never in an argument', () => {
    const s = requestScript(1, 10, '__t_write', ['/a', '/a/f', '', ''], Buffer.from("'; rm -rf / #\n"))
    const lines = s.trim().split('\n')
    expect(lines[0]).toBe('__t_up')
    expect(lines[1]).toMatch(/^printf '%s\\n' '[A-Za-z0-9+/=]+' >>"\$__T_D\/u"$/)
    expect(lines[2]).toBe(`__t_q 1 10 30 __t_write '/a' '/a/f' '' ''`)
    expect(s).not.toContain('rm -rf')
  })
  it('ssh argv: no terminal, no forwardings, the host argv, one fixed remote command', () => {
    const a = sessionArgs(['-p', '2222', 'box'])
    expect(a[0]).toBe('-T')
    expect(a).toContain('ClearAllForwardings=yes')
    expect(a).toContain('ForwardAgent=no')
    expect(a).toContain('PermitLocalCommand=no')
    expect(a).not.toContain('StrictHostKeyChecking=no')
    expect(a.slice(-3)).toEqual(['2222', 'box', 'exec /bin/sh'])
    expect(sessionArgs(['box'], { batch: true })).toContain('BatchMode=yes')
  })
  it('the prelude needs a proper nonce', () => {
    expect(() => prelude('x; rm')).toThrow()
    expect(prelude('0'.repeat(32))).toContain('@@R %s ok')
  })
})

// A fake child process: what the session writes, and what it answers.
function fakeChild() {
  const child = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.written = []
  child.stdin.write = (s) => child.stdin.written.push(String(s))
  child.stdin.end = () => {}
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => child.emit('exit', null)
  return child
}
const NONCE = 'a'.repeat(32)
const b64 = (s) => Buffer.from(s).toString('base64')

describe('session protocol (mocked transport)', () => {
  it('ignores junk before the ready line, then frames answers by nonce and id', async () => {
    const child = fakeChild()
    const s = createRemoteSession({ file: 'ssh', args: [], spawnImpl: () => child, randomHex: () => NONCE })
    const started = s.start()
    child.stdout.emit('data', Buffer.from('Welcome to box\n@@T fake 1 0\n'))
    child.stdout.emit('data', Buffer.from(`\n@@R ${NONCE} ok\n`))
    await started
    const p = s.run('__t_nop', [])
    expect(child.stdin.written.pop()).toBe('__t_q 1 4194304 30 __t_nop\n')
    child.stdout.emit('data', Buffer.from(`\n@@T ${NONCE} 1 0\n${b64('hello @@T ' + NONCE + ' 1 z')}\n\n@@T ${NONCE} 1 e\n${b64('warn')}\n@@T ${NONCE} 1 z\n`))
    const r = await p
    expect(r.rc).toBe(0)
    expect(r.out.toString()).toBe(`hello @@T ${NONCE} 1 z`)
    expect(r.err).toBe('warn')
  })

  it('a request past its time ends the session; the rest fail too', async () => {
    const child = fakeChild()
    const timers = { setTimeout: (fn, ms) => (ms === 15005 ? setTimeout(fn, 1) : 0), clearTimeout: (t) => t && clearTimeout(t) }
    const s = createRemoteSession({ file: 'ssh', args: [], spawnImpl: () => child, randomHex: () => NONCE, timers })
    const started = s.start()
    child.stdout.emit('data', Buffer.from(`@@R ${NONCE} ok\n`))
    await started
    const a = s.run('__t_nop', [], { timeoutMs: 5 })
    const b = s.run('__t_nop', [])
    await expect(a).rejects.toMatchObject({ code: 'timeout' })
    await expect(b).rejects.toMatchObject({ code: 'timeout' })
    expect(s.state).toBe('closed')
  })

  it('ssh failing before the ready line says so with its message', async () => {
    const child = fakeChild()
    const s = createRemoteSession({ file: 'ssh', args: [], spawnImpl: () => child, randomHex: () => NONCE })
    const started = s.start()
    child.stderr.emit('data', Buffer.from('Permission denied (publickey).\n'))
    child.emit('exit', 255)
    await expect(started).rejects.toMatchObject({ code: 'connect', exitCode: 255, stderr: 'Permission denied (publickey).' })
  })

  it('an answer larger than the limit ends the session', async () => {
    const child = fakeChild()
    const s = createRemoteSession({ file: 'ssh', args: [], spawnImpl: () => child, randomHex: () => NONCE, maxResponse: 100 })
    const started = s.start()
    child.stdout.emit('data', Buffer.from(`@@R ${NONCE} ok\n`))
    await started
    const p = s.run('__t_nop', [])
    child.stdout.emit('data', Buffer.from(`@@T ${NONCE} 1 0\n` + 'A'.repeat(200)))
    await expect(p).rejects.toMatchObject({ code: 'too-large' })
  })

  it('cancel ends the session and every request waiting', async () => {
    const child = fakeChild()
    const s = createRemoteSession({ file: 'ssh', args: [], spawnImpl: () => child, randomHex: () => NONCE })
    const started = s.start()
    s.close('cancelled')
    await expect(started).rejects.toMatchObject({ code: 'cancelled' })
    await expect(s.run('__t_nop')).rejects.toMatchObject({ code: 'cancelled' })
  })
})

// The real prelude, run by Git for Windows' sh through a fake ssh.exe.
describe.skipIf(!gitSh())('session against a POSIX shell (fake ssh)', () => {
  let dir
  let session
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  const posix = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')

  it('a command past its time is stopped on the host (exit 124) and the shell goes on', async () => {
    // __t_q driven directly (a test-only command): `sleep 20` with a 1 s limit.
    const nonce = 'b'.repeat(32)
    const child = fakeSpawn({})('ssh.exe', ['exec /bin/sh'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    const seen = new Promise((resolve) => {
      child.stdout.on('data', (d) => {
        out += d.toString()
        if (out.includes(`@@T ${nonce} 2 z`)) resolve()
      })
    })
    const started = Date.now()
    child.stdin.write(prelude(nonce) + '__t_q 1 100 1 sleep 20\n__t_q 2 100 5 __t_nop\n')
    await seen
    child.stdin.end()
    expect(out).toMatch(new RegExp(`@@T ${nonce} 1 124`))
    expect(out).toMatch(new RegExp(`@@T ${nonce} 2 0`))
    expect(Date.now() - started).toBeLessThan(15000)
  }, 30000)

  it('starts, lists a folder and reads a file', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rs-'))
    fs.mkdirSync(join(dir, 'sub'))
    fs.writeFileSync(join(dir, "it's here.txt"), 'hello\n')
    const launch = fakeSshLaunch({ home: dir })
    session = createRemoteSession({ file: launch.file, args: sessionArgs(launch.args), spawnImpl: launch.spawnImpl })
    await session.start()
    const ls = await session.run('__t_ls', [posix(dir), posix(dir), '100'])
    expect(ls.rc).toBe(0)
    const names = ls.out.toString('utf8').split('\0').filter(Boolean).sort()
    expect(names).toEqual(["d sub", "f it's here.txt"])
    const rd = await session.run('__t_read', [posix(dir), `${posix(dir)}/it's here.txt`, '1000'])
    expect(rd.rc).toBe(0)
    const text = rd.out.toString('utf8')
    expect(text.slice(text.indexOf('\n') + 1)).toBe('hello\n')
    expect(text.split('\n')[0]).toMatch(/^6 \d+ \d+ \d+ sha256:[0-9a-f]{64}$/)
    const out = await session.run('__t_read', [posix(dir), '/etc/hostname-nope', '1000'])
    expect([RC.MISSING, RC.OUTSIDE]).toContain(out.rc)
  }, 30000)
})
