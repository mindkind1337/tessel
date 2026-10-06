// A cookie file is imported only from the path its own file picker returned
// (main process): the picker gives the window a single-use token, never the
// path, and the import takes the path back from the token. Any other path
// (one the window made up, a UNC share, a device path) is refused.
import crypto from 'crypto'

export const TOKEN_TTL_MS = 10 * 60 * 1000
const MAX_TOKENS = 20

// A local absolute file path: a drive letter on Windows (no \server\share,
// no \?\ or \.\ device paths, no relative path), "/" elsewhere (not "//").
export function isAllowedCookieFilePath(p, platform = process.platform) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return false
  if (/^[\\/]{2}/.test(p)) return false
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) && !/[\\/]\.\.(?:[\\/]|$)/.test(p)
  return p.startsWith('/') && !/\/\.\.(?:\/|$)/.test(p)
}

export function createFileTokens({ platform = process.platform, now = () => Date.now(), ttlMs = TOKEN_TTL_MS } = {}) {
  const tokens = new Map() // token -> { path, at }

  function prune() {
    const t = now()
    for (const [k, v] of tokens) if (t - v.at > ttlMs) tokens.delete(k)
    while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value)
  }

  // A picked path -> its token, or null when the path is not allowed.
  function issue(path) {
    if (!isAllowedCookieFilePath(path, platform)) return null
    prune()
    const token = crypto.randomBytes(24).toString('hex')
    tokens.set(token, { path, at: now() })
    return token
  }

  // A token -> its path, once; null for anything else.
  function take(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return null
    const entry = tokens.get(token)
    tokens.delete(token)
    if (!entry || now() - entry.at > ttlMs) return null
    return isAllowedCookieFilePath(entry.path, platform) ? entry.path : null
  }

  return { issue, take }
}
