// An image pasted for an agent in a terminal on an SSH host (remoteFs.js
// pasteImage, remoteShell.js __t_paste): written in ~/.tessel-server/paste
// there, its path given back. The host is a fake: fake-ssh.cjs runs Git for
// Windows' sh on a temporary folder; nothing connects anywhere.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteFs, remotePastePath } from '../remoteFs'
import { FUNCTIONS } from '../remoteShell'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

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
// A small PNG (its bytes only matter for the round trip).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256))])

describe('a pasted image sent to a host: before anything reaches it', () => {
  it('takes back only a path in ~/.tessel-server/paste with no control character (a \r pasted would be an Enter)', () => {
    expect(remotePastePath('/home/deploy/.tessel-server/paste/image-1-abc123.png\n')).toBe('/home/deploy/.tessel-server/paste/image-1-abc123.png')
    expect(remotePastePath('/home/de\rploy/.tessel-server/paste/image-1-abc123.png\n')).toBe('')
    expect(remotePastePath('/home/x\x1b[2J/.tessel-server/paste/image-1-abc123.png')).toBe('')
    expect(remotePastePath('/home/x\x7f/.tessel-server/paste/image-1-abc123.png')).toBe('')
    expect(remotePastePath('/home/x/.tessel-server/paste/image-1.png; rm -rf ~')).toBe('')
    expect(remotePastePath('relative/.tessel-server/paste/image-1.png')).toBe('')
  })

  it('the host function is on the allow list', () => {
    expect(FUNCTIONS.has('__t_paste')).toBe(true)
  })

  it('refuses a bad host, no image, or one too big', async () => {
    let spawned = 0
    const rfs = createRemoteFs({
      hosts,
      spawnImpl: () => {
        spawned++
        throw new Error('no')
      }
    })
    expect((await rfs.pasteImage('bad id; rm', PNG)).ok).toBe(false)
    expect((await rfs.pasteImage(HOST, Buffer.alloc(0))).error).toBe('The clipboard has no image.')
    expect((await rfs.pasteImage(HOST, 'not a buffer')).ok).toBe(false)
    expect((await rfs.pasteImage(HOST, Buffer.alloc(20 * 1024 * 1024 + 1))).error).toBe('The image is too large to send (over 20 MB).')
    expect(spawned).toBe(0)
    rfs.close()
  })
})

describe.skipIf(!gitSh())('a pasted image sent to a host over a fake ssh (Git for Windows sh)', () => {
  let base
  let home
  let rfs
  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rpaste-'))
    home = join(base, 'home')
    fs.mkdirSync(home, { recursive: true })
    rfs = createRemoteFs({ hosts, spawnImpl: fakeSpawn({ home }) })
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('written in ~/.tessel-server/paste, byte for byte, its path given back; each paste its own file', async () => {
    expect(await rfs.connect(HOST)).toEqual({ ok: true })
    const a = await rfs.pasteImage(HOST, PNG)
    expect(a.ok).toBe(true)
    expect(a.path).toMatch(new RegExp(`^${posixPath(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.tessel-server/paste/image-\\d+-[0-9a-f]{6}\\.png$`))
    const name = a.path.split('/').pop()
    const local = join(home, '.tessel-server', 'paste', name)
    expect(fs.readFileSync(local).equals(PNG)).toBe(true)
    const b = await rfs.pasteImage(HOST, PNG.subarray(0, 100))
    expect(b.ok).toBe(true)
    expect(b.path).not.toBe(a.path)
    expect(fs.readdirSync(join(home, '.tessel-server', 'paste'))).toHaveLength(2)
  }, 30000)

  it('refused when ~/.tessel-server is not a folder of this user (a file there)', async () => {
    const other = fs.mkdtempSync(join(base, 'home2-'))
    fs.writeFileSync(join(other, '.tessel-server'), 'not a folder')
    const r2 = createRemoteFs({ hosts, spawnImpl: fakeSpawn({ home: other }) })
    try {
      expect(await r2.connect(HOST)).toEqual({ ok: true })
      const res = await r2.pasteImage(HOST, PNG)
      expect(res.ok).toBe(false)
      expect(fs.readFileSync(join(other, '.tessel-server'), 'utf8')).toBe('not a folder')
    } finally {
      r2.close()
    }
  }, 30000)
})
