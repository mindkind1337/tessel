// @vitest-environment node
import { it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createPasswordVault, parsePasswordCsv, fillSavedPassword } from '../browserPasswords'
import { registerPasswordManager } from '../browserPasswordManager'

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-password-test-'))
  const key = crypto.randomBytes(32)
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(text), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes])
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()
    }
  }
  const file = path.join(dir, 'browser-passwords.sealed')
  return { dir, file, safeStorage, vault: createPasswordVault({ file, safeStorage }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

it('imports quoted CSV and seals secrets; exact origins and explicit agent opt-in are required', () => {
  const f = fixture()
  try {
    const parsed = parsePasswordCsv('name,url,username,password\r\nSite,https://example.test/login,"user,name","secret,""quoted""\nline"\r\n')
    expect(parsed[0].password).toBe('secret,"quoted"\nline')
    expect(f.vault.importRows(parsed)).toMatchObject({ imported: 1, skipped: 0 })
    expect(fs.readFileSync(f.file).includes(Buffer.from('secret'))).toBe(false)
    expect(JSON.stringify(f.vault.list())).not.toContain('secret')
    const entry = f.vault.list()[0]
    expect(f.vault.list(entry.origin, true)).toEqual([])
    expect(() => f.vault.credential(entry.id, 'https://other.test')).toThrow()
    expect(() => f.vault.credential(entry.id, entry.origin, true)).toThrow()
    f.vault.change(entry.id, 'allow', true)
    expect(f.vault.list(entry.origin, true)).toHaveLength(1)
    f.vault.importRows(parsed)
    expect(f.vault.list(entry.origin, true)).toEqual([])
    const again = createPasswordVault({ file: f.file, safeStorage: f.safeStorage })
    expect(again.list()).toHaveLength(1)
    f.vault.change(entry.id, 'delete')
    expect(f.vault.list()).toEqual([])
    f.safeStorage.isEncryptionAvailable = () => false
    expect(() => f.vault.importRows(parsed)).toThrow('encryption-unavailable')
  } finally { f.cleanup() }
})

it('fails closed on a damaged vault, HTTP sites and Live Share, never returning a page secret', async () => {
  const f = fixture()
  try {
    f.vault.importRows([{ origin: 'https://example.test', username: 'test', password: 'fixture-only' }])
    const id = f.vault.list()[0].id
    const guest = { getURL: () => 'https://example.test/login', executeJavaScriptInIsolatedWorld: vi.fn(async () => ({ ok: false, code: 'fixture-only', password: 'fixture-only' })) }
    const blocked = await fillSavedPassword({ vault: f.vault, guest, id, allowed: () => false })
    expect(blocked.code).toBe('private-page-required')
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    const result = await fillSavedPassword({ vault: f.vault, guest, id, allowed: () => true })
    expect(result).toEqual({ ok: false, code: 'fill-failed' })
    guest.getURL = () => 'http://example.test'
    expect((await fillSavedPassword({ vault: f.vault, guest, id, allowed: () => true })).code).toBe('https-required')
    fs.writeFileSync(f.file, 'damaged')
    expect(() => f.vault.importRows([])).toThrow('vault-unavailable')
    expect(fs.readFileSync(f.file, 'utf8')).toBe('damaged')
  } finally { f.cleanup() }
})

it('refuses every vault IPC and agent login during Live Share or from a foreign sender', async () => {
  const f = fixture()
  try {
    const handlers = {}, sender = {}, foreign = {}
    let sharing = true
    const manager = registerPasswordManager({ ipcMain: { handle: (name, fn) => { handlers[name] = fn } }, safeStorage: f.safeStorage, dialog: {}, dataDir: f.dir, getWindow: () => ({ isDestroyed: () => false, webContents: sender }), guestFor: () => null, allowedPage: () => true, sharingActive: () => sharing })
    for (const fn of Object.values(handlers)) expect(await fn({ sender })).toMatchObject({ ok: false, code: 'private-page-required' })
    expect(await manager.login({ getURL: () => 'https://example.test' })).toMatchObject({ ok: false })
    sharing = false
    for (const fn of Object.values(handlers)) expect(await fn({ sender: foreign })).toMatchObject({ ok: false })
    expect(await handlers['browser:passwordList']({ sender })).toMatchObject({ ok: true, entries: [] })
  } finally { f.cleanup() }
})
