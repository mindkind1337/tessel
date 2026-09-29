import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { parseRisky, neutralize, riskHash, createGitTrust, setGitTrust, hookEntries } from '../gitSafety'
import { scmStatus, scmFileVersions, scmStage, scmCommit } from '../sourceControl'
import { projectStatus } from '../explorer'

describe('risky repository settings', () => {
  it('lists the settings that run programs (fsmonitor off is not one)', () => {
    const out = 'core.fsmonitor\nfalse\0filter.lfs.process\ngit-lfs filter-process\0diff.x.textconv\nsh -c evil\0core.hookspath\n.husky\0user.name\nme\0'
    expect(parseRisky(out).map((r) => r.key)).toEqual(['filter.lfs.process', 'diff.x.textconv', 'core.hookspath'])
  })
  it('ext:: remote URLs, upload/receive-pack and protocol.ext.allow count; plain URLs do not', () => {
    const out =
      'remote.origin.url\nhttps://github.com/x/y\0remote.evil.url\next::sh -c touch% /tmp/pwned\0remote.origin.uploadpack\nsh -c evil\0protocol.ext.allow\nalways\0protocol.ext.allow\nnever\0'
    expect(parseRisky(out).map((r) => r.key)).toEqual(['remote.evil.url', 'remote.origin.uploadpack', 'protocol.ext.allow'])
    expect(hookEntries(['pre-commit', 'pre-push.sample', 'post-checkout'])).toEqual([
      { key: 'hook', value: 'post-checkout' },
      { key: 'hook', value: 'pre-commit' }
    ])
  })
  it('a repository not trusted never runs hooks nor the ext:: transport, whatever is set', () => {
    const args = neutralize([])
    expect(args).toContain('core.hooksPath=/nonexistent-tessel-no-hooks')
    expect(args).toContain('protocol.ext.allow=never')
    expect(neutralize([{ key: 'remote.o.uploadpack' }])).toContain('remote.o.uploadpack=git-upload-pack')
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

describe('local repositories: hooks in .git/hooks', () => {
  let dir
  let marks
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  beforeAll(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-githooks-'))
    marks = join(os.tmpdir(), `tessel-githooks-marks-${process.pid}.txt`)
    g('init', '-q')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    fs.writeFileSync(join(dir, 'a.txt'), 'one\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'first')
    const hook = join(dir, '.git', 'hooks', 'pre-commit')
    fs.writeFileSync(hook, `#!/bin/sh\necho HOOK_RAN >> '${marks.replace(/\\/g, '/')}'\n`)
    fs.chmodSync(hook, 0o755)
  })
  afterEach(() => setGitTrust(null))
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(marks, { force: true })
  })
  const commitOnce = async (name) => {
    fs.writeFileSync(join(dir, name), 'x\n')
    expect((await scmStage({ root: dir, paths: [name] })).ok).toBe(true)
    return scmCommit({ root: dir, message: `add ${name}` })
  }

  it('not trusted: the commit is made without running them, after asking', async () => {
    const asks = []
    setGitTrust(createGitTrust({ ask: async (q) => (asks.push(q), false) }))
    fs.writeFileSync(marks, '')
    expect((await commitOnce('b.txt')).ok).toBe(true)
    expect(fs.readFileSync(marks, 'utf8')).toBe('')
    expect(asks[0].risky).toEqual([{ key: 'hook', value: 'pre-commit' }])
  }, 60000)

  it('trusted: they run as git runs them', async () => {
    setGitTrust(createGitTrust({ ask: async () => true }))
    fs.writeFileSync(marks, '')
    expect((await commitOnce('c.txt')).ok).toBe(true)
    expect(fs.readFileSync(marks, 'utf8')).toMatch(/HOOK_RAN/)
  }, 60000)
})
