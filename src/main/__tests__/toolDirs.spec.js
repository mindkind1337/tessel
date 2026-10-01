// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, delimiter } from 'path'
import { extraToolDirs, withToolDirs } from '../toolDirs'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tooldirs-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})
const mk = (...p) => {
  fs.mkdirSync(join(home, ...p), { recursive: true })
  return join(home, ...p)
}

describe('folders installers leave off PATH', () => {
  it('finds the Store Python and python.org user scripts, uv/pipx, only those that exist', () => {
    const store = mk('Local', 'Packages', 'PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python313', 'Scripts')
    const user = mk('Roaming', 'Python', 'Python312', 'Scripts')
    const uv = mk('.local', 'bin')
    const env = { LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming'), TESSEL_TOOLDIRS_TEST: '1' }
    const dirs = extraToolDirs(env, home, ['C:\\Py\\Scripts', 'not a path'])
    expect(dirs).toEqual(expect.arrayContaining([store, user, uv, 'C:\\Py\\Scripts']))
    expect(dirs).not.toContain('not a path')
    expect(dirs).not.toContain(join(home, '.bun', 'bin')) // not there
  })

  it("puts an agent's own install folder before Python's (Kimi Code over the old pip kimi)", () => {
    const store = mk('Local', 'Packages', 'PythonSoftwareFoundation.Python.3.13_x', 'LocalCache', 'local-packages', 'Python313', 'Scripts')
    const kimi = mk('.kimi-code', 'bin')
    const env = { LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming'), TESSEL_TOOLDIRS_TEST: '1' }
    const dirs = extraToolDirs(env, home)
    expect(dirs.indexOf(kimi)).toBeLessThan(dirs.indexOf(store))
  })

  it("finds Cursor's CLI folder (its installer may not be in the PATH Tessel started with)", () => {
    const cursor = mk('Local', 'cursor-agent')
    const env = { LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming'), TESSEL_TOOLDIRS_TEST: '1' }
    expect(extraToolDirs(env, home)).toContain(cursor)
  })

  it('adds them after PATH, once each, whatever the case', () => {
    const p = ['C:\\Windows', 'C:\\Users\\u\\AppData\\Roaming\\npm'].join(delimiter)
    const out = withToolDirs(p, ['c:\\users\\u\\appdata\\roaming\\npm\\', 'C:\\Py\\Scripts', 'C:\\Py\\Scripts'])
    expect(out.split(delimiter)).toEqual(['C:\\Windows', 'C:\\Users\\u\\AppData\\Roaming\\npm', 'C:\\Py\\Scripts'])
    expect(withToolDirs('', ['C:\\a'])).toBe('C:\\a')
  })
})
