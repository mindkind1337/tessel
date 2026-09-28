// Independent implementation informed by stablyai/orca's Claude account/runtime
// auth services (MIT, Lovecast Inc., 2026). Credentials stay in private main-process
// storage; public records contain identity metadata only. Windows/file auth only.
import os from 'os'
import fs from 'fs/promises'
import { join, resolve, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import {
  authError,
  inspect,
  ensureDirectory,
  readText,
  writeText,
  exclusiveText,
  jsonObject,
  ownedDirectory,
  removeOwnedDirectory
} from './claudeAccountsStorage'

const MARKER = '.tessel-managed-claude-auth'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const queues = new Map()
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const publicText = (value) =>
  text(value)
    ?.replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 240) || null
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])])
        )
      : value
const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`
const absentOauth = () => ({ present: false, value: null })
const oauthField = (config) =>
  Object.hasOwn(config, 'oauthAccount')
    ? { present: true, value: config.oauthAccount }
    : absentOauth()
const identity = (value) => ({
  account: text(value?.accountUuid ?? value?.accountId),
  email: text(value?.emailAddress ?? value?.email)?.toLowerCase() || null,
  organization: text(value?.organizationUuid ?? value?.organizationId ?? value?.orgId)
})
const conflict = (a, b) =>
  ['account', 'email', 'organization'].some((k) => a[k] && b[k] && a[k] !== b[k])
function matches(a, b) {
  return (
    !conflict(a, b) &&
    !!((a.account && a.account === b.account) || (a.email && a.email === b.email)) &&
    (!a.organization || a.organization === b.organization)
  )
}
function credentials(raw) {
  if (raw === null) return null
  const parsed = jsonObject(raw)
  if (!object(parsed.claudeAiOauth) || !text(parsed.claudeAiOauth.accessToken))
    throw authError('Claude OAuth credentials are missing or invalid.')
  return parsed.claudeAiOauth
}
function metadata(raw) {
  if (raw === null) return { version: 1, selectedId: null, accounts: [] }
  const value = jsonObject(raw)
  if (
    value.version !== 1 ||
    !(value.selectedId === null || typeof value.selectedId === 'string') ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 100 ||
    value.accounts.some(
      (a) =>
        !object(a) ||
        !UUID.test(a.id) ||
        !object(a.identity) ||
        !['account', 'email', 'organization'].every(
          (key) => a.identity[key] === null || typeof a.identity[key] === 'string'
        ) ||
        (!a.identity.account && !a.identity.email) ||
        typeof a.lastLoginAt !== 'string'
    ) ||
    new Set(value.accounts.map((a) => a.id)).size !== value.accounts.length
  )
    throw authError()
  return value
}

export function createClaudeAccounts({
  userData,
  home = os.homedir(),
  env = process.env,
  runLogin,
  now = Date.now
} = {}) {
  if (!text(userData) || !isAbsolute(userData) || !isAbsolute(home))
    throw authError('Absolute account storage and home paths are required.')
  const data = resolve(userData)
  const accountsRoot = join(data, 'claude-accounts')
  const runtimeRoot = join(data, 'claude-runtime-auth')
  const indexPath = join(accountsRoot, 'accounts.json')
  const snapshotPath = join(runtimeRoot, 'system-default-auth.json')
  const journalPath = join(runtimeRoot, 'transaction.json')
  const override = text(env.CLAUDE_CONFIG_DIR)
  if (override && !isAbsolute(override)) throw authError('CLAUDE_CONFIG_DIR must be absolute.')
  const configDir = override || join(resolve(home), '.claude')
  const credentialsPath = join(configDir, '.credentials.json')
  // Claude config-dir logins use a colocated .claude.json (also used by Orca).
  const configPath = override
    ? join(configDir, '.claude.json')
    : join(resolve(home), '.claude.json')
  const binding = { credentialsPath, configPath }
  const queueKey = process.platform === 'win32' ? data.toLowerCase() : data
  const authPath = (id) => {
    if (!UUID.test(id)) throw authError('Unknown Claude account.')
    return join(accountsRoot, id, 'auth')
  }
  const safe = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      throw error?.safeClaudeAccountError ? error : authError()
    }
  }
  const serialized = (fn) => {
    const previous = queues.get(queueKey) || Promise.resolve()
    const next = previous.catch(() => {}).then(() => safe(fn))
    queues.set(queueKey, next)
    next
      .finally(() => {
        if (queues.get(queueKey) === next) queues.delete(queueKey)
      })
      .catch(() => {})
    return next
  }
  const readMetadata = async () => metadata(await readText(indexPath))
  const readConfig = async () => {
    const raw = await readText(configPath)
    const config = raw === null ? {} : jsonObject(raw)
    if (
      Object.hasOwn(config, 'oauthAccount') &&
      config.oauthAccount !== null &&
      !object(config.oauthAccount)
    )
      throw authError()
    return config
  }
  async function systemAuth() {
    // A missing child of an unreadable/link home must never look logged out.
    await inspect(resolve(home), true)
    const raw = await readText(credentialsPath)
    if (raw !== null) jsonObject(raw)
    return { credentials: raw, oauth: oauthField(await readConfig()) }
  }
  async function managed(id) {
    const path = authPath(id)
    try {
      if (!(await ownedDirectory(accountsRoot, path, MARKER, id))) return { status: 'missing' }
      const raw = await readText(join(path, '.credentials.json'))
      const accountRaw = await readText(join(path, 'oauth-account.json'))
      if (raw === null || accountRaw === null) return { status: 'missing' }
      const token = credentials(raw)
      const oauth = jsonObject(accountRaw)
      if (conflict(identity(token), identity(oauth))) throw authError()
      return { status: 'ready', raw, oauth, token }
    } catch {
      return { status: 'unknown' }
    }
  }
  function publicAccount(account, status, selectedId) {
    return {
      id: account.id,
      label: publicText(account.label) || publicText(account.email) || 'Claude account',
      email: publicText(account.email),
      organization: publicText(account.organization),
      plan: publicText(account.plan),
      status,
      lastLoginAt: account.lastLoginAt,
      active: account.id === selectedId
    }
  }
  function authStatus(auth) {
    if (auth.credentials === null) return 'missing'
    try {
      const stored = jsonObject(auth.credentials)
      // A valid credentials document may hold API/provider auth without a
      // claude.ai OAuth login. System default may still launch with that setup.
      if (!Object.hasOwn(stored, 'claudeAiOauth') || stored.claudeAiOauth === null) return 'missing'
      const token = credentials(auth.credentials)
      const who = identity(auth.oauth.value)
      return auth.oauth.present && (who.account || who.email) && !conflict(identity(token), who)
        ? 'ready'
        : 'unknown'
    } catch {
      return 'unknown'
    }
  }
  async function snapshot(refresh = false) {
    const raw = await readText(snapshotPath)
    if (refresh) {
      // Each departure from System default captures the login currently there.
      // Read both source surfaces successfully before replacing an older backup.
      const original = { version: 1, binding, ...(await systemAuth()) }
      await writeText(snapshotPath, encode(original), raw)
      return original
    }
    if (raw !== null) {
      const value = jsonObject(raw)
      if (
        value.version !== 1 ||
        !equal(value.binding, binding) ||
        !(value.credentials === null || typeof value.credentials === 'string') ||
        !object(value.oauth) ||
        typeof value.oauth.present !== 'boolean' ||
        (value.oauth.present && value.oauth.value !== null && !object(value.oauth.value))
      )
        throw authError('The system-default Claude auth snapshot is unavailable or invalid.')
      if (value.credentials !== null) jsonObject(value.credentials)
      return value
    }
    throw authError('The system-default Claude auth snapshot is missing.')
  }
  async function slotPath(change) {
    if (change.kind === 'index') return indexPath
    if (change.kind === 'credentials') return credentialsPath
    if (change.kind === 'managedCredentials' || change.kind === 'managedOauth') {
      const path = authPath(change.id)
      if (!(await ownedDirectory(accountsRoot, path, MARKER, change.id))) throw authError()
      return join(
        path,
        change.kind === 'managedCredentials' ? '.credentials.json' : 'oauth-account.json'
      )
    }
    throw authError()
  }
  async function readSlot(change) {
    return change.kind === 'oauth'
      ? oauthField(await readConfig())
      : readText(await slotPath(change))
  }
  async function applySlot(change, value, expected) {
    const current = await readSlot(change)
    if (equal(current, value)) return
    if (!equal(current, expected))
      throw authError(
        'Claude account files changed during the operation. Recovery requires the original files.'
      )
    if (change.kind === 'oauth') {
      const raw = await readText(configPath)
      const config = raw === null ? {} : jsonObject(raw)
      if (!equal(oauthField(config), expected)) throw authError()
      if (value.present) config.oauthAccount = value.value
      else delete config.oauthAccount
      await writeText(configPath, Object.keys(config).length ? encode(config) : null, raw)
    } else await writeText(await slotPath(change), value, current)
  }
  function validateJournal(value) {
    if (
      value.version !== 1 ||
      !equal(value.binding, binding) ||
      !Array.isArray(value.changes) ||
      value.changes.length > 12
    )
      throw authError()
    for (const change of value.changes) {
      if (
        !object(change) ||
        !['index', 'credentials', 'oauth', 'managedCredentials', 'managedOauth'].includes(
          change.kind
        )
      )
        throw authError()
      if (change.kind.startsWith('managed') && !UUID.test(change.id)) throw authError()
      for (const part of ['before', 'after']) {
        const v = change[part]
        if (change.kind === 'oauth') {
          if (
            !object(v) ||
            typeof v.present !== 'boolean' ||
            (v.present && v.value !== null && !object(v.value))
          )
            throw authError()
        } else if (!(v === null || typeof v === 'string')) throw authError()
        else if (change.kind === 'index') metadata(v)
        else if (v !== null) jsonObject(v)
      }
    }
  }
  async function recover() {
    const raw = await readText(journalPath)
    if (raw === null) return
    const journal = jsonObject(raw)
    validateJournal(journal)
    for (const change of [...journal.changes].reverse())
      await applySlot(change, change.before, change.after)
    await writeText(journalPath, null, raw)
  }
  async function transaction(changes) {
    const prepared = []
    for (const change of changes) {
      const before = await readSlot(change)
      if (Object.hasOwn(change, 'expected') && !equal(before, change.expected))
        throw authError(
          'Claude account files changed during the operation. Retry after other logins finish.'
        )
      if (!equal(before, change.after)) prepared.push({ ...change, before })
    }
    if (!prepared.length) return
    const journal = { version: 1, binding, changes: prepared }
    validateJournal(journal)
    const raw = encode(journal)
    await exclusiveText(journalPath, raw)
    try {
      for (const change of prepared) await applySlot(change, change.after, change.before)
      await writeText(journalPath, null, raw)
    } catch {
      try {
        await recover()
      } catch {
        throw authError(
          'Claude account change could not be rolled back. Launch is blocked until recovery succeeds.'
        )
      }
      throw authError('Claude account change failed; the previous login was restored.')
    }
  }
  function accountChanges(id, auth) {
    return [
      { kind: 'managedCredentials', id, after: auth.raw },
      { kind: 'managedOauth', id, after: encode(auth.oauth) }
    ]
  }
  async function refreshed(account, saved) {
    if (saved.status !== 'ready') return saved
    const runtime = await systemAuth()
    if (runtime.credentials === null) return saved
    let token
    try {
      token = credentials(runtime.credentials)
    } catch {
      return saved
    }
    const who = identity(runtime.oauth.value)
    if (!runtime.oauth.present || !matches(account.identity, who) || conflict(identity(token), who))
      return saved
    const beforeExpiry = Number(saved.token.expiresAt)
    const afterExpiry = Number(token.expiresAt)
    if (Number.isFinite(beforeExpiry) && Number.isFinite(afterExpiry) && afterExpiry < beforeExpiry)
      return saved
    return { status: 'ready', raw: runtime.credentials, oauth: runtime.oauth.value, token }
  }
  async function changeSelection(value, removeId = null) {
    await recover()
    const state = await readMetadata()
    const old = state.accounts.find((a) => a.id === state.selectedId)
    const changes = []
    let oldAuth = old ? await managed(old.id) : null
    if (oldAuth?.status === 'unknown')
      throw authError(
        'The selected Claude account is unreadable. No authentication files were changed.'
      )
    if (old && oldAuth.status === 'ready') {
      oldAuth = await refreshed(old, oldAuth)
      changes.push(...accountChanges(old.id, oldAuth))
    }
    const target = value === null ? null : state.accounts.find((a) => a.id === value)
    if (value !== null && !target) throw authError('Unknown Claude account.')
    let auth
    if (target) {
      auth = target.id === old?.id ? oldAuth : await managed(target.id)
      if (auth?.status !== 'ready' || !matches(target.identity, identity(auth.oauth)))
        throw authError('This Claude account needs a valid login before selection.')
      const original = await snapshot(state.selectedId === null)
      changes.push(
        {
          kind: 'credentials',
          after: auth.raw,
          ...(state.selectedId === null ? { expected: original.credentials } : {})
        },
        {
          kind: 'oauth',
          after: { present: true, value: auth.oauth },
          ...(state.selectedId === null ? { expected: original.oauth } : {})
        }
      )
    } else if (state.selectedId !== null) {
      const original = await snapshot()
      changes.push(
        { kind: 'credentials', after: original.credentials },
        { kind: 'oauth', after: original.oauth }
      )
    }
    const next = {
      ...state,
      selectedId: value,
      accounts: state.accounts.filter((a) => a.id !== removeId)
    }
    changes.push({ kind: 'index', after: encode(next) })
    await transaction(changes)
    return { ok: true, selectedId: value, restartRequired: state.selectedId !== value }
  }
  async function login(id, { signal, onProgress } = {}) {
    await recover()
    const state = await readMetadata()
    const previous = id ? state.accounts.find((a) => a.id === id) : null
    if (id && !previous) throw authError('Unknown Claude account.')
    if (id && (await managed(id)).status === 'unknown') throw authError()
    if (id && state.selectedId === id) await snapshot()
    if (typeof runLogin !== 'function') throw authError('Claude login is unavailable.')
    if (signal?.aborted) throw authError('Claude login was cancelled.')
    const loginId = randomUUID()
    const temporary = join(runtimeRoot, `login-${loginId}`)
    await ensureDirectory(temporary)
    await exclusiveText(join(temporary, MARKER), `login:${loginId}\n`)
    let created = null
    let cleanupSafe = true
    try {
      // The runner reports uncertain termination explicitly. Record that before
      // cancellation checks so an aborted, possibly live child keeps its home.
      const result = await runLogin({ provider: 'claude', home: temporary, signal, onProgress })
      cleanupSafe = result?.cleanupSafe !== false
      if (!cleanupSafe)
        throw Object.assign(
          authError(
            'Claude sign-in could not be stopped. Temporary files were retained because process termination could not be confirmed.'
          ),
          { cleanupSafe: false }
        )
      if (signal?.aborted) throw authError('Claude login was cancelled.')
      if (!result?.ok)
        throw authError('Claude login did not complete. The previous account was preserved.')
      const status = result.status
      const raw = await readText(join(temporary, '.credentials.json'))
      const token = credentials(raw)
      if (!token) throw authError('Claude login produced no credentials.')
      const configRaw =
        (await readText(join(temporary, '.claude.json'))) ??
        (await readText(join(temporary, '.config.json')))
      const oauth = configRaw === null ? null : jsonObject(configRaw).oauthAccount
      const who = identity(oauth)
      if (
        !object(status) ||
        status.loggedIn !== true ||
        !object(oauth) ||
        !matches(who, identity(status)) ||
        conflict(identity(token), who) ||
        (previous && !matches(previous.identity, who))
      )
        throw authError('Claude login identity could not be verified for this account.')
      const accountId = id || randomUUID()
      const path = authPath(accountId)
      if (!id) {
        await ensureDirectory(path)
        await exclusiveText(join(path, MARKER), `${accountId}\n`)
        created = { id: accountId, path }
      } else if (!(await ownedDirectory(accountsRoot, path, MARKER, accountId))) throw authError()
      const account = {
        id: accountId,
        identity: who,
        email: publicText(oauth.emailAddress ?? oauth.email ?? status.email),
        organization: publicText(
          status.organizationName ?? status.orgName ?? oauth.organizationName ?? who.organization
        ),
        plan: publicText(status.subscriptionType ?? token.subscriptionType ?? status.plan),
        lastLoginAt: new Date(now()).toISOString()
      }
      account.label = account.email || publicText(oauth.displayName) || 'Claude account'
      const next = {
        ...state,
        accounts: [...state.accounts.filter((a) => a.id !== accountId), account]
      }
      const changes = accountChanges(accountId, { raw, oauth })
      if (state.selectedId === accountId)
        changes.push(
          { kind: 'credentials', after: raw },
          { kind: 'oauth', after: { present: true, value: oauth } }
        )
      changes.push({ kind: 'index', after: encode(next) })
      await transaction(changes)
      created = null
      return {
        ok: true,
        account: publicAccount(account, 'ready', state.selectedId),
        selectedId: state.selectedId,
        restartRequired: state.selectedId === accountId
      }
    } finally {
      if (created) {
        // Leave files needed by a failed durable rollback for recovery.
        if ((await readText(journalPath)) === null)
          await removeOwnedDirectory(accountsRoot, created.path, MARKER, created.id)
      }
      if (cleanupSafe)
        await removeOwnedDirectory(runtimeRoot, temporary, MARKER, `login:${loginId}`)
    }
  }
  const savedAccountRefusal = () => ({
    ok: false,
    error: "Select this pane's saved Claude account in AI provider accounts before restarting it."
  })
  async function validSavedAccount(state, id) {
    if (id === null) return true
    const account = state.accounts.find((entry) => entry.id === id)
    if (!account) return false
    const auth = await managed(id)
    return auth.status === 'ready' && matches(account.identity, identity(auth.oauth))
  }
  return {
    // Deliberately unqueued: UI polling remains responsive during browser login.
    list: () =>
      safe(async () => {
        const state = await readMetadata()
        let status = 'unknown'
        try {
          status = authStatus(state.selectedId === null ? await systemAuth() : await snapshot())
        } catch {
          /* unknown, not missing */
        }
        const pending = await readText(journalPath)
        const accounts = await Promise.all(
          state.accounts.map(async (a) =>
            publicAccount(a, pending ? 'unknown' : (await managed(a.id)).status, state.selectedId)
          )
        )
        return {
          provider: 'claude',
          selectedId: state.selectedId,
          system: { id: null, label: 'System default', status: pending ? 'unknown' : status },
          accounts
        }
      }),
    add: (options) => serialized(() => login(null, options)),
    reauthenticate: (id, options) => serialized(() => login(id, options)),
    select: (id) => serialized(() => changeSelection(id)),
    remove: (id) =>
      serialized(async () => {
        await recover()
        const state = await readMetadata()
        if (!state.accounts.some((a) => a.id === id)) throw authError('Unknown Claude account.')
        if ((await managed(id)).status === 'unknown')
          throw authError('Managed Claude auth cannot be removed safely.')
        const result = await changeSelection(state.selectedId === id ? null : state.selectedId, id)
        try {
          await removeOwnedDirectory(accountsRoot, authPath(id), MARKER, id)
          await fs.rmdir(join(accountsRoot, id)).catch((error) => {
            if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
          })
        } catch {
          return {
            ...result,
            warning: 'Account removed; its managed files could not be cleaned safely.'
          }
        }
        return result
      }),
    // Main-process quota calls must verify the identity physically installed in
    // the shared Claude runtime. History scope alone cannot prove that identity.
    usageScope: (accountId = undefined) =>
      safe(async () => {
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        if (id !== state.selectedId || !(await validSavedAccount(state, id)))
          return { ok: false, error: 'The selected Claude account changed or is unavailable.' }
        return {
          ok: true,
          env: override ? { CLAUDE_CONFIG_DIR: configDir } : {},
          accountId: id,
          expectedIdentity: id ? { ...state.accounts.find((row) => row.id === id).identity } : null
        }
      }),
    sessionEnv: (accountId = undefined) =>
      safe(async () => {
        // History inspection never materializes auth, repairs state, or switches
        // the global selection. Claude histories share the effective config dir.
        const state = await readMetadata()
        const id = accountId === undefined ? state.selectedId : accountId
        if (!(await validSavedAccount(state, id)))
          return { ok: false, error: 'The saved Claude account is missing or unreadable.' }
        return { ok: true, env: override ? { CLAUDE_CONFIG_DIR: configDir } : {}, accountId: id }
      }),
    launchEnv: (accountId = undefined) =>
      serialized(async () => {
        // A saved pane must not silently change global auth during restoration.
        // Check before recovery as well, so an obvious mismatch causes no writes.
        if (accountId !== undefined) {
          const before = await readMetadata()
          if (accountId !== before.selectedId || !(await validSavedAccount(before, accountId)))
            return savedAccountRefusal()
        }
        await recover()
        const state = await readMetadata()
        const id = state.selectedId
        if (accountId !== undefined && accountId !== id) return savedAccountRefusal()
        if (id !== null) {
          const account = state.accounts.find((a) => a.id === id)
          const auth = account ? await managed(id) : { status: 'missing' }
          if (auth.status === 'unknown')
            throw authError('Selected Claude authentication is unreadable; launch was refused.')
          if (auth.status === 'missing') {
            await changeSelection(null)
            return {
              ok: false,
              error:
                'The selected Claude account is missing. System default was restored; choose an account before launching.'
            }
          }
          await changeSelection(id)
        } else if (authStatus(await systemAuth()) === 'unknown')
          throw authError('System Claude authentication is unreadable; launch was refused.')
        // Reapply a configured override after the launch facade removes inherited
        // auth variables. Without an override, retain Claude's default config path.
        return {
          ok: true,
          env: id && override ? { CLAUDE_CONFIG_DIR: configDir } : {},
          accountId: id
        }
      })
  }
}
