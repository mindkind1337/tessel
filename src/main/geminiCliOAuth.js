// Settings > AI provider accounts > Gemini, "Use Gemini CLI credentials
// (experimental)": finds the OAuth client the installed Gemini CLI signs in
// with, so an expired Gemini CLI login can be refreshed for a usage read.
// After Orca's gemini-cli-oauth-extractor.ts and gemini-oauth-sources.ts (MIT,
// Copyright (c) 2026 Lovecast Inc.). Tessel's differences: the CLI is found on
// PATH and Tessel's tool folders without running where.exe, files are read
// with size bounds, and a refreshed token stays in memory (oauth_creds.json is
// never written).
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { extraToolDirs } from './toolDirs'

const OAUTH2_SUBPATH = path.join('dist', 'src', 'code_assist', 'oauth2.js')
const MAX_SOURCE = 32 * 1024 * 1024
const MAX_BUNDLE_FILES = 400
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export function parseOAuthClient(content) {
  const id = /OAUTH_CLIENT_ID\s*=\s*['"]([^'"\s]{1,300})['"]/.exec(content)?.[1]
  const secret = /OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"\s]{1,300})['"]/.exec(content)?.[1]
  return id && secret ? { clientId: id, clientSecret: secret } : null
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}
async function readClient(file) {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_SOURCE) return null
    return parseOAuthClient(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// The gemini launcher on PATH or in Tessel's tool folders (npm, bun, …).
export async function findGeminiBinary({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
  const dirs = [
    ...pathValue.split(platform === 'win32' ? ';' : path.delimiter),
    ...extraToolDirs(env, home)
  ].filter((dir) => dir && path.isAbsolute(dir))
  const names = platform === 'win32' ? ['gemini.cmd', 'gemini.exe', 'gemini.ps1'] : ['gemini']
  for (const dir of dirs) for (const name of names) if (await isFile(path.join(dir, name))) return path.join(dir, name)
  if (platform !== 'win32')
    for (const file of ['/usr/local/bin/gemini', '/opt/homebrew/bin/gemini', path.join(home, '.local', 'bin', 'gemini')])
      if (await isFile(file)) return file
  return null
}

async function packageRoot(start) {
  let current = path.dirname(start)
  for (let i = 0; i <= 8; i++) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(current, 'package.json'), 'utf8'))
      if (pkg?.name === '@google/gemini-cli') return current
    } catch {
      /* none or malformed: keep walking */
    }
    for (const candidate of [
      path.join(current, 'lib', 'node_modules', '@google', 'gemini-cli'),
      path.join(current, 'node_modules', '@google', 'gemini-cli')
    ])
      if (await isFile(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

export async function extractGeminiOAuthClient(options = {}) {
  const found = await findGeminiBinary(options)
  if (!found) return null
  let real = found
  try {
    real = await fs.realpath(found)
  } catch {
    /* keep the launcher path */
  }
  const base = path.dirname(path.dirname(real))
  const known = [
    path.join(base, 'libexec', 'lib', 'node_modules', '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
    path.join(base, 'lib', 'node_modules', '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
    path.join(base, 'share', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
    path.join(base, '..', 'gemini-cli-core', OAUTH2_SUBPATH),
    path.join(base, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH)
  ]
  for (const file of known) {
    const client = await readClient(path.normalize(file))
    if (client) return client
  }
  const root = await packageRoot(real)
  if (!root) return null
  for (const file of [
    path.join(root, 'node_modules', '@google', 'gemini-cli-core', OAUTH2_SUBPATH),
    path.join(root, OAUTH2_SUBPATH)
  ]) {
    const client = await readClient(file)
    if (client) return client
  }
  // Newer CLIs (0.38+) ship hash-named bundle chunks instead of oauth2.js.
  try {
    const entries = (await fs.readdir(path.join(root, 'bundle'))).filter((f) => f.endsWith('.js')).slice(0, MAX_BUNDLE_FILES)
    for (const entry of entries) {
      const client = await readClient(path.join(root, 'bundle', entry))
      if (client) return client
    }
  } catch {
    /* no bundle folder */
  }
  return null
}

// A Gemini access token refreshed for usage reads, kept in memory only and
// reused until shortly before it expires (two reads of one refresh match).
export function createGeminiRefresher({ request = globalThis.fetch, extract = extractGeminiOAuthClient, clock = Date.now } = {}) {
  let cached = null // { key, token, expiresAt }
  return async function refresh(refreshToken, signal) {
    const key = createHash('sha256').update(String(refreshToken)).digest('hex')
    if (cached?.key === key && cached.expiresAt - 60000 > clock()) return cached.token
    const client = await extract()
    if (!client) return null
    const response = await request(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }).toString(),
      redirect: 'error',
      signal
    })
    if (!response?.ok) {
      await response?.body?.cancel?.().catch(() => {})
      return null
    }
    const text = await response.text()
    if (text.length > 64 * 1024) return null
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return null
    }
    if (typeof data?.access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(data.access_token)) return null
    const seconds = Number.isFinite(data.expires_in) ? Math.max(60, Math.min(data.expires_in, 86400)) : 3600
    cached = { key, token: data.access_token, expiresAt: clock() + seconds * 1000 }
    return cached.token
  }
}
