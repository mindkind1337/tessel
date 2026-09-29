import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRemoteFs } from '../remoteFs'
import { createRemotePromptWriter } from '../automationRemotePrompt'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

const HOST = 'ssh-test2'
const hosts = {
  launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
  get: () => ({ id: HOST, label: 'Box' }),
  paneStarted: () => {},
  paneConnected: () => {},
  paneClosing: () => {},
  paneExited: () => {}
}
const FILE = '.tessel/automations/auto-1234-abcd.md'

describe('a remote project\'s automation prompt', () => {
  it('only its own file shape is written', async () => {
    const calls = []
    const w = createRemotePromptWriter({ create: async (q) => calls.push(q), writeForEdit: async (q) => (calls.push(q), { ok: true }) })
    expect((await w.write({ hostId: HOST, path: '/srv/app', file: '../../etc/passwd', text: 'x' })).ok).toBe(false)
    expect((await w.write({ hostId: HOST, path: '/srv/app', file: '.tessel/automations/x;rm.md', text: 'x' })).ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe.skipIf(!gitSh())('a remote project\'s automation prompt over a fake ssh (Git for Windows sh)', () => {
  let base
  let proj
  let rfs
  let writer
  const g = (...args) => execFileSync('git', ['-C', proj, ...args], { stdio: 'pipe' }).toString()

  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-arp-'))
    proj = join(base, 'proj')
    const home = join(base, 'home')
    fs.mkdirSync(proj)
    fs.mkdirSync(home)
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    fs.writeFileSync(join(proj, 'a.txt'), 'one\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    rfs = createRemoteFs({ hosts, send: () => {}, spawnImpl: fakeSpawn({ home }) })
    writer = createRemotePromptWriter(rfs)
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('is written in .tessel/automations with a .gitignore, so `git add -A` never takes it; emptied at the end', async () => {
    const res = await writer.write({ hostId: HOST, path: posixPath(proj), file: FILE, text: 'Do the audit.\n' })
    expect(res).toEqual({ ok: true })
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', 'auto-1234-abcd.md'), 'utf8')).toBe('Do the audit.\n')
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', '.gitignore'), 'utf8')).toBe('*\n')
    g('add', '-A')
    expect(g('status', '--porcelain')).not.toContain('.tessel')
    // A second run: the folder is there, the file overwritten.
    expect((await writer.write({ hostId: HOST, path: posixPath(proj), file: FILE, text: 'Again.\n' })).ok).toBe(true)
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', 'auto-1234-abcd.md'), 'utf8')).toBe('Again.\n')
    expect((await writer.clear({ hostId: HOST, path: posixPath(proj), file: FILE })).ok).toBe(true)
    expect(fs.readFileSync(join(proj, '.tessel', 'automations', 'auto-1234-abcd.md'), 'utf8')).toBe('')
  }, 60000)

  it('a .tessel that is a link out of the project (a cloned repo) is refused', async () => {
    const other = join(base, 'other')
    fs.mkdirSync(join(other, 'proj2'), { recursive: true })
    const proj2 = join(other, 'proj2')
    const outside = join(base, 'outside')
    fs.mkdirSync(join(outside, 'automations'), { recursive: true })
    try {
      fs.symlinkSync(outside, join(proj2, '.tessel'), 'junction')
    } catch {
      return // no right to make a link here
    }
    const res = await writer.write({ hostId: HOST, path: posixPath(proj2), file: FILE, text: 'secret prompt\n' })
    expect(res.ok).toBe(false)
    expect(fs.existsSync(join(outside, 'automations', 'auto-1234-abcd.md'))).toBe(false)
    expect(fs.existsSync(join(outside, 'automations', '.gitignore'))).toBe(false)
  }, 60000)
})
