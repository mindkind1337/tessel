// OpenSSH client config: the Host entries of ~/.ssh/config, with its Include
// files. Ported from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// src/main/ssh/ssh-config-parser.ts, ssh-config-include-expander.ts and
// ssh-config-path-expansion.ts.
//
// Only config files are read. IdentityFile stays a path: a key file is never
// opened, read or copied.
import fs from 'fs'
import os from 'os'
import { posix, win32 } from 'path'

const MAX_INCLUDE_GLOB_MATCHES = 256
const MAX_INCLUDE_FILE_BYTES = 1024 * 1024
const MAX_INCLUDE_DEPTH = 16
const TARGET_DEPENDENT_INCLUDE_TOKENS = new Set(['h', 'n', 'p', 'r', 'j', 'k', 'C'])

// --- Parser -------------------------------------------------------------------

// [{ host, hostname?, port?, user?, identityFile?, identityAgent?,
//    identitiesOnly?, gssapiAuthentication?, proxyCommand?, proxyJump? }]
// Host blocks with one or more patterns; wildcard / negated patterns
// ("Host *", "Host !x", "Host web-?") are skipped; Match ends a block.
export function parseSshConfig(content, { home = os.homedir() } = {}) {
  const hosts = []
  let current = []

  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const directive = parseConfigDirective(line)
    if (!directive) continue
    const { key, rawValue } = directive

    if (key === 'host') {
      for (const h of current) hosts.push(h)
      const concrete = splitOpenSshArguments(rawValue).filter(
        (p) => !p.startsWith('!') && !p.includes('*') && !p.includes('?')
      )
      current = concrete.map((pattern) => ({ host: pattern }))
      continue
    }
    if (key === 'match') {
      for (const h of current) hosts.push(h)
      current = []
      continue
    }
    if (current.length === 0) continue

    const value = splitOpenSshArguments(rawValue)[0] ?? ''
    // OpenSSH uses the first obtained value for single-valued parameters.
    for (const h of current) {
      switch (key) {
        case 'hostname':
          h.hostname ??= value
          break
        case 'port':
          h.port ??= Number.parseInt(value, 10) || 22
          break
        case 'user':
          h.user ??= value
          break
        case 'identityfile':
          h.identityFile = resolveSshConfigHomePath(value, home)
          break
        case 'identityagent':
          h.identityAgent ??= resolveSshConfigHomePath(value, home)
          break
        case 'identitiesonly':
          h.identitiesOnly ??= value.toLowerCase() === 'yes'
          break
        case 'gssapiauthentication':
          h.gssapiAuthentication ??= value.toLowerCase() === 'yes'
          break
        case 'proxycommand':
          // A shell snippet: the rest of the line, quotes and # included.
          h.proxyCommand ??= rawValue.trim()
          break
        case 'proxyjump':
          h.proxyJump ??= value
          break
      }
    }
  }
  for (const h of current) hosts.push(h)
  return hosts
}

function parseConfigDirective(line) {
  const m = line.match(/^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/)
  return m ? { key: m[1].toLowerCase(), rawValue: m[2].trim() } : null
}

// Whitespace-separated words; "quoted words" keep their spaces; an unquoted
// # starts a comment.
export function splitOpenSshArguments(input) {
  const args = []
  let current = ''
  let inQuotes = false
  let escaped = false
  for (const char of String(input || '')) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (inQuotes && char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && char === '#') break
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

// Windows OpenSSH prints __PROGRAMDATA__ unexpanded; ~ is the home folder.
export function resolveSshConfigHomePath(filepath, home = os.homedir()) {
  const token = '__PROGRAMDATA__'
  if (filepath.startsWith(token)) {
    const rest = filepath.slice(token.length)
    if (rest === '' || rest.startsWith('\\') || rest.startsWith('/')) {
      const programData = process.env.ProgramData
      return programData ? win32.join(programData, rest) : filepath
    }
  }
  if (filepath === '~') return home
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    return pathApiFor(home).join(home, ...filepath.slice(2).split(/[\\/]+/).filter(Boolean))
  }
  return filepath
}

// --- Include ------------------------------------------------------------------

// The config's text with every Include replaced by the included files' text.
export function expandSshConfigIncludes(configPath, { home = os.homedir(), fsApi = fs } = {}) {
  const pathApi = pathApiFor(configPath)
  const localHost = safe(() => os.hostname(), '')
  const context = {
    cache: new Map(),
    home,
    pathApi,
    fsApi,
    rootDir: pathApi.dirname(configPath),
    username: currentUser(),
    uid: currentUid(),
    hostname: localHost,
    shortHostname: localHost.split('.')[0] || localHost
  }
  return expandFile(configPath, context, []).join('\n')
}

