// Read-only credential sources adapted from Orca's rate-limits clients (MIT).
// Token values stay in the main process and are read afresh for each action.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { boundedCredentialRead, inspectCredentialPath } from './providerUsage'
import { t } from './i18n'
import { DEFAULT_PROVIDER_SETTINGS } from './providerCredentials'
import { createGeminiRefresher } from './geminiCliOAuth'
import { miniMaxModels } from './usageProviderMapping'

// MiniMax's usage endpoint rejects non-browser clients (Orca's
// minimax-request-context.ts): a real browser user agent, per platform.
function browserAgent(platform) {
  if (platform === 'win32') return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0'
  if (platform === 'darwin')
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0'
  return 'Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0'
}
// A pasted cookie as "name=value" pairs: a Cookie header, or a browser's
// cookie export (name:"value"). After Orca's parseCookiePairs.
export function cookiePairs(cookie) {
  const text = String(cookie || '')
  const pairs = text
    .split(';')
    .map((part) => part.trim().replace(/^Cookie:\s*/i, ''))
    .map((part) => {
      const eq = part.indexOf('=')
      return eq > 0 ? { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() } : null
    })
    .filter((p) => p?.name && p.value && /^[\w.-]+$/.test(p.name))
  for (const m of text.matchAll(/(?:^|[;\s])([A-Za-z0-9_.-]+)\s*:\s*["']([^"']+)["']/g))
    pairs.push({ name: m[1], value: m[2].trim() })
  return pairs.filter((p) => /^[\x21-\x7e]+$/.test(p.value) && !p.value.includes(';')).slice(0, 100)
}
// OpenCode's auth cookies only (Orca's opencode-go-usage-fetcher.ts): a bare
// token pasted alone is the "auth" cookie.
const OPENCODE_COOKIES = new Set(['auth', '__Host-auth', '__Host-console_session'])
export function openCodeCookie(raw) {
  let text = String(raw || '').trim()
  if (text && !text.includes(';') && !text.includes('=') && /^[\w.*~-]+$/.test(text)) text = `auth=${text}`
  const pairs = cookiePairs(text).filter((p) => OPENCODE_COOKIES.has(p.name))
  return pairs.length ? pairs.map((p) => `${p.name}=${p.value}`).join('; ') : null
}

