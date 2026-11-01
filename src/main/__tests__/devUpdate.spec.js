// @vitest-environment node
// A development Tessel says when GitHub has newer builds, and brings them in
// only when that cannot hurt (a fast-forward of a copy with no change of its
// own). Run against real repositories: a bare "GitHub", the user's copy, and
// another clone that pushes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createDevUpdate, devRestartCommand } from '../devUpdate'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()

let dir, origin, mine, other
const commit = (repo, file, text, msg) => {
  fs.writeFileSync(path.join(repo, file), text)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', msg)
}
const make = (extra = {}) => {
  const sent = []
  const du = createDevUpdate({ root: mine, send: (ch, p) => sent.push([ch, p]), ...extra })
  return { du, sent }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-devupd-'))
  origin = path.join(dir, 'origin.git')
  mine = path.join(dir, 'mine')
  other = path.join(dir, 'other')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, mine], { stdio: 'ignore' })
  git(mine, 'checkout', '-q', '-B', 'main')
  commit(mine, 'a.txt', '1', 'first')
  git(mine, 'push', '-q', '-u', 'origin', 'main')
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('knowing there is something new', () => {
  it('up to date: nothing to say', async () => {
    const { du } = make()
    expect((await du.check()).state).toBe('none')
  })
  it('new commits on GitHub: how many, which build, what they are, said to the window', async () => {
    commit(other, 'b.txt', '2', 'Add b')
    commit(other, 'c.txt', '3', 'Add c\u001b[31m')
    git(other, 'push', '-q', 'origin', 'main')
    const { du, sent } = make()
    const s = await du.check()
    expect(s).toMatchObject({ state: 'available', behind: 2, ahead: 0, newBuild: 3, upstream: 'origin/main', blocked: '', depsChanged: false, mainChanged: false })
    expect(s.commits.map((c) => c.subject)).toEqual(['Add c [31m', 'Add b'])
    expect(s.commits[0].subject).not.toMatch(/\u001b/)
    expect(sent.at(-1)).toEqual(['devUpdate:status', s])
  })
  it('says when the main process or the packages change', async () => {
    fs.mkdirSync(path.join(other, 'src/main'), { recursive: true })
    commit(other, 'src/main/x.js', 'x', 'main')
    commit(other, 'package.json', '{}', 'deps')
    git(other, 'push', '-q', 'origin', 'main')
    const { du } = make()
    expect(await du.check()).toMatchObject({ mainChanged: true, depsChanged: true })
  })
  it('a copy that follows nothing, or cannot reach GitHub, is not a failure of Tessel', async () => {
    git(mine, 'checkout', '-q', '--detach')
    expect((await make().du.check()).state).toBe('none')
    git(mine, 'checkout', '-q', 'main')
    fs.rmSync(origin, { recursive: true, force: true })
    expect(await make().du.check()).toMatchObject({ state: 'error', reason: 'fetch' })
  })
  it('an installed Tessel never runs it', async () => {
    const { du, sent } = make({ packaged: true })
    expect((await du.check()).state).toBe('disabled')
    expect(await du.apply()).toMatchObject({ ok: false })
    expect(sent).toEqual([])
  })
})

describe('bringing it in', () => {
  const push = () => {
    commit(other, 'b.txt', '2', 'Add b')
    git(other, 'push', '-q', 'origin', 'main')
  }
  it('a clean copy is fast-forwarded', async () => {
    push()
    const { du } = make()
    await du.check()
    const r = await du.apply()
    expect(r).toMatchObject({ ok: true, behind: 1 })
    expect(fs.existsSync(path.join(mine, 'b.txt'))).toBe(true)
    expect(du.status.state).toBe('updated')
    expect((await du.check()).state).toBe('none')
  })
  it('changes that are not committed: nothing is touched, the user is told', async () => {
    push()
    fs.writeFileSync(path.join(mine, 'a.txt'), 'mine')
    const { du } = make()
    expect(await du.check()).toMatchObject({ state: 'available', blocked: 'dirty' })
    expect(await du.apply()).toEqual({ ok: false, reason: 'dirty' })
    expect(fs.readFileSync(path.join(mine, 'a.txt'), 'utf8')).toBe('mine')
    expect(fs.existsSync(path.join(mine, 'b.txt'))).toBe(false)
  })
  it('commits of its own: no merge is made for the user', async () => {
    push()
    commit(mine, 'own.txt', 'own', 'mine')
    const { du } = make()
    expect(await du.check()).toMatchObject({ state: 'available', blocked: 'ahead', ahead: 1 })
    const head = git(mine, 'rev-parse', 'HEAD')
    expect(await du.apply()).toEqual({ ok: false, reason: 'ahead' })
    expect(git(mine, 'rev-parse', 'HEAD')).toBe(head)
  })
  it('nothing new: nothing done', async () => {
    const { du } = make()
    expect(await du.apply()).toEqual({ ok: false, reason: 'current' })
  })
})

