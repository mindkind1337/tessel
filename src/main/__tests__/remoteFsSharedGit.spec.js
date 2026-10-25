// @vitest-environment node
// The Files panel's own git work (its colours, the Changes count) on a host
// with no background lane (an older terminal host, the system ssh): it
// shares the host's one session with the agent readers, a pane's setup and
// the user's clicks. 2026-10-25, a FiveM server's huge tree: the git status
// listed every untracked file, ran out of time after 30 s, again and again,
// and the agent views and new panes gave up behind it.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'events'
import { createRemoteFs, SHARED_GIT_MS, SHARED_GIT_HOLD_MS } from '../remoteFs'
import { remoteRoot, childPath } from '../../shared/remotePath'

const HOST = 'ssh-shgit1'
const ROOT = remoteRoot(HOST, '/srv/app')

// A fake host: every request is recorded ({ fn, secs, args, reply }) and
// answered at once unless host.hold(request) says to keep it.
function fakeHost() {
  const host = { children: [], reqs: [], hold: () => false, answer: () => [0, ''] }
  host.spawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    let nonce = null
    const reply = (id, rc, out) =>
      setImmediate(() => child.stdout.emit('data', Buffer.from(`@@T ${nonce} ${id} ${rc}\n${Buffer.from(out || '').toString('base64')}\n@@T ${nonce} ${id} e\n\n@@T ${nonce} ${id} z\n`)))
    child.stdin = Object.assign(new EventEmitter(), {
      write(text) {
        const s = String(text)
        const n = /__T_N=([0-9a-f]{32})/.exec(s)
        if (n) {
          nonce = n[1]
          setImmediate(() => child.stdout.emit('data', Buffer.from(`@@R ${nonce} ok\n`)))
        }
        for (const m of s.matchAll(/__t_q (\d+) \d+ (\d+) (__t_\w+)([^\n]*)/g)) {
          const r = { child, fn: m[3], secs: Number(m[2]), args: m[4] }
          r.reply = (rc, out) => reply(Number(m[1]), rc, out)
          host.reqs.push(r)
          if (!host.hold(r)) r.reply(...host.answer(r))
        }
        return true
      },
      end() {}
    })
    child.kill = () => {
      child.killed = true
      setImmediate(() => child.emit('exit', null))
    }
    host.children.push(child)
    return child
  }
  return host
}

const isStatus = (r) => r.fn === '__t_gitin' && / 'status' /.test(`${r.args} `)
// The repository's top, its settings (none risky), its hooks (none), then
// the git status itself.
function answers(statusOut = '?? cache/\0 M a.lua\0') {
  return (r) => {
    if (r.fn === '__t_top') return [0, '/srv/app\n/srv/app\n']
    if (r.fn === '__t_gitin' && !isStatus(r)) return /'remote'|'diff'/.test(r.args) ? [0, ''] : [1, '']
    if (isStatus(r)) return [0, statusOut]
    if (r.fn === '__t_tread') return [0, '3 1700000000\nabc']
    if (r.fn === '__t_home') return [0, '/home/me\n']
    return [0, '']
  }
}

function setup({ onlyLive = false, clock } = {}) {
  const host = fakeHost()
  host.answer = answers()
  const ssh = {
    modeFor: async () => ({ mode: 'ssh2', spec: { host: 'box' } }),
    onlyLiveSupported: () => onlyLive,
    spawnFor: () => host.spawn
  }
  const hosts = {
    get: () => ({ id: HOST, label: 'Box' }),
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box' }),
    sharedConnected: () => true,
    paneStarted() {},
    paneConnected() {},
    paneClosing() {},
    paneExited() {}
  }
  const warned = []
  const rfs = createRemoteFs({ hosts, ssh, spawnImpl: host.spawn, log: { warn: (_area, m) => warned.push(m) }, ...(clock ? { now: () => clock.now } : {}) })
  rfs.setRoots([ROOT])
  return { rfs, host, warned }
}
const ticks = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

describe("the Files panel's git status", () => {
  it('an untracked folder is one entry (--untracked-files=normal), shown under its own path', async () => {
    const { rfs, host } = setup()
    const st = await rfs.projectStatus({ root: ROOT, ignored: true, background: true })
    expect(st).toMatchObject({ ok: true, repo: true })
    expect(st.files).toEqual({ [childPath(ROOT, 'cache')]: 'U', [childPath(ROOT, 'a.lua')]: 'M' })
    const req = host.reqs.find(isStatus)
    expect(req.args).toContain('--untracked-files=normal')
    expect(req.args).not.toContain('--untracked-files=all')
    expect(req.args).toContain('--ignored=matching')
    rfs.close()
  })

  it('the Changes tab still lists every untracked file (--untracked-files=all)', async () => {
    const { rfs, host } = setup()
    host.answer = answers('# branch.oid (initial)\0# branch.head main\0? cache/a.bin\0? cache/b.bin\0')
    const st = await rfs.scm.scmStatus({ root: ROOT })
    expect(st.ok).toBe(true)
    expect(st.entries.map((e) => e.path)).toEqual(['cache/a.bin', 'cache/b.bin'])
    expect(host.reqs.find(isStatus).args).toContain('--untracked-files=all')
    rfs.close()
  })
})

