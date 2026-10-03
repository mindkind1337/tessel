import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createRemoteFs, checkRemoteName, cleanRel, findPattern, trashInfoPath, porcelainLetters, parseStat } from '../remoteFs'
import { remoteRoot, childPath } from '../../shared/remotePath'
import { gitSh, fakeSpawn, posixPath } from './fixtures/fakeSsh'

describe('helpers', () => {
  it('names: POSIX rules, never a separator or a control character', () => {
    expect(checkRemoteName('a:b?.txt')).toBe('')
    expect(checkRemoteName('a/b')).not.toBe('')
    expect(checkRemoteName('a\\b')).not.toBe('')
    expect(checkRemoteName('..')).not.toBe('')
    expect(checkRemoteName('a\nb')).not.toBe('')
    expect(checkRemoteName('')).not.toBe('')
  })
  it('relative paths: no . or .., no control characters', () => {
    expect(cleanRel('a/b\\c')).toBe('a/b/c')
    expect(cleanRel('a/../b')).toBe(null)
    expect(cleanRel('a/\u0001')).toBe(null)
  })
  it('find patterns match the text literally', () => {
    expect(findPattern('a*b?[c]\\')).toBe('*a\\*b\\?\\[c\\]\\\\*')
  })
  it('trash info paths are URL-escaped', () => {
    expect(trashInfoPath("/home/me/it's a#b")).toBe('/home/me/it%27s%20a%23b')
  })
  it('porcelain letters and stat lines', () => {
    expect(porcelainLetters('?? new.txt\0 M a.js\0R  b.js\0old.js\0')).toEqual([['new.txt', 'U'], ['a.js', 'M'], ['b.js', 'R']])
    expect(parseStat('12 1700000000 42 644')).toEqual({ size: 12, mtimeMs: 1700000000000, sig: 'r:12:1700000000:42' })
    expect(parseStat('garbage')).toBe(null)
  })
})

const HOST = 'ssh-test1'
function stubHosts(events) {
  return {
    launchFor: () => ({ ok: true, file: 'ssh.exe', args: ['box'], name: 'Box', target: { id: HOST } }),
    get: () => ({ id: HOST, label: 'Box' }),
    // Signed in already (remoteFs.js opens no session nobody asked for).
    sharedConnected: () => true,
    paneStarted: (id, hostId, o) => events.push(['started', id, hostId, o]),
    paneConnected: (id) => events.push(['connected', id]),
    paneClosing: (id) => events.push(['closing', id]),
    paneExited: (id) => events.push(['exited', id])
  }
}