describe('restart to apply: the background code changed since the app started', () => {
  const clock = { t: 1_000_000 }
  const fresh = () => {
    const { du } = make({ now: () => (clock.t += 10_000) })
    return du
  }
  const pushFrom = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(other, file)), { recursive: true })
    commit(other, file, text, `change ${file}`)
    git(other, 'push', '-q', 'origin', 'main')
  }
  it('nothing changed since the start: no banner', async () => {
    expect(await fresh().restartNeeded()).toEqual({ needed: false, count: 0, files: [] })
  })
  it('a merge that changes src/main or src/preload or launch.mjs: the banner, with the files', async () => {
    const du = fresh()
    pushFrom('src/main/a.js', 'a')
    pushFrom('launch.mjs', 'l')
    await du.check()
    expect((await du.restartNeeded()).needed).toBe(false) // fetched, not merged: the running code is the same files
    await du.apply()
    expect(await du.restartNeeded()).toEqual({ needed: true, count: 2, files: ['launch.mjs', 'src/main/a.js'] })
  })
  it('an edit not committed counts too; a renderer-only change does not', async () => {
    fs.mkdirSync(path.join(mine, 'src/renderer'), { recursive: true })
    fs.mkdirSync(path.join(mine, 'src/preload'), { recursive: true })
    const du = fresh()
    commit(mine, 'src/renderer/x.vue', 'x', 'renderer only')
    expect((await du.restartNeeded()).needed).toBe(false)
    fs.writeFileSync(path.join(mine, 'src/preload/p.js'), 'p')
    git(mine, 'add', 'src/preload/p.js')
    expect(await du.restartNeeded()).toMatchObject({ needed: true, count: 1, files: ['src/preload/p.js'] })
  })
  it('an installed Tessel never shows it', async () => {
    const { du } = make({ packaged: true })
    expect((await du.restartNeeded()).needed).toBe(false)
  })
})

describe('restart now: how the next Tessel starts', () => {
  it('launch.mjs in the background, told to wait for this process; npm\u2019s node, never Electron\u2019s program', () => {
    const c = devRestartCommand({ root: 'C:\\Tessel', pid: 4242, env: { npm_node_execpath: 'C:\\node\\node.exe', ELECTRON_RENDERER_URL: 'http://127.0.0.1:5737', ELECTRON_RUN_AS_NODE: '1', KEEP: 'x' }, execPath: 'C:\\Tessel\\node_modules\\electron\\dist\\electron.exe' })
    expect(c.file).toBe('C:\\node\\node.exe')
    expect(c.args).toEqual(['C:\\Tessel/launch.mjs', 'dev', '--hidden', '--wait-for', '4242'])
    expect(c.options).toMatchObject({ cwd: 'C:\\Tessel', detached: true, stdio: 'ignore', windowsHide: true })
    expect(c.options.env.KEEP).toBe('x')
    expect(c.options.env.ELECTRON_RENDERER_URL).toBeUndefined()
    expect(c.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
  it('no npm node known and Electron as the program: plain node from the path', () => {
    const c = devRestartCommand({ root: '/repo/', pid: 1, env: {}, execPath: '/x/electron' })
    expect(c.file).toBe('node')
    expect(c.args[0]).toBe('/repo/launch.mjs')
  })
})