describe('no background lane: the git work in the shared session', () => {
  it(`is stopped on the host after ${SHARED_GIT_MS / 1000} s; asked by the user (foreground) it keeps its own limit`, async () => {
    const { rfs, host } = setup()
    await rfs.projectStatus({ root: ROOT, ignored: true, background: true })
    expect(host.reqs.filter(isStatus).map((r) => r.secs)).toEqual([SHARED_GIT_MS / 1000])
    await rfs.projectStatus({ root: ROOT })
    expect(host.reqs.filter(isStatus).map((r) => r.secs)).toEqual([SHARED_GIT_MS / 1000, 30])
    // The Changes count read by itself: the same.
    await rfs.scm.scmStatus({ root: ROOT, background: true })
    expect(host.reqs.filter(isStatus).map((r) => r.secs)).toEqual([SHARED_GIT_MS / 1000, 30, SHARED_GIT_MS / 1000])
    rfs.close()
  })

  it("runs after the agent readers and the pane's setup waiting in the queue", async () => {
    const { rfs, host } = setup()
    // The repository known (its top, settings, hooks), the session up.
    await rfs.projectStatus({ root: ROOT, ignored: true, background: true })
    // A click holds the session a moment...
    let held = null
    host.hold = (r) => {
      if (r.fn !== '__t_ls' || held) return false
      held = r
      return true
    }
    const listed = rfs.listDir({ root: ROOT })
    await ticks()
    expect(held).toBeTruthy()
    // ...meanwhile the colours, the Changes count, a reader and the home folder are asked.
    const colours = rfs.projectStatus({ root: ROOT, ignored: true, background: true })
    const count = rfs.scm.scmStatus({ root: ROOT, background: true })
    await ticks()
    const reader = rfs.readAgentFile(HOST, { agent: 'claude', id: 'abcdef12-3456' })
    const home = rfs.hostHome(HOST)
    await ticks()
    const before = host.reqs.length
    held.reply(0, '')
    await Promise.all([listed, colours, count, reader, home])
    const after = host.reqs.slice(before).map((r) => r.fn)
    const firstGit = after.findIndex((f) => f === '__t_gitin' || f === '__t_gitop')
    expect(after.indexOf('__t_tread')).toBeGreaterThanOrEqual(0)
    expect(after.indexOf('__t_tread')).toBeLessThan(firstGit)
    expect(after.indexOf('__t_home')).toBeGreaterThanOrEqual(0)
    expect(after.indexOf('__t_home')).toBeLessThan(firstGit)
    expect((await reader).ok).toBe(true)
    expect(await home).toEqual({ ok: true, home: '/home/me' })
    rfs.close()
  })

  it(`one that ran out of time: not run in the background again for that repository for ${SHARED_GIT_HOLD_MS / 60_000} min; the user's own still runs`, async () => {
    const clock = { now: 1_000_000 }
    const { rfs, host, warned } = setup({ clock })
    const base = host.answer
    host.answer = (r) => (isStatus(r) ? [124, ''] : base(r))
    const first = await rfs.projectStatus({ root: ROOT, ignored: true, background: true })
    expect(first.ok).toBe(false)
    expect(warned.filter((m) => /git work on ssh-shgit1 ran out of time in the shared session/.test(m))).toHaveLength(1)
    const sent = host.reqs.length
    // Held: answered at once, nothing sent to the host (colours, Changes count).
    const again = await rfs.projectStatus({ root: ROOT, ignored: true, background: true })
    expect(again.ok).toBe(false)
    expect((await rfs.scm.scmStatus({ root: ROOT, background: true })).ok).toBe(false)
    expect(host.reqs.length).toBe(sent)
    // The Changes tab (foreground) still asks, with its own limit.
    host.answer = base
    expect((await rfs.projectStatus({ root: ROOT })).ok).toBe(true)
    expect(host.reqs.slice(sent).filter(isStatus).map((r) => r.secs)).toEqual([30])
    // Later: asked in the background again.
    clock.now += SHARED_GIT_HOLD_MS + 1
    expect((await rfs.projectStatus({ root: ROOT, ignored: true, background: true })).ok).toBe(true)
    rfs.close()
  })
})

describe('with a background lane', () => {
  it('the git status keeps its own limit there (it holds no pane or click)', async () => {
    const { rfs, host } = setup({ onlyLive: true })
    rfs.allow(HOST)
    // The Files session up first (the lane only rides a live connection).
    await rfs.listDir({ root: ROOT })
    const st = await rfs.projectStatus({ root: ROOT, ignored: true, background: true })
    expect(st.ok).toBe(true)
    const req = host.reqs.find(isStatus)
    expect(req.secs).toBe(30)
    expect(req.child).not.toBe(host.children[0])
    rfs.close()
  })
})
