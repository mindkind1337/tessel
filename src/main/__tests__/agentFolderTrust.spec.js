// @vitest-environment node
// Pre-trusting the folder an agent starts in (agentFolderTrust.js,
// codexProjectTrust.js). Every write goes to a fake home in a temp folder:
// the env and homedir are always given, never this machine's own.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import {
  claudeConfigFile,
  claudeTrustKeys,
  createAgentFolderTrust,
  cursorSlug,
  grantClaudeFolderTrust,
  isTooBroadToPreTrust,
  withClaudeFolderTrust
} from '../agentFolderTrust'
import { withCodexProjectTrusted, projectHeaderPath } from '../codexProjectTrust'

let tmp, home, project, other
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(join(os.tmpdir(), 'tessel-pretrust-')))
  home = join(tmp, 'home')
  project = join(tmp, 'code', 'app')
  other = join(tmp, 'code', 'elsewhere')
  for (const d of [home, project, other]) fs.mkdirSync(d, { recursive: true })
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const env = () => ({ USERPROFILE: home, HOME: home })
const style = process.platform === 'win32' ? 'win32' : 'posix'
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

describe('Codex config.toml edit', () => {
  it('appends a table, keeping every other line, comment and the CRLF endings', () => {
    const text = '# my settings\r\nmodel = "gpt-5"\r\n\r\n[mcp_servers.x]\r\ncommand = "x" # keep\r\n'
    const r = withCodexProjectTrusted(text, 'C:\\code\\app')
    expect(r.changed).toBe(true)
    expect(r.text).toBe(text + '\r\n[projects."C:\\\\code\\\\app"]\r\ntrust_level = "trusted"\r\n')
    // Idempotent.
    expect(withCodexProjectTrusted(r.text, 'C:\\code\\app')).toEqual({ text: r.text, changed: false })
  })

  it('an empty file gets just the table', () => {
    expect(withCodexProjectTrusted('', '/home/me/app').text).toBe('[projects."/home/me/app"]\ntrust_level = "trusted"\n')
  })

  it('finds the table in any spelling and case on Windows, and adds the key inside it', () => {
    const text = "[\"projects\".'c:/CODE/App'] # mine\nother = 1\n\n[tui]\nx = 2\n"
    const r = withCodexProjectTrusted(text, 'C:\\code\\app')
    expect(r.text).toBe("[\"projects\".'c:/CODE/App'] # mine\ntrust_level = \"trusted\"\nother = 1\n\n[tui]\nx = 2\n")
  })

  it('rewrites an odd trust_level once, never doubles it, and never overrides "untrusted"', () => {
    const odd = '[projects."/a"]\n"trust_level" = "maybe"\n'
    expect(withCodexProjectTrusted(odd, '/a').text).toBe('[projects."/a"]\ntrust_level = "trusted"\n')
    const no = '[projects."/a"]\ntrust_level = "untrusted"\n'
    expect(withCodexProjectTrusted(no, '/a')).toEqual({ text: no, changed: false, reason: 'untrusted' })
    // A trust_level of another table is not ours.
    const later = '[projects."/a"]\n[projects."/b"]\ntrust_level = "trusted"\n'
    expect(withCodexProjectTrusted(later, '/a').text).toBe('[projects."/a"]\ntrust_level = "trusted"\n[projects."/b"]\ntrust_level = "trusted"\n')
  })

  it('a header inside a multi-line string is data, not a table', () => {
    const text = 'notes = """\n[projects."/a"]\n"""\n'
    const r = withCodexProjectTrusted(text, '/a')
    expect(r.text).toBe(text + '\n[projects."/a"]\ntrust_level = "trusted"\n')
    expect(projectHeaderPath('[[projects."/a"]]')).toBe(null)
    expect(projectHeaderPath('[projects."/a".sub]')).toBe(null)
  })

  it('a folder already set as a dotted key or an inline table is left alone (no duplicate table, no overriding "untrusted")', () => {
    const forms = [
      'projects."/a".trust_level = "untrusted"\n',
      '[projects]\n"/a" = { trust_level = "untrusted" }\n',
      '[projects]\n"/a".trust_level = "untrusted"\n',
      'projects = { "/a" = { trust_level = "untrusted" } }\n',
      "[projects]\n'C:/CODE/App' = { trust_level = \"untrusted\" }\n"
    ]
    for (const text of forms) {
      const r = withCodexProjectTrusted(text, text.includes('App') ? 'C:\\code\\app' : '/a')
      expect(r).toEqual({ text, changed: false, reason: 'unreadable' })
    }
    // Other folders in those forms: ours is added as its own table.
    const other = '[projects]\n"/b" = { trust_level = "trusted" }\n'
    expect(withCodexProjectTrusted(other, '/a').changed).toBe(true)
    const header = '[projects."/a"]\ntrust_level = "untrusted"\n'
    expect(withCodexProjectTrusted(header, '/a').reason).toBe('untrusted')
  })

  it('keeps a byte-order mark', () => {
    const r = withCodexProjectTrusted('\ufeffa = 1\n', '/a')
    expect(r.text.startsWith('\ufeffa = 1\n')).toBe(true)
  })
})

