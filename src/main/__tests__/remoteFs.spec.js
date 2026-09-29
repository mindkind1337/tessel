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
    await rfs.listDir({ root: remoteRoot(HOST, '/srv/app') })
    const { argv } = JSON.parse(fs.readFileSync(argvFile, 'utf8'))
    expect(argv).toContain('BatchMode=yes')
    expect(argv[argv.length - 1]).toBe('exec /bin/sh')
    fs.rmSync(argvFile, { force: true })
    rfs.close()
  }, 30000)
})
