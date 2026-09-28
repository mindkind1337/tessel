// OpenSSH client config: the Host entries of ~/.ssh/config, with its Include
// files. Ported from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// src/main/ssh/ssh-config-parser.ts, ssh-config-include-expander.ts and
// ssh-config-path-expansion.ts.
//
// What is read: ~/.ssh/config and the files its Include lines name. An
// IdentityFile stays a path (Tessel never opens it). An Include can name any
// file, so a file is skipped, before anything is read from it, when its name
// is a key's (id_*, *.pem, *.key, *.pub, known_hosts*, authorized_keys, a file
// with a matching .pub), and after reading only its first 64 bytes when they
// look like a key ("-----BEGIN", PuTTY, openssh-key-v1). This is a best effort
// against a broad Include (e.g. `Include *` inside ~/.ssh), not a guarantee:
// a key under an unusual name and format could still be read as text.
//
// Everything is read asynchronously (main never blocks) and within one
// budget for the whole parse (files, include expansions, bytes read, bytes
// expanded, directory entries and glob matches): an Include that fans out or
// nests deeply stops at the budget instead of amplifying.
import fs from 'fs'
import os from 'os'
import { posix, win32 } from 'path'

const MAX_INCLUDE_DEPTH = 16
const TARGET_DEPENDENT_INCLUDE_TOKENS = new Set(['h', 'n', 'p', 'r', 'j', 'k', 'C'])

// The whole parse's budget (not per file). Exported for the tests.
export const SSH_CONFIG_LIMITS = Object.freeze({
  maxFileBytes: 256 * 1024, // one file larger than this is skipped unread
  maxFiles: 64, // distinct files opened
  maxReadBytes: 1024 * 1024, // bytes read from disk, all files together
  maxExpansions: 256, // file expansions (the same file included twice counts twice)
  maxExpandedBytes: 1024 * 1024, // the expanded text handed to the parser
  maxGlobEntries: 4096, // directory entries looked at by Include globs
  maxGlobMatches: 256 // files matched by Include globs, all Includes together
})
const KEY_PEEK_BYTES = 64

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

// The config's text with every Include replaced by the included files' text,
// within SSH_CONFIG_LIMITS. -> Promise<string>
export async function expandSshConfigIncludes(configPath, options = {}) {
  return (await expandSshConfigIncludesDetailed(configPath, options)).text
}

// -> Promise<{ text, truncated, stats }>; truncated: the budget cut the parse.
export async function expandSshConfigIncludesDetailed(configPath, { home = os.homedir(), fsApi = fs, limits = {} } = {}) {
  const pathApi = pathApiFor(configPath)
  const localHost = safe(() => os.hostname(), '')
  const context = {
    cache: new Map(),
    home,
    pathApi,
    fsp: fsApi.promises || fs.promises,
    rootDir: pathApi.dirname(configPath),
    username: currentUser(),
    uid: currentUid(),
    hostname: localHost,
    shortHostname: localHost.split('.')[0] || localHost,
    limits: { ...SSH_CONFIG_LIMITS, ...limits },
    stats: { files: 0, readBytes: 0, expansions: 0, expandedBytes: 0, globEntries: 0, globMatches: 0, skippedKeys: 0 },
    truncated: false
  }
  const out = []
  await expandFile(configPath, context, [], out)
  return { text: out.join('\n'), truncated: context.truncated, stats: { ...context.stats } }
}

// Stops the parse: every later step sees `truncated` and returns at once.
function overBudget(context) {
  context.truncated = true
  return true
}

async function expandFile(filePath, context, stack, out) {
  if (context.truncated || stack.length >= MAX_INCLUDE_DEPTH) return
  if (context.stats.expansions >= context.limits.maxExpansions) return void overBudget(context)
  context.stats.expansions++
  let canonical = null
  try {
    canonical = await context.fsp.realpath(filePath)
  } catch {
    return
  }
  if (stack.includes(canonical)) return
  const text = await readCached(canonical, context)
  if (text === null) return
  const next = [...stack, canonical]
  for (const line of text.split(/\r?\n/)) {
    if (context.truncated) return
    const includeArgs = parseIncludeDirective(line)
    if (!includeArgs) {
      // Checked before the line is kept: the expanded text never grows past
      // the budget, however often a file is included.
      const bytes = Buffer.byteLength(line) + 1
      if (context.stats.expandedBytes + bytes > context.limits.maxExpandedBytes) return void overBudget(context)
      context.stats.expandedBytes += bytes
      out.push(line)
      continue
    }
    for (const arg of includeArgs) {
      for (const p of await resolveIncludePaths(arg, context)) {
        if (context.truncated) return
        await expandFile(p, context, next, out)
      }
    }
  }
}

// A file name that is a key's, or a file with a matching public key.
const KEY_NAME_RE = /^(id_.*|.*\.(pem|key|pub|ppk|p12|pfx|der|crt|cer)|known_hosts.*|authorized_keys.*|ssh_host_.*)$/i
export function isKeyFileName(name) {
  return KEY_NAME_RE.test(String(name || ''))
}

// The first bytes of a key file (PEM, OpenSSH, PuTTY), after an optional BOM
// and blank space.
export function looksLikeKeyStart(buf) {
  const head = Buffer.from(buf).toString('latin1').replace(/^﻿|^ï»¿/, '').trimStart()
  return head.startsWith('-----BEGIN') || head.startsWith('PuTTY-User-Key-File') || head.startsWith('openssh-key-v1') || head.startsWith('---- BEGIN SSH2')
}

