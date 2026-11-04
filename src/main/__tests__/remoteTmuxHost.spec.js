// @vitest-environment node
// The host side of Tessel's own tmux (remoteShell.js __t_tmuxq / __t_tmux,
// remoteFs.js queryTmux / installTmux): the copy is written under
// ~/.tessel-server/bin only when its sha256 matches and it runs, and the
// query tells the system's tmux, Tessel's copy and uname -m apart. A POSIX sh
// plays the host (Git for Windows' sh on a temporary folder: fake ssh); a
// shell script stands for the binary (it prints "tmux 3.5a" to -V).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { join } from 'path'
import { createRemoteFs } from '../remoteFs'
import { FUNCTIONS } from '../remoteShell'
import { gitSh, fakeSpawn } from './fixtures/fakeSsh'

const HOST = 'ssh-test1'
const hosts = {
  launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
  get: () => ({ id: HOST, label: 'Box' }),
  sharedConnected: () => true,
  paneStarted: () => {},
  paneConnected: () => {},
  paneClosing: () => {},
  paneExited: () => {}
}
const FAKE_TMUX = Buffer.from('#!/bin/sh\nif [ "$1" = -V ]; then echo "tmux 3.5a"; exit 0; fi\nexit 1\n')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

describe('before anything reaches the host', () => {
  it('the host functions are on the allow list', () => {
    expect(FUNCTIONS.has('__t_tmuxq')).toBe(true)
    expect(FUNCTIONS.has('__t_tmux')).toBe(true)
  })

  it('refuses a bad host, version, checksum or binary without spawning anything', async () => {
    let spawned = 0
    const rfs = createRemoteFs({
      hosts,
      spawnImpl: () => {
        spawned++
        throw new Error('no')
      }
    })
    expect((await rfs.queryTmux('bad id; rm')).error).toBeTruthy()
    expect((await rfs.installTmux('bad id; rm', { version: '3.5a', sha256: sha(FAKE_TMUX), binary: FAKE_TMUX })).error).toBeTruthy()
    expect((await rfs.installTmux(HOST, { version: '3.5a; rm', sha256: sha(FAKE_TMUX), binary: FAKE_TMUX })).error).toBe('bad tmux version')
    expect((await rfs.installTmux(HOST, { version: '3.5a', sha256: 'abc', binary: FAKE_TMUX })).error).toBe('bad tmux checksum')
    expect((await rfs.installTmux(HOST, { version: '3.5a', sha256: sha(FAKE_TMUX).toUpperCase(), binary: FAKE_TMUX })).error).toBe('bad tmux checksum')
    expect((await rfs.installTmux(HOST, { version: '3.5a', sha256: sha(FAKE_TMUX), binary: 'text' })).error).toBe('bad tmux binary')
    expect((await rfs.installTmux(HOST, { version: '3.5a', sha256: sha(FAKE_TMUX), binary: Buffer.alloc(0) })).error).toBe('bad tmux binary')
    expect(spawned).toBe(0)
    rfs.close()
  })
})

describe.skipIf(!gitSh())('Tessel’s tmux on a fake host (Git for Windows sh)', () => {
  let base
  let home
  let rfs
  let savedPath
  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rtmux-'))
    home = join(base, 'home')
    fs.mkdirSync(home, { recursive: true })
    // This computer may have a tmux on PATH (Git for Windows can): a shim
    // first on PATH that fails -V stands for a host without a system tmux,
    // so the query's own-copy and uname branches are the ones exercised.
    const shim = join(base, 'shim')
    fs.mkdirSync(shim)
    fs.writeFileSync(join(shim, 'tmux'), '#!/bin/sh\nexit 1\n')
    savedPath = process.env.PATH
    process.env.PATH = `${shim}${process.platform === 'win32' ? ';' : ':'}${savedPath || ''}`
    rfs = createRemoteFs({ hosts, spawnImpl: fakeSpawn({ home }) })
  })
  afterAll(() => {
    process.env.PATH = savedPath
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })
  const binDir = () => join(home, '.tessel-server', 'bin')

  // A host without a system tmux (the shim on PATH fails -V) and without
  // Tessel's copy yet: uname -s and -m only.
  it('the query: no system tmux, no copy yet: uname -s and -m only', async () => {
    expect(await rfs.connect(HOST)).toEqual({ ok: true })
    const q = await rfs.queryTmux(HOST)
    expect(q.rc).toBe(0)
    const out = q.out.toString('utf8')
    expect(out).toMatch(/^@os \S+\n@arch \S+\n$/)
    expect(out).not.toContain('@sys')
    expect(out).not.toContain('@own')
  }, 30000)

  it('a checksum that does not match: 83, nothing kept in ~/.tessel-server/bin', async () => {
    const r = await rfs.installTmux(HOST, { version: '3.5a', sha256: 'b'.repeat(64), binary: FAKE_TMUX })
    expect(r.rc).toBe(83)
    expect(fs.existsSync(join(binDir(), 'tmux'))).toBe(false)
    expect(fs.readdirSync(binDir()).filter((n) => n.startsWith('.tmux.'))).toEqual([])
  }, 30000)

  it('a copy that does not run here (the wrong kind of machine, a noexec home): 84, the file removed', async () => {
    const blob = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x00, 0xb7, 0x00])
    const r = await rfs.installTmux(HOST, { version: '3.5a', sha256: sha(blob), binary: blob })
    expect(r.rc).toBe(84)
    expect(fs.existsSync(join(binDir(), 'tmux'))).toBe(false)
    expect(fs.readdirSync(binDir()).filter((n) => n.startsWith('.tmux.'))).toEqual([])
  }, 30000)

  it('a good copy: written byte for byte, run once (-V printed), its version kept; the query then names it', async () => {
    const r = await rfs.installTmux(HOST, { version: '3.5a', sha256: sha(FAKE_TMUX), binary: FAKE_TMUX })
    expect(r.rc).toBe(0)
    expect(r.out.toString('utf8').trim()).toBe('tmux 3.5a')
    expect(fs.readFileSync(join(binDir(), 'tmux')).equals(FAKE_TMUX)).toBe(true)
    expect(fs.readFileSync(join(binDir(), 'TMUX_VERSION'), 'utf8').trim()).toBe('3.5a')
    expect(fs.readdirSync(binDir()).filter((n) => n.startsWith('.tmux.'))).toEqual([])
    const q = await rfs.queryTmux(HOST)
    expect(q.rc).toBe(0)
    const out = q.out.toString('utf8')
    expect(out).toMatch(/^@own tmux 3\.5a\n@os \S+\n@arch \S+\n$/)
    expect(out).not.toContain('@sys')
  }, 30000)

  it('refused when ~/.tessel-server is not a folder of this user (a file there)', async () => {
    const other = fs.mkdtempSync(join(base, 'home2-'))
    fs.writeFileSync(join(other, '.tessel-server'), 'not a folder')
    const r2 = createRemoteFs({ hosts, spawnImpl: fakeSpawn({ home: other }) })
    try {
      expect(await r2.connect(HOST)).toEqual({ ok: true })
      const res = await r2.installTmux(HOST, { version: '3.5a', sha256: sha(FAKE_TMUX), binary: FAKE_TMUX })
      expect(res.rc).toBe(98)
      expect(fs.readFileSync(join(other, '.tessel-server'), 'utf8')).toBe('not a folder')
    } finally {
      r2.close()
    }
  }, 30000)
})
