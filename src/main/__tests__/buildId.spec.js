// @vitest-environment node
// The build's sub id (buildId.js): b<commits> (<commit>), so a build is told
// apart from the release it comes after without touching the release's number.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readBuild, formatBuild, shortBuild, createBuildId } from '../buildId'

// git answering from a table
const fakeRun = (answers) => (_cmd, args, _opts, cb) => {
  const key = args.slice(2).join(' ')
  const out = answers[key]
  if (out === undefined) cb(new Error('no'), '')
  else cb(null, out + '\n')
}
const GOOD = { 'rev-list --count HEAD': '5421', 'rev-parse --short=7 HEAD': '8a26940' }

describe('reading it from git', () => {
  it('the number of commits and the short commit', async () => {
    expect(await readBuild('/repo', fakeRun(GOOD))).toEqual({ count: 5421, hash: '8a26940' })
  })
  it('no git, not a repository, or odd answers: nothing (never a wrong number)', async () => {
    expect(await readBuild('/repo', fakeRun({}))).toBeNull()
    expect(await readBuild('/repo', fakeRun({ ...GOOD, 'rev-list --count HEAD': 'abc' }))).toBeNull()
    expect(await readBuild('/repo', fakeRun({ ...GOOD, 'rev-parse --short=7 HEAD': 'not a hash' }))).toBeNull()
    expect(await readBuild('/repo', fakeRun({ ...GOOD, 'rev-list --count HEAD': '' }))).toBeNull()
  })
  it('on this very repository: a whole number of commits and a real commit', async () => {
    let root = process.cwd()
    while (!fs.existsSync(path.join(root, '.git')) && path.dirname(root) !== root) root = path.dirname(root)
    const b = await readBuild(root)
    expect(b).not.toBeNull()
    expect(Number.isInteger(b.count) && b.count > 0).toBe(true)
    expect(b.hash).toMatch(/^[0-9a-f]{7}$/)
  })
  it('its text', () => {
    expect(formatBuild({ count: 5421, hash: '8a26940' })).toBe('b5421 (8a26940)')
    expect(shortBuild({ count: 5421, hash: '8a26940' })).toBe('b5421')
    expect(formatBuild(null)).toBe('')
    expect(shortBuild(null)).toBe('')
  })
})

describe('the one a running Tessel gives', () => {
  it('a development Tessel follows the repository (read again after a few seconds, not at every call)', async () => {
    let n = 0
    let t = 0
    const answers = { ...GOOD }
    const run = (c, a, o, cb) => {
      n++
      fakeRun(answers)(c, a, o, cb)
    }
    const b = createBuildId({ root: '/repo', packaged: false, run, now: () => t })
    expect(await b.get()).toEqual({ count: 5421, hash: '8a26940' })
    expect(await b.get()).toEqual({ count: 5421, hash: '8a26940' })
    expect(n).toBe(2) // the count and the commit, once
    // A push: a new commit, seen once the cache has run out.
    answers['rev-list --count HEAD'] = '5422'
    answers['rev-parse --short=7 HEAD'] = 'b3c4d5e'
    expect((await b.get()).count).toBe(5421)
    t = 4000
    expect(await b.get()).toEqual({ count: 5422, hash: 'b3c4d5e' })
  })
  it('an installed Tessel has the one its build was made at, and never asks git', async () => {
    const run = () => {
      throw new Error('git must not run')
    }
    expect(await createBuildId({ root: '/x', packaged: true, baked: { count: 5430, hash: 'abcdef0' }, run }).get()).toEqual({ count: 5430, hash: 'abcdef0' })
    expect(await createBuildId({ root: '/x', packaged: true, baked: null, run }).get()).toBeNull()
    expect(await createBuildId({ root: '/x', packaged: true, baked: { count: 'x' }, run }).get()).toBeNull()
  })
  it('requests made together share one read', async () => {
    let n = 0
    const run = (c, a, o, cb) => {
      n++
      fakeRun(GOOD)(c, a, o, cb)
    }
    const b = createBuildId({ root: '/repo', packaged: false, run })
    await Promise.all([b.get(), b.get(), b.get()])
    expect(n).toBe(2)
  })
})

describe('it is shown and sent', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8')
  it('beside the version in the header, from the main process, baked into an installed build; the release version is untouched', () => {
    const app = read('renderer', 'src', 'App.vue')
    expect(app).toContain('data-test="brand-build"')
    expect(app).toContain("window.addEventListener('focus', readBuild)")
    expect(read('preload', 'index.js')).toContain("build: () => ipcRenderer.invoke('app:build')")
    const main = read('main', 'index.js')
    expect(main).toContain("ipcMain.handle('app:build'")
    expect(main).toContain('`build ${formatBuild(b)}`')
    const cfg = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'electron.vite.config.mjs'), 'utf8')
    expect(cfg).toContain("__TESSEL_BUILD__: JSON.stringify(command === 'build' ? bakedBuild() : null)")
    // The sub id never rewrites package.json: a release stays x.y.z.
    expect(main + app).not.toMatch(/package\.json.*version.*build/i)
  })
})
