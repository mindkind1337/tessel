import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { localGitArgs, setGitTrust } from '../gitSafety'

describe('localGitArgs asked several times at once', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-inflight-'))
    execFileSync('git', ['init', '-q', dir])
    setGitTrust(null)
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('shares one check per repository and options', async () => {
    const a = localGitArgs(dir)
    const b = localGitArgs(dir.toUpperCase())
    const c = localGitArgs(dir, { ask: false })
    expect(b).toBe(a)
    expect(c).not.toBe(a)
    const [x, y, z] = await Promise.all([a, b, c])
    expect(x).toEqual(y)
    expect(z).toEqual(x)
    expect(x).toContain('core.fsmonitor=false')
  })

  it('answers from the cache once checked, and checks again after a reset', async () => {
    const first = await localGitArgs(dir)
    expect(await localGitArgs(dir)).toBe(first)
    setGitTrust(null)
    const again = localGitArgs(dir)
    expect(await again).toEqual(first)
  })
})
