// @vitest-environment node
// A repository's own log.showSignature=true and gpg.program=<a script> make
// git log / git show run that script on any signed commit. Tessel reads
// commits by itself (Source Control's Commits, the Timeline, a commit link's
// hover): its git never checks a signature, whatever the repository says
// (gitSafety.js SAFE_ARGS, agentTools.js run, --no-show-signature), and the
// trust prompt lists those settings.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { scmCommitInfo, scmFileHistory, scmHistory, scmResolveCommit } from '../sourceControl'
import { run } from '../agentTools'
import { GUEST_FIXED_ARGS, neutralize, parseRisky, SAFE_ARGS } from '../gitSafety'

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const g = (cwd, args, input) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', input }).toString()
let dir
let repo
let marker
let signed

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-sig-'))
  repo = join(dir, 'repo')
  marker = join(dir, 'ran')
  fs.mkdirSync(repo)
  g(repo, ['init', '-q', '-b', 'main'])
  g(repo, ['config', 'user.email', 'ann@example.com'])
  g(repo, ['config', 'user.name', 'Ann'])
  fs.writeFileSync(join(repo, 'a.txt'), 'one\n')
  g(repo, ['add', '-A'])
  g(repo, ['commit', '-q', '-m', 'first'])
  // A commit carrying a (fake) signature: git hands it to gpg.program.
  const tree = g(repo, ['rev-parse', 'HEAD^{tree}']).trim()
  const parent = g(repo, ['rev-parse', 'HEAD']).trim()
  const body = `tree ${tree}\nparent ${parent}\nauthor Ann <ann@example.com> 1700000000 +0000\ncommitter Ann <ann@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned one\n`
  signed = g(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], body).trim()
  g(repo, ['update-ref', 'refs/heads/main', signed])
  const script = join(dir, 'fake-gpg.sh')
  fs.writeFileSync(script, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\nexit 1\n`)
  fs.chmodSync(script, 0o755)
  g(repo, ['config', 'log.showSignature', 'true'])
  g(repo, ['config', 'gpg.program', script.replace(/\\/g, '/')])
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("a repository's signature checker never runs from Tessel's git", () => {
  it('the repository would run it on its own (the setup is real)', () => {
    g(repo, ['log', '-1', '--format=%H'])
    expect(fs.existsSync(marker)).toBe(true)
  })

  it('Commits, the Timeline, a commit link and any git call through run() leave it alone', async () => {
    expect((await scmResolveCommit({ root: repo, commit: signed.slice(0, 8) })).id).toBe(signed)
    expect((await scmCommitInfo({ root: repo, commit: signed })).ok).toBe(true)
    expect((await scmHistory({ root: repo })).items[0].id).toBe(signed)
    expect((await scmFileHistory({ root: repo, path: join(repo, 'a.txt') })).ok).toBe(true)
    expect((await run('git', ['-C', repo, 'log', '-1', '--format=%H'])).stdout.trim()).toBe(signed)
    expect((await run('git', ['-C', repo, 'show', '-s', signed])).ok).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('the trust prompt lists those settings; not trusted, and for a guest, they are off', () => {
    const out = 'log.showsignature\ntrue\0gpg.program\n/x/evil.sh\0gpg.ssh.program\n/x/evil2\0gpg.x509.program\n/x/evil3\0log.showsignature\nfalse\0'
    expect(parseRisky(out).map((r) => r.key)).toEqual(['log.showsignature', 'gpg.program', 'gpg.ssh.program', 'gpg.x509.program'])
    const args = neutralize(parseRisky(out)).join(' ')
    expect(args).toContain('log.showSignature=false')
    expect(args).toContain('gpg.program=gpg')
    expect(args).toContain('gpg.ssh.program=ssh-keygen')
    expect(args).toContain('gpg.x509.program=gpgsm')
    expect(SAFE_ARGS).toContain('log.showSignature=false')
    expect(GUEST_FIXED_ARGS.join(' ')).toMatch(/log\.showSignature=false.*gpg\.program=gpg.*gpg\.ssh\.program=ssh-keygen.*gpg\.x509\.program=gpgsm/)
  })
})