function expandFile(filePath, context, stack) {
  if (stack.length >= MAX_INCLUDE_DEPTH) return []
  const canonical = safe(() => context.fsApi.realpathSync.native(filePath), null)
  if (!canonical || stack.includes(canonical)) return []
  const text = readCached(canonical, context)
  if (text === null) return []
  const out = []
  const next = [...stack, canonical]
  for (const line of text.split(/\r?\n/)) {
    const includeArgs = parseIncludeDirective(line)
    if (!includeArgs) {
      out.push(line)
      continue
    }
    for (const arg of includeArgs) {
      for (const p of resolveIncludePaths(arg, context)) {
        for (const l of expandFile(p, context, next)) out.push(l)
      }
    }
  }
  return out
}

function readCached(filePath, context) {
  if (context.cache.has(filePath)) return context.cache.get(filePath)
  let text = null
  try {
    const st = context.fsApi.statSync(filePath)
    if (st.isFile() && st.size <= MAX_INCLUDE_FILE_BYTES) text = context.fsApi.readFileSync(filePath, 'utf8')
  } catch {
    text = null
  }
  context.cache.set(filePath, text)
  return text
}

function parseIncludeDirective(line) {
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('#')) return null
  const m = trimmed.match(/^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/)
  if (!m || m[1].toLowerCase() !== 'include') return null
  const args = splitOpenSshArguments(m[2])
  return args.length ? args : null
}

function resolveIncludePaths(pattern, context) {
  let missing = false
  const withEnv = pattern.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const v = process.env[name]
    if (v === undefined) missing = true
    return v ?? ''
  })
  if (missing) return []
  const withTokens = expandIncludeTokens(withEnv, context)
  if (withTokens === null) return []
  const { pathApi } = context
  let abs
  if (withTokens === '~') abs = context.home
  else if (withTokens.startsWith('~/') || withTokens.startsWith('~\\')) abs = pathApi.join(context.home, withTokens.slice(2))
  else if (pathApi.isAbsolute(withTokens)) abs = pathApi.normalize(withTokens)
  else abs = pathApi.normalize(pathApi.join(context.rootDir, withTokens))
  if (/[*?[]/.test(abs)) return globFiles(abs, context).slice(0, MAX_INCLUDE_GLOB_MATCHES)
  return safe(() => context.fsApi.existsSync(abs), false) ? [abs] : []
}

function expandIncludeTokens(input, context) {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c !== '%') {
      out += c
      continue
    }
    const tok = input[i + 1]
    if (!tok) {
      out += c
      continue
    }
    i++
    if (tok === '%') out += '%'
    else if (TARGET_DEPENDENT_INCLUDE_TOKENS.has(tok)) return null
    else if (tok === 'd') out += context.home
    else if (tok === 'u') out += context.username
    else if (tok === 'i') {
      if (!context.uid) return null
      out += context.uid
    } else if (tok === 'l') out += context.hostname
    else if (tok === 'L') out += context.shortHostname
    else out += `%${tok}`
  }
  return out
}

// A glob in the path's segments (* ? [..]), sorted like OpenSSH's glob(3).
function globFiles(absPattern, context) {
  const { pathApi, fsApi } = context
  const root = pathApi.parse(absPattern).root
  const parts = absPattern.slice(root.length).split(/[\\/]+/).filter(Boolean)
  let bases = [root]
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const next = []
    for (const base of bases) {
      if (!/[*?[]/.test(part)) {
        next.push(pathApi.join(base, part))
        continue
      }
      const re = globSegmentRegex(part)
      let names = []
      try {
        names = fsApi.readdirSync(base)
      } catch {
        names = []
      }
      for (const name of names) {
        if (name.startsWith('.') && !part.startsWith('.')) continue
        if (re.test(name)) next.push(pathApi.join(base, name))
      }
    }
    bases = next
    if (bases.length > 4096) bases = bases.slice(0, 4096)
  }
  return bases.filter((p) => safe(() => fsApi.statSync(p).isFile(), false)).sort((a, b) => a.localeCompare(b))
}

function globSegmentRegex(segment) {
  let re = ''
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (c === '*') re += '[^\\\\/]*'
    else if (c === '?') re += '[^\\\\/]'
    else if (c === '[') {
      const end = segment.indexOf(']', i + 1)
      if (end > i + 1) {
        let cls = segment.slice(i + 1, end).replace(/\\/g, '\\\\')
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        re += `[${cls}]`
        i = end
      } else re += '\\['
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '')
}

function pathApiFor(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || String(p).startsWith('\\\\') ? win32 : posix
}

function currentUser() {
  const info = safe(() => os.userInfo(), null)
  return (info && info.username) || process.env.USER || process.env.USERNAME || ''
}

function currentUid() {
  const info = safe(() => os.userInfo(), null)
  return info && typeof info.uid === 'number' && info.uid >= 0 ? String(info.uid) : undefined
}

function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// --- Loading ------------------------------------------------------------------

// The Host entries of <home>/.ssh/config (and its Includes); [] when absent.
export function loadUserSshConfig({ home = os.homedir(), fsApi = fs } = {}) {
  const configPath = pathApiFor(home).join(home, '.ssh', 'config')
  if (!safe(() => fsApi.existsSync(configPath), false)) return []
  try {
    return parseSshConfig(expandSshConfigIncludes(configPath, { home, fsApi }), { home })
  } catch {
    return []
  }
}
