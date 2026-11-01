// @vitest-environment node
// Export and import of the settings (settingsBackup.js): what goes in the file, what
// never does, what a hostile file cannot do, and the two-step import (staged, then
// put in place at the next start, with the replaced files kept).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CATEGORIES, FORMAT, PENDING_DIR, BACKUPS_DIR, buildBackup, inspectBackup, stageImport, hasPendingImport, applyPendingImport } from '../settingsBackup'

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

  it('at the next start the staged files replace the live ones; the replaced ones are kept and the old .bak does not come back', () => {
    const files = bundleFiles() // restoreWorkspaces: false
    put('workspace-layout.json', { version: 1, settings: { restoreWorkspaces: true } })
    put('workspace-layout.json.bak', { version: 1, settings: { restoreWorkspaces: 'OLD-BAK' } })
    stageImport({ dir, files, categories: ['settings', 'board'] })
    const r = applyPendingImport({ dir, now: () => Date.UTC(2026, 10, 1, 12, 0, 0) })
    expect(r.applied.sort()).toEqual(['task-board.json', 'workspace-layout.json'])
    expect(r.failed).toEqual([])
    expect(JSON.parse(read('workspace-layout.json')).settings.restoreWorkspaces).toBe(false)
    expect(fs.existsSync(path.join(dir, 'workspace-layout.json.bak'))).toBe(false)
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
