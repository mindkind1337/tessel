import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { parseRisky, neutralize, riskHash, createGitTrust, setGitTrust } from '../gitSafety'
import { scmStatus, scmFileVersions } from '../sourceControl'
import { projectStatus } from '../explorer'

describe('risky repository settings', () => {
  it('lists the settings that run programs (fsmonitor off is not one)', () => {
    const out = 'core.fsmonitor\nfalse\0filter.lfs.process\ngit-lfs filter-process\0diff.x.textconv\nsh -c evil\0core.hookspath\n.husky\0user.name\nme\0'
    expect(parseRisky(out).map((r) => r.key)).toEqual(['filter.lfs.process', 'diff.x.textconv', 'core.hookspath'])
  })
  it('turns them off with -c overrides', () => {
    const args = neutralize(
      [{ key: 'filter.evil.clean' }, { key: 'diff.x.textconv' }, { key: 'core.hooksPath' }, { key: 'core.sshCommand' }],
      { hooksDir: '/none' }
    )
    expect(args.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false'])
    for (const kv of ['filter.evil.clean=', 'filter.evil.process=', 'filter.evil.required=false', 'diff.x.textconv=', 'diff.x.command=', 'core.hooksPath=/none', 'core.sshCommand=ssh'])
      expect(args).toContain(kv)
  })
  it('remembers the answer per repository and exact settings; asks once at a time', async () => {
    const file = join(os.tmpdir(), `tessel-trust-${process.pid}.json`)
    let asked = 0
    const trust = createGitTrust({ file, ask: async () => (asked++, true) })
    const risky = [{ key: 'core.fsmonitor', value: 'x' }]
    const [a, b] = await Promise.all([trust.decide('r1', risky), trust.decide('r1', risky)])
    expect([a, b, asked]).toEqual([true, true, 1])
    const again = createGitTrust({ file, ask: async () => (asked++, false) })
    expect(await again.decide('r1', risky)).toBe(true)
    expect(await again.decide('r1', [{ key: 'core.fsmonitor', value: 'y' }])).toBe(false) // changed: asked again
    expect(asked).toBe(2)
    expect(await again.decide('r2', risky, { mayAsk: false })).toBe(false)
    expect(riskHash(risky)).toMatch(/^[0-9a-f]{64}$/)
    fs.rmSync(file, { force: true })
  })
})

describe('local repositories: nothing of their config runs until trusted', () => {
  let dir
  let marks
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  const readMarks = () => (fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8') : '')
  beforeAll(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-gitsafety-'))
    marks = join(os.tmpdir(), `tessel-gitsafety-marks-${process.pid}.txt`)
    g('init', '-q')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    g('config', 'core.autocrlf', 'false')
    fs.writeFileSync(join(dir, '.gitattributes'), 'a.txt filter=evil diff=evil\n')
    fs.writeFileSync(join(dir, 'a.txt'), 'one\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    const m = marks.replace(/\\/g, '/')
    g('config', 'core.fsmonitor', `echo FSMONITOR >> '${m}'; false`)
    g('config', 'filter.evil.clean', `echo CLEAN >> '${m}'; cat`)
    g('config', 'diff.evil.textconv', `sh -c 'echo TEXTCONV >> "${m}"; cat "$1"' x`)
    fs.appendFileSync(join(dir, 'a.txt'), 'two\n')
  })
  afterEach(() => setGitTrust(null))
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(marks, { force: true })
  })

  it('Changes and Files status, and a diff, with the settings off', async () => {
    const asks = []
    setGitTrust(createGitTrust({ ask: async (q) => (asks.push(q), false) }))
    fs.writeFileSync(marks, '')
    const s = await scmStatus({ root: dir })
    expect(s.ok).toBe(true)
    expect(s.entries.find((e) => e.path === 'a.txt')).toMatchObject({ area: 'unstaged', added: 1 })
    expect((await projectStatus({ root: dir })).ok).toBe(true)
    expect((await scmFileVersions({ root: dir, path: 'a.txt', area: 'unstaged' })).ok).toBe(true)
    expect(readMarks()).toBe('')
    expect(asks).toHaveLength(1)
  }, 60000)
})
