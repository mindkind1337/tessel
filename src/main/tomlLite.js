// A small TOML 1.0 reader, for checking a config file Tessel edits (Grok
// Build's config.toml) before and after the edit: the whole syntax (tables,
// arrays of tables, dotted and quoted keys, every string form, numbers,
// booleans, dates, arrays and inline tables), and the rules that make a file
// invalid (a key or a table defined twice, a value without a key, an
// unclosed string or bracket). Values come back as plain JavaScript (a date
// as its text). -> { ok: true, data } | { ok: false, error, line }.
const BARE = /^[A-Za-z0-9_-]+/

class TomlError extends Error {
  constructor(message, line) {
    super(message)
    this.line = line
  }
}

export function parseToml(text) {
  const src = String(text ?? '').replace(/^﻿/, '')
  let i = 0
  let line = 1
  const fail = (msg) => {
    throw new TomlError(msg, line)
  }
  const peek = (n = 0) => src[i + n]
  const rest = () => src.slice(i)
  const skipWs = () => {
    while (peek() === ' ' || peek() === '\t') i++
  }
  const skipComment = () => {
    if (peek() === '#') {
      while (i < src.length && peek() !== '\n') {
        const c = src.charCodeAt(i)
        if ((c < 0x20 && c !== 0x09) || c === 0x7f) fail('control character in a comment')
        i++
      }
    }
  }
  const newline = () => {
    if (peek() === '\r' && peek(1) === '\n') i += 2
    else if (peek() === '\n') i++
    else return false
    line++
    return true
  }
  // Whitespace, comments and newlines (inside arrays).
  const skipAll = () => {
    for (;;) {
      skipWs()
      skipComment()
      if (!newline()) return
    }
  }
  const endOfLine = () => {
    skipWs()
    skipComment()
    if (i < src.length && !newline()) fail('unexpected text after a value')
  }

  function basicString() {
    i++ // "
    let out = ''
    for (;;) {
      if (i >= src.length || peek() === '\n' || peek() === '\r') fail('unclosed string')
      const c = peek()
      if (c === '"') {
        i++
        return out
      }
      if (c === '\\') out += escape()
      else {
        const code = src.charCodeAt(i)
        if ((code < 0x20 && code !== 0x09) || code === 0x7f) fail('control character in a string')
        out += c
        i++
      }
    }
  }
  function escape() {
    i++ // \
    const c = peek()
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
    if (c in simple) {
      i++
      return simple[c]
    }
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8
      const hex = src.slice(i + 1, i + 1 + len)
      if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) fail('bad unicode escape')
      const cp = parseInt(hex, 16)
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('bad unicode escape')
      i += 1 + len
      return String.fromCodePoint(cp)
    }
    fail('bad escape in a string')
  }
  function literalString() {
    i++ // '
    const end = src.indexOf("'", i)
    const nl = src.slice(i, end < 0 ? undefined : end).search(/[\r\n]/)
    if (end < 0 || nl >= 0) fail('unclosed string')
    const s = src.slice(i, end)
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(s)) fail('control character in a string') // eslint-disable-line no-control-regex
    i = end + 1
    return s
  }
  function multiString(quote) {
    i += 3
    if (peek() === '\r' && peek(1) === '\n') i += 2
    else if (peek() === '\n') i++
    let out = ''
    for (;;) {
      if (i >= src.length) fail('unclosed string')
      if (src.startsWith(quote.repeat(3), i)) {
        // Up to two quotes may sit right before the closing three.
        let n = 3
        while (n < 5 && src[i + n] === quote) n++
        out += quote.repeat(n - 3)
        i += n
        return out
      }
      const c = peek()
      if (c === '\n') {
        line++
        out += c
        i++
      } else if (quote === '"' && c === '\\') {
        // A line-ending backslash trims the newline and the spaces after it.
        const after = /^\\[ \t]*\r?\n/.exec(rest())
        if (after) {
          i += after[0].length
          line++
          for (;;) {
            const m = /^[ \t]*/.exec(rest())
            i += m[0].length
            if (!newline()) break
          }
        } else out += escape()
      } else {
        const code = src.charCodeAt(i)
        if ((code < 0x20 && code !== 0x09 && code !== 0x0d) || code === 0x7f) fail('control character in a string')
        out += c
        i++
      }
    }
  }
  function key() {
    const parts = []
    for (;;) {
      skipWs()
      if (peek() === '"') parts.push(src.startsWith('"""', i) ? fail('bad key') : basicString())
      else if (peek() === "'") parts.push(src.startsWith("'''", i) ? fail('bad key') : literalString())
      else {
        const m = BARE.exec(rest())
        if (!m) fail('a key is missing')
        parts.push(m[0])
        i += m[0].length
      }
      skipWs()
      if (peek() !== '.') return parts
      i++
    }
  }
  const DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?/
  const NUM = /^[+-]?(?:inf|nan)\b|^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|^0o[0-7](?:_?[0-7])*|^0b[01](?:_?[01])*|^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/
  function value() {
    const c = peek()
    if (src.startsWith('"""', i)) return multiString('"')
    if (src.startsWith("'''", i)) return multiString("'")
    if (c === '"') return basicString()
    if (c === "'") return literalString()
    if (c === '[') return array()
    if (c === '{') return inlineTable()
    if (/^true(?![A-Za-z0-9_-])/.test(rest())) {
      i += 4
      return true
    }
    if (/^false(?![A-Za-z0-9_-])/.test(rest())) {
      i += 5
      return false
    }
    const d = DATE.exec(rest())
    if (d && !/^[A-Za-z0-9_:.+-]/.test(src.slice(i + d[0].length))) {
      i += d[0].length
      return d[0]
    }
    const n = NUM.exec(rest())
    if (n && !/^[A-Za-z0-9_.]/.test(src.slice(i + n[0].length))) {
      i += n[0].length
      const t = n[0].replace(/_/g, '')
      if (/inf$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity
      if (/nan$/.test(t)) return NaN
      if (/^0[xob]/.test(t)) return Number(t)
      return Number(t)
    }
    fail('a value is missing or not valid')
  }
  function array() {
    i++ // [
    const out = []
    for (;;) {
      skipAll()
      if (peek() === ']') {
        i++
        return out
      }
      out.push(value())
      skipAll()
      if (peek() === ',') {
        i++
        continue
      }
      if (peek() === ']') {
        i++
        return out
      }
      fail('unclosed array')
    }
  }
  function inlineTable() {
    i++ // {
    const out = {}
    const fixed = new Set()
    skipWs()
    if (peek() === '}') {
      i++
      return out
    }
    for (;;) {
      const k = key()
      skipWs()
      if (peek() !== '=') fail('"=" is missing')
      i++
      skipWs()
      assign(out, k, value(), fixed)
      skipWs()
      if (peek() === ',') {
        i++
        continue
      }
      if (peek() === '}') {
        i++
        return out
      }
      fail('unclosed inline table')
    }
  }
  // Tables made closed: inline tables and arrays can never be added to.
  const sealed = new WeakSet()
  const implicit = new WeakSet() // made by a dotted key or a sub-table's header
  const dotted = new WeakSet() // made by a dotted key: never given a [header] after
  function assign(table, parts, v, fixed = null) {
    let t = table
    for (let k = 0; k < parts.length - 1; k++) {
      const p = parts[k]
      if (t[p] === undefined) {
        t[p] = {}
        implicit.add(t[p])
        dotted.add(t[p])
      } else if (typeof t[p] !== 'object' || t[p] === null || Array.isArray(t[p]) || sealed.has(t[p])) fail(`the key ${parts.join('.')} is defined twice`)
      t = t[p]
    }
    const last = parts[parts.length - 1]
    if (Object.hasOwn(t, last)) fail(`the key ${parts.join('.')} is defined twice`)
    if (v && typeof v === 'object') sealed.add(v)
    t[last] = v
    if (fixed) fixed.add(parts.join('\u0000'))
  }

  const root = {}
  const defined = new WeakSet() // tables given a [header] of their own
  let current = root
  try {
    for (;;) {
      skipAll()
      if (i >= src.length) break
      if (peek() === '[') {
        const arr = peek(1) === '['
        i += arr ? 2 : 1
        const parts = key()
        if (arr ? !src.startsWith(']]', i) : peek() !== ']') fail('unclosed table header')
        i += arr ? 2 : 1
        let t = root
        for (let k = 0; k < parts.length - (arr ? 1 : 0); k++) {
          const p = parts[k]
          const isLast = !arr && k === parts.length - 1
          if (t[p] === undefined) {
            t[p] = {}
            if (!isLast) implicit.add(t[p])
          } else if (Array.isArray(t[p]) && !isLast && !sealed.has(t[p])) {
            t = t[p][t[p].length - 1]
            continue
          } else if (typeof t[p] !== 'object' || t[p] === null || Array.isArray(t[p]) || sealed.has(t[p])) fail(`the table ${parts.join('.')} is defined twice`)
          else if (isLast) {
            if (defined.has(t[p]) || dotted.has(t[p]) || !implicit.has(t[p])) fail(`the table ${parts.join('.')} is defined twice`)
          }
          t = t[p]
        }
        if (arr) {
          const p = parts[parts.length - 1]
          if (t[p] === undefined) t[p] = []
          else if (!Array.isArray(t[p]) || sealed.has(t[p])) fail(`the table ${parts.join('.')} is defined twice`)
          const entry = {}
          t[p].push(entry)
          t = entry
        } else {
          implicit.delete(t)
        }
        defined.add(t)
        current = t
        endOfLine()
        continue
      }
      const k = key()
      skipWs()
      if (peek() !== '=') fail('"=" is missing')
      i++
      skipWs()
      assign(current, k, value())
      endOfLine()
    }
  } catch (err) {
    if (err instanceof TomlError) return { ok: false, error: err.message, line: err.line }
    throw err
  }
  return { ok: true, data: root }
}

// A key as TOML writes it: bare when it can be, else quoted.
export const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k))
// A plain value as TOML writes it (strings, finite numbers, booleans, flat
// tables of those), or null when it is none of these.
export function tomlValue(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (Array.isArray(v)) {
    const items = v.map(tomlValue)
    return items.includes(null) ? null : `[${items.join(', ')}]`
  }
  if (v && typeof v === 'object') {
    const items = Object.entries(v).map(([k, x]) => {
      const t = tomlValue(x)
      return t === null || (x && typeof x === 'object') ? null : `${tomlKey(k)} = ${t}`
    })
    return items.includes(null) ? null : `{ ${items.join(', ')} }`
  }
  return null
}