async function readCached(filePath, context) {
  if (context.cache.has(filePath)) return context.cache.get(filePath)
  const text = await readConfigFile(filePath, context)
  context.cache.set(filePath, text)
  return text
}

// A config file's text, or null (not a file, too large, looks like a key,
// over budget, unreadable). Never reads more than the file's allowance.
async function readConfigFile(filePath, context) {
  const { fsp, pathApi, limits, stats } = context
  if (isKeyFileName(pathApi.basename(filePath))) {
    stats.skippedKeys++
    return null
  }
  if (await isFile(`${filePath}.pub`, context)) {
    stats.skippedKeys++
    return null
  }
  let st
  try {
    st = await fsp.stat(filePath)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > limits.maxFileBytes) return null
  if (stats.files >= limits.maxFiles) return (overBudget(context), null)
  if (stats.readBytes + Math.min(st.size, KEY_PEEK_BYTES) > limits.maxReadBytes) return (overBudget(context), null)
  stats.files++
  let fh = null
  try {
    fh = await fsp.open(filePath, 'r')
    // The first bytes alone first: a key stops here.
    const peek = Buffer.alloc(Math.min(KEY_PEEK_BYTES, st.size))
    const { bytesRead: peeked } = peek.length ? await fh.read(peek, 0, peek.length, 0) : { bytesRead: 0 }
    stats.readBytes += peeked
    if (looksLikeKeyStart(peek.subarray(0, peeked))) {
      stats.skippedKeys++
      return null
    }
    // Then the rest, never past the size seen, the file cap or the budget
    // (checked before the buffer is allocated).
    const rest = Math.min(st.size, limits.maxFileBytes) - peeked
    if (rest > 0 && stats.readBytes + rest > limits.maxReadBytes) return (overBudget(context), null)
    const body = Buffer.alloc(Math.max(0, rest))
    let got = 0
    while (got < body.length) {
      const { bytesRead } = await fh.read(body, got, body.length - got, peeked + got)
      if (!bytesRead) break
      got += bytesRead
    }
    stats.readBytes += got
    return Buffer.concat([peek.subarray(0, peeked), body.subarray(0, got)]).toString('utf8')
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

async function isFile(p, context) {
  try {
    return (await context.fsp.stat(p)).isFile()
  } catch {
    return false
  }
}

function parseIncludeDirective(line) {
  const trimmed = line.trimStart()
  if (!trimmed || trimmed.startsWith('#')) return null
  const m = trimmed.match(/^([^=\s]+)(?:\s*=\s*|\s+)(.*)$/)
  if (!m || m[1].toLowerCase() !== 'include') return null
  const args = splitOpenSshArguments(m[2])
  return args.length ? args : null
}

async function resolveIncludePaths(pattern, context) {
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
  if (/[*?[]/.test(abs)) return globFiles(abs, context)
  return (await isFile(abs, context)) ? [abs] : []
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
// Directory entries and matches count against the parse's budget; names of
// key files are dropped here already.
async function globFiles(absPattern, context) {
  const { pathApi, fsp, limits, stats } = context
  const root = pathApi.parse(absPattern).root
  const parts = absPattern.slice(root.length).split(/[\\/]+/).filter(Boolean)
  let bases = [root]
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const last = i === parts.length - 1
    const next = []
    for (const base of bases) {
      if (!/[*?[]/.test(part)) {
        next.push(pathApi.join(base, part))
        continue
      }
      const re = globSegmentRegex(part)
      // Entries are read one by one and the reading stops at the budget, so a
      // huge folder is never listed in full (readdir would load every name).
      const names = []
      let dir = null
      try {
        dir = await fsp.opendir(base)
        for (;;) {
          if (stats.globEntries >= limits.maxGlobEntries) {
            overBudget(context)
            break
          }
          const entry = await dir.read()
          if (!entry) break
          stats.globEntries++
          names.push(entry.name)
        }
      } catch {
        /* unreadable folder: nothing matches */
      } finally {
        if (dir) await dir.close().catch(() => {})
      }
      names.sort((a, b) => a.localeCompare(b))
      for (const name of names) {
        if (name.startsWith('.') && !part.startsWith('.')) continue
        if (last && isKeyFileName(name)) continue
        if (re.test(name)) next.push(pathApi.join(base, name))
      }
      if (context.truncated) break
    }
    bases = next
    if (context.truncated) break
  }
  const files = []
  for (const p of bases.sort((a, b) => a.localeCompare(b))) {
    if (stats.globMatches >= limits.maxGlobMatches) {
      overBudget(context)
      break
    }
    if (await isFile(p, context)) {
      stats.globMatches++
      files.push(p)
    }
  }
  return files
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
// -> Promise<hosts[]>
export async function loadUserSshConfig(options = {}) {
  return (await loadUserSshConfigDetailed(options)).hosts
}

// -> Promise<{ hosts, truncated }>; truncated: the budget cut the parse, so
// some hosts may be missing.
export async function loadUserSshConfigDetailed({ home = os.homedir(), fsApi = fs, limits } = {}) {
  const configPath = pathApiFor(home).join(home, '.ssh', 'config')
  const fsp = fsApi.promises || fs.promises
  try {
    await fsp.stat(configPath)
  } catch {
    return { hosts: [], truncated: false }
  }
  try {
    const { text, truncated } = await expandSshConfigIncludesDetailed(configPath, { home, fsApi, limits })
    return { hosts: parseSshConfig(text, { home }), truncated }
  } catch {
    return { hosts: [], truncated: false }
  }
}
