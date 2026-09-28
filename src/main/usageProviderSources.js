// Read-only credential sources adapted from Orca's rate-limits clients (MIT).
// Token values stay in the main process and are read afresh for each action.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { boundedCredentialRead, inspectCredentialPath } from './providerUsage'

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
  clock = Date.now
} = {}) {
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
        refuse('credentials', 'The credential file is too large.')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      refuse(
        'credentials',
        'The provider login could not be read safely. Run its CLI and try again.'
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
    if (provider === 'minimax') return !!token(env.MINIMAX_API_KEY)
    if (provider === 'opencode-go' && token(env.OPENCODE_API_KEY)) return true
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
    if (provider === 'gemini') {
      const creds = await json(paths.gemini[0])
      headers = bearer(creds?.access_token, 'Sign in with Gemini CLI to read usage.')
      if (typeof creds.expiry_date !== 'number' || creds.expiry_date <= clock() + 5000)
        refuse('expired', 'Run Gemini to refresh its login, then retry usage.')
    } else if (provider === 'kimi') {
      const creds = await json(paths.kimi[0])
      headers = bearer(creds?.access_token, 'Sign in with Kimi to read usage.')
      if (typeof creds.expires_at !== 'number' || creds.expires_at * 1000 <= clock() + 5000)
        refuse('expired', 'Run Kimi to refresh its login, then retry usage.')
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
      headers = bearer(creds?.key, 'Sign in with Grok to read usage.')
      if (!fresh(creds)) refuse('expired', 'Run Grok to refresh its login, then retry usage.')
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
      if (!session) refuse('unavailable', 'Sign in with Cursor or cursor-agent to read usage.')
      if (session.expired) refuse('expired', 'Run cursor-agent login to refresh Cursor usage.')
      headers = {
        Cookie: `WorkosCursorSessionToken=${encodeURIComponent(session.sub)}%3A%3A${session.raw}`,
        Accept: 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard'
      }
    } else if (provider === 'opencode-go') {
      const data = await json(paths['opencode-go'][0])
      let key = data?.['opencode-go']?.type === 'api' ? token(data['opencode-go'].key) : null
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
      headers = bearer(
        key || env.OPENCODE_API_KEY,
        'Connect an OpenCode Go subscription in OpenCode to read usage.'
      )
    } else if (provider === 'minimax') {
      headers = bearer(
        env.MINIMAX_API_KEY,
        'Set MINIMAX_API_KEY in the environment running Tessel to read usage.'
      )
    } else refuse('unavailable', 'This provider has no quota collector.')
    return {
      headers,
      fingerprint: createHash('sha256').update(JSON.stringify(headers)).digest('hex')
    }
  }
  return { present, auth }
}
