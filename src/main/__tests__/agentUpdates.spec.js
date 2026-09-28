// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  parseVersion,
  compareVersions,
  isNewer,
  parseNpmLs,
  fetchLatest,
  registryUrl,
  classifyInstall,
  npmUpdateSteps,
  createAgentUpdates,
  NPM_PACKAGES
} from '../agentUpdates'

describe('versions', () => {
  it('finds the version in what CLIs print', () => {
    expect(parseVersion('2.1.284 (Claude Code)')).toBe('2.1.284')
    expect(parseVersion('codex-cli 0.157.1')).toBe('0.157.1')
    expect(parseVersion('v1.2.3-beta.4+build.7')).toBe('1.2.3-beta.4')
    expect(parseVersion('2026.03.13')).toBe('2026.3.13')
    expect(parseVersion('no version')).toBe(null)
    expect(parseVersion(null)).toBe(null)
  })
  it('compares like semver, pre-releases included', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('0.157.1', '0.158.0')).toBe(-1)
    // A pre-release comes before its release.
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    // The semver.org order.
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let i = 0; i < order.length - 1; i++) expect(compareVersions(order[i], order[i + 1])).toBe(-1)
    // Build metadata does not count.
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0)
    expect(Number.isNaN(compareVersions('x', '1.0.0'))).toBe(true)
  })
  it('only a strictly newer version is an update', () => {
    expect(isNewer('2.1.285', '2.1.284')).toBe(true)
    expect(isNewer('2.1.284', '2.1.284')).toBe(false)
    expect(isNewer('2.1.283', '2.1.284')).toBe(false)
    expect(isNewer('2.2.0-beta.1', '2.1.9')).toBe(true)
    expect(isNewer(null, '1.0.0')).toBe(false)
  })
})

describe('npm ls', () => {
  it('reads the global packages and their versions', () => {
    const text = JSON.stringify({
      name: 'npm',
      dependencies: {
        '@anthropic-ai/claude-code': { version: '2.1.284', overridden: false },
        '@openai/codex': { version: '0.157.1' },
        broken: { invalid: true },
        odd: { version: 'not-a-version' }
      }
    })
    expect(parseNpmLs(text)).toEqual({ '@anthropic-ai/claude-code': '2.1.284', '@openai/codex': '0.157.1' })
  })
  it('survives warnings around the JSON, empty or garbage output', () => {
    expect(parseNpmLs('npm WARN something\n{"dependencies":{"cline":{"version":"3.0.65"}}}\n')).toEqual({ cline: '3.0.65' })
    expect(parseNpmLs('')).toEqual({})
    expect(parseNpmLs('{ not json')).toEqual({})
    expect(parseNpmLs('{}')).toEqual({})
  })
})

describe('where an agent comes from', () => {
  const home = 'C:\\Users\\me'
  const npmPrefix = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  const npmVersions = { '@anthropic-ai/claude-code': '2.1.0', '@openai/codex': '0.150.0' }
  it('npm: the command runs from npm global folder and the package is installed', () => {
    const c = classifyInstall({ id: 'codex', commandPath: `${npmPrefix}\\codex`, npmPrefix, npmVersions, home })
    expect(c).toEqual({ source: 'npm', pkg: '@openai/codex', installed: '0.150.0', steps: ['npm install -g @openai/codex@latest'] })
  })
  it("Claude Code's native install updates itself with claude update", () => {
    const c = classifyInstall({ id: 'claude', commandPath: 'C:\\Users\\me\\.local\\bin\\claude.exe', npmPrefix, npmVersions, home })
    expect(c.source).toBe('native')
    expect(c.steps).toEqual(['claude update'])
  })
  it('a copy found elsewhere first (winget, scoop...) is not updated by Tessel', () => {
    expect(classifyInstall({ id: 'codex', commandPath: 'C:\\tools\\codex.exe', npmPrefix, npmVersions, home }).source).toBe('other')
    expect(classifyInstall({ id: 'gemini', commandPath: `${npmPrefix}\\gemini`, npmPrefix, npmVersions, home }).source).toBe('other')
    expect(classifyInstall({ id: 'kimi', commandPath: 'C:\\x\\kimi.exe', npmPrefix, npmVersions, home }).source).toBe('other')
  })
  it('keeps the install options of an agent (Pi without install scripts)', () => {
    expect(npmUpdateSteps('pi')).toEqual(['npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest'])
    expect(npmUpdateSteps('nope')).toBe(null)
    for (const pkg of Object.values(NPM_PACKAGES)) expect(pkg).toMatch(/^(@[\w.-]+\/)?[\w.-]+$/)
  })
})

