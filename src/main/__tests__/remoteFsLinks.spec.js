import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteFs, MAX_LINK_STATS } from '../remoteFs'
import { remoteRoot, childPath } from '../../shared/remotePath'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

const HOST = 'ssh-test1'
const hosts = (connected) => ({
  launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
  get: () => ({ id: HOST, label: 'Box' }),
  sharedConnected: () => connected.value,
  paneStarted: () => {},
  paneConnected: () => {},
  paneClosing: () => {},
  paneExited: () => {}
})

// Terminal links in an SSH pane: which printed paths are files or folders
// on the host, one round trip, inside the saved projects only.
describe.skipIf(!gitSh())('SSH terminal links over a fake ssh (Git for Windows sh)', () => {
  let base
  let proj
  let rfs
  let root
  const connected = { value: true }

  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs-links-'))
    proj = join(base, 'proj')
    fs.mkdirSync(join(proj, 'src'), { recursive: true })
    fs.mkdirSync(join(base, 'home'))
    fs.writeFileSync(join(proj, 'src', 'main.js'), 'x\n')
    fs.writeFileSync(join(proj, 'my file.txt'), 'x\n')
    fs.writeFileSync(join(base, 'secret.txt'), 'outside\n')
    rfs = createRemoteFs({ hosts: hosts(connected), send: () => {}, spawnImpl: fakeSpawn({ home: join(base, 'home') }) })
    root = remoteRoot(HOST, posixPath(proj))
    rfs.setRoots([root])
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('files, folders and missing paths in one batch; nothing outside the project', async () => {
    const outside = remoteRoot(HOST, posixPath(join(base, 'secret.txt')))
    const paths = [childPath(root, 'src/main.js'), childPath(root, 'src'), childPath(root, 'my file.txt'), childPath(root, 'nope.js'), outside, root]
    const res = await rfs.statLinks(paths)
    expect(res[paths[0]]).toBe('file')
    expect(res[paths[1]]).toBe('dir')
    expect(res[paths[2]]).toBe('file')
    expect(res[paths[3]]).toBe(null)
    expect(res[outside]).toBe(null)
    expect(res[root]).toBe('dir')
  }, 30000)

  it('caps a batch', async () => {
    const many = Array.from({ length: MAX_LINK_STATS + 5 }, (_, i) => childPath(root, `f${i}.js`))
    expect(Object.keys(await rfs.statLinks(many))).toHaveLength(MAX_LINK_STATS)
  }, 30000)

  it('never signs in from a hover: a host not connected answers nothing', async () => {
    rfs.closeHost(HOST)
    connected.value = false
    const p = childPath(root, 'src/main.js')
    expect(await rfs.statLinks([p])).toEqual({ [p]: null })
    connected.value = true
  }, 30000)
})
