import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { resolveFiles, forgetDeadRoots, statRoot, lookablePath, regValue, defaultWslDistro, MAX_RESOLVE } from '../fileOpen'
import { codexImageInEntry, codexImageFile } from '../pastedImages'

let dir
beforeAll(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-resolve-'))
  fs.mkdirSync(join(dir, 'src'))
  fs.writeFileSync(join(dir, 'src', 'a.js'), 'x')
  fs.writeFileSync(join(dir, 'Makefile'), 'all:')
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
beforeEach(() => forgetDeadRoots())

describe('files:resolve (terminal links)', () => {
  it('files only by default; files and folders with detail', async () => {
    const q = { cwd: dir, paths: ['src/a.js', 'src', 'nope.js', 'Makefile'] }
    expect(await resolveFiles(q)).toEqual({ 'src/a.js': join(dir, 'src', 'a.js'), src: null, 'nope.js': null, Makefile: join(dir, 'Makefile') })
    const d = await resolveFiles({ ...q, detail: true })
    expect(d.src).toEqual({ path: join(dir, 'src'), kind: 'dir' })
    expect(d['src/a.js']).toEqual({ path: join(dir, 'src', 'a.js'), kind: 'file' })
    expect(d['nope.js']).toBe(null)
  })
  it('"~" is the home folder', async () => {
    const res = await resolveFiles({ paths: ['~/src/a.js'], detail: true }, { home: dir })
    expect(res['~/src/a.js']).toEqual({ path: join(dir, 'src', 'a.js'), kind: 'file' })
  })
  it('a look that does not answer in time gives up, and its drive is skipped for a while', async () => {
    const asked = []
    const stat = (p) => {
      asked.push(p)
      return p.startsWith('Z:') ? new Promise(() => {}) : fs.promises.stat(p)
    }
    const t0 = Date.now()
    const res = await resolveFiles({ paths: ['Z:\\dead\\a.js', 'Z:\\dead\\b.js', join(dir, 'src', 'a.js')] }, { stat, timeoutMs: 50 })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(res['Z:\\dead\\a.js']).toBe(null)
    expect(res[join(dir, 'src', 'a.js')]).toBe(join(dir, 'src', 'a.js'))
    // One look per dead drive: the second path on it was never asked.
    expect(asked.filter((p) => p.startsWith('Z:'))).toEqual(['Z:\\dead\\a.js'])
    await resolveFiles({ paths: ['Z:\\dead\\c.js'] }, { stat, timeoutMs: 50 })
    expect(asked.filter((p) => p.startsWith('Z:'))).toHaveLength(1)
  })
  it('never a network share or a device path; WSL share allowed', async () => {
    const asked = []
    const stat = async (p) => {
      asked.push(p)
      throw new Error('missing')
    }
    await resolveFiles({ paths: ['\\\\evil\\share\\a.txt', '//evil/share/a.txt', '\\\\?\\C:\\a.txt', '\\\\.\\pipe\\x', '\\\\wsl.localhost\\Ubuntu\\a.txt', '\\\\wsl$\\Ubuntu\\b.txt'] }, { stat })
    expect(asked).toEqual(['\\\\wsl.localhost\\Ubuntu\\a.txt', '\\\\wsl$\\Ubuntu\\b.txt'])
    expect(lookablePath('\\\\wsl.localhost\\Ubuntu')).toBe(true)
    expect(lookablePath('\\\\server\\share')).toBe(false)
    expect(statRoot('\\\\wsl.localhost\\Ubuntu\\home')).toBe('\\\\wsl.localhost\\ubuntu')
    expect(statRoot('c:\\x')).toBe('C:')
  })
  it('caps a batch; SSH paths go to the remote look-up', async () => {
    const many = Array.from({ length: MAX_RESOLVE + 20 }, (_, i) => `f${i}.js`)
    const res = await resolveFiles({ cwd: dir, paths: many })
    expect(Object.keys(res)).toHaveLength(MAX_RESOLVE)
    const seen = []
    const remote = async (paths) => {
      seen.push(...paths)
      return { 'ssh://ssh-b1/srv/app/a.js': 'file', 'ssh://ssh-b1/srv/app/src': 'dir' }
    }
    const r = await resolveFiles({ paths: ['ssh://ssh-b1/srv/app/a.js', 'ssh://ssh-b1/srv/app/src', 'ssh://ssh-b1/srv/app/x'], detail: true }, { remote })
    expect(seen).toHaveLength(3)
    expect(r['ssh://ssh-b1/srv/app/a.js']).toEqual({ path: 'ssh://ssh-b1/srv/app/a.js', kind: 'file' })
    expect(r['ssh://ssh-b1/srv/app/src']).toEqual({ path: 'ssh://ssh-b1/srv/app/src', kind: 'dir' })
    expect(r['ssh://ssh-b1/srv/app/x']).toBe(null)
    // A relative path never counts from an ssh:// folder on this PC.
    expect(await resolveFiles({ cwd: 'ssh://ssh-b1/srv/app', paths: ['a.js'] })).toEqual({ 'a.js': null })
  })
})

describe('the WSL default distro', () => {
  it('reads it from the registry like wsl.exe', async () => {
    expect(regValue('\r\nHKEY_CURRENT_USER\\x\r\n    DefaultDistribution    REG_SZ    {aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\r\n', 'DefaultDistribution')).toBe('{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}')
    const run = (_f, args, _o, cb) => {
      const key = args[1]
      if (/Lxss$/.test(key)) cb(null, '    DefaultDistribution    REG_SZ    {aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}\r\n')
      else cb(null, '    DistributionName    REG_SZ    Ubuntu-24.04\r\n')
    }
    expect(await defaultWslDistro({ run, platform: 'win32' })).toBe('Ubuntu-24.04')
    expect(await defaultWslDistro({ run: (_f, _a, _o, cb) => cb(new Error('none')), platform: 'win32' })).toBe(null)
    expect(await defaultWslDistro({ run, platform: 'linux' })).toBe(null)
  })
})

describe('[Image #N] in a Codex pane', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  const entry = (n, data = png) => ({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: `<image name=[Image #${n}] path="C:\\Temp\\codex-clipboard-x.png">` },
        { type: 'input_image', image_url: `data:image/png;base64,${data}` },
        { type: 'input_text', text: '</image>' }
      ]
    }
  })
  it('finds the image after its tag', () => {
    expect(codexImageInEntry(entry(2), 2)).toEqual({ mediaType: 'image/png', data: png })
    expect(codexImageInEntry(entry(2), 1)).toBe(null)
    expect(codexImageInEntry({ type: 'response_item', payload: { role: 'assistant', content: [] } }, 1)).toBe(null)
  })
  it('saves the latest image with that number from the rollout', async () => {
    const rollout = join(dir, 'rollout.jsonl')
    const other = Buffer.from('89504e470d0a1a0aff', 'hex').toString('base64')
    fs.writeFileSync(rollout, [JSON.stringify(entry(1)), 'not json [Image #1]', JSON.stringify(entry(1, other))].join('\n') + '\n')
    const out = join(dir, 'paste')
    const file = await codexImageFile({ rollout, sessionId: 's1', n: 1 }, out)
    expect(file.startsWith(out)).toBe(true)
    expect(fs.readFileSync(file).toString('base64')).toBe(other)
    expect(await codexImageFile({ rollout, sessionId: 's1', n: 3 }, out)).toBe(null)
    expect(await codexImageFile({ rollout: join(dir, 'missing.jsonl'), sessionId: 's1', n: 1 }, out)).toBe(null)
  })
})
