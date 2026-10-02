import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { envelopeProtection, secureStorageAvailable } from '../credentialProtection'

describe('credential protection at rest', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-cred-protection-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('tells a sealed envelope from a readable record, from the bytes only', () => {
    const file = join(dir, 'secrets.json')
    expect(envelopeProtection(file)).toBe(null)
    fs.writeFileSync(file, JSON.stringify({ v: 1, ciphertext: Buffer.from([1, 2, 250]).toString('base64') }))
    expect(envelopeProtection(file)).toBe('sealed')
    fs.writeFileSync(file, JSON.stringify({ minimaxApiKey: 'not-a-real-key' }))
    expect(envelopeProtection(file)).toBe('plaintext')
    fs.writeFileSync(file, '{}')
    expect(envelopeProtection(file)).toBe(null)
    fs.writeFileSync(file, 'not json')
    expect(envelopeProtection(file)).toBe(null)
    fs.writeFileSync(file, '')
    expect(envelopeProtection(file)).toBe(null)
  })

  it('knows when safeStorage can seal', () => {
    const store = (available, backend) => ({ isEncryptionAvailable: vi.fn(() => available), getSelectedStorageBackend: vi.fn(() => backend) })
    expect(secureStorageAvailable(store(true, 'dpapi'))).toBe(true)
    expect(secureStorageAvailable(store(false, 'dpapi'))).toBe(false)
    expect(secureStorageAvailable(store(true, 'basic_text'))).toBe(false)
    expect(secureStorageAvailable({ isEncryptionAvailable: () => true })).toBe(true)
    expect(secureStorageAvailable({ isEncryptionAvailable: () => { throw new Error('x') } })).toBe(false)
    expect(secureStorageAvailable(null)).toBe(false)
  })
})
