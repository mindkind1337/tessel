// The Files tab of a remote project over tessel-host: a daemon that lists the
// project folder empty (it opened the folder before it was replaced and keeps
// reading the old one) does not hide what the folder holds: the shell is
// asked too. Any other answer of the daemon is shown as it is.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { remoteRoot } from '../../shared/remotePath'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

const daemon = { answer: null, asked: [], distrusted: [] }
vi.mock('../host/remote', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    createRemoteExplorer: (deps) => {
      const real = actual.createRemoteExplorer(deps)
      return {
        ...real,
        served: (virtual) => !daemon.distrusted.includes(virtual),
        distrust: (virtual) => daemon.distrusted.push(virtual),
        list: async (virtual, rel) => {
          if (daemon.distrusted.includes(virtual)) return null
          daemon.asked.push(rel)
          return typeof daemon.answer === 'function' ? daemon.answer(rel) : daemon.answer
        }
      }
    }
  }
})
const { createRemoteFs } = await import('../remoteFs')

const HOST = 'ssh-test0001-abcd12'
const hosts = () => ({
  launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
  get: () => ({ id: HOST, label: 'Box' }),
  sharedConnected: () => true,
  paneStarted: () => {},
  paneConnected: () => {},
  paneClosing: () => {},
  paneExited: () => {}
})

describe.skipIf(!gitSh())('a project folder the daemon lists empty', () => {
  let base, proj, empty, rfs, root, emptyRoot
  const warned = []

  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs-empty-'))
    proj = join(base, 'proj')
    empty = join(base, 'empty')
    fs.mkdirSync(join(proj, 'ps-mdt-prop'), { recursive: true })
    fs.writeFileSync(join(proj, 'fxmanifest.lua'), 'x\n')
    fs.mkdirSync(empty)
    fs.mkdirSync(join(base, 'home'))
    rfs = createRemoteFs({ hosts: hosts(), send: () => {}, spawnImpl: fakeSpawn({ home: join(base, 'home') }), log: { warn: (_, m) => warned.push(m), info: () => {} } })
    root = remoteRoot(HOST, posixPath(proj))
    emptyRoot = remoteRoot(HOST, posixPath(empty))
    rfs.setRoots([root, emptyRoot])
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('really empty: still empty, nothing noted; a subfolder or a full answer from the daemon is taken as it is', async () => {
    daemon.answer = { ok: true, entries: [], truncated: false }
    expect((await rfs.listDir({ root: emptyRoot })).entries).toEqual([])
    expect((await rfs.listMany({ root: emptyRoot, dirs: [emptyRoot] })).results[0].entries).toEqual([])
    expect(warned).toEqual([])
    expect(daemon.distrusted).toEqual([])
    // A subfolder listed empty: the daemon's answer (an empty folder is common).
    daemon.answer = { ok: true, entries: [], truncated: false }
    expect((await rfs.listDir({ root, dir: `${root}\\ps-mdt-prop` })).entries).toEqual([])
    const shown = [{ name: 'only', path: `${root}\\only`, dir: false }]
    daemon.answer = { ok: true, entries: shown, truncated: false }
    expect((await rfs.listDir({ root })).entries).toEqual(shown)
  }, 30000)

  it('the shell finds entries: they are shown, and the project is no longer asked of the daemon', async () => {
    daemon.answer = { ok: true, entries: [], truncated: false }
    const res = await rfs.listDir({ root })
    expect(res.ok).toBe(true)
    expect(res.entries.map((e) => e.name)).toEqual(['ps-mdt-prop', 'fxmanifest.lua'])
    expect(warned.filter((m) => /lists the project folder empty/.test(m))).toHaveLength(1)
    expect(daemon.distrusted).toEqual([root])
    // Its sub-folders and the next refreshes: from the shell, no new note.
    daemon.asked.length = 0
    expect((await rfs.listDir({ root, dir: `${root}\\ps-mdt-prop` })).ok).toBe(true)
    const many = await rfs.listMany({ root, dirs: [root, `${root}\\ps-mdt-prop`] })
    expect(many.results[0].entries.map((e) => e.name)).toEqual(['ps-mdt-prop', 'fxmanifest.lua'])
    expect(daemon.asked).toEqual([])
    expect(warned).toHaveLength(1)
  }, 30000)

  it('a refresh of several folders checks an empty project folder too', async () => {
    daemon.distrusted.length = 0
    warned.length = 0
    daemon.answer = { ok: true, entries: [], truncated: false }
    const many = await rfs.listMany({ root, dirs: [root, `${root}\\ps-mdt-prop`] })
    expect(many.results[0].entries.map((e) => e.name)).toEqual(['ps-mdt-prop', 'fxmanifest.lua'])
    expect(daemon.distrusted).toEqual([root])
    expect(warned).toHaveLength(1)
  }, 30000)
})