describe('Claude Code config', () => {
  it('adds hasTrustDialogAccepted, keeping the folder entry and every other key', () => {
    const cfg = { numStartups: 3, projects: { '/a': { allowedTools: ['x'] }, '/b': { hasTrustDialogAccepted: true } } }
    const r = withClaudeFolderTrust(cfg, ['/a'])
    expect(r.kind).toBe('changed')
    expect(r.config).toEqual({ numStartups: 3, projects: { '/a': { allowedTools: ['x'], hasTrustDialogAccepted: true }, '/b': { hasTrustDialogAccepted: true } } })
    expect(withClaudeFolderTrust(cfg, ['/b']).kind).toBe('unchanged')
    expect(withClaudeFolderTrust({ projects: [] }, ['/a']).kind).toBe('refuse')
  })

  it('keys as Claude spells them: / on Windows', () => {
    expect(claudeTrustKeys('C:\\code\\app\\', 'win32')).toContain('C:/code/app/')
    expect(claudeTrustKeys('/home/me/../me/app', 'posix')).toContain('/home/me/app')
  })

  it('the file Claude reads: CLAUDE_CONFIG_DIR, the legacy file, custom OAuth', () => {
    const none = () => false
    expect(claudeConfigFile({}, '/h', { style: 'posix', exists: none })).toBe('/h/.claude.json')
    expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: '/acc' }, '/h', { style: 'posix', exists: none })).toBe('/acc/.claude.json')
    expect(claudeConfigFile({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'x' }, '/h', { style: 'posix', exists: none })).toBe('/h/.claude-custom-oauth.json')
    expect(claudeConfigFile({}, '/h', { style: 'posix', exists: (f) => f === '/h/.claude/.config.json' })).toBe('/h/.claude/.config.json')
  })

  it('never creates the file, never rewrites one it cannot parse, never breaks the lock', async () => {
    const file = join(home, '.claude.json')
    expect(await grantClaudeFolderTrust(file, ['/a'])).toBe('missing-config')
    expect(fs.existsSync(file)).toBe(false)
    fs.writeFileSync(file, '{ broken')
    expect(await grantClaudeFolderTrust(file, ['/a'])).toBe('unreadable')
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken')
    fs.writeFileSync(file, JSON.stringify({ userID: 'u' }))
    fs.mkdirSync(`${file}.lock`)
    expect(await grantClaudeFolderTrust(file, ['/a'])).toBe('locked')
    expect(readJson(file)).toEqual({ userID: 'u' })
    fs.rmdirSync(`${file}.lock`)
    expect(await grantClaudeFolderTrust(file, ['/a'])).toBe('granted')
    expect(readJson(file)).toEqual({ userID: 'u', projects: { '/a': { hasTrustDialogAccepted: true } } })
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
  })
})

it('too broad: a disk root, a home, or a folder above a home; not a folder inside it', () => {
  expect(isTooBroadToPreTrust(home, [home])).toBe(true)
  expect(isTooBroadToPreTrust(tmp, [home])).toBe(true)
  expect(isTooBroadToPreTrust(process.platform === 'win32' ? 'C:\\' : '/', [home])).toBe(true)
  expect(isTooBroadToPreTrust(join(home, 'code'), [home])).toBe(false)
  expect(isTooBroadToPreTrust(project, [home])).toBe(false)
})