describe('registry', () => {
  let server
  let base
  const seen = []
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || null, cookie: req.headers.cookie || null })
      if (req.url === '/@scope%2Fcli/latest') return res.end(JSON.stringify({ name: '@scope/cli', version: '3.4.5' }))
      if (req.url === '/plain/latest') return res.end(JSON.stringify({ version: '1.0.0-beta.2' }))
      if (req.url === '/garbage/latest') return res.end('<html>')
      if (req.url === '/slow/latest') return // never answers
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => {
    server.closeAllConnections?.()
    server.close()
  })
  it('asks <registry>/<package>/latest, scoped names escaped', () => {
    expect(registryUrl('https://registry.npmjs.org/', '@a/b')).toBe('https://registry.npmjs.org/@a%2Fb/latest')
  })
  it('reads the latest version, with no credentials sent', async () => {
    expect(await fetchLatest('@scope/cli', { registry: base })).toEqual({ version: '3.4.5' })
    expect(await fetchLatest('plain', { registry: base })).toEqual({ version: '1.0.0-beta.2' })
    expect(seen.every((s) => !s.auth && !s.cookie)).toBe(true)
  })
  it('reports errors instead of throwing', async () => {
    expect((await fetchLatest('missing', { registry: base })).error).toMatch(/404/)
    expect((await fetchLatest('garbage', { registry: base })).error).toMatch(/unreadable/)
    expect((await fetchLatest('slow', { registry: base, timeoutMs: 300 })).error).toMatch(/in time/)
    expect((await fetchLatest('../etc', { registry: base })).error).toMatch(/not a package/)
    expect((await fetchLatest('x', { registry: 'file:///c:/' })).error).toMatch(/bad registry/)
  })

  describe('checks', () => {
    let dir
    let fetches
    let server2
    let reg
    const versions = { '@anthropic-ai/claude-code': '2.1.290', '@openai/codex': '0.157.1', 'opencode-ai': '1.20.0' }
    beforeEach(async () => {
      dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agentupd-'))
      fetches = []
      server2 = http.createServer((req, res) => {
        fetches.push(req.url)
        const pkg = decodeURIComponent(req.url.replace(/^\//, '').replace(/\/latest$/, ''))
        if (!versions[pkg]) {
          res.statusCode = 404
          return res.end('{}')
        }
        res.end(JSON.stringify({ version: versions[pkg] }))
      })
      await new Promise((r) => server2.listen(0, '127.0.0.1', r))
      reg = `http://127.0.0.1:${server2.address().port}`
    })
    afterEach(() => {
      server2.closeAllConnections?.()
      server2.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const prefix = 'C:\\npm'
    function make(extra = {}) {
      let t = 1000
      return createAgentUpdates({
        getAgents: async () => [
          { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
          { id: 'codex', name: 'Codex CLI', command: 'codex', available: true },
          { id: 'opencode', name: 'OpenCode', command: 'opencode', available: true },
          { id: 'kimi', name: 'Kimi Code', command: 'kimi', available: true },
          { id: 'gemini', name: 'Gemini CLI', command: 'gemini', available: false },
          { id: 'mine', name: 'Mine', command: 'mine', available: true, custom: true }
        ],
        which: async (bin) => ({ claude: 'C:\\Users\\me\\.local\\bin\\claude.exe', codex: `${prefix}\\codex`, opencode: `${prefix}\\opencode.cmd`, kimi: 'C:\\k\\kimi.exe' })[bin] || null,
        shell: async (line) =>
          line.startsWith('npm ls')
            ? { ok: false, stdout: JSON.stringify({ dependencies: { '@openai/codex': { version: '0.157.1' }, 'opencode-ai': { version: '1.18.32' } } }) }
            : { ok: true, stdout: `${prefix}\\node_modules\r\n` },
        runFile: async (file, args) => ({ ok: true, stdout: file.endsWith('claude.exe') && args[0] === '--version' ? '2.1.284 (Claude Code)\n' : '' }),
        cacheFile: join(dir, 'agent-updates.json'),
        home: 'C:\\Users\\me',
        registry: reg,
        now: () => (t += 1000),
        ...extra
      })
    }
    it('lists installed agents with their versions and updates, told once per version', async () => {
      const u = make()
      const r = await u.check()
      expect(r.agents.claude).toMatchObject({ source: 'native', installed: '2.1.284', latest: '2.1.290', update: true, steps: ['claude update'] })
      expect(r.agents.codex).toMatchObject({ source: 'npm', installed: '0.157.1', latest: '0.157.1', update: false })
      expect(r.agents.opencode).toMatchObject({ source: 'npm', installed: '1.18.32', latest: '1.20.0', update: true, steps: ['npm install -g opencode-ai@latest'] })
      expect(r.agents.kimi).toMatchObject({ source: 'other', update: false })
      expect(r.agents.kimi.note).toMatch(/installer/)
      expect(r.agents.gemini).toBeUndefined()
      expect(r.agents.mine).toBeUndefined()
      expect(r.newlyFound.map((f) => f.id).sort()).toEqual(['claude', 'opencode'])
      // Cached: no new registry request, and nothing told twice.
      const n = fetches.length
      const r2 = await u.check()
      expect(fetches.length).toBe(n)
      expect(r2.newlyFound).toEqual([])
      expect(u.status().agents.opencode.update).toBe(true)
      // Forced: asked again; a newer version is told again.
      versions['opencode-ai'] = '1.21.0'
      const r3 = await make().check({ force: true })
      expect(fetches.length).toBeGreaterThan(n)
      expect(r3.newlyFound).toEqual([{ id: 'opencode', name: 'OpenCode', installed: '1.18.32', latest: '1.21.0' }])
    })
    it('keeps the last known latest version when the registry is down', async () => {
      await make().check()
      server2.close()
      server2.closeAllConnections?.()
      const r = await make({ registry: 'http://127.0.0.1:9' }).check({ force: true })
      expect(r.agents.opencode.latest).toBe('1.21.0')
      expect(r.agents.opencode.error).toBeTruthy()
    })
    it('a fake detection file replaces the real one (tests only)', async () => {
      const fake = join(dir, 'fake.json')
      fs.writeFileSync(fake, JSON.stringify({ agents: [{ id: 'opencode', installed: '1.0.0', steps: ['echo updated'] }] }))
      const r = await make({ fakeFile: fake }).check()
      expect(Object.keys(r.agents)).toEqual(['opencode'])
      expect(r.agents.opencode).toMatchObject({ installed: '1.0.0', latest: '1.21.0', update: true, steps: ['echo updated'] })
    })
  })
})
