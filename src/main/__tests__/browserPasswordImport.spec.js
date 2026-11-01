// @vitest-environment node
import { it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
const mock = vi.hoisted(() => ({ browsers: [], key: null }))
vi.mock('../cookieImport/detect', () => ({ detectBrowsers: async () => mock.browsers }))
vi.mock('../cookieImport/dpapi', () => ({ unprotectDpapi: async () => mock.key }))
import { importBrowserPasswords, passwordSources } from '../browserPasswords'

it('imports Chromium passwords from a snapshot, counts protected values and rejects unknown profiles', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-password-import-'))
  try {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const file = path.join(root, 'Login Data')
    const state = path.join(root, 'Local State')
    mock.key = crypto.randomBytes(32)
    fs.writeFileSync(state, JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIfixture').toString('base64') } }))
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', mock.key, iv)
    const body = Buffer.concat([cipher.update('fixture-only'), cipher.final()])
    const sealed = Buffer.concat([Buffer.from('v10'), iv, body, cipher.getAuthTag()])
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE logins(origin_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)')
    const insert = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?)')
    insert.run('https://example.test/login', 'fixture', sealed, 0)
    insert.run('https://protected.test', 'fixture', Buffer.from('v20fixture'), 0)
    insert.run('https://excluded.test', 'fixture', sealed, 1)
    db.close()
    mock.browsers = [{ id: 'chrome', name: 'Chrome', family: 'chromium', localStatePath: state, profiles: [{ dir: root, name: 'Fixture' }] }]
    const vault = { importRows: vi.fn((rows) => ({ ok: true, imported: rows.length, skipped: 0 })) }
    const sources = await passwordSources()
    expect(JSON.stringify(sources)).not.toContain('fixture-only')
    const result = await importBrowserPasswords(vault, { browserId: 'chrome', profileDir: root }, path.join(root, 'copies'))
    expect(result).toMatchObject({ imported: 1, appBoundCount: 1, protectedCount: 0 })
    expect(vault.importRows.mock.calls[0][0][0]).toMatchObject({ password: 'fixture-only' })
    await expect(importBrowserPasswords(vault, { browserId: 'chrome', profileDir: 'arbitrary' }, root)).rejects.toMatchObject({ code: 'not-found' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
