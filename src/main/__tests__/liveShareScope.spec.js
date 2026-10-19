// Live Share phase 2's scope (src/main/liveShare/shareScope.js) on real temp
// folders: a guest's path stays inside the project by its real path
// (junctions and links out, 8.3 names, streams, trailing dots and spaces,
// device names refused), .git and .tessel stay hidden but for the notes,
// ignored and secret files are hidden while the share's setting is on, the
// files that run things are write-protected without the type right, and the
// last guard leaves no host path in an answer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import {
  createShareScope,
  rootInfo,
  isAlwaysHidden,
  isSecretName,
  isSecretRel,
  isProtectedRel,
  writeAllowed,
  hiddenByName,
  assertNoHostPaths,
  within
} from '../liveShare/shareScope'

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString()
const TOKEN = 'abcdefghijklmnop1234'
let dir
let root
let outside
const put = (base, rel, text = 'x') => {
  const p = join(base, ...rel.split('/'))
  fs.mkdirSync(join(p, '..'), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
// The 8.3 short name Windows gave a path (the long one when it gave none).
function shortName(p) {
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { windowsVerbatimArguments: true, stdio: 'pipe' }).toString().trim()
    return out.split(/[\\/]/).pop()
  } catch {
    return null
  }
}
const off = { hideIgnored: false }

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsscope-')))
  root = join(dir, 'proj')
  outside = join(dir, 'outside')
  fs.mkdirSync(root)
  put(outside, 'secret.txt', 'outside secret')
  put(root, 'src/a.js', 'console.log(1)\n')
  put(root, '.env', 'API_KEY=1')
  put(root, '.env.example', 'API_KEY=')
  put(root, '.tessel/notes.md', '# notes\n')
  put(root, `.tessel/team/${TOKEN}/HOW-TO.md`, 'inbox')
  put(root, '.tessel/setup.ps1', 'echo hi')
  put(root, '.claude/settings.json', '{}')
  put(root, 'build/out.js', 'built')
  put(root, '.gitignore', 'build/\n*.log\n')
  put(root, 'debug.log', 'log')
  g(root, 'init', '-q')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('rules by name', () => {
  it('always hides .git and .tessel but its notes', () => {
    expect(isAlwaysHidden('.git')).toBe(true)
    expect(isAlwaysHidden('.git/config')).toBe(true)
    expect(isAlwaysHidden('sub/.GIT/hooks/pre-commit')).toBe(true)
    expect(isAlwaysHidden('.tessel')).toBe(false)
    expect(isAlwaysHidden('.tessel/notes.md')).toBe(false)
    expect(isAlwaysHidden('.Tessel/Notes.md')).toBe(false)
    expect(isAlwaysHidden(`.tessel/team/${TOKEN}`)).toBe(true)
    expect(isAlwaysHidden('.tessel/setup.ps1')).toBe(true)
    expect(isAlwaysHidden('.tessel/notes.md/x')).toBe(true)
    expect(isAlwaysHidden('src/a.js')).toBe(false)
    expect(isAlwaysHidden('.github/workflows/ci.yml')).toBe(false)
  })

  it('knows secret names, not their examples', () => {
    for (const s of ['.env', '.env.local', '.ENV.production', 'server.pem', 'tls.key', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_rsa.pub', 'id_ed25519', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'vault.kdbx', 'terraform.tfstate', 'terraform.tfstate.backup', 'prod.tfvars', 'credentials.json', 'credentials-prod.json', 'service-account-x.json', '.aws', '.ssh', '.docker'])
      expect(isSecretName(s), s).toBe(true)
    for (const s of ['.env.example', '.env.sample', '.env.local.template', 'environment.ts', 'keys.js', 'README.md', 'credentials.md', 'package.json'])
      expect(isSecretName(s), s).toBe(false)
    expect(isSecretRel('home/.ssh/config')).toBe(true)
    expect(isSecretRel('src/.aws')).toBe(true)
    expect(hiddenByName('.env', {})).toBe(true)
    expect(hiddenByName('.env', off)).toBe(false)
    expect(hiddenByName('.git/config', off)).toBe(true)
  })

  it('write-protects what runs by itself, unless the guest may type', () => {
    for (const p of ['.claude/settings.json', '.claude', 'sub/.claude/agents/x.md', '.codex/config.toml', '.gemini/settings.json', '.cursor/rules', '.mcp.json', 'sub/.mcp.json', '.vscode/tasks.json', '.husky/pre-commit', '.envrc', '.tessel/setup.ps1', '.VSCODE/launch.json'])
      expect(isProtectedRel(p), p).toBe(true)
    // What git ignores and how it reads files, hook managers' configs and
    // folders, an agent's instructions and the notes (any depth, any case).
    for (const p of ['.gitignore', 'sub/.GITIGNORE', '.gitattributes', '.gitmodules', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yaml', 'lefthook-local.yml', '.lintstagedrc', '.lintstagedrc.json', 'lint-staged.config.mjs', 'commitlint.config.js', '.commitlintrc.yaml', '.githooks/pre-commit', 'CLAUDE.md', 'docs/AGENTS.md', 'GEMINI.md', '.cursorrules', '.github/copilot-instructions.md', '.tessel/notes.md', '.tessel'])
      expect(isProtectedRel(p), p).toBe(true)
    for (const p of ['src/a.js', '.mcp.json.bak', 'claude/settings.json', 'claude.md.txt', 'gitignore', 'lint-staged.js', ''])
      expect(isProtectedRel(p), p).toBe(false)
    // Other agents' settings and instructions (what they run, their MCP
    // servers and models).
    for (const p of ['opencode.json', 'sub/opencode.jsonc', '.opencode/agent/x.md', 'crush.json', '.crush.json', '.aider.conf.yml', '.continue/config.yaml', '.windsurf/rules/a.md', '.kiro/steering/x.md', '.goosehints', '.grok/settings.json', '.roo/rules.md', '.qwen/settings.json'])
      expect(isProtectedRel(p), p).toBe(true)
    // The folder the project's git runs hooks from (core.hooksPath).
    expect(isProtectedRel('tools/hooks/pre-commit', ['tools/hooks'])).toBe(true)
    expect(isProtectedRel('tools/hooksx/a', ['tools/hooks'])).toBe(false)
    expect(writeAllowed('tools/hooks/pre-commit', { edit: true }, ['tools/hooks'])).toBe(false)
    expect(writeAllowed('.mcp.json', { edit: true })).toBe(false)
    expect(writeAllowed('.mcp.json', { edit: true, type: 'yes' })).toBe(false)
    expect(writeAllowed('.mcp.json', { edit: true, type: true })).toBe(true)
    expect(writeAllowed('src/a.js', { edit: true })).toBe(true)
  })
})

describe('roots', () => {
  it('takes a local folder only, by its real path', () => {
    expect(rootInfo(root)).toEqual({ root, real: fs.realpathSync.native(root) })
    expect(rootInfo('relative/path')).toBe(null)
    expect(rootInfo('ssh://ssh-1/home')).toBe(null)
    expect(rootInfo('lshare://p')).toBe(null)
    expect(rootInfo(`\\\\?\\${root}`)).toBe(null)
    expect(rootInfo(join(root, 'src', 'a.js'))).toBe(null)
    expect(rootInfo(join(dir, 'gone'))).toBe(null)
    expect(rootInfo('C:\\')).toBe(null)
    expect(within('C:\\a\\b', 'C:\\A\\B\\c')).toBe(true)
    expect(within('C:\\a\\b', 'C:\\a\\bc')).toBe(false)
  })
})

describe('resolving a guest path', () => {
  let scope
  beforeEach(() => {
    scope = createShareScope()
  })

  it('finds a file inside the project', async () => {
    const r = await scope.resolve(root, 'src/a.js')
    expect(r.ok).toBe(true)
    expect(r.realRel).toBe('src/a.js')
    expect(r.isFile).toBe(true)
    expect(r.real).toBe(join(fs.realpathSync.native(root), 'src', 'a.js'))
    expect((await scope.resolve(root, '')).isDir).toBe(true)
    expect((await scope.resolve(root, 'src/gone.js')).code).toBe('not-found')
    expect((await scope.resolve(root, 'src/new.js', { mustExist: false })).ok).toBe(true)
    expect((await scope.resolve(root, 'nodir/new.js', { mustExist: false })).code).toBe('not-found')
    expect((await scope.resolve(root, 'nodir/deeper/x.js', { mustExist: 'any' })).ok).toBe(true)
    expect((await scope.resolve(root, 'src/a.js/x', { mustExist: 'any' })).code).toBe('not-found')
    expect((await scope.resolve(join(dir, 'nope'), 'src/a.js')).code).toBe('no-project')
  })

  it('refuses paths that leave the project or that Windows reads otherwise', async () => {
    for (const bad of ['../outside/secret.txt', 'src/../../outside', 'C:/Windows/win.ini', `${outside}\\secret.txt`, '\\\\localhost\\c$\\x', '//localhost/c$/x', '\\\\?\\C:\\x', '/etc/passwd', 'src\\a.js'])
      expect((await scope.resolve(root, bad)).code, bad).toBe('bad-path')
    // Streams, trailing dots and spaces (Windows drops them), device names.
    for (const bad of ['.tessel/notes.md::$DATA', 'src/a.js:secret', '.git.', '.tessel./team', 'src ', 'src/a.js.', 'nul', 'src/con.txt', 'COM1', 'lpt\u00b9', 'conin$'])
      expect((await scope.resolve(root, bad)).code, bad).toBe('bad-path')
    expect((await scope.resolve(root, 'x'.repeat(256))).code).toBe('bad-path')
  })

  it('never follows a junction out of the project, and follows one inside it', async () => {
    fs.symlinkSync(outside, join(root, 'link'), 'junction')
    fs.symlinkSync(join(root, 'src'), join(root, 'inlink'), 'junction')
    expect((await scope.resolve(root, 'link/secret.txt')).code).toBe('not-found')
    expect((await scope.resolve(root, 'link')).code).toBe('not-found')
    expect((await scope.resolve(root, 'link/new.txt', { mustExist: false })).code).toBe('not-found')
    expect((await scope.resolve(root, 'link/a/b/c', { mustExist: 'any' })).code).toBe('not-found')
    const r = await scope.resolve(root, 'inlink/a.js')
    expect(r.ok).toBe(true)
    expect(r.realRel).toBe('src/a.js')
    // The entry itself stays the link (a rename acts on it, not on src).
    expect((await scope.resolve(root, 'inlink')).entry).toBe(join(fs.realpathSync.native(root), 'inlink'))
  })

  it('never reaches a hidden folder through a junction inside the project', async () => {
    fs.symlinkSync(join(root, '.tessel'), join(root, 'sneaky'), 'junction')
    expect((await scope.resolve(root, `sneaky/team/${TOKEN}/HOW-TO.md`)).code).toBe('not-found')
    expect((await scope.resolve(root, 'sneaky/setup.ps1')).code).toBe('not-found')
    expect((await scope.resolve(root, 'sneaky/notes.md')).realRel).toBe('.tessel/notes.md')
    fs.symlinkSync(join(root, '.git'), join(root, 'gitlink'), 'junction')
    expect((await scope.resolve(root, 'gitlink/config')).code).toBe('not-found')
  })

  it('never follows a file link out of the project (when this Windows allows making one)', async () => {
    try {
      fs.symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'leak.txt'), 'file')
    } catch {
      return // no symlink right here (no developer mode): the junction cases cover it
    }
    expect((await scope.resolve(root, 'src/leak.txt')).code).toBe('not-found')
  })

  it('catches 8.3 short names by the real path', async () => {
    const short = shortName(join(root, '.tessel'))
    if (!short || short.toLowerCase() === '.tessel') return // no 8.3 names on this volume
    expect((await scope.resolve(root, `${short}/team/${TOKEN}/HOW-TO.md`)).code).toBe('not-found')
    expect((await scope.resolve(root, `${short}/setup.ps1`)).code).toBe('not-found')
    const notes = await scope.resolve(root, `${short}/notes.md`)
    expect(notes.ok).toBe(true)
    expect(notes.realRel).toBe('.tessel/notes.md')
    const claude = shortName(join(root, '.claude'))
    if (claude && claude.toLowerCase() !== '.claude') {
      const r = await scope.resolve(root, `${claude}/settings.json`)
      expect(r.realRel).toBe('.claude/settings.json')
      expect(writeAllowed(r.realRel, { edit: true })).toBe(false)
    }
    const example = shortName(join(root, '.env.example'))
    if (example && example.toLowerCase() !== '.env.example') expect((await scope.resolve(root, example)).ok).toBe(true)
    const env = shortName(join(root, '.env'))
    if (env && env.toLowerCase() !== '.env') expect((await scope.resolve(root, env)).code).toBe('not-found')
  })

  it('hides .tessel/team/<token> and keeps notes.md readable', async () => {
    expect((await scope.resolve(root, `.tessel/team/${TOKEN}/HOW-TO.md`)).code).toBe('not-found')
    expect((await scope.resolve(root, '.tessel/team')).code).toBe('not-found')
    expect((await scope.resolve(root, `.tessel/team/${TOKEN}/HOW-TO.md`, { settings: off })).code).toBe('not-found')
    expect((await scope.resolve(root, '.tessel/notes.md')).ok).toBe(true)
    expect((await scope.resolve(root, '.TESSEL/NOTES.MD')).ok).toBe(true)
    expect((await scope.resolve(root, '.tessel')).isDir).toBe(true)
    expect((await scope.resolve(root, '.git/config')).code).toBe('not-found')
    expect((await scope.resolve(root, '.git/config', { settings: off })).code).toBe('not-found')
  })

  it('hides .env and ignored files, and shows them again with the setting off', async () => {
    expect((await scope.resolve(root, '.env')).code).toBe('not-found')
    expect((await scope.resolve(root, '.ENV')).code).toBe('not-found')
    expect((await scope.resolve(root, '.env.example')).ok).toBe(true)
    expect((await scope.resolve(root, 'build/out.js')).code).toBe('not-found')
    expect((await scope.resolve(root, 'build')).code).toBe('not-found')
    expect((await scope.resolve(root, 'debug.log')).code).toBe('not-found')
    expect((await scope.resolve(root, 'build/new.js', { mustExist: false })).code).toBe('not-found')
    expect((await scope.resolve(root, '.env', { settings: off })).ok).toBe(true)
    expect((await scope.resolve(root, 'build/out.js', { settings: off })).ok).toBe(true)
    expect((await scope.resolve(root, 'debug.log', { settings: off })).ok).toBe(true)
    // A path seen ignored stays hidden for the share, whatever a .gitignore
    // says later (a folder seen ignored: what is in it too); a new share
    // (reset) asks git again.
    fs.writeFileSync(join(root, '.gitignore'), '*.log\n')
    scope.invalidate(root)
    expect((await scope.resolve(root, 'build/out.js')).code).toBe('not-found')
    put(root, 'build/later.js')
    expect((await scope.resolve(root, 'build/later.js')).code).toBe('not-found')
    scope.reset()
    expect((await scope.resolve(root, 'build/out.js')).ok).toBe(true)
    // Through a junction to an ignored folder too.
    fs.writeFileSync(join(root, '.gitignore'), 'build/\n')
    scope.invalidate(root)
    fs.symlinkSync(join(root, 'build'), join(root, 'b2'), 'junction')
    expect((await scope.resolve(root, 'b2/out.js')).code).toBe('not-found')
  })

  it('hides everything git would have to say when git fails, but nothing outside a repository', async () => {
    const failing = createShareScope({ ignoreCheck: async () => null })
    expect((await failing.resolve(root, 'src/a.js')).code).toBe('not-found')
    expect((await failing.resolve(root, 'src/a.js', { settings: off })).ok).toBe(true)
    const plain = join(dir, 'plain')
    put(plain, 'build/out.js')
    expect((await failing.resolve(plain, 'build/out.js')).ok).toBe(true)
  })

  it('reads through one handle and refuses a file swapped since it was resolved', async () => {
    const r = await scope.resolve(root, 'src/a.js', { kind: 'file' })
    const got = scope.readResolved(r, 1024)
    expect(got.ok).toBe(true)
    expect(got.buf.toString()).toBe('console.log(1)\n')
    expect(scope.readResolved(r, 4).code).toBe('too-large')
    // Replaced by another file (a new identity on disk).
    fs.rmSync(join(root, 'src', 'a.js'))
    fs.writeFileSync(join(root, 'src', 'a.js'), 'swapped')
    expect(scope.readResolved(r, 1024).code).toBe('not-found')
    // A folder swapped for a junction out of the project.
    const again = await scope.resolve(root, 'src/a.js', { kind: 'file' })
    fs.renameSync(join(root, 'src'), join(root, 'src-old'))
    put(outside, 'a.js', 'outside')
    fs.symlinkSync(outside, join(root, 'src'), 'junction')
    expect(scope.readResolved(again, 1024).code).toBe('not-found')
  })

  it('lists what of a folder a guest may not see', async () => {
    const info = scope.root(root)
    const hidden = await scope.hiddenOf(info, ['src/a.js', '.env', 'build', 'debug.log', '.tessel/notes.md', `.tessel/team`, '.git'], {})
    expect([...hidden].sort()).toEqual(['.env', '.git', '.tessel/team', 'build', 'debug.log'])
    const shown = await scope.hiddenOf(info, ['src/a.js', '.env', 'build', '.git'], off)
    expect([...shown]).toEqual(['.git'])
  })
})

// A small seeded random source, so a failure can be replayed.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('assertNoHostPaths', () => {
  const ROOT = 'C:\\Users\\Jean Claude\\Projects\\My App'
  const REAL = 'D:\\real\\my-app'
  // A host path in one string of an answer: a drive path, a share or long
  // path (two backslashes), or a piece of the roots.
  const hostLike = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\\s]|jean claude|d:\\real|d:\/real/i
  const strings = (v, out = []) => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) out.push(k), strings(x, out)
    return out
  }
  const leaks = (v) => strings(v).filter((x) => hostLike.test(x))

  it('replaces the roots and any drive, share or long path, keys too', () => {
    const { value, hits } = assertNoHostPaths(
      {
        error: `ENOENT: no such file, open '${ROOT}\\src\\a.js'`,
        nested: [{ p: 'see c:/users/jean claude/projects/my app/x and \\\\server\\share\\dir\\f.txt' }],
        [`${REAL}\\k`]: 1,
        msys: '/c/Users/Jean Claude/Projects/My App/src',
        long: '\\\\?\\D:\\real\\my-app\\x',
        url: 'https://github.com/o/r/commit/abc',
        rel: 'src/a.js',
        n: 3,
        b: true,
        none: null
      },
      [ROOT, REAL]
    )
    expect(hits).toBeGreaterThan(0)
    expect(leaks(value)).toEqual([])
    expect(value.url).toBe('https://github.com/o/r/commit/abc')
    expect(value.rel).toBe('src/a.js')
    expect(value.n).toBe(3)
    expect(value.b).toBe(true)
    expect(value.none).toBe(null)
  })

  it('leaves the fields asked for as they are (a file the guest may save back)', () => {
    const { value } = assertNoHostPaths({ text: 'path = C:\\data\\x', results: [{ text: 'C:\\y', rel: 'C:\\z' }] }, [ROOT], { keep: ['text', 'results.*.text'] })
    expect(value.text).toBe('path = C:\\data\\x')
    expect(value.results[0].text).toBe('C:\\y')
    expect(value.results[0].rel).toBe('…')
  })

  it('property: no generated answer keeps a host path', () => {
    const rand = rng(20261016)
    const pick = (list) => list[Math.floor(rand() * list.length)]
    const words = ['src', 'a.js', 'hello world', 'Ünïcödé', 'x:y', 'origin/main', 'https://example.com/a/b', 'line\nbreak', '…', '']
    const hostBits = [
      () => ROOT,
      () => REAL,
      () => ROOT.toUpperCase(),
      () => ROOT.replace(/\\/g, '/'),
      () => `/c/Users/Jean Claude/Projects/My App/${pick(words)}`,
      () => `${pick(['C', 'd', 'Z'])}:\\${pick(words)}\\${pick(words)}`,
      () => `${pick(['C', 'e'])}:/${pick(words)}`,
      () => `\\\\${pick(['srv', 'nas-1'])}\\${pick(['share', 'c$'])}\\${pick(words)}`,
      () => `\\\\?\\${REAL}\\${pick(words)}`,
      () => `file:///C:/${pick(words)}`,
      () => `'${ROOT}\\${pick(words)}'`
    ]
    const str = () => {
      const parts = []
      const n = 1 + Math.floor(rand() * 5)
      for (let i = 0; i < n; i++) parts.push(rand() < 0.4 ? pick(hostBits)() : pick(words))
      return parts.join(pick([' ', '', ': ', '"', '\t']))
    }
    const value = (depth) => {
      const r = rand()
      if (depth > 3 || r < 0.4) return str()
      if (r < 0.5) return Math.floor(rand() * 100)
      if (r < 0.55) return null
      if (r < 0.75) return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1))
      const o = {}
      for (let i = 0; i < 1 + Math.floor(rand() * 4); i++) o[rand() < 0.2 ? str() : `k${i}`] = value(depth + 1)
      return o
    }
    for (let i = 0; i < 400; i++) {
      const payload = value(0)
      const { value: out } = assertNoHostPaths(payload, [ROOT, REAL])
      expect(leaks(out), `case ${i}: ${JSON.stringify(payload).slice(0, 300)}`).toEqual([])
      // Idempotent: a second pass finds nothing more.
      expect(assertNoHostPaths(out, [ROOT, REAL]).hits).toBe(0)
    }
  })
})
