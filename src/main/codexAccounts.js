// Isolated account homes and absence grace are informed by Orca (MIT),
// Copyright (c) 2026 Lovecast Inc. This implementation is written for Tessel.
// Reference: https://github.com/stablyai/orca/tree/main/src/main/codex-accounts
// Credentials stay in Codex's auth.json, never in metadata or public responses.
import fs from 'fs'
import os from 'os'
import { createHash, randomUUID } from 'crypto'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path'
import { writeJsonSafe } from './safeJson'

const MARKER = '.tessel-managed-codex.json'
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const LIMIT = 2 * 1024 * 1024
const queues = new Map()
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const text = (value) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const within = (base, path) => {
  const rel = relative(base, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
const problem = (message) => Object.assign(new Error(message), { accountError: true })
const hash = (contents) => createHash('sha256').update(contents).digest('hex')

function noLinks(path, allowMissing = false) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  const pieces = absolute.slice(root.length).split(sep).filter(Boolean)
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i])
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return false
      throw error
    }
    if (stat.isSymbolicLink() || (i < pieces.length - 1 && !stat.isDirectory()))
      throw problem(
        'Codex account storage contains a link or an invalid directory. Restore its original location and retry.'
      )
    if (!samePath(fs.realpathSync(current), resolve(current)))
      throw problem('Codex account storage no longer resolves to its original location.')
  }
  return true
}

function readSmall(file, { missing = false } = {}) {
  if (!noLinks(file, missing)) return null
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size > LIMIT)
    throw problem('A Codex account file is invalid or too large.')
  return fs.readFileSync(file, 'utf8')
}