export class ProviderReadError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
export const refuse = (code, message) => {
  throw new ProviderReadError(code, message)
}
export function token(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,16384}$/.test(value) ? value : null
}
export function createUsageProviderSources({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  readFile = boundedCredentialRead,
  inspect = inspectCredentialPath,
  clock = Date.now,
  // Settings > AI provider accounts (providerCredentials.js): saved keys,
  // cookies and options for Gemini, OpenCode Go and MiniMax.
  credentials = null,
  geminiRefresh = createGeminiRefresher(),
  timeoutMs = 10000
} = {}) {
  const options = () => {
    try {
      return { ...DEFAULT_PROVIDER_SETTINGS, ...(credentials?.settings() || {}) }
    } catch {
      return { ...DEFAULT_PROVIDER_SETTINGS }
    }
  }
  const saved = (name) => {
    try {
      const value = credentials?.secret(name)
      return typeof value === 'string' && value ? value : null
    } catch {
      return null
    }
  }
  const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const cursor =
    platform === 'win32'
      ? path.join(roaming, 'Cursor')
      : platform === 'darwin'
        ? path.join(home, '.cursor')
        : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cursor')
  const desktop =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Cursor')
      : platform === 'win32'
        ? cursor
        : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor')
  const openCode = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode')
  const paths = {
    gemini: [path.join(home, '.gemini', 'oauth_creds.json')],
    kimi: [
      path.join(
        env.KIMI_CODE_HOME || path.join(home, '.kimi-code'),
        'credentials',
        'kimi-code.json'
      )
    ],
    grok: [path.join(env.GROK_HOME || path.join(home, '.grok'), 'auth.json')],
    cursor: [
      path.join(cursor, 'auth.json'),
      path.join(desktop, 'User', 'globalStorage', 'state.vscdb')
    ],
    'opencode-go': [path.join(openCode, 'auth.json'), path.join(openCode, 'opencode.db')]
  }
  // cursor-agent's settings (its authInfo names the signed-in person, never a
  // token): ~/.cursor on Windows and macOS, the config folder elsewhere.
  const cursorConfigs = [
    ...new Set([path.join(home, '.cursor', 'cli-config.json'), path.join(cursor, 'cli-config.json')])
  ]
  async function exists(file) {
    try {
      await inspect(file)
      return true
    } catch {
      return false
    }
  }
  async function json(file) {
    try {
      const raw = await readFile(file)
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024)
        refuse('credentials', t('main.usage.credentialTooLarge', 'The credential file is too large.'))
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      refuse(
        'credentials',
        t('main.usage.loginUnreadable', 'The provider login could not be read safely. Run its CLI and try again.')
      )
    }
  }
  async function dbRows(file, sql, ...params) {
    let db
    try {
      await inspect(file)
      for (const suffix of ['-wal', '-shm']) {
        try {
          await inspect(file + suffix)
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
        }
      }
      const sqlite = process.getBuiltinModule?.('node:sqlite')
      if (!sqlite) return []
      db = new sqlite.DatabaseSync(file, { readOnly: true })
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;')
      return db.prepare(sql).all(...params)
    } catch {
      return []
    } finally {
      db?.close()
    }
  }
  async function openCodeDatabases() {
    // OpenCode's versioned databases share its data directory. Bound discovery,
    // reject links in dbRows, and query only credential rows, never conversations.
    const result = [paths['opencode-go'][1]]
    try {
      const dir = await fs.opendir(openCode)
      let n = 0
      for await (const ent of dir) {
        if (++n > 200) break
        if (ent.isFile() && /^opencode(?:[-\w.]*)\.db$/.test(ent.name))
          result.push(path.join(openCode, ent.name))
        if (result.length >= 16) break
      }
    } catch {
      /* absent */
    }
    return [...new Set(result)]
  }
  async function present(provider) {
    if (provider === 'minimax')
      return !!(token(env.MINIMAX_API_KEY) || saved('minimaxApiKey') || saved('minimaxCookie'))
    if (
      provider === 'opencode-go' &&
      (token(env.OPENCODE_API_KEY) || saved('opencodeGoApiKey') || saved('opencodeCookie'))
    )
      return true
    const candidates =
      provider === 'opencode-go'
        ? [paths[provider][0], ...(await openCodeDatabases())]
        : paths[provider] || []
    return (await Promise.all(candidates.map(exists))).some(Boolean)
  }
  function bearer(value, message) {
    const key = token(value)
    if (!key) refuse('unavailable', message)
    return { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  }
  function cursorToken(raw) {
    if (!token(raw)) return null
    try {
      const payload = JSON.parse(Buffer.from(raw.split('.')[1], 'base64url').toString('utf8'))
      if (typeof payload.sub !== 'string' || !payload.sub.trim()) return null
      return {
        raw,
        sub: payload.sub,
        expired: typeof payload.exp === 'number' && payload.exp * 1000 <= clock()
      }
    } catch {
      return null
    }
  }
  async function auth(provider) {
    let headers
    let extra = {}
    if (provider === 'gemini') {
      const creds = await json(paths.gemini[0])
      headers = bearer(creds?.access_token, t('main.usage.signInGemini', 'Sign in with Gemini CLI to read usage.'))
      if (typeof creds.expiry_date !== 'number' || creds.expiry_date <= clock() + 5000) {
        // Opt-in (Settings): refresh with the Gemini CLI's own OAuth client, in memory.
        const optIn = options().geminiCliOAuth
        let fresh = null
        if (optIn && token(creds.refresh_token)) {
          try {
            fresh = await geminiRefresh(
              creds.refresh_token,
              AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 30000)))
            )
          } catch {
            fresh = null
          }
        }
        if (!fresh)
          refuse(
            'expired',
            optIn
              ? t('main.usage.refreshGeminiFailed', 'The Gemini CLI login could not be refreshed. Run Gemini, then retry usage.')
              : t('main.usage.refreshGemini', 'Run Gemini to refresh its login, then retry usage.')
          )
        headers = bearer(fresh, t('main.usage.signInGemini', 'Sign in with Gemini CLI to read usage.'))
      }
    } else if (provider === 'kimi') {
      const creds = await json(paths.kimi[0])
      headers = bearer(creds?.access_token, t('main.usage.signInKimi', 'Sign in with Kimi to read usage.'))
      if (typeof creds.expires_at !== 'number' || creds.expires_at * 1000 <= clock() + 5000)
        refuse('expired', t('main.usage.refreshKimi', 'Run Kimi to refresh its login, then retry usage.'))
    } else if (provider === 'grok') {
      const data = (await json(paths.grok[0])) || {}
      const preferred = Object.entries(data).filter(
        ([key]) => key === 'https://auth.x.ai' || key.startsWith('https://auth.x.ai::')
      )
      const rows = (preferred.length ? preferred : Object.entries(data))
        .map(([, row]) => row)
        .filter((row) => token(row?.key))
      const fresh = (row) => !row.expires_at || Date.parse(row.expires_at) > clock() + 300000
      const creds = rows.find(fresh) || rows[0]
      headers = bearer(creds?.key, t('main.usage.signInGrok', 'Sign in with Grok to read usage.'))
      if (!fresh(creds)) refuse('expired', t('main.usage.refreshGrok', 'Run Grok to refresh its login, then retry usage.'))
      headers['X-XAI-Token-Auth'] = 'xai-grok-cli'
      if (token(creds.user_id)) headers['x-userid'] = creds.user_id
    } else if (provider === 'cursor') {
      const cli = await json(paths.cursor[0])
      let session = cursorToken(cli?.accessToken)
      if (!session || session.expired) {
        const rows = await dbRows(
          paths.cursor[1],
          'SELECT value FROM ItemTable WHERE key = ? AND length(value) <= 16384 LIMIT 1',
          'cursorAuth/accessToken'
        )
        const candidate = cursorToken(rows[0]?.value)
        if (candidate && !candidate.expired) session = candidate
      }
      if (!session) refuse('unavailable', t('main.usage.signInCursor', 'Sign in with Cursor or cursor-agent to read usage.'))
      if (session.expired) refuse('expired', t('main.usage.refreshCursor', 'Run cursor-agent login to refresh Cursor usage.'))
      headers = {
        Cookie: `WorkosCursorSessionToken=${encodeURIComponent(session.sub)}%3A%3A${session.raw}`,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard'
      }
    } else if (provider === 'opencode-go') {
      const data = await json(paths['opencode-go'][0])
      // Settings' key first (an override), then OpenCode's /connect, then the environment.
      let key = token(saved('opencodeGoApiKey'))
      if (!key && data?.['opencode-go']?.type === 'api') key = token(data['opencode-go'].key)
      if (!key) {
        for (const file of await openCodeDatabases()) {
          const rows = await dbRows(
            file,
            'SELECT value FROM credential WHERE integration_id = ? AND length(value) <= 20000 ORDER BY active DESC, time_created DESC LIMIT 8',
            'opencode-go'
          )
          for (const row of rows) {
            try {
              const value = JSON.parse(row.value)
              if (value?.type === 'key' && token(value.key)) {
                key = value.key
                break
              }
            } catch {
              /* malformed row */
            }
          }
          if (key) break
        }
      }
      key = key || token(env.OPENCODE_API_KEY)
      // The session cookie: the legacy console's usage (OpenCode Black accounts).
      const pasted = saved('opencodeCookie')
      const cookie = openCodeCookie(pasted)
      if (pasted && !cookie && !key)
        refuse(
          'credentials',
          t('main.usage.openCodeNoAuthCookie', 'No auth cookie found. Paste the full Cookie header from opencode.ai DevTools.')
        )
      if (!key && !cookie)
        refuse('unavailable', t('main.usage.connectOpenCode', 'Connect an OpenCode Go subscription in OpenCode to read usage.'))
      headers = key ? bearer(key) : { Accept: 'application/json' }
      extra = { console: cookie ? { cookie, workspaceId: options().opencodeWorkspaceId || null } : null }
    } else if (provider === 'minimax') {
      // A saved API key wins over the cookie (as in Orca), then the environment's key.
      const settings = options()
      const key = token(saved('minimaxApiKey'))
      const rawCookie = key ? null : saved('minimaxCookie')
      const cn = settings.minimaxEndpoint === 'cn'
      if (key || !rawCookie) {
        headers = bearer(
          key || env.MINIMAX_API_KEY,
          t(
            'main.usage.setMinimaxCredentials',
            'Save a MiniMax API key or session cookie in Settings > AI provider accounts, or set MINIMAX_API_KEY.'
          )
        )
      } else {
        const pairs = cookiePairs(rawCookie)
        const value = (name) => pairs.find((p) => p.name === name)?.value || null
        if (!value('_token'))
          refuse('credentials', t('main.usage.minimaxNoAuthCookie', 'MiniMax auth cookie not found. Paste a Cookie header with _token.'))
        const group = settings.minimaxGroupId || value('minimax_group_id_v2')
        headers = {
          Cookie: pairs.map((p) => `${p.name}=${p.value}`).join('; '),
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: cn ? 'https://platform.minimaxi.com/console/usage' : 'https://platform.minimax.io/console/usage',
          'User-Agent': browserAgent(platform),
          ...(group && /^[\w-]{1,64}$/.test(group) ? { 'X-Group-Id': group } : {})
        }
      }
      extra = {
        endpoint: cn ? 'minimaxCn' : 'minimax',
        models: miniMaxModels(settings.minimaxUsageModels),
        transport: headers.Cookie ? 'cookie' : 'api-key'
      }
    } else refuse('unavailable', t('main.usage.noCollector', 'This provider has no quota collector.'))
    return {
      headers,
      ...extra,
      fingerprint: createHash('sha256').update(JSON.stringify([headers, extra])).digest('hex')
    }
  }
  // Who is signed in (Settings > AI provider accounts): display fields and
  // whether the login is still valid, never a token. After Orca's
  // cursor-accounts/status.ts, cursor-auth.ts and grok-accounts/status.ts.
  const short = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null)
  async function signIn(provider) {
    const out = {
      signedIn: false,
      email: null,
      displayName: null,
      credentialSource: null,
      planType: null,
      teamId: null,
      tokenFresh: false,
      error: null
    }
    try {
      if (provider === 'grok') {
        const data = await json(paths.grok[0])
        if (!data) return out
        const entries = Object.entries(data)
        const preferred = entries.filter(
          ([key]) => key === 'https://auth.x.ai' || key.startsWith('https://auth.x.ai::')
        )
        const rows = (preferred.length ? preferred : entries).map(([, row]) => row).filter((row) => token(row?.key))
        const fresh = (row) => !row.expires_at || Date.parse(row.expires_at) - clock() > 300000
        const row = rows.find(fresh) || rows[0]
        if (!row) return out
        return { ...out, signedIn: true, email: short(row.email), teamId: short(row.team_id), tokenFresh: fresh(row) }
      }
      if (provider !== 'cursor') return out
      let identity = {}
      for (const file of cursorConfigs) {
        try {
          const config = await json(file)
          if (config?.authInfo && typeof config.authInfo === 'object') {
            identity = { email: short(config.authInfo.email), displayName: short(config.authInfo.displayName) }
            break
          }
        } catch {
          /* identity only */
        }
      }
      // A live session wins over the order of sources (Orca's cursor-auth.ts).
      let expired = null
      let error = null
      try {
        const cli = cursorToken((await json(paths.cursor[0]))?.accessToken)
        if (cli && !cli.expired) return { ...out, ...identity, signedIn: true, credentialSource: 'cli', tokenFresh: true }
        if (cli) expired = { ...out, ...identity, signedIn: true, credentialSource: 'cli' }
      } catch (err) {
        error = err instanceof ProviderReadError ? err.message : null
      }
      const rows = await dbRows(
        paths.cursor[1],
        'SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?) AND length(value) <= 16384',
        'cursorAuth/accessToken',
        'cursorAuth/cachedEmail',
        'cursorAuth/stripeMembershipType'
      )
      const value = (key) => {
        const found = rows.find((r) => r.key === key)?.value
        if (typeof found === 'string') return found
        return found instanceof Uint8Array ? Buffer.from(found).toString('utf8').trim() : null
      }
      const desktop = cursorToken(value('cursorAuth/accessToken'))
      if (desktop) {
        const found = {
          ...out,
          signedIn: true,
          email: short(value('cursorAuth/cachedEmail')),
          planType: short(value('cursorAuth/stripeMembershipType')),
          credentialSource: 'desktop',
          tokenFresh: !desktop.expired
        }
        if (!desktop.expired) return found
        expired ??= found
      }
      return expired || { ...out, error }
    } catch (error) {
      return {
        ...out,
        error:
          error instanceof ProviderReadError
            ? error.message
            : t('main.usage.loginUnreadable', 'The provider login could not be read safely. Run its CLI and try again.')
      }
    }
  }
  return { present, auth, signIn }
}