describe.skipIf(!gitSh())('remote project over a fake ssh (Git for Windows sh)', () => {
  let base
  let proj
  let home
  let rfs
  let root
  const events = []
  const sent = []
  const g = (...args) => execFileSync('git', ['-C', proj, ...args], { stdio: 'pipe' }).toString()

  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs-'))
    proj = join(base, 'proj')
    home = join(base, 'home')
    fs.mkdirSync(proj)
    fs.mkdirSync(home)
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    g('config', 'core.autocrlf', 'false')
    fs.writeFileSync(join(proj, 'a.txt'), 'one\n')
    fs.mkdirSync(join(proj, 'src'))
    fs.writeFileSync(join(proj, 'src', 'main.js'), 'console.log(1)\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    fs.writeFileSync(join(base, 'secret.txt'), 'outside\n')
    rfs = createRemoteFs({ hosts: stubHosts(events), send: (c, p) => sent.push([c, p]), spawnImpl: fakeSpawn({ home }) })
    root = remoteRoot(HOST, posixPath(proj))
    rfs.setRoots([root])
  })
  afterAll(() => {
    rfs.close()
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('lists the project, folders first, .git hidden', async () => {
    const res = await rfs.listDir({ root })
    expect(res.ok).toBe(true)
    expect(res.entries.map((e) => [e.name, e.dir])).toEqual([['src', true], ['a.txt', false]])
    expect(res.entries[1].path).toBe(childPath(root, 'a.txt'))
    // Its session is the host's connection (status bar), started once.
    expect(events.filter((e) => e[0] === 'started')).toHaveLength(1)
    expect(sent.some(([c]) => c === 'remoteFs:activity')).toBe(true)
  }, 30000)

  it('refuses a path outside the project (.., another folder)', async () => {
    expect((await rfs.listDir({ root, dir: `${root}\\..` })).ok).toBe(false)
    expect((await rfs.readForEdit(remoteRoot(HOST, posixPath(join(base, 'secret.txt'))))).ok).toBe(false)
  })

  it('never follows a link out of the project (read, write, list)', async () => {
    const tryLink = (target, at, type) => {
      try {
        fs.symlinkSync(target, at, type)
        return true
      } catch {
        return false // no right to make this kind of link here (Windows without developer mode)
      }
    }
    // A folder link (a junction needs no special right on Windows).
    if (tryLink(base, join(proj, 'up'), 'junction')) {
      const listed = await rfs.listDir({ root })
      expect(listed.entries.find((e) => e.name === 'up')).toMatchObject({ dir: true, link: true })
      expect((await rfs.listDir({ root, dir: childPath(root, 'up') })).ok).toBe(false)
      expect((await rfs.readForEdit(childPath(root, 'up/secret.txt'))).ok).toBe(false)
      expect((await rfs.writeForEdit({ file: childPath(root, 'up/secret.txt'), text: 'pwned' })).ok).toBe(false)
      expect((await rfs.create({ root, dir: childPath(root, 'up'), name: 'x' })).ok).toBe(false)
      expect((await rfs.rename({ root, path: childPath(root, 'up/secret.txt'), name: 'y' })).ok).toBe(false)
      expect((await rfs.trash({ root, path: childPath(root, 'up/secret.txt') })).ok).toBe(false)
      expect(fs.readFileSync(join(base, 'secret.txt'), 'utf8')).toBe('outside\n')
      expect(fs.existsSync(join(base, 'x'))).toBe(false)
      fs.rmSync(join(proj, 'up'))
    }
    if (tryLink(join(base, 'secret.txt'), join(proj, 'link.txt'), 'file')) {
      expect((await rfs.readForEdit(childPath(root, 'link.txt'))).ok).toBe(false)
      expect((await rfs.writeForEdit({ file: childPath(root, 'link.txt'), text: 'pwned' })).ok).toBe(false)
      expect(fs.readFileSync(join(base, 'secret.txt'), 'utf8')).toBe('outside\n')
      fs.rmSync(join(proj, 'link.txt'))
    }
  }, 30000)

  it('reads, then saves atomically with conflict detection', async () => {
    const file = childPath(root, 'a.txt')
    const r = await rfs.readForEdit(file)
    expect(r).toMatchObject({ ok: true, text: 'one\n', bom: false })
    expect(r.hash).toMatch(/^sha256:/)
    const w = await rfs.writeForEdit({ file, text: 'two\n', expectHash: r.hash, expectSig: r.sig })
    expect(w.ok).toBe(true)
    expect(fs.readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('two\n')
    // Changed on the host meanwhile: refused, never overwritten.
    fs.writeFileSync(join(proj, 'a.txt'), 'agent\n')
    const w2 = await rfs.writeForEdit({ file, text: 'mine\n', expectHash: w.hash })
    expect(w2).toMatchObject({ ok: false, conflict: true })
    expect(fs.readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('agent\n')
    // No temporary file left next to it.
    expect(fs.readdirSync(proj).filter((n) => n.includes('tessel'))).toEqual([])
  }, 30000)

  it('keeps quotes, $ and backticks in names as text', async () => {
    const name = "it's $(touch pwned) `x`.txt"
    const c = await rfs.create({ root, dir: root, name })
    expect(c.ok).toBe(true)
    const w = await rfs.writeForEdit({ file: c.path, text: 'héllo\n' })
    expect(w.ok).toBe(true)
    expect(fs.readFileSync(join(proj, name), 'utf8')).toBe('héllo\n')
    expect(fs.existsSync(join(proj, 'pwned'))).toBe(false)
    expect(fs.existsSync(join(home, 'pwned'))).toBe(false)
  }, 30000)

  it('refuses binary and non-UTF-8 files like the local editor', async () => {
    fs.writeFileSync(join(proj, 'bin.dat'), Buffer.from([1, 0, 2]))
    fs.writeFileSync(join(proj, 'latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    expect(await rfs.readForEdit(childPath(root, 'bin.dat'))).toMatchObject({ ok: false, code: 'binary' })
    expect(await rfs.readForEdit(childPath(root, 'latin.txt'))).toMatchObject({ ok: false, code: 'encoding' })
  }, 30000)

  it('creates, renames, and deletes to the host user trash', async () => {
    const d = await rfs.create({ root, dir: root, name: 'docs', folder: true })
    expect(d.ok).toBe(true)
    const f = await rfs.create({ root, dir: d.path, name: 'x.md' })
    expect(f.ok).toBe(true)
    expect((await rfs.create({ root, dir: d.path, name: 'x.md' })).ok).toBe(false)
    const rn = await rfs.rename({ root, path: f.path, name: 'y.md' })
    expect(rn).toMatchObject({ ok: true, path: childPath(root, 'docs/y.md') })
    const tr = await rfs.trash({ root, path: rn.path })
    expect(tr.ok).toBe(true)
    expect(fs.existsSync(join(proj, 'docs', 'y.md'))).toBe(false)
    const trash = join(home, '.local', 'share', 'Trash')
    expect(fs.readdirSync(join(trash, 'files'))).toContain('y.md')
    expect(fs.readFileSync(join(trash, 'info', 'y.md.trashinfo'), 'utf8')).toMatch(/^\[Trash Info\]\nPath=\/.*\/docs\/y\.md\nDeletionDate=\d{4}-/)
    expect((await rfs.trash({ root, path: root })).ok).toBe(false)
  }, 30000)

  it('explorer status and the editor Changes view', async () => {
    const st = await rfs.projectStatus({ root })
    expect(st.ok).toBe(true)
    expect(st.files[childPath(root, 'a.txt')]).toBe('M')
    const head = await rfs.headContent(childPath(root, 'a.txt'))
    expect(head).toMatchObject({ ok: true, repo: true, isNew: false, text: 'one\n' })
  }, 30000)

  it('Changes: status, stage, commit (message through stdin), file versions', async () => {
    const s = await rfs.scm.scmStatus({ root })
    expect(s).toMatchObject({ ok: true, repo: true, top: root, branch: 'main' })
    const a = s.entries.find((e) => e.path === 'a.txt')
    expect(a).toMatchObject({ area: 'unstaged', status: 'modified', added: 1, removed: 1 })
    const v = await rfs.scm.scmFileVersions({ root, path: 'a.txt', area: 'unstaged' })
    expect(v).toMatchObject({ ok: true, original: 'one\n', modified: 'agent\n', exists: true, full: childPath(root, 'a.txt') })
    expect((await rfs.scm.scmStage({ root, paths: ['a.txt'] })).ok).toBe(true)
    const msg = "Fix 'quotes' $(no) `run`\n\nBody line"
    const c = await rfs.scm.scmCommit({ root, message: msg })
    expect(c.ok).toBe(true)
    expect(g('log', '-1', '--format=%B').trim()).toBe(msg)
    expect((await rfs.scm.scmStage({ root, paths: ['../secret.txt'] })).ok).toBe(false)
    const h = await rfs.scm.scmHistory({ root })
    expect(h.ok).toBe(true)
    expect(h.items[0].subject).toBe("Fix 'quotes' $(no) `run`")
  }, 60000)

  it('discard: tracked files restored, untracked ones to the trash', async () => {
    fs.writeFileSync(join(proj, 'src', 'main.js'), 'changed\n')
    fs.writeFileSync(join(proj, 'tmp.log'), 'junk\n')
    const res = await rfs.scm.scmDiscard({ root, paths: ['src/main.js', 'tmp.log'] })
    expect(res).toMatchObject({ ok: true, restored: 1, trashed: 1 })
    expect(fs.readFileSync(join(proj, 'src', 'main.js'), 'utf8')).toBe('console.log(1)\n')
    expect(fs.existsSync(join(proj, 'tmp.log'))).toBe(false)
  }, 60000)

  it('search by name and by content', async () => {
    const n = await rfs.searchNames({ root, query: 'MAIN' })
    expect(n.ok).toBe(true)
    expect(n.results.map((r) => r.rel)).toEqual(['src/main.js'])
    const c = await rfs.searchContent({ root, query: 'console' })
    expect(c.ok).toBe(true)
    expect(c.results).toEqual([{ path: childPath(root, 'src/main.js'), rel: 'src/main.js', line: 1, text: 'console.log(1)' }])
  }, 60000)

  it('polls watched files and reports a change made on the host', async () => {
    const file = childPath(root, 'src/main.js')
    rfs.watchFiles([file])
    await rfs.poll()
    fs.writeFileSync(join(proj, 'src', 'main.js'), 'console.log(2) // longer\n')
    sent.length = 0
    await rfs.poll()
    expect(sent.find(([c]) => c === 'editor:changed')).toEqual(['editor:changed', expect.objectContaining({ path: file, exists: true })])
    rfs.watchFiles([])
  }, 30000)

  it('cancel ends the session; the next operation starts a new one', async () => {
    expect(rfs.closeHost(HOST)).toBe(true)
    const res = await rfs.listDir({ root })
    expect(res.ok).toBe(true)
    expect(events.filter((e) => e[0] === 'started').length).toBeGreaterThanOrEqual(2)
  }, 30000)

  it('sparse checkout: its folders for the tree, and names searched below one', async () => {
    expect(await rfs.sparseInfo({ root })).toEqual({ ok: true, sparse: false, dirs: [] })
    g('sparse-checkout', 'set', '--cone', 'src')
    try {
      expect(await rfs.sparseInfo({ root })).toEqual({ ok: true, sparse: true, dirs: [{ rel: 'src', path: childPath(root, 'src') }] })
      const n = await rfs.searchNames({ root, dir: childPath(root, 'src'), query: 'a' })
      expect(n.results.map((r) => r.rel)).toEqual(['src/main.js'])
    } finally {
      g('sparse-checkout', 'disable')
    }
  }, 60000)

  it('keeps accented sparse folders on a remote host', async () => {
    const dir = '\u00e9tudes'
    fs.mkdirSync(join(proj, dir))
    fs.writeFileSync(join(proj, dir, 'notes.md'), 'x\n')
    g('add', '--', dir)
    g('commit', '-qm', 'accented folder')
    g('config', 'core.quotePath', 'true')
    g('sparse-checkout', 'set', '--cone', dir)
    try {
      expect(await rfs.sparseInfo({ root })).toEqual({
        ok: true, sparse: true, dirs: [{ rel: dir, path: childPath(root, dir) }]
      })
    } finally {
      g('sparse-checkout', 'disable')
    }
  }, 60000)
})

// The security review's probes, kept as regression tests.
describe.skipIf(!gitSh())('review: a repository config never runs code unasked; roots are the saved ones', () => {
  let base
  let proj
  let home
  let marks
  let root
  const g = (...a) => execFileSync('git', ['-C', proj, ...a], { stdio: 'pipe' }).toString()
  const readMarks = () => (fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8') : '')
  const make = (trusted, asks) =>
    createRemoteFs({
      hosts: stubHosts([]),
      spawnImpl: fakeSpawn({ home }),
      trust: () => ({
        decide: async (key, risky) => {
          asks.push({ key, keys: risky.map((r) => r.key) })
          return trusted
        }
      })
    })

  beforeAll(() => {
    base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-rfs-review-'))
    proj = join(base, 'proj')
    home = join(base, 'home')
    marks = join(base, 'marks.txt')
    for (const d of [proj, home, join(base, 'outside')]) fs.mkdirSync(d)
    fs.writeFileSync(join(base, 'outside', 'secret.txt'), 'TOP SECRET\n')
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    g('config', 'core.autocrlf', 'false')
    fs.writeFileSync(join(proj, 'a.txt'), 'one\n')
    fs.writeFileSync(join(proj, '.gitattributes'), 'a.txt filter=evil diff=evil\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    const m = posixPath(marks)
    g('config', 'core.fsmonitor', `echo FSMONITOR >> '${m}'; false`)
    g('config', 'filter.evil.clean', `echo CLEAN_FILTER >> '${m}'; cat`)
    fs.appendFileSync(join(proj, 'a.txt'), 'dirty\n')
    root = remoteRoot(HOST, posixPath(proj))
  })
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

  it('F1: Files status, Changes status and the background check run none of its programs until trusted', async () => {
    const asks = []
    const rfs = make(false, asks)
    rfs.setRoots([root])
    fs.writeFileSync(marks, '')
    expect((await rfs.projectStatus({ root })).ok).toBe(true)
    const s = await rfs.scm.scmStatus({ root })
    expect(s.ok).toBe(true)
    expect(s.entries.find((e) => e.path === 'a.txt')).toMatchObject({ area: 'unstaged' })
    expect((await rfs.headContent(childPath(root, 'a.txt'))).ok).toBe(true)
    rfs.watchRoot(root)
    await rfs.poll()
    await rfs.poll()
    await rfs.poll()
    rfs.unwatchRoots()
    expect(readMarks()).toBe('')
    // Asked once for the repository, naming what would run.
    expect(asks).toHaveLength(1)
    expect(asks[0].keys.map((k) => k.toLowerCase()).sort()).toEqual(['core.fsmonitor', 'filter.evil.clean'])
    rfs.close()
  }, 120000)

  it('F1: once trusted, its settings run as git would run them', async () => {
    const rfs = make(true, [])
    rfs.setRoots([root])
    fs.writeFileSync(marks, '')
    await rfs.scm.scmStatus({ root })
    expect(readMarks()).toMatch(/CLEAN_FILTER/)
    rfs.close()
  }, 60000)

  it('hooks in .git/hooks: asked about, and not run on commit until trusted', async () => {
    const hook = join(proj, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, `#!/bin/sh\necho HOOK_RAN >> '${posixPath(marks)}'\n`)
    fs.chmodSync(hook, 0o755)
    const commit = async (rfs, name) => {
      fs.writeFileSync(join(proj, name), 'x\n')
      const st = await rfs.scm.scmStage({ root, paths: [name] })
      if (!st.ok) throw new Error('stage: ' + st.error)
      const res = await rfs.scm.scmCommit({ root, message: `add ${name}` })
      if (!res.ok) throw new Error('commit: ' + res.error)
      return res
    }
    const asks = []
    const untrusted = make(false, asks)
    untrusted.setRoots([root])
    fs.writeFileSync(marks, '')
    expect((await commit(untrusted, 'h1.txt')).ok).toBe(true)
    expect(readMarks()).toBe('')
    expect(asks[0].keys).toContain('hook')
    untrusted.close()
    const trusted = make(true, [])
    trusted.setRoots([root])
    fs.writeFileSync(marks, '')
    await commit(trusted, 'h2.txt')
    expect(readMarks()).toMatch(/HOOK_RAN/)
    trusted.close()
    fs.rmSync(hook)
  }, 120000)

  it('F2: a root the window names is not a project: nothing outside the saved ones is reached', async () => {
    const rfs = make(false, [])
    rfs.setRoots([root])
    const secret = remoteRoot(HOST, posixPath(join(base, 'outside', 'secret.txt')))
    expect((await rfs.readForEdit(secret)).ok).toBe(false)
    expect((await rfs.listDir({ root: remoteRoot(HOST, '/') })).ok).toBe(false)
    expect((await rfs.listDir({ root: remoteRoot(HOST, posixPath(base)) })).ok).toBe(false)
    expect((await rfs.scm.scmStatus({ root: remoteRoot(HOST, posixPath(base)) })).ok).toBe(false)
    expect((await rfs.readForEdit(secret)).ok).toBe(false)
    expect((await rfs.writeForEdit({ file: secret, text: 'overwritten\n' })).ok).toBe(false)
    expect(fs.readFileSync(join(base, 'outside', 'secret.txt'), 'utf8')).toBe('TOP SECRET\n')
    rfs.close()
  }, 60000)

  it('F2: a repository whose top is above the project gives git its top, never the editor', async () => {
    const top = join(base, 'outer')
    fs.mkdirSync(join(top, 'app'), { recursive: true })
    execFileSync('git', ['-C', top, 'init', '-q'])
    fs.writeFileSync(join(top, 'private.txt'), 'outside the project\n')
    fs.writeFileSync(join(top, 'app', 'x.txt'), 'x\n')
    const appRoot = remoteRoot(HOST, posixPath(join(top, 'app')))
    const rfs = make(false, [])
    rfs.setRoots([appRoot])
    const s = await rfs.scm.scmStatus({ root: appRoot })
    expect(s.ok).toBe(true)
    expect(s.top).not.toBe(appRoot)
    // Files of the project, reached through the repository's top: fine.
    expect((await rfs.readForEdit(childPath(s.top, 'app/x.txt'))).ok).toBe(true)
    // A file of the repository outside the project: not for the editor, nor
    // for a diff's right side.
    expect((await rfs.readForEdit(childPath(s.top, 'private.txt'))).ok).toBe(false)
    const v = await rfs.scm.scmFileVersions({ root: appRoot, path: 'private.txt', area: 'untracked' })
    expect(v.ok && v.modified).toBeFalsy()
    rfs.close()
  }, 60000)

  it('saving over a FIFO is refused (it would block the session)', async () => {
    const fifo = join(proj, 'pipe')
    try {
      execFileSync(gitSh(), ['-c', `mkfifo '${posixPath(fifo)}'`])
    } catch {
      return // no FIFOs here
    }
    const rfs = make(false, [])
    rfs.setRoots([root])
    const w = await rfs.writeForEdit({ file: childPath(root, 'pipe'), text: 'x', expectHash: 'sha256:' + '0'.repeat(64) })
    expect(w.ok).toBe(false)
    expect((await rfs.readForEdit(childPath(root, 'pipe'))).ok).toBe(false)
    rfs.close()
    fs.rmSync(fifo, { force: true })
  }, 60000)
})

describe.skipIf(!gitSh())('connection failures', () => {
  it('says why ssh could not connect', async () => {
    const rfs = createRemoteFs({ hosts: stubHosts([]), spawnImpl: fakeSpawn({ exit: true }) })
    rfs.setRoots([remoteRoot(HOST, '/srv/app')])
    const res = await rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Permission denied/)
    rfs.close()
  }, 30000)

  it('without askpass, ssh runs in batch mode (it may not ask anything)', async () => {
    const argvFile = join(os.tmpdir(), `tessel-argv-${process.pid}.json`)
    const rfs = createRemoteFs({ hosts: stubHosts([]), spawnImpl: fakeSpawn({ exit: true, argvFile }) })
    rfs.setRoots([remoteRoot(HOST, '/srv/app')])
    await rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    const { argv } = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    expect(argv).toContain('BatchMode=yes')
    expect(argv[argv.length - 1]).toBe('exec /bin/sh')
    fs.rmSync(argvFile, { force: true })
    rfs.close()
  }, 30000)
})

// Never a sign-in nobody asked for (after a restart of Tessel with a remote
// project shown): no session for a host the user has not connected to in
// this run, unless its shared ssh2 connection is signed in already.
describe('no sign-in by itself', () => {
  const make = (shared) => {
    const sent = []
    const calls = []
    const spawnImpl = (...args) => {
      calls.push(args)
      throw Object.assign(new Error('spawn refused in this test'), { code: 'spawn' })
    }
    const hosts = { ...stubHosts([]), sharedConnected: () => shared }
    const rfs = createRemoteFs({ hosts, send: (c, p) => sent.push([c, p]), spawnImpl })
    rfs.setRoots([remoteRoot(HOST, '/srv/app')])
    return { rfs, sent, calls }
  }

  it('a host not connected: refused without starting ssh, the badge is told to offer Connect', async () => {
    const { rfs, sent, calls } = make(false)
    const res = await rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not connected/)
    const status = await rfs.projectStatus({ root: remoteRoot(HOST, '/srv/app') })
    expect(status.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(sent.some(([c, p]) => c === 'remoteFs:activity' && p.hostId === HOST && p.needsConnect === true)).toBe(true)
    rfs.close()
  })

  it('Connect (the user) may sign in, and so may later operations', async () => {
    const { rfs, calls } = make(false)
    await rfs.connect(HOST)
    expect(calls.length).toBeGreaterThan(0)
    const before = calls.length
    await rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    expect(calls.length).toBeGreaterThan(before)
    rfs.close()
  })

  it('a terminal opened on the host (allow) or an automation on the project (allowPath) may sign in', async () => {
    const a = make(false)
    a.rfs.allow(HOST)
    await a.rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    expect(a.calls.length).toBeGreaterThan(0)
    a.rfs.close()
    const b = make(false)
    b.rfs.allowPath(remoteRoot(HOST, '/srv/app'))
    await b.rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    expect(b.calls.length).toBeGreaterThan(0)
    b.rfs.close()
  })

  it('the shared connection already signed in: nothing to ask, it opens', async () => {
    const { rfs, calls } = make(true)
    await rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    expect(calls.length).toBeGreaterThan(0)
    rfs.close()
  })
})
