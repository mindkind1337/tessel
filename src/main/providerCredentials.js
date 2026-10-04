// Usage credentials and options for the providers Tessel reads quotas for
// without managing their sign-in (Settings > AI provider accounts: Gemini,
// OpenCode Go, MiniMax, a GLM Coding Plan key). The settings they hold follow Orca's AccountsPane and
// minimax-api-key-store.ts / minimax-cookie-store.ts (MIT, Copyright (c) 2026
// Lovecast Inc.); this storage is Tessel's: secrets are encrypted with the OS
// (safeStorage) like Linear's key and never leave the main process; only
// "saved" flags and plain options reach the window.
import fs from 'fs'
import { randomUUID } from 'crypto'
import { isAbsolute, join, resolve } from 'path'
import { writeJsonSafe } from './safeJson'
import { t } from './i18n'
import { envelopeProtection } from './credentialProtection'

export const SECRET_NAMES = Object.freeze([
  'minimaxApiKey',
  'minimaxCookie',
  'opencodeGoApiKey',
  'opencodeCookie',
  // A standalone GLM Coding Plan key (Z.ai or BigModel), read before ZCode
  // CLI's own (after Orca's zcode-plan-api-key-store.ts, MIT, Copyright (c)
  // 2026 Lovecast Inc.).
  'zcodePlanApiKey'
])
// The provider whose usage reading a value changes (to drop its old reading).
export const CREDENTIAL_PROVIDER = Object.freeze({
  minimaxApiKey: 'minimax',
  minimaxCookie: 'minimax',
  minimaxEndpoint: 'minimax',
  minimaxGroupId: 'minimax',
  minimaxUsageModels: 'minimax',
  opencodeGoApiKey: 'opencode-go',
  opencodeCookie: 'opencode-go',
  opencodeWorkspaceId: 'opencode-go',
  geminiCliOAuth: 'gemini',
  zcodePlanApiKey: 'zcode',
  zcodePlanSite: 'zcode'
})
// Orca's defaults (default-global-settings.ts).
export const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
  geminiCliOAuth: false,
  opencodeWorkspaceId: '',
  minimaxEndpoint: 'overseas',
  minimaxGroupId: '',
  minimaxUsageModels: 'general',
  // The GLM Coding Plan key's site: Z.ai ('zai') or BigModel ('bigmodel').
  zcodePlanSite: 'zai'
})
// A null prototype: "constructor" or "toString" is no setting.
const SETTING_RULES = Object.assign(Object.create(null), {
  geminiCliOAuth: (v) => typeof v === 'boolean',
  opencodeWorkspaceId: (v) => typeof v === 'string' && (v === '' || /^(?:wrk|wk)_[A-Za-z0-9]{1,100}$/.test(v)),
  minimaxEndpoint: (v) => v === 'overseas' || v === 'cn',
  minimaxGroupId: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(v),
  minimaxUsageModels: (v) => typeof v === 'string' && /^[A-Za-z0-9_.,\s-]{0,200}$/.test(v),
  zcodePlanSite: (v) => v === 'zai' || v === 'bigmodel'
})
const MAX_SECRET = 16384
const MAX_FILE = 128 * 1024

export class CredentialError extends Error {}
const fail = (message) => {
  throw new CredentialError(message)
}

// A pasted value: an API key is one token; a cookie header may hold spaces.
export function cleanSecret(name, value) {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (name.endsWith('Cookie')) text = text.replace(/^Cookie:\s*/i, '')
  if (!text || text.length > MAX_SECRET) return null
  return (name.endsWith('Cookie') ? /^[\x20-\x7e]+$/ : /^[\x21-\x7e]+$/).test(text) ? text : null
}

const validSettings = (value) =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.entries(value).every(([key, v]) => !SETTING_RULES[key] || SETTING_RULES[key](v))

