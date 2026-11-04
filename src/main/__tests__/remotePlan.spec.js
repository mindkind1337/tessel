// The prelude's __t_plan / __t_planup (tessel-host's install commands run in
// the host's shell session, src/main/host/daemon.ts): a fixed command runs as
// it is; one with an upload gets the bytes on its standard input, decoded,
// and the upload file is gone after it.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteSession, sessionArgs, FUNCTIONS } from '../remoteShell'
import { gitSh, fakeSshLaunch } from './fixtures/fakeSsh'

describe('plan commands', () => {
  it('are allowed functions of the prelude', () => {
    expect(FUNCTIONS.has('__t_plan')).toBe(true)
    expect(FUNCTIONS.has('__t_planup')).toBe(true)
  })
})

describe.skipIf(!gitSh())('plan commands against a POSIX shell (fake ssh)', () => {
  let dir
  let session
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  const posix = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/')

  it('runs a fixed command, and one with the program on its standard input', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-plan-'))
    const launch = fakeSshLaunch({ home: dir })
    session = createRemoteSession({ file: launch.file, args: sessionArgs(launch.args), spawnImpl: launch.spawnImpl })
    await session.start()
    const probe = await session.run('__t_plan', ['uname -m'])
    expect(probe.rc).toBe(0)
    expect(probe.out.toString('utf8').trim()).not.toBe('')
    const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 39, 34, 36, 92, ...Array.from({ length: 3000 }, (_, i) => i % 251)])
    const target = `${posix(dir)}/.tessel-host-0.1.1-x86_64.0123456789abcdef.part`
    const up = await session.run('__t_planup', [`umask 077 && cat > "${target}"`], { upload: bytes })
    expect(up.rc).toBe(0)
    expect(fs.readFileSync(join(dir, '.tessel-host-0.1.1-x86_64.0123456789abcdef.part'))).toEqual(bytes)
    const failed = await session.run('__t_plan', ['exit 7'])
    expect(failed.rc).toBe(7)
    // The next command sees no upload left behind.
    const left = await session.run('__t_plan', ['[ -e "$__T_D/u" ] && echo there || echo gone'])
    expect(left.out.toString('utf8').trim()).toBe('gone')
  }, 30000)
})
