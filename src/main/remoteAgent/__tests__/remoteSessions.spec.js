// @vitest-environment node
// Agent sessions on a remote host (history): the shim's `sessions` line read
// and checked (parseRemoteSessions), a host that is not connected never
// signed in to (remoteFs.listAgentSessions), and __t_rsess on a POSIX sh
// playing the host.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createRemoteSession, sessionArgs, requestScript } from '../../remoteShell'
import { createRemoteFs } from '../../remoteFs'
import { parseRemoteSessions, remoteSessionsLimit } from '../remoteAgentSetup'
import { gitSh, fakeSshLaunch, posixPath } from '../../__tests__/fixtures/fakeSsh'

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const line = (sessions) => JSON.stringify({ v: 1, sessions })

describe('parseRemoteSessions', () => {
  it('keeps checked rows, adds the host', () => {
    const rows = parseRemoteSessions(
      line([
        { agent: 'claude', id: ID, cwd: '/home/me/app', started: '2026-10-05T10:00:00.000Z', updated: 1759658400000, title: 'Fix the login' },
        { agent: 'codex', id: 'abc-123', cwd: '/srv/x y', started: null, updated: 5, title: 'Two\nlines\u0007 here' }
      ]),
      'ssh-box'
    )
    expect(rows).toEqual([
      { agent: 'claude', id: ID, cwd: '/home/me/app', started: '2026-10-05T10:00:00.000Z', updated: 1759658400000, title: 'Fix the login', host: 'ssh-box' },
      { agent: 'codex', id: 'abc-123', cwd: '/srv/x y', started: null, updated: 5, title: 'Two lines here', host: 'ssh-box' }
    ])
  })

  it('drops rows that break the contract', () => {
    const ok = { agent: 'claude', id: ID, cwd: '/a', started: null, updated: 1, title: 't' }
    const rows = parseRemoteSessions(
      line([
        { ...ok, agent: 'gemini' },
        { ...ok, id: '../../etc' },
        { ...ok, id: 'x'.repeat(81) },
        { ...ok, cwd: 'relative/path' },
        { ...ok, cwd: '/a\nb' },
        { ...ok, cwd: 42 },
        null,
        'row',
        ok
      ]),
      'h'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(ID)
  })

  it('bad dates, times and titles become null / empty; a long title is cut', () => {
    const [r] = parseRemoteSessions(line([{ agent: 'codex', id: 'a1', cwd: '/a', started: 'not a date', updated: -3, title: 'x'.repeat(500) }]), 'h')
    expect(r.started).toBe(null)
    expect(r.updated).toBe(null)
    expect(r.title).toHaveLength(200)
    const [r2] = parseRemoteSessions(line([{ agent: 'codex', id: 'a1', cwd: '/a', updated: Infinity, title: { x: 1 } }]), 'h')
    expect(r2).toMatchObject({ started: null, updated: null, title: '' })
  })

  it('reads the last JSON line of the right shape; nothing readable -> null', () => {
    const text = `Welcome to the box\n{"other":1}\n${line([{ agent: 'claude', id: 'a', cwd: '/a' }])}\nnot json\n`
    expect(parseRemoteSessions(text, 'h')).toHaveLength(1)
    expect(parseRemoteSessions('', 'h')).toBe(null)
    expect(parseRemoteSessions('{"v":2,"sessions":[]}', 'h')).toBe(null)
    expect(parseRemoteSessions('{"v":1,"sessions":{}}', 'h')).toBe(null)
    expect(parseRemoteSessions(line([]), 'h')).toEqual([])
  })

  it('at most `limit` rows per agent', () => {
    const many = (agent) => Array.from({ length: 5 }, (_, i) => ({ agent, id: `${agent}${i}`, cwd: '/a' }))
    const rows = parseRemoteSessions(line([...many('claude'), ...many('codex')]), 'h', 2)
    expect(rows.map((r) => r.id)).toEqual(['claude0', 'claude1', 'codex0', 'codex1'])
  })

  it('the limit: 1..200, else 60', () => {
    expect(remoteSessionsLimit(5)).toBe(5)
    expect(remoteSessionsLimit('200')).toBe(200)
    for (const v of [0, 201, -1, 1.5, 'x', null, undefined, '5; rm -rf /']) expect(remoteSessionsLimit(v)).toBe(60)
  })

  it('the request line carries the limit quoted', () => {
    expect(requestScript(1, 10, '__t_rsess', ['60'])).toBe(`__t_q 1 10 30 __t_rsess '60'\n`)
  })
})

describe('listAgentSessions on a host that is not connected', () => {
  it('says so, never starts ssh', async () => {
    const spawned = []
    const hosts = {
      get: () => ({ id: 'ssh-box', label: 'Box' }),
      sharedConnected: () => false,
      launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: 'ssh-box' } }),
      paneStarted() {},
      paneConnected() {},
      paneExited() {}
    }
    const rfs = createRemoteFs({ hosts, spawnImpl: (...a) => spawned.push(a) })
    // Even a host a terminal was opened on (allowed): no session is opened.
    rfs.allow('ssh-box')
    const res = await rfs.listAgentSessions('ssh-box', 10)
    expect(res).toMatchObject({ ok: false, notConnected: true })
    expect(res.error).toContain('Box')
    expect(spawned).toEqual([])
    expect(rfs.connectedQuietly('ssh-box')).toBe(false)
    expect(await rfs.listAgentSessions('bad id;', 10)).toMatchObject({ ok: false })
    rfs.close()
  })
})

describe.skipIf(!gitSh())('__t_rsess on a POSIX sh (fake ssh)', () => {
  let dir
  let session
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  const sysPath = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'

  async function rsess(home, limit) {
    const launch = fakeSshLaunch({ home })
    // No node on the PATH, no login shell: only the recorded one.
    session = createRemoteSession({
      file: launch.file,
      args: sessionArgs(launch.args),
      env: { SystemRoot: process.env.SystemRoot || '', PATH: sysPath, SHELL: '/usr/bin/false' },
      spawnImpl: launch.spawnImpl
    })
    await session.start()
    return session.run('__t_rsess', [limit], { cap: 64 * 1024, timeoutMs: 30000 })
  }
  function helper(home, { node = true } = {}) {
    fs.mkdirSync(join(home, '.tessel-server', 'bin'), { recursive: true })
    fs.writeFileSync(join(home, '.tessel-server', 'bin', 'tessel-shim.cjs'), `process.stdout.write(JSON.stringify({ v: 1, argv: process.argv.slice(2) }) + '\\n')\n`)
    if (node) fs.writeFileSync(join(home, '.tessel-server', 'bin', 'NODE'), posixPath(process.execPath) + '\n')
  }

  it('runs the shim with the node the helper recorded', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rsess-'))
    helper(dir)
    const res = await rsess(dir, '25')
    expect(res.rc).toBe(0)
    expect(JSON.parse(res.out.toString('utf8').trim())).toEqual({ v: 1, argv: ['sessions', '25'] })
  }, 60000)

  it('no helper or no node: 81; a limit that is not digits: 90', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rsess-'))
    expect((await rsess(dir, '5')).rc).toBe(81)
    session.close('done')
    helper(dir, { node: false })
    expect((await rsess(dir, '5')).rc).toBe(81)
    session.close('done')
    helper(dir)
    expect((await rsess(dir, '5; rm -rf ~')).rc).toBe(90)
    expect(fs.existsSync(join(dir, '.tessel-server', 'bin', 'tessel-shim.cjs'))).toBe(true)
  }, 60000)
})