export function createProviderCredentials({ dir, safeStorage } = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir))
    throw new TypeError('Provider credential storage requires an absolute directory.') // i18n-ignore programming error
  const folder = resolve(dir)
  const settingsFile = join(folder, 'settings.json')
  const secretsFile = join(folder, 'secrets.json')
  let secrets = null // decrypted, main process only
  let secretsError = null

  // Never follow a link planted in Tessel's own storage.
  function plain(path, kind) {
    let stat
    try {
      stat = fs.lstatSync(path)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    if (stat.isSymbolicLink() || (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()))
      fail(t('main.providerCredentials.storageInvalid', 'Tessel’s provider credential storage is invalid.'))
    return stat
  }
  function ensureFolder() {
    if (!plain(folder, 'dir')) fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    plain(folder, 'dir')
  }
  function encryption() {
    let ok = false
    try {
      ok =
        !!safeStorage?.isEncryptionAvailable() &&
        safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
    } catch {
      ok = false
    }
    return ok
  }
  function loadSecrets() {
    if (secrets) return secrets
    const stat = plain(folder, 'dir') && plain(secretsFile, 'file')
    if (!stat) return (secrets = {})
    try {
      if (stat.size > MAX_FILE || stat.nlink > 1) fail('invalid')
      if (!encryption()) fail('unavailable')
      const raw = JSON.parse(fs.readFileSync(secretsFile, 'utf8'))
      if (raw?.v !== 1 || typeof raw.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.ciphertext))
        fail('invalid')
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(raw.ciphertext, 'base64')))
      const next = {}
      for (const name of SECRET_NAMES) {
        const value = cleanSecret(name, record?.[name])
        if (value) next[name] = value
      }
      secretsError = null
      return (secrets = next)
    } catch {
      secretsError = t(
        'main.providerCredentials.unreadable',
        'Saved provider credentials could not be decrypted. Save them again or forget them.'
      )
      return {}
    }
  }
  function saveSecrets(next) {
    if (!encryption())
      fail(
        t(
          'main.providerCredentials.noSecureStorage',
          'Secure credential storage is unavailable on this computer, so nothing was saved.'
        )
      )
    ensureFolder()
    const existing = plain(secretsFile, 'file')
    if (existing && existing.nlink > 1)
      fail(t('main.providerCredentials.storageInvalid', 'Tessel’s provider credential storage is invalid.'))
    const encrypted = safeStorage.encryptString(JSON.stringify(next))
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_FILE / 2)
      fail(t('main.providerCredentials.encryptFailed', 'The credential could not be encrypted.'))
    const temporary = join(folder, `secrets-${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temporary, JSON.stringify({ v: 1, ciphertext: encrypted.toString('base64') }), {
        flag: 'wx',
        mode: 0o600
      })
      plain(secretsFile, 'file')
      fs.renameSync(temporary, secretsFile)
    } finally {
      try {
        fs.unlinkSync(temporary)
      } catch {
        /* renamed */
      }
    }
    secrets = next
    secretsError = null
  }
  function settings() {
    try {
      if (!plain(folder, 'dir') || !plain(settingsFile, 'file')) return { ...DEFAULT_PROVIDER_SETTINGS }
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      const out = { ...DEFAULT_PROVIDER_SETTINGS }
      if (raw && typeof raw === 'object')
        for (const key of Object.keys(out)) if (SETTING_RULES[key](raw[key])) out[key] = raw[key]
      return out
    } catch {
      return { ...DEFAULT_PROVIDER_SETTINGS }
    }
  }
  function status() {
    const saved = loadSecrets()
    return {
      ok: true,
      secure: encryption(),
      // How the saved file sits on disk ('sealed' | 'plaintext' | null), for
      // Settings' warning; read without decrypting.
      protection: envelopeProtection(secretsFile),
      saved: Object.fromEntries(SECRET_NAMES.map((name) => [name, !!saved[name]])),
      settings: settings(),
      ...(secretsError ? { error: secretsError } : {})
    }
  }
  const failure = (error) => ({
    ok: false,
    error:
      error instanceof CredentialError
        ? error.message
        : t('main.providerCredentials.saveFailed', 'The provider setting could not be saved.')
  })
  return {
    status,
    saveSecret(name, value) {
      try {
        if (!SECRET_NAMES.includes(name)) fail(t('main.providerCredentials.unknown', 'Unknown provider credential.'))
        const clean = cleanSecret(name, value)
        if (!clean) fail(t('main.providerCredentials.invalidValue', 'Paste a valid value.'))
        const current = loadSecrets()
        // An unreadable store is replaced only by an explicit save.
        saveSecrets({ ...(secretsError ? {} : current), [name]: clean })
        return status()
      } catch (error) {
        return failure(error)
      }
    },
    clearSecret(name) {
      try {
        if (!SECRET_NAMES.includes(name)) fail(t('main.providerCredentials.unknown', 'Unknown provider credential.'))
        const current = loadSecrets()
        if (secretsError) {
          // Forgetting what cannot be read: drop the whole unreadable file.
          plain(secretsFile, 'file')
          fs.rmSync(secretsFile, { force: true })
          secrets = {}
          secretsError = null
        } else if (current[name]) {
          const next = { ...current }
          delete next[name]
          if (Object.keys(next).length) saveSecrets(next)
          else {
            plain(secretsFile, 'file')
            fs.rmSync(secretsFile, { force: true })
            secrets = {}
          }
        }
        return status()
      } catch (error) {
        return failure(error)
      }
    },
    update(patch) {
      try {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
          fail(t('main.providerCredentials.invalidValue', 'Paste a valid value.'))
        const next = settings()
        for (const [key, value] of Object.entries(patch)) {
          if (!SETTING_RULES[key]) fail(t('main.providerCredentials.unknown', 'Unknown provider credential.'))
          const v = typeof value === 'string' ? value.trim() : value
          if (!SETTING_RULES[key](v)) fail(t('main.providerCredentials.invalidValue', 'Paste a valid value.'))
          next[key] = v
        }
        ensureFolder()
        plain(settingsFile, 'file')
        writeJsonSafe(settingsFile, next, validSettings)
        return status()
      } catch (error) {
        return failure(error)
      }
    },
    // Main process only (usage reads): never sent over IPC.
    secret(name) {
      return loadSecrets()[name] || null
    },
    settings
  }
}
