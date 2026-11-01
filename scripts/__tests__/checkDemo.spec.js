// @vitest-environment node
// What must stop the site going online (scripts/check-demo.mjs).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_FILE_BYTES, MAX_FILES, checkFolder, scanText } from '../check-demo.mjs'

const whats = (text, opts) => scanText(text, opts).map((hit) => hit.what)

describe('scanText', () => {
  it('finds local paths, in every spelling a bundle has them', () => {
    for (const text of ['C:\\Users\\alice\\a.js', 'C:\\\\Users\\\\alice\\\\a.js', 'c:/Users/alice/a.js']) expect(whats(text), text).toContain('a Windows user folder')
    expect(whats('at /home/runner/work/x')).toContain('a home folder')
    expect(whats('at /Users/alice/code/x')).toContain('a macOS user folder')
  })

  it('leaves the app\'s own help text alone', () => {
    expect(whats('Use an absolute path like /home/user/project or ~/project.')).toEqual([])
    expect(whats('`/home/linuxbrew/.linuxbrew/bin`')).toEqual([])
  })

  it('finds the build machine\'s user name, as a whole word, in any case', () => {
    expect(whats('built by Alice-Smith!', { username: 'alice-smith' })).toHaveLength(1)
    expect(whats('malice', { username: 'alice' })).toEqual([])
    // A CI account's name is too common a word; its paths are still found.
    expect(whats('the runner of the test', { username: 'runner' })).toEqual([])
    expect(whats('/home/runner/work/x', { username: 'runner' })).toContain('a home folder')
  })

  it('finds this checkout\'s own path', () => {
    const rootPaths = ['D:\\a\\tessel\\tessel']
    expect(whats('__file:`D:/a/tessel/tessel/src/App.vue`', { rootPaths })).toContain('this checkout’s own path')
    expect(whats('D:\\\\a\\\\tessel\\\\tessel\\\\src', { rootPaths })).toContain('this checkout’s own path')
  })

  it('finds what is shaped like a token or a key', () => {
    const a = 'A'.repeat(40)
    for (const [text, what] of [
      [`sk-ant-api03-${a}`, 'an Anthropic key'],
      [`sk-proj-${a}`, 'an OpenAI-style key'],
      [`ghp_${'a1'.repeat(20)}`, 'a GitHub token'],
      [`github_pat_${'a1'.repeat(25)}`, 'a GitHub token'],
      ['AKIAIOSFODNN7EXAMPLE', 'an AWS key'],
      [`AIza${'b'.repeat(35)}`, 'a Google API key'],
      [`GOCSPX-${'c'.repeat(28)}`, 'a Google OAuth secret'],
      ['123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com', 'a Google OAuth client'],
      [`xoxb-${'1234567890-'.repeat(3)}`, 'a Slack token'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmn', 'a JSON web token'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz12345', 'a private key'],
      ['api_key="abcdefghijklmnopqrstuvwxyz012345"', 'a secret in a setting']
    ]) {
      expect(whats(text), what).toContain(what)
    }
  })

  it('does not take the app\'s own code for a credential', () => {
    // maskSecrets' patterns, and an ordinary key of a catalog.
    expect(whats('/\\bsk-ant-[A-Za-z0-9_-]+/g, /ghp_[A-Za-z0-9]+/')).toEqual([])
    expect(whats('"chat.orca.copy.toggle_priority_service_tier":"x"')).toEqual([])
  })
})

describe('checkFolder', () => {
  const dirs = []
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  function site(page = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'none\'">') {
    const root = mkdtempSync(join(tmpdir(), 'tessel-site-'))
    dirs.push(root)
    mkdirSync(join(root, 'demo'))
    writeFileSync(join(root, 'demo', 'index.html'), page)
    return root
  }

  it('passes a clean folder', () => {
    const result = checkFolder(site())
    expect(result.problems).toEqual([])
    expect(result.files).toBe(1)
  })

  it('fails on a file over Cloudflare\'s limit', () => {
    const root = site()
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1))
    expect(checkFolder(root).problems.join()).toMatch(/big\.bin.*MiB/)
  })

  it('fails over Cloudflare\'s file count, and does not count its _headers', () => {
    const root = site()
    writeFileSync(join(root, '_headers'), '/*\n  X-Test: 1\n')
    expect(checkFolder(root).files).toBe(1)
    expect(MAX_FILES).toBe(20000)
    for (let i = 0; i < 3; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
    expect(checkFolder(root).files).toBe(4)
  })

  it('fails if the demo is missing, or its page may call out', () => {
    const root = site()
    rmSync(join(root, 'demo'), { recursive: true })
    expect(checkFolder(root).problems.join()).toMatch(/missing/)
    expect(checkFolder(site('<html></html>')).problems.join()).toMatch(/no Content-Security-Policy/)
    expect(checkFolder(site('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">')).problems.join()).toMatch(/connect-src/)
  })

  it('names the file and what it found', () => {
    const root = site()
    writeFileSync(join(root, 'leak.js'), 'const home = "C:\\\\Users\\\\alice\\\\x"')
    expect(checkFolder(root).problems.join()).toMatch(/leak\.js: a Windows user folder/)
  })
})
