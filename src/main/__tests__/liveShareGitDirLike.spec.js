// Live Share: a repository's own folder kept under another name than .git
// (a bare repository inside the project: HEAD, objects and refs in it) is
// hidden from guests like .git, with all it holds (its config and hooks,
// which git runs when a command runs there), and a guest never makes the
// last of those three in a folder, not even two guests at once. Synthetic
// folders only: no git command runs in them, no hook runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createShareRequests } from '../liveShare/shareRequests'
import { createShareScope, looksGitDir, completesGitDir, rootInfo } from '../liveShare/shareScope'
import { setGitTrust } from '../gitSafety'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
const put = (base, rel, text = 'x') => {
  const p = join(base, ...rel.split('/'))
  fs.mkdirSync(join(p, '..'), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
let dir
let root
let requests
const ALL = { edit: true, type: true, git: true }
const ask = (op, args, rights = ALL, settings = {}) =>
  requests.handle({ op, project: 'p1', args }, { roots: { p1: root }, rights, settings, trashItem: async () => {}, recheck: () => true })
// A bare repository's folder, made by hand.
function bareAt(rel) {
  put(root, `${rel}/HEAD`, 'ref: refs/heads/main\n')
  fs.mkdirSync(join(root, ...rel.split('/'), 'objects'), { recursive: true })
  fs.mkdirSync(join(root, ...rel.split('/'), 'refs', 'heads'), { recursive: true })
  put(root, `${rel}/config`, '[core]\n\tbare = true\n\tneedle = findme\n')
  put(root, `${rel}/hooks/pre-receive`, '#!/bin/sh\necho findme\n')
}

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-ls-gitdir-')))
  root = join(dir, 'proj')
  fs.mkdirSync(root)
  g(root, 'init', '-q', '-b', 'main')
  put(root, 'src/a.js', 'a')
  requests = createShareRequests({ scope: createShareScope() })
})
afterEach(() => {
  setGitTrust(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the signature', () => {
  it('HEAD, objects and refs in a folder, whatever they are', () => {
    bareAt('repos/service')
    expect(looksGitDir(join(root, 'repos', 'service'))).toBe(true)
    expect(looksGitDir(join(root, 'repos'))).toBe(false)
    put(root, 'two/HEAD')
    put(root, 'two/objects')
    expect(looksGitDir(join(root, 'two'))).toBe(false)
    expect(completesGitDir(join(root, 'two'), 'refs')).toBe(true)
    expect(completesGitDir(join(root, 'two'), 'REFS')).toBe(true)
    expect(completesGitDir(join(root, 'two'), 'objects')).toBe(false)
    expect(completesGitDir(join(root, 'two'), 'refs2')).toBe(false)
  })
})

describe('a bare repository inside the project', () => {
  beforeEach(() => bareAt('repos/service'))

  for (const settings of [{}, { hideIgnored: false }]) {
    it(`is hidden with all it holds (hide ignored ${settings.hideIgnored !== false})`, async () => {
      const listed = await ask('fs.list', { dir: 'repos' }, ALL, settings)
      expect(listed.ok).toBe(true)
      expect(listed.data.entries.map((e) => e.name)).toEqual([])
      for (const p of ['repos/service', 'repos/service/config', 'repos/service/hooks/pre-receive', 'REPOS/Service/CONFIG'])
        expect((await ask('fs.read', { path: p }, ALL, settings)).ok, p).toBe(false)
      expect((await ask('fs.list', { dir: 'repos/service/hooks' }, ALL, settings)).ok).toBe(false)
      expect(await ask('fs.write', { path: 'repos/service/hooks/pre-receive', text: 'y', expectHash: 'x'.repeat(64) }, ALL, settings)).toMatchObject({ ok: false })
      expect(await ask('fs.write', { path: 'repos/service/hooks/post-update', text: 'y' }, ALL, settings)).toMatchObject({ ok: false })
      expect(await ask('fs.create', { dir: 'repos/service', name: 'x' }, ALL, settings)).toMatchObject({ ok: false })
      expect(fs.existsSync(join(root, 'repos', 'service', 'hooks', 'post-update'))).toBe(false)
      // Not moved, renamed or put in the Recycle Bin, nor the folder it is in.
      expect(await ask('fs.rename', { path: 'repos/service', name: 'svc' }, ALL, settings)).toMatchObject({ ok: false })
      expect(await ask('fs.rename', { path: 'repos', name: 'r2' }, ALL, settings)).toEqual({ ok: false, code: 'not-allowed' })
      expect(await ask('fs.trash', { path: 'repos' }, ALL, settings)).toEqual({ ok: false, code: 'not-allowed' })
      // Not found by a search, nor in the project's file list.
      const names = await ask('fs.searchNames', { query: 'pre-receive' }, ALL, settings)
      expect(names.ok && names.data.results).toEqual([])
      const content = await ask('fs.searchContent', { query: 'findme' }, ALL, settings)
      expect(content.ok && content.data.results).toEqual([])
      const files = await ask('fs.fileList', {}, ALL, settings)
      expect(files.ok).toBe(true)
      expect(JSON.stringify(files.data.files)).toMatch(/a\.js/)
      expect(files.data.files.some((f) => /service/i.test(typeof f === 'string' ? f : f.rel || f.path))).toBe(false)
      // Nor in git's status (untracked there).
      const st = await ask('scm.status', {}, ALL, settings)
      expect(st.ok).toBe(true)
      expect(JSON.stringify(st)).toMatch(/src/)
      expect(JSON.stringify(st)).not.toMatch(/service/i)
      const fst = await ask('fs.status', {}, ALL, settings)
      expect(fst.ok).toBe(true)
      expect(JSON.stringify(fst)).not.toMatch(/service/i)
    })
  }

  it('through a link to it too', async () => {
    try {
      fs.symlinkSync(join(root, 'repos', 'service'), join(root, 'lnk'), 'junction')
    } catch {
      return
    }
    expect((await ask('fs.read', { path: 'lnk/config' })).ok).toBe(false)
    expect((await ask('fs.list', { dir: 'lnk' })).ok).toBe(false)
    const listed = await ask('fs.list', { dir: '' })
    expect(listed.data.entries.map((e) => e.name)).not.toContain('lnk')
  })

  it('the rest of the project as before', async () => {
    const listed = await ask('fs.list', { dir: '' })
    expect(listed.data.entries.map((e) => e.name).sort()).toEqual(['repos', 'src'])
    // Only two of the three, or a name ending in .git: a folder as any other.
    put(root, 'half/HEAD', 'h')
    fs.mkdirSync(join(root, 'half', 'objects'))
    put(root, 'app.git/readme.txt', 'r')
    expect((await ask('fs.read', { path: 'half/HEAD' })).ok).toBe(true)
    expect((await ask('fs.read', { path: 'app.git/readme.txt' })).ok).toBe(true)
    const r = await ask('fs.read', { path: 'src/a.js' })
    expect((await ask('fs.write', { path: 'src/a.js', text: 'b', expectHash: r.data.hash })).ok).toBe(true)
  })
})

describe('a guest never makes the last of the three', () => {
  beforeEach(() => {
    put(root, 'x/HEAD', 'ref: refs/heads/main\n')
    fs.mkdirSync(join(root, 'x', 'objects'))
  })

  it('by a new folder or file, a save or a new name, in any case', async () => {
    expect(await ask('fs.create', { dir: 'x', name: 'refs', folder: true })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.create', { dir: 'x', name: 'Refs' })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('fs.write', { path: 'x/REFS', text: 'y' })).toEqual({ ok: false, code: 'not-allowed' })
    fs.mkdirSync(join(root, 'x', 'refs2'))
    expect(await ask('fs.rename', { path: 'x/refs2', name: 'refs' })).toEqual({ ok: false, code: 'not-allowed' })
    expect(fs.existsSync(join(root, 'x', 'refs'))).toBe(false)
    // Another name in it, or a mark where the other two are not: as before.
    expect((await ask('fs.create', { dir: 'x', name: 'notes.txt' })).ok).toBe(true)
    expect((await ask('fs.create', { dir: 'src', name: 'refs', folder: true })).ok).toBe(true)
  })

  it('nor two guests at once', async () => {
    fs.rmSync(join(root, 'x', 'objects'), { recursive: true })
    const both = await Promise.all([ask('fs.create', { dir: 'x', name: 'objects', folder: true }), ask('fs.create', { dir: 'x', name: 'refs', folder: true })])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(looksGitDir(join(root, 'x'))).toBe(false)
  })
})

describe('a discard never brings back the last of the three', () => {
  it('refused; another discard as before', async () => {
    g(root, 'config', 'user.email', 'host@example.invalid')
    g(root, 'config', 'user.name', 'Host')
    g(root, 'config', 'core.autocrlf', 'false')
    put(root, 'x/objects/k', 'o')
    put(root, 'x/refs/k', 'r')
    g(root, 'add', '-A')
    g(root, 'commit', '-qm', 'init')
    fs.rmSync(join(root, 'x', 'refs'), { recursive: true })
    put(root, 'x/HEAD', 'ref: refs/heads/main\n')
    put(root, 'x/config', '[core]\n')
    expect(await ask('scm.discard', { paths: ['x/refs/k'] })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('scm.discard', { paths: ['x/refs'] })).toEqual({ ok: false, code: 'not-allowed' })
    expect(fs.existsSync(join(root, 'x', 'refs'))).toBe(false)
    expect(looksGitDir(join(root, 'x'))).toBe(false)
    // A deleted file elsewhere: brought back.
    fs.rmSync(join(root, 'src', 'a.js'))
    g(root, 'add', '-A', 'src')
    g(root, 'commit', '-qm', 'a')
    put(root, 'src/a.js', 'changed')
    expect((await ask('scm.discard', { paths: ['src/a.js'] })).ok).toBe(true)
  })
})

describe('a project folder that is a repository’s own, or in one', () => {
  it('is never shared', () => {
    bareAt('srv/app')
    expect(rootInfo(join(root, 'srv', 'app'))).toBe(null)
    fs.mkdirSync(join(root, 'srv', 'app', 'hooks'), { recursive: true })
    expect(rootInfo(join(root, 'srv', 'app', 'hooks'))).toBe(null)
    fs.mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    expect(rootInfo(join(root, '.git', 'hooks'))).toBe(null)
    expect(rootInfo(join(root, '.git'))).toBe(null)
    expect(rootInfo(join(root, 'src'))).not.toBe(null)
  })
})

describe('HEAD with a commondir file (a worktree’s own folder)', () => {
  it('is hidden, and never made', async () => {
    put(root, 'a/HEAD', 'ref: refs/heads/main\n')
    put(root, 'a/commondir', '../b\n')
    put(root, 'a/sub/x.txt', 'x')
    put(root, 'b/config', '[core]\n')
    expect(looksGitDir(join(root, 'a'))).toBe(true)
    expect((await ask('fs.read', { path: 'a/sub/x.txt' })).ok).toBe(false)
    expect((await ask('fs.list', { dir: '' })).data.entries.map((e) => e.name)).not.toContain('a')
    expect(rootInfo(join(root, 'a', 'sub'))).toBe(null)
    put(root, 'c/HEAD', 'h')
    expect(await ask('fs.create', { dir: 'c', name: 'commondir' })).toEqual({ ok: false, code: 'not-allowed' })
    put(root, 'd/commondir', '../b\n')
    expect(await ask('fs.write', { path: 'd/HEAD', text: 'ref: refs/heads/main\n' })).toEqual({ ok: false, code: 'not-allowed' })
  })
})

describe('a discard of several files never brings back a repository’s folder', () => {
  beforeEach(() => {
    g(root, 'config', 'user.email', 'host@example.invalid')
    g(root, 'config', 'user.name', 'Host')
    g(root, 'config', 'core.autocrlf', 'false')
  })

  it('two marks at once, from the index', async () => {
    put(root, 'x/HEAD', 'ref: refs/heads/main\n')
    put(root, 'x/objects/o', 'o')
    g(root, 'add', '-A')
    fs.rmSync(join(root, 'x', 'HEAD'))
    fs.rmSync(join(root, 'x', 'objects'), { recursive: true })
    put(root, 'x/refs/r', 'r')
    expect(await ask('scm.discard', { paths: ['x/HEAD', 'x/objects/o'] })).toEqual({ ok: false, code: 'not-allowed' })
    expect(looksGitDir(join(root, 'x'))).toBe(false)
  })

  it('a whole folder', async () => {
    put(root, 'x/HEAD', 'ref: refs/heads/main\n')
    put(root, 'x/objects/o', 'o')
    put(root, 'x/refs/r', 'r')
    g(root, 'add', '-A')
    fs.rmSync(join(root, 'x'), { recursive: true })
    expect(await ask('scm.discard', { paths: ['x'] })).toEqual({ ok: false, code: 'not-allowed' })
    expect(await ask('scm.discard', { paths: ['x/HEAD', 'x/objects/o', 'x/refs/r'] })).toEqual({ ok: false, code: 'not-allowed' })
    expect(fs.existsSync(join(root, 'x'))).toBe(false)
    // One of them alone: brought back.
    expect((await ask('scm.discard', { paths: ['x/objects/o'] })).ok).toBe(true)
    expect(fs.existsSync(join(root, 'x', 'objects', 'o'))).toBe(true)
  })
})