it('Cursor slug: no drive colon or separators', () => {
  expect(cursorSlug('C:\\code\\app')).toBe('C-code-app')
  expect(cursorSlug('/home/me/app')).toBe('home-me-app')
})

describe('createAgentFolderTrust', () => {
  const make = (extra = {}) => {
    const s = createAgentFolderTrust({ homedir: () => home, platform: process.platform, ...extra })
    s.setRoots([project])
    return s
  }
  const claudeFile = () => join(home, '.claude.json')

  it('a project the user added: Claude trusts it; other folders, other agents, the setting off: nothing', async () => {
    fs.writeFileSync(claudeFile(), '{"oauthAccount":{"x":1}}')
    const s = make()
    expect(await s.apply({ agentId: 'claude', cwd: other, env: env(), enabled: true })).toBe('not-eligible')
    expect(await s.apply({ agentId: 'claude', cwd: project, env: env(), enabled: false })).toBe('off')
    expect(await s.apply({ agentId: 'aider', cwd: project, env: env(), enabled: true })).toBe('no-preset')
    expect(await s.apply({ agentId: 'claude', cwd: project, env: env(), enabled: true, remote: true })).toBe('not-eligible')
    expect(await s.apply({ agentId: 'claude', cwd: project, env: env(), enabled: true, wsl: true })).toBe('not-eligible')
    expect(await s.apply({ agentId: 'claude', cwd: 'relative/path', env: env(), enabled: true })).toBe('not-eligible')
    expect(readJson(claudeFile())).toEqual({ oauthAccount: { x: 1 } })
    expect(await s.apply({ agentId: 'claude', cwd: project, env: env(), enabled: true })).toBe('granted')
    const cfg = readJson(claudeFile())
    expect(cfg.oauthAccount).toEqual({ x: 1 })
    expect(Object.keys(cfg.projects)).toEqual(claudeTrustKeys(project, style))
    expect(await s.apply({ agentId: 'claude', cwd: project, env: env(), enabled: true })).toBe('unchanged')
  })

  it("a Claude account's CLAUDE_CONFIG_DIR is the file written", async () => {
    const acc = join(tmp, 'acc')
    fs.mkdirSync(acc)
    fs.writeFileSync(join(acc, '.claude.json'), '{}')
    fs.writeFileSync(claudeFile(), '{}')
    await make().apply({ agentId: 'claude', cwd: project, env: { ...env(), CLAUDE_CONFIG_DIR: acc }, enabled: true })
    expect(readJson(join(acc, '.claude.json')).projects).toBeTruthy()
    expect(readJson(claudeFile())).toEqual({})
  })

  it('a folder trusted for chats counts; a copy counts only through a chosen project', async () => {
    fs.writeFileSync(claudeFile(), '{}')
    const copy = join(tmp, 'copy')
    fs.mkdirSync(copy)
    const chatTrust = { isTrusted: (d) => d === other }
    let copyOf = []
    const workerCopies = { trustRoots: (cwd, o) => (cwd === copy && o.worker === true ? copyOf : []) }
    const s = make({ chatTrust, workerCopies })
    expect(await s.apply({ agentId: 'claude', cwd: other, env: env(), enabled: true })).toBe('granted')
    expect(await s.apply({ agentId: 'claude', cwd: copy, env: env(), enabled: true })).toBe('not-eligible')
    copyOf = [join(tmp, 'unknown-project')]
    expect(await s.apply({ agentId: 'claude', cwd: copy, env: env(), enabled: true })).toBe('not-eligible')
    copyOf = [project]
    expect(await s.apply({ agentId: 'claude', cwd: copy, env: env(), enabled: true })).toBe('granted')
  })

  it('a project at the home folder: never for Claude or Copilot, Codex still', async () => {
    fs.writeFileSync(claudeFile(), '{}')
    fs.mkdirSync(join(home, '.codex'))
    const s = make()
    s.setRoots([home])
    expect(await s.apply({ agentId: 'claude', cwd: home, env: env(), enabled: true })).toBe('too-broad')
    expect(await s.apply({ agentId: 'copilot', cwd: home, env: env(), enabled: true })).toBe('too-broad')
    expect(readJson(claudeFile())).toEqual({})
    expect(await s.apply({ agentId: 'codex', cwd: home, env: env(), enabled: true })).toBe('granted')
  })

  it('Codex: never a home that is itself a git repository (Codex would trust every folder below it without its own)', async () => {
    fs.mkdirSync(join(home, '.codex'))
    fs.mkdirSync(join(home, '.git'))
    const s = make()
    s.setRoots([home, project])
    expect(await s.apply({ agentId: 'codex', cwd: home, env: env(), enabled: true })).toBe('too-broad')
    expect(fs.existsSync(join(home, '.codex', 'config.toml'))).toBe(false)
    // A project folder that is a repository still is.
    fs.mkdirSync(join(project, '.git'))
    expect(await s.apply({ agentId: 'codex', cwd: project, env: env(), enabled: true })).toBe('granted')
  })

  it('Codex: the config.toml of its CODEX_HOME, edited in place; no Codex home, nothing created', async () => {
    const s = make()
    expect(await s.apply({ agentId: 'codex', cwd: project, env: env(), enabled: true })).toBe('missing-config')
    expect(fs.existsSync(join(home, '.codex'))).toBe(false)
    const codexHome = join(tmp, 'codex-acc')
    fs.mkdirSync(codexHome)
    fs.writeFileSync(join(codexHome, 'config.toml'), '# mine\nmodel = "x"\n')
    expect(await s.apply({ agentId: 'codex', cwd: project, env: { ...env(), CODEX_HOME: codexHome }, enabled: true })).toBe('granted')
    const text = fs.readFileSync(join(codexHome, 'config.toml'), 'utf8')
    expect(text.startsWith('# mine\nmodel = "x"\n\n[projects."')).toBe(true)
    expect(text.endsWith('"]\ntrust_level = "trusted"\n')).toBe(true)
    expect(await s.apply({ agentId: 'codex', cwd: project, env: { ...env(), CODEX_HOME: codexHome }, enabled: true })).toBe('unchanged')
  })

  it('Cursor, Copilot and Antigravity: their own files under the home, other keys kept', async () => {
    const s = make()
    fs.mkdirSync(join(home, '.copilot'))
    fs.writeFileSync(join(home, '.copilot', 'config.json'), JSON.stringify({ loggedInUsers: [1], trustedFolders: ['/x'] }))
    expect(await s.apply({ agentId: 'copilot', cwd: project, env: env(), enabled: true })).toBe('granted')
    expect(readJson(join(home, '.copilot', 'config.json'))).toEqual({ loggedInUsers: [1], trustedFolders: ['/x', project] })
    expect(await s.apply({ agentId: 'copilot', cwd: project, env: env(), enabled: true })).toBe('unchanged')

    expect(await s.apply({ agentId: 'antigravity', cwd: project, env: env(), enabled: true })).toBe('granted')
    expect(readJson(join(home, '.gemini', 'antigravity-cli', 'settings.json'))).toEqual({ trustedWorkspaces: [project] })

    expect(await s.apply({ agentId: 'cursor', cwd: project, env: env(), enabled: true })).toBe('granted')
    const marker = join(home, '.cursor', 'projects', cursorSlug(project), '.workspace-trusted')
    expect(readJson(marker).workspacePath).toBe(project)
  })

  it('a settings file that does not parse is left alone', async () => {
    fs.mkdirSync(join(home, '.copilot'))
    fs.writeFileSync(join(home, '.copilot', 'config.json'), '// comment\n{')
    expect(await make().apply({ agentId: 'copilot', cwd: project, env: env(), enabled: true })).toBe('unreadable')
    expect(fs.readFileSync(join(home, '.copilot', 'config.json'), 'utf8')).toBe('// comment\n{')
  })

  it('a slow write never holds the launch past the deadline', async () => {
    fs.writeFileSync(claudeFile(), '{"a":1}')
    fs.mkdirSync(`${claudeFile()}.lock`)
    const s = make({ deadlineMs: 20 })
    expect(await s.apply({ agentId: 'claude', cwd: project, env: env(), enabled: true })).toBe('timeout')
    // The write behind it gives up on the held lock without touching the file.
    await new Promise((r) => setTimeout(r, 900))
    expect(readJson(claudeFile())).toEqual({ a: 1 })
    fs.rmdirSync(`${claudeFile()}.lock`)
  })
})
