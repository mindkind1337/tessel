// Codex's own folder trust in its config.toml:
//
//   [projects."<real path>"]
//   trust_level = "trusted"
//
// Edited in place, byte for byte: every other line, comment, blank line and
// the file's line endings stay as they are (no TOML library rewrites it).
// After Orca's src/main/codex/config-toml-project-trust.ts,
// config-toml-line-scan.ts, config-toml-key-path.ts and config-toml-syntax.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.).
//
// One difference: a folder the user marked `trust_level = "untrusted"` (Codex
// writes it when you answer No) is left alone. Tessel never overrides a "no".

// --- Line scanning ------------------------------------------------------------
// Lines inside a multi-line string or an unclosed array can look exactly like
// `[section]` headers or `key = value` pairs, but they are data.
const structural = (s) => !s.basic && !s.literal && s.arrayDepth === 0

function skipBasic(line, i) {
  while (i < line.length) {
    if (line[i] === '\\') i += 2
    else if (line[i] === '"') return i + 1
    else i++
  }
  return i
}
function skipLiteral(line, i) {
  const end = line.indexOf("'", i)
  return end === -1 ? line.length : end + 1
}

function nextScan(state, line) {
  let mode = state.basic ? 'basic' : state.literal ? 'literal' : null
  let arrayDepth = state.arrayDepth
  let i = 0
  while (i < line.length) {
    if (mode === 'basic' || mode === 'literal') {
      const close = mode === 'basic' ? '"""' : "'''"
      if (mode === 'basic' && line[i] === '\\') {
        i += 2
      } else if (line.startsWith(close, i)) {
        mode = null
        i += 3
      } else {
        i++
      }
      continue
    }
    const c = line[i]
    if (c === '#') break
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      mode = c === '"' ? 'basic' : 'literal'
      i += 3
    } else if (c === '"') {
      i = skipBasic(line, i + 1)
    } else if (c === "'") {
      i = skipLiteral(line, i + 1)
    } else {
      // Header brackets balance on their line: a depth still open at the
      // end of a line is a multi-line array.
      if (c === '[') arrayDepth++
      if (c === ']') arrayDepth = Math.max(0, arrayDepth - 1)
      i++
    }
  }
  return { basic: mode === 'basic', literal: mode === 'literal', arrayDepth }
}

// Each line of `text` with its offsets (end excludes a trailing \r) and
// whether it is TOML structure.
function* lines(text) {
  let cursor = 0
  let state = { basic: false, literal: false, arrayDepth: 0 }
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(cursor, end).replace(/\r$/, '')
    yield { line, start: cursor, end: cursor + line.length, structural: structural(state) }
    state = nextScan(state, line)
    if (nl === -1) return
    cursor = nl + 1
  }
}

// --- Strings and keys ---------------------------------------------------------
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

// A one-line "basic" or 'literal' string at `offset` -> { value, end } | null.
function parseString(line, offset) {
  let i = offset
  while (line[i] === ' ' || line[i] === '\t') i++
  if (line.startsWith('"""', i) || line.startsWith("'''", i)) return null
  const quote = line[i]
  if (quote !== '"' && quote !== "'") return null
  i++
  let value = ''
  while (i < line.length) {
    const c = line[i]
    if (c === quote) return { value, end: i + 1 }
    if (quote === '"' && c === '\\') {
      const e = line[i + 1]
      if (ESCAPES[e] !== undefined) {
        value += ESCAPES[e]
        i += 2
        continue
      }
      const len = e === 'u' ? 4 : e === 'U' ? 8 : 0
      const hex = len ? line.slice(i + 2, i + 2 + len) : ''
      if (!len || !new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) return null
      const cp = parseInt(hex, 16)
      if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return null
      value += String.fromCodePoint(cp)
      i += 2 + len
      continue
    }
    value += c
    i++
  }
  return null
}

const skipWs = (s, i) => {
  while (s[i] === ' ' || s[i] === '\t') i++
  return i
}

// A dotted key (bare or quoted parts) -> { segments, end } | null.
function parseKeyPath(source, offset = 0) {
  const segments = []
  let i = skipWs(source, offset)
  while (i < source.length) {
    const quoted = parseString(source, i)
    if (quoted) {
      segments.push(quoted.value)
      i = quoted.end
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(i))
      if (!bare) return null
      segments.push(bare[0])
      i += bare[0].length
    }
    i = skipWs(source, i)
    if (source[i] !== '.') return { segments, end: i }
    i = skipWs(source, i + 1)
  }
  return null
}

