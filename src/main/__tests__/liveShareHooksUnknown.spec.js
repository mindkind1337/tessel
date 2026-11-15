// Live Share: when git cannot tell where the project's hooks run from
// (core.hooksPath: git failing, timing out) or whether the folder is a
// repository, a guest writes nothing (no file looks unprotected for a
// while) and what git ignores stays hidden; asked again on the next request.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { createShareRequests } from '../liveShare/shareRequests'
import { createShareScope, UNKNOWN_RETRY_MS } from '../liveShare/shareScope'
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
const E = { edit: true }
const ask = (op, args, rights = {}) =>
  requests.handle({ op, project: 'p1', args }, { roots: { p1: root }, rights, settings: {}, trashItem: async () => {}, recheck: () => true })

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-ls-hooks-')))
  root = join(dir, 'proj')
  fs.mkdirSync(root)
  g(root, 'init', '-q', '-b', 'main')
  put(root, 'src/a.js', 'a')
})
// Later than the retry delay of an unknown answer.
function later() {
  const now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now + UNKNOWN_RETRY_MS + 1000)
}
afterEach(() => {
  vi.restoreAllMocks()
  setGitTrust(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

async function write(path, rights = E) {
  const r = await ask('fs.read', { path }, rights)
  expect(r.ok, path).toBe(true)
  return { readOnly: r.data.readOnly, res: await ask('fs.write', { path, text: 'y', expectHash: r.data.hash }, rights) }
}

describe('the hooks folder cannot be told', () => {
  for (const [what, fail] of [
    ['git fails', async () => undefined],
    ['git throws', async () => { throw new Error('timed out') }]
  ]) {
    it(`${what}: read-only, nothing written; asked again next time`, async () => {
      let broken = true
      const hooksPath = vi.fn(async (...a) => (broken ? fail(...a) : null))
      requests = createShareRequests({ scope: createShareScope({ hooksPath }) })
      let w = await write('src/a.js')
      expect(w.readOnly).toBe(true)
      expect(w.res).toEqual({ ok: false, code: 'not-allowed' })
      // The type right does not get round it either (as for an SSH project).
      w = await write('src/a.js', { edit: true, type: true })
      expect(w.res).toEqual({ ok: false, code: 'not-allowed' })
      expect(await ask('notes.save', { text: 'n' }, { edit: true, type: true })).toEqual({ ok: false, code: 'not-allowed' })
      // Not asked again on every request.
      const asked = hooksPath.mock.calls.length
      broken = false
      expect((await write('src/a.js')).res).toEqual({ ok: false, code: 'not-allowed' })
      expect(hooksPath.mock.calls.length).toBe(asked)
      // A while later: git answers again, the file can be saved.
      later()
      w = await write('src/a.js')
      expect(w.readOnly).toBe(false)
      expect(w.res.ok).toBe(true)
      expect(fs.readFileSync(join(root, 'src', 'a.js'), 'utf8')).toBe('y')
    })
  }

  it('a hooks folder set, or none: as before', async () => {
    const real = createShareScope()
    requests = createShareRequests({ scope: real })
    expect((await write('src/a.js')).res.ok).toBe(true)
    g(root, 'config', 'core.hooksPath', '.')
    real.invalidate()
    requests = createShareRequests({ scope: createShareScope() })
    put(root, 'pre-commit', 'x')
    expect((await write('pre-commit')).res).toEqual({ ok: false, code: 'not-allowed' })
    expect((await write('src/a.js')).res.ok).toBe(true)
    // ~ is git's home folder: outside the project.
    g(root, 'config', 'core.hooksPath', '~/hooks-elsewhere')
    requests = createShareRequests({ scope: createShareScope() })
    expect((await write('pre-commit')).res.ok).toBe(true)
  })

  it('~ in core.hooksPath is the home folder, as git reads it', async () => {
    const home = process.env.HOME
    process.env.HOME = root
    try {
      g(root, 'config', 'core.hooksPath', '~/h')
      put(root, 'h/pre-commit', 'x')
      requests = createShareRequests({ scope: createShareScope() })
      expect((await write('h/pre-commit')).res).toEqual({ ok: false, code: 'not-allowed' })
      expect((await write('src/a.js')).res.ok).toBe(true)
    } finally {
      if (home === undefined) delete process.env.HOME
      else process.env.HOME = home
    }
  })
})

describe('whether it is a repository cannot be told', () => {
  it('everything git could ignore is hidden, nothing written; asked again next time', async () => {
    put(root, '.gitignore', 'local.yml\n')
    put(root, 'local.yml', 'secret')
    let broken = true
    const gitTop = vi.fn(async () => {
      if (broken) throw new Error('git rev-parse: null')
      return root
    })
    requests = createShareRequests({ scope: createShareScope({ gitTop }) })
    const listed = await ask('fs.list', { dir: '' })
    const names = listed.ok ? listed.data.entries.map((e) => e.name) : []
    expect(names).not.toContain('local.yml')
    expect(names).not.toContain('src')
    expect((await ask('fs.read', { path: 'local.yml' })).ok).toBe(false)
    broken = false
    later()
    const again = await ask('fs.list', { dir: '' })
    expect(again.data.entries.map((e) => e.name)).toContain('src')
    expect(again.data.entries.map((e) => e.name)).not.toContain('local.yml')
    expect((await write('src/a.js')).res.ok).toBe(true)
  })

  it('a repository git refuses (a broken .git file): unknown too, not "not one"', async () => {
    const odd = join(dir, 'odd')
    put(odd, '.git', 'gitdir: ' + join(dir, 'nowhere'))
    put(odd, 'b.txt', 'b')
    root = odd
    requests = createShareRequests({ scope: createShareScope() })
    // What git ignores cannot be told: hidden, as everything else.
    expect((await ask('fs.read', { path: 'b.txt' }, E)).ok).toBe(false)
    expect(await ask('fs.write', { path: 'b.txt', text: 'y', expectHash: 'x' }, E)).toMatchObject({ ok: false })
    expect(fs.readFileSync(join(odd, 'b.txt'), 'utf8')).toBe('b')
  })

  it('a folder that is not one: shown and written as before', async () => {
    const plain = join(dir, 'plain')
    put(plain, 'b.txt', 'b')
    root = plain
    requests = createShareRequests({ scope: createShareScope() })
    const listed = await ask('fs.list', { dir: '' })
    expect(listed.data.entries.map((e) => e.name)).toContain('b.txt')
    expect((await write('b.txt')).res.ok).toBe(true)
  })
})