// Replace only a simple root string setting. Multiline strings are tracked so
// a setting-shaped example inside instructions cannot change the TOML scope.
function mirrorConfig(contents) {
  const kept = []
  let table = false
  let multiline = null
  for (const line of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trimStart()
    if (!multiline && /^(?:model_providers|"model_providers"|'model_providers')\s*=/.test(trimmed))
      throw problem(
        'Inline Codex provider definitions cannot be mirrored safely. Use System default or ordinary provider tables before adding an account.'
      )
    if (
      !multiline &&
      /^(?:profiles|"profiles"|'profiles')\s*(?:\.|=)/.test(trimmed) &&
      /model_provider/.test(trimmed)
    )
      throw problem(
        'A dotted or inline profile provider setting cannot be mirrored safely. Use System default or ordinary profile tables first.'
      )
    if (
      !multiline &&
      (/^(?:\[\s*)?"[^"\n]*\\[^"\n]*"\s*(?:\.|=|\])/.test(trimmed) ||
        /^(?:\[\s*)?(?:model_providers|"model_providers"|'model_providers')\s*\.\s*"[^"\n]*\\/.test(
          trimmed
        ))
    )
      throw problem(
        'An escaped Codex provider key cannot be mirrored safely. Use System default or simplify that key first.'
      )
    if (
      !multiline &&
      /^(?:\[\s*)?(?:model_providers|"model_providers"|'model_providers')\s*\.\s*(?:openai|"openai"|'openai')(?:\s*[.\]=])/.test(
        trimmed
      )
    )
      throw problem(
        'The system Codex config overrides the built-in OpenAI provider. Use System default for that provider before selecting a managed ChatGPT account.'
      )
    if (!multiline && /^\[/.test(trimmed)) table = true
    const assignment =
      !multiline &&
      /^(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*=/.test(
        trimmed
      )
    if (!multiline && !assignment && /^[^#=]*cli_auth_credentials_store[^=]*=/.test(trimmed))
      throw problem(
        'A dotted credential-store setting cannot be mirrored safely. Use System default or simplify that setting first.'
      )
    if (assignment && table)
      throw problem(
        'The system Codex config sets credential storage inside a table or profile. Use System default or move that setting to the root before adding an account.'
      )
    if (assignment && !table) {
      if (
        !/^[^=]+=\s*(?:"(?:file|keyring|auto|ephemeral)"|'(?:file|keyring|auto|ephemeral)')\s*(?:#.*)?$/.test(
          trimmed
        )
      )
        throw problem(
          'The system credentials-store setting uses unsupported TOML syntax. Keep the system account or simplify that setting first.'
        )
      continue
    }
    if (
      !multiline &&
      /^(?:model_provider|"model_provider"|'model_provider')\s*=/.test(trimmed) &&
      !/^[^=]+=\s*(?:"openai"|'openai')\s*(?:#.*)?$/.test(trimmed)
    )
      throw problem(
        'The system Codex config selects a custom provider. Use System default for that provider before adding a ChatGPT account.'
      )
    // Root key encoded with TOML escapes cannot safely be edited without a parser.
    if (!multiline && /^"[^"\n]*\\[^"\n]*"\s*=/.test(trimmed))
      throw problem(
        'The system Codex config has an escaped root key. Use System default or simplify that key before adding an account.'
      )
    kept.push(line)
    let quote = null
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (line.startsWith(multiline, i) && (multiline === "'''" || line[i - 1] !== '\\')) {
          i += 2
          multiline = null
        }
      } else if (quote) {
        if (line[i] === quote && (quote === "'" || line[i - 1] !== '\\')) quote = null
      } else if (line[i] === '#') break
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multiline = line.slice(i, i + 3)
        i += 2
      } else if (line[i] === '"' || line[i] === "'") quote = line[i]
    }
  }
  if (multiline) throw problem('The system Codex config contains an unfinished multiline string.')
  return 'cli_auth_credentials_store = "file"\n' + kept.join('\n')
}

function authDetails(raw) {
  let auth
  try {
    auth = JSON.parse(raw)
  } catch {
    return { status: 'unknown' }
  }
  if (!record(auth)) return { status: 'unknown' }
  const tokens = record(auth.tokens) ? auth.tokens : {}
  const mode = auth.auth_mode
  const ready =
    (mode == null || mode === 'chatgpt' || mode === 'chatgptAuthTokens') &&
    text(tokens.access_token) &&
    text(tokens.refresh_token)
  const apiKey = (mode == null || mode === 'apikey') && text(auth.OPENAI_API_KEY)
  if (!ready && !apiKey) return { status: Object.keys(auth).length ? 'unknown' : 'missing' }
  let claims = {}
  try {
    const encoded = tokens.id_token?.split('.')[1]
    if (encoded) claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {}
  if (!record(claims)) claims = {}
  const identity = record(claims['https://api.openai.com/auth'])
    ? claims['https://api.openai.com/auth']
    : {}
  const profile = record(claims['https://api.openai.com/profile'])
    ? claims['https://api.openai.com/profile']
    : {}
  return {
    status: 'ready',
    email: text(claims.email) || text(profile.email),
    organization: text(identity.workspace_name) || text(profile.workspace_name),
    plan: text(identity.chatgpt_plan_type) || (apiKey ? 'API key' : null),
    identity: {
      accountId: text(tokens.account_id) || text(identity.chatgpt_account_id),
      workspaceId: text(identity.workspace_account_id) || text(identity.chatgpt_account_id),
      userId: text(identity.chatgpt_user_id) || text(claims.sub),
      email: text(claims.email) || text(profile.email),
      apiKeyHash: apiKey ? hash(auth.OPENAI_API_KEY) : null
    }
  }
}

function matchingIdentity(previous, current) {
  if (!record(previous) || !record(current)) return false
  const keys = ['accountId', 'workspaceId', 'userId', 'apiKeyHash']
  for (const key of keys) if (previous[key] && previous[key] !== current[key]) return false
  if (previous.email && current.email && previous.email !== current.email) return false
  return (
    keys.some((key) => previous[key] && previous[key] === current[key]) ||
    Boolean(previous.email && previous.email === current.email)
  )
}

const validStore = (value) =>
  record(value) &&
  value.version === 1 &&
  (value.selectedId === null || ID.test(value.selectedId)) &&
  Array.isArray(value.accounts) &&
  value.accounts.every(
    (account) =>
      record(account) &&
      ID.test(account.id) &&
      ['label', 'email', 'organization', 'plan', 'lastLoginAt'].every(
        (key) => account[key] === null || typeof account[key] === 'string'
      )
  ) &&
  new Set(value.accounts.map((account) => account.id)).size === value.accounts.length &&
  (value.selectedId === null || value.accounts.some((account) => account.id === value.selectedId))

export function createCodexAccounts({
  userData,
  home = os.homedir(),
  env = process.env,
  runLogin,
  now = Date.now
}) {
  const base = resolve(userData, 'codex-accounts')
  const systemHome = resolve(env.CODEX_HOME || join(home, '.codex'))
  const metadata = join(base, 'accounts.json')
  const missingSince = new Map()
  const key = process.platform === 'win32' ? base.toLowerCase() : base
  const clock = () => (typeof now === 'function' ? now() : now)
  const stamp = () => new Date(clock()).toISOString()

  function storage(create = false) {
    if (within(systemHome, base) || within(base, systemHome))
      throw problem('Managed account storage must be separate from the system Codex home.')
    const exists = noLinks(base, true)
    if (!exists && create) {
      fs.mkdirSync(base, { recursive: true, mode: 0o700 })
      noLinks(base)
    }
    return exists || create
  }
  function load() {
    if (!storage()) return { version: 1, selectedId: null, accounts: [] }
    // A display/usage read never creates recovery files. I/O errors propagate;
    // only a missing or damaged primary permits the last complete backup.
    const primary = readSmall(metadata, { missing: true })
    const parseStore = (raw) => {
      try {
        const value = JSON.parse(raw)
        return validStore(value) ? value : null
      } catch {
        return null
      }
    }
    const value = primary === null ? null : parseStore(primary)
    if (value) return value
    const backup = readSmall(`${metadata}.bak`, { missing: true })
    const recovered = backup === null ? null : parseStore(backup)
    if (recovered) return recovered
    if (primary !== null || backup !== null)
      throw problem(
        'Saved Codex accounts could not be read. Restore the account metadata or retry; no accounts were changed.'
      )
    return { version: 1, selectedId: null, accounts: [] }
  }
  function save(value) {
    storage(true)
    for (const path of [
      metadata,
      `${metadata}.bak`,
      `${metadata}.${process.pid}.tmp`,
      `${metadata}.bak.${process.pid}.tmp`
    ])
      noLinks(path, true)
    writeJsonSafe(metadata, value, validStore)
  }
  function paths(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw problem('Choose a valid saved Codex account.')
    return { directory: join(base, id), home: join(base, id, 'home') }
  }
  function owned(id) {
    storage()
    const target = paths(id)
    noLinks(target.home)
    if (
      !fs.lstatSync(target.home).isDirectory() ||
      !within(fs.realpathSync(base), fs.realpathSync(target.home))
    )
      throw problem('The managed Codex account home is outside its original storage.')
    let marker
    try {
      marker = JSON.parse(readSmall(join(target.home, MARKER)))
    } catch (error) {
      if (error.accountError) throw error
      throw problem(
        'The Codex account ownership marker is missing or unreadable. No files were changed.'
      )
    }
    if (marker?.version !== 1 || marker?.provider !== 'codex' || marker?.id !== id)
      throw problem('The Codex account ownership marker does not match. No files were changed.')
    return target
  }
  function atomic(file, contents) {
    noLinks(file, true)
    if (readSmall(file, { missing: true }) === contents) return
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 })
      noLinks(file, true)
      fs.renameSync(temp, file)
    } finally {
      try {
        fs.unlinkSync(temp)
      } catch {}
    }
  }
  function config(target) {
    const raw = readSmall(join(systemHome, 'config.toml'), { missing: true }) || ''
    const mirroredConfig = mirrorConfig(raw)
    // Tessel's team hooks and global task-board instructions are separate
    // resources. Copy only these regular, bounded files; never auth or history.
    const markerPath = join(target, MARKER)
    const marker = JSON.parse(readSmall(markerPath))
    const previous = record(marker.mirroredResources) ? marker.mirroredResources : {}
    const next = {}
    const operations = []
    for (const name of ['hooks.json', 'AGENTS.md', 'AGENTS.override.md']) {
      const source = readSmall(join(systemHome, name), { missing: true })
      const file = join(target, name)
      const existing = readSmall(file, { missing: true })
      if (
        existing !== null &&
        source !== existing &&
        (previous[name] ? hash(existing) !== previous[name] : source !== null)
      )
        throw problem(
          'A managed Codex hooks or instructions file was edited separately. Reconcile it with the system file before launching this account.'
        )
      if (source !== null) {
        next[name] = hash(source)
        operations.push(() => atomic(file, source))
      } else if (previous[name] && existing !== null) operations.push(() => fs.unlinkSync(file))
    }
    atomic(join(target, 'config.toml'), mirroredConfig)
    for (const apply of operations) apply()
    atomic(markerPath, JSON.stringify({ ...marker, mirroredResources: next }))
  }
  function createHome(id) {
    storage(true)
    const target = paths(id)
    noLinks(target.directory, true)
    fs.mkdirSync(target.directory, { mode: 0o700 })
    fs.mkdirSync(target.home, { mode: 0o700 })
    atomic(join(target.home, MARKER), JSON.stringify({ version: 1, provider: 'codex', id }))
    try {
      config(target.home)
    } catch (error) {
      // Setup may fail before the caller receives this path. Only this fresh,
      // marked home without any auth file is eligible for rollback cleanup.
      if (readSmall(join(target.home, 'auth.json'), { missing: true }) === null) {
        try {
          erase(id)
        } catch {}
      }
      throw error
    }
    return target
  }
  function inspect(id, grace = true) {
    try {
      const target = owned(id)
      const raw = readSmall(join(target.home, 'auth.json'), { missing: true })
      if (raw !== null) {
        missingSince.delete(id)
        return authDetails(raw)
      }
      if (!missingSince.has(id)) missingSince.set(id, clock())
      return { status: grace && clock() - missingSince.get(id) < 5000 ? 'unknown' : 'missing' }
    } catch {
      return { status: 'unknown' }
    }
  }
  function accountView(account, selectedId) {
    const found = currentIdentity(account)
    return {
      id: account.id,
      label: text(account.label) || 'Codex account',
      email: found.email || text(account.email),
      organization: found.organization || text(account.organization),
      plan: found.plan || text(account.plan),
      lastLoginAt: text(account.lastLoginAt),
      status: found.status,
      active: selectedId === account.id
    }
  }
  function currentIdentity(account) {
    const found = inspect(account.id)
    if (
      found.status === 'ready' &&
      !matchingIdentity(account.identity || { email: account.email }, found.identity)
    )
      return { status: 'unknown' }
    return found
  }
  function view(store) {
    let system = { id: null, label: 'System default', status: 'unknown' }
    try {
      const raw = readSmall(join(systemHome, 'auth.json'), { missing: true })
      if (raw !== null) system = { ...system, status: authDetails(raw).status }
      // Missing file cannot distinguish a keyring login from no login.
    } catch {}
    return {
      provider: 'codex',
      selectedId: store.selectedId,
      system,
      accounts: store.accounts.map((account) => accountView(account, store.selectedId)),
      restartRequired: false
    }
  }
  function find(store, id) {
    paths(id)
    const account = store.accounts.find((item) => item.id === id)
    if (!account) throw problem('This Codex account is no longer saved. Refresh the account list.')
    return account
  }
  function erase(id, validateOnly = false) {
    const target = owned(id)
    function validateTree(path, depth = 0) {
      if (depth > 40)
        throw problem(
          'The managed account contains a directory tree that cannot be removed safely.'
        )
      noLinks(path)
      const stat = fs.lstatSync(path)
      if (stat.isDirectory())
        for (const name of fs.readdirSync(path)) validateTree(join(path, name), depth + 1)
      else if (!stat.isFile())
        throw problem(
          'The managed account contains an unsupported file type. No files were removed.'
        )
    }
    validateTree(target.directory)
    owned(id)
    if (!validateOnly) fs.rmSync(target.directory, { recursive: true, force: false })
  }
  function entry(id, details) {
    return {
      id,
      label: details.email || details.organization || 'Codex account',
      email: details.email || null,
      organization: details.organization || null,
      plan: details.plan || null,
      identity: details.identity || null,
      lastLoginAt: stamp()
    }
  }
  async function login(target, options) {
    if (options.signal?.aborted) throw problem('Codex sign-in was cancelled.')
    let result
    try {
      result = await runLogin({
        provider: 'codex',
        home: target.home,
        signal: options.signal,
        onProgress: options.onProgress
      })
    } catch (error) {
      const failed = problem(
        'Codex sign-in did not complete. Retry; your existing accounts were preserved.'
      )
      if (error?.cleanupSafe === false) failed.cleanupSafe = false
      throw failed
    }
    if (result?.cleanupSafe === false)
      throw Object.assign(
        problem('Codex sign-in could not be stopped safely. Its temporary files were retained.'),
        { cleanupSafe: false }
      )
    if (options.signal?.aborted) throw problem('Codex sign-in was cancelled.')
    if (!result?.ok)
      throw problem('Codex sign-in did not complete. Retry; your existing accounts were preserved.')
  }
  function serial(task) {
    const result = (queues.get(key) || Promise.resolve())
      .catch(() => {})
      .then(task)
      .catch((error) => {
        if (error.accountError) throw error
        throw problem(
          'Codex account files are unavailable or could not be saved. Retry; no system credentials were changed.'
        )
      })
    queues.set(
      key,
      result.catch(() => {})
    )
    return result
  }
  function runtime(refresh, requested = undefined) {
    const store = load()
    const id = requested === undefined ? store.selectedId : requested
    if (id === null) return { ok: true, env: {}, accountId: null }
    try {
      const account = find(store, id)
      const target = owned(id)
      if (currentIdentity(account).status !== 'ready')
        return {
          ok: false,
          error:
            'The selected Codex login is unavailable. Sign in again or explicitly select System default.'
        }
      if (refresh) config(target.home)
      return { ok: true, env: { CODEX_HOME: target.home }, accountId: id }
    } catch (error) {
      return {
        ok: false,
        error: error.accountError
          ? error.message
          : 'The selected Codex account cannot be opened safely. Restore its files or explicitly select System default.'
      }
    }
  }

  return {
    // The settings panel must stay responsive while browser sign-in awaits.
    list: async () => {
      try {
        return view(load())
      } catch (error) {
        if (error.accountError) throw error
        throw problem('Saved Codex account metadata is temporarily unavailable. Retry in a moment.')
      }
    },
    add: (options = {}) =>
      serial(async () => {
        const store = load()
        const id = randomUUID()
        let target
        try {
          target = createHome(id)
          await login(target, options)
          const details = inspect(id, false)
          if (details.status !== 'ready' || !matchingIdentity(details.identity, details.identity))
            throw problem(
              'Codex did not save a usable file login. Check your credential-store policy and retry.'
            )
          const account = entry(id, details)
          save({ ...store, accounts: [...store.accounts, account] })
          return { ok: true, id, ...view({ ...store, accounts: [...store.accounts, account] }) }
        } catch (error) {
          // A completed login must survive metadata write failure for recovery.
          if (error.cleanupSafe !== false && target && inspect(id, false).status === 'missing') {
            try {
              erase(id)
            } catch {}
          }
          throw error
        }
      }),
    reauthenticate: (id, options = {}) =>
      serial(async () => {
        const store = load()
        find(store, id)
        const target = owned(id)
        const stageId = randomUUID()
        let stage
        try {
          stage = createHome(stageId)
          await login(stage, options)
          const details = inspect(stageId, false)
          if (details.status !== 'ready')
            throw problem('Codex did not save a usable login. The previous account login was kept.')
          const raw = readSmall(join(owned(stageId).home, 'auth.json'))
          owned(id)
          const previous = readSmall(join(target.home, 'auth.json'), { missing: true })
          const savedAccount = find(store, id)
          const baseline = savedAccount.identity || (previous && authDetails(previous).identity)
          if (!matchingIdentity(baseline, details.identity))
            throw problem(
              'The signed-in Codex identity does not match this account. The previous login was kept; use Add account for a different identity.'
            )
          atomic(join(target.home, 'auth.json'), raw)
          const next = {
            ...store,
            accounts: store.accounts.map((account) =>
              account.id === id ? entry(id, details) : account
            )
          }
          try {
            save(next)
          } catch (error) {
            owned(id)
            if (previous === null) fs.unlinkSync(join(target.home, 'auth.json'))
            else atomic(join(target.home, 'auth.json'), previous)
            throw error
          }
          try {
            erase(stageId)
          } catch {
            /* A retained owned staging home is safer than discarding the new login. */
          }
          return { ok: true, id, ...view(next) }
        } catch (error) {
          if (
            error.cleanupSafe !== false &&
            stage &&
            inspect(stageId, false).status === 'missing'
          ) {
            try {
              erase(stageId)
            } catch {}
          }
          throw error
        }
      }),
    select: (id) =>
      serial(() => {
        const store = load()
        if (id !== null) {
          const account = find(store, id)
          const target = owned(id)
          if (currentIdentity(account).status !== 'ready')
            throw problem('This Codex login is unavailable. Sign in again before selecting it.')
          config(target.home)
        }
        const next = { ...store, selectedId: id }
        save(next)
        return { ok: true, ...view(next) }
      }),
    remove: (id) =>
      serial(() => {
        const store = load()
        find(store, id)
        // Validate before metadata mutation. Rename to a tombstone is avoided so
        // existing processes can never accidentally use another account's home.
        erase(id, true)
        const next = {
          ...store,
          selectedId: store.selectedId === id ? null : store.selectedId,
          accounts: store.accounts.filter((account) => account.id !== id)
        }
        save(next)
        try {
          erase(id)
        } catch (error) {
          save(store)
          throw error
        }
        missingSince.delete(id)
        return { ok: true, ...view(next) }
      }),
    launchEnv: (id = undefined) => serial(() => runtime(true, id)),
    usageEnv: async (id = undefined) => runtime(false, id)
  }
}