// A table header line without its comment -> '[...]' | null.
function tableHeader(line) {
  let i = 0
  while (i < line.length && line[i] !== '#') {
    if (line[i] === '"') i = skipBasic(line, i + 1)
    else if (line[i] === "'") i = skipLiteral(line, i + 1)
    else i++
  }
  const header = line.slice(0, i).trim()
  return /^\[.+\]$/.test(header) ? header : null
}

// `[projects."<path>"]` in any spelling (["projects".'<path>'] too) -> path | null.
export function projectHeaderPath(line) {
  const header = tableHeader(line)
  if (!header || header.startsWith('[[')) return null
  const inner = header.slice(1, -1)
  const key = parseKeyPath(inner)
  if (!key || key.end !== inner.length || key.segments.length !== 2 || key.segments[0] !== 'projects') return null
  return key.segments[1]
}

export function escapeTomlBasic(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

// How Codex compares project paths: Windows paths with / and case-folded.
export function codexPathKey(path) {
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('\\\\') && !path.startsWith('//')) return path
  return path.replace(/\\/g, '/').toLowerCase()
}

// Is `projects` (all of it, or this folder's entry) set some other way than a
// [projects."<path>"] table: an inline table (projects = {...}, or
// "<path>" = {...} under [projects]) or dotted keys (projects."<path>".x = ...)?
// A table added then would define it twice (Codex could not read its config)
// and could override the user's "untrusted".
function projectSetOtherwise(source, want) {
  let table = []
  for (const l of lines(source)) {
    if (!l.structural) continue
    const header = tableHeader(l.line)
    if (header) {
      const inner = header.startsWith('[[') && header.endsWith(']]') ? header.slice(2, -2) : header.slice(1, -1)
      const key = parseKeyPath(inner)
      table = key && key.end === inner.length ? key.segments : [null]
      continue
    }
    const key = parseKeyPath(l.line)
    if (!key || l.line[key.end] !== '=') continue
    const full = [...table, ...key.segments]
    if (full[0] !== 'projects') continue
    if (full.length === 1) return true
    // Inside our own [projects."<path>"] table: its keys are ours to read.
    if (table.length === 2 && table[0] === 'projects' && codexPathKey(String(table[1])) === want) continue
    if (codexPathKey(full[1]) === want) return true
  }
  return false
}

// --- The edit -----------------------------------------------------------------
// `text` with `projectPath` trusted -> { text, changed, reason? }.
// reason: 'untrusted' (the user said no to this folder: left alone);
// 'unreadable' (the folder or the projects list is written in a form this
// edit does not make: left alone, Codex asks).
export function withCodexProjectTrusted(text, projectPath) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const bom = source === text ? '' : '﻿'
  const want = codexPathKey(projectPath)
  if (projectSetOtherwise(source, want)) return { text, changed: false, reason: 'unreadable' }
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const trustLine = 'trust_level = "trusted"'
  let headerEnd = null
  for (const l of lines(source)) {
    if (!l.structural) continue
    if (headerEnd === null) {
      const p = projectHeaderPath(l.line)
      if (p !== null && codexPathKey(p) === want) headerEnd = l.end
      continue
    }
    // Inside our table: up to the next header.
    if (tableHeader(l.line)) break
    const key = parseKeyPath(l.line)
    if (!key || key.segments.length !== 1 || key.segments[0] !== 'trust_level' || l.line[key.end] !== '=') continue
    const value = parseString(l.line, key.end + 1)
    const clean = value && /^[ \t]*(?:#.*)?$/.test(l.line.slice(value.end))
    if (clean && value.value === 'trusted') return { text, changed: false }
    if (clean && value.value === 'untrusted') return { text, changed: false, reason: 'untrusted' }
    // Any other spelling or value: rewritten, so the key is never doubled.
    return { text: bom + source.slice(0, l.start) + trustLine + source.slice(l.end), changed: true }
  }
  if (headerEnd !== null) {
    return { text: `${bom}${source.slice(0, headerEnd)}${eol}${trustLine}${source.slice(headerEnd)}`, changed: true }
  }
  const block = `[projects."${escapeTomlBasic(projectPath)}"]${eol}${trustLine}`
  if (!source.length) return { text: `${bom}${block}${eol}`, changed: true }
  const sep = source.endsWith(eol + eol) ? '' : source.endsWith(eol) || source.endsWith('\n') ? eol : eol + eol
  return { text: `${bom}${source}${sep}${block}${eol}`, changed: true }
}
