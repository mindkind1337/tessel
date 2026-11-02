import { t } from '../i18n'
import { ConnectionError } from './connections'

// What every provider's tools share (google.js, microsoft.js, github.js...): checking what an agent
// gave, showing it on a card, reading text someone else wrote, and the one way a token leaves this
// computer. What is read is the person's own data, in full; what it says is someone else's words,
// and the agent is told so (index.js).
const CALL_MS = 30 * 1000
export const MAX_BODY = 200 * 1024
export const MAX_FILE_BYTES = 2 * 1024 * 1024
// An answer of a service bigger than this is not read at all: the agent asks for less.
const MAX_JSON = 16 * 1024 * 1024
const MAX_HTML = 256 * 1024

export class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const bad = (message) => new AppError('invalid_argument', message)
export function text(value, name, { required = false, max = 2000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`Give "${name}".`)
    return ''
  }
  if (typeof value !== 'string') throw bad(`"${name}" must be text.`)
  if (value.length > max) throw bad(`"${name}" is at most ${max} characters.`)
  return value
}
export const count = (value, fallback, max) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : fallback
}
// An id goes into a URL's path: one segment, and never one that means the folder above.
export function pathId(value, name) {
  const id = text(value, name, { required: true, max: 1024 })
  if (id === '.' || id === '..') throw bad(`"${name}" is not valid.`)
  return encodeURIComponent(id)
}
// A header or a card's value: on one line, whatever it was given.
export const oneLine = (value) => String(value || '').replace(/[\r\n]+/g, ' ').trim()

// What a card shows: on one line, with nothing that hides or turns text around, and spaces that
// cannot push a word to look like a line of its own.
export const shownLine = (value) => oneLine(value).replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim()
// A value on a card, and if it is cut the card says how much was left out.
export const shortened = (value, max = 200) => {
  const line = shownLine(value)
  return line.length > max ? `${line.slice(0, max)} ${t('main.apps.card.more', '[{{count}} more characters]', { count: line.length - max })}` : line
}
// A list of addresses on a card: each one bounded, and how many more if there are too many.
// (Cut in the middle: its end says where it goes. Letters that only look like plain ones are said.)
export const shownAddress = (value) => {
  const line = shownLine(value)
  const cut = line.length > 80 ? `${line.slice(0, 30)}...${line.slice(-45)}` : line
  return /[^\x20-\x7e]/.test(line) ? `${cut} ${t('main.apps.card.notPlain', '[not plain ASCII]')}` : cut
}
const domainOf = (value) => {
  const found = /@([^\s@>,]+)/.exec(shownLine(value))
  return found ? found[1].toLowerCase() : null
}
export const shownList = (values, most = 20) => {
  const list = values.slice(0, most).map(shownAddress)
  const hidden = values.slice(most)
  if (!hidden.length) return list.join(', ')
  const domains = [...new Set(hidden.map(domainOf).filter(Boolean))].slice(0, 5).map((d) => shortened(d, 60))
  return `${list.join(', ')} ${t('main.apps.card.andMore', 'and {{count}} more', { count: hidden.length })}${domains.length ? ` (${domains.join(', ')})` : ''}`
}
// A To or Cc line: every address of it, as a list.
export const shownAddresses = (value) => shownList(shownLine(value).split(/[,;]\s*/).filter(Boolean))
export const query = (params) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  return q.toString()
}
export const jsonBody = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// A long text the agent reads: cut, and saying so.
export const cut = (value, max = MAX_BODY) => {
  const whole = String(value ?? '')
  return whole.length > max ? `${whole.slice(0, max)}\n[the rest is cut]` : whole
}

// A big answer stops being read at the limit: no service, file or log can fill the main process.
async function readBytes(res, max) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const whole = Buffer.from(await res.arrayBuffer())
    return { bytes: whole.subarray(0, max), over: whole.length > max }
  }
  const parts = []
  let size = 0
  try {
    while (size <= max) {
      const { done, value } = await reader.read()
      if (done) return { bytes: Buffer.concat(parts), over: false }
      parts.push(Buffer.from(value))
      size += value.length
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return { bytes: Buffer.concat(parts).subarray(0, max), over: true }
}

// A file's words. -> { text, over } or null when it is not text (a NUL in its first part).
export async function fileText(res, max = MAX_FILE_BYTES) {
  const { bytes, over } = await readBytes(res, max)
  if (bytes.subarray(0, 8192).includes(0)) return null
  return { text: bytes.toString('utf8'), over }
}

const refusalCode = (status) => (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : 'failed')
const refusalWords = (reason) => {
  if (!reason || typeof reason !== 'object') return ''
  if (typeof reason.error?.message === 'string') return reason.error.message
  if (typeof reason.message === 'string') return reason.message
  if (typeof reason.detail === 'string') return reason.detail
  if (typeof reason.error_description === 'string') return reason.error_description
  if (typeof reason.error === 'string') return reason.error
  return ''
}

// The one way a token leaves this computer: to the fixed hosts of its provider, over TLS, never along
// a redirect, and renewed once if the service says it ended. Anything else an agent can pass goes in
// a path segment (pathId) or a query, so no id, tenant or site can send a token anywhere else.
//   raw: the Response, for a file. A download that answers with a redirect is followed without the token.
export function createCall({ connections, provider, name, hosts, fetchFn, headers = {}, wordsOf = refusalWords, hintOf = () => '' }) {
  return async function call(account, url, init = {}, { raw = false } = {}) {
    const target = new URL(url)
    if (target.protocol !== 'https:' || !hosts.includes(target.host)) throw new AppError('failed', `Tessel does not send a ${name} token to that address.`)
    const got = await connections.access(provider, account)
    const ask = (token) => fetchFn(url, { ...init, headers: { ...headers, ...(init.headers || {}), authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(CALL_MS) })
    let res
    try {
      res = await ask(got.token)
      if (res.status === 401) res = await ask(await got.refreshed())
      if (raw && res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url)
        if (next.protocol !== 'https:') throw new AppError('failed', `${name} answered with an address that is not safe.`)
        res = await fetchFn(next.href, { redirect: 'follow', signal: AbortSignal.timeout(CALL_MS) })
      }
    } catch (err) {
      if (err instanceof ConnectionError || err instanceof AppError) throw err
      throw new AppError('offline', `Could not reach ${name}.`)
    }
    if (!res.ok) {
      const reason = await res.json().catch(() => null)
      const words = String(shownLine(wordsOf(reason)) || `${name} answered ${res.status}.`).slice(0, 400)
      const hint = hintOf(res.status, reason)
      throw new AppError(refusalCode(res.status), hint ? `${words} ${hint}` : words)
    }
    if (raw) return res
    if (res.status === 204) return {}
    const { bytes, over } = await readBytes(res, MAX_JSON)
    if (over) throw new AppError('too_big', `${name} answered with too much at once: ask for less.`)
    const words = bytes.toString('utf8')
    if (!words.trim()) return {}
    try {
      return JSON.parse(words)
    } catch {
      throw new AppError('failed', `${name} answered with something Tessel cannot read.`)
    }
  }
}

// The text of an HTML part, for a mail with no plain text: enough to read it. Anyone can send a
// mail, and this runs in Tessel's main process, so it walks the text once, with no pattern that can
// go back over it, and over a bounded size. Tags are read the way a browser reads them, so a link
// shows the address it really goes to; when in doubt it keeps the words.
const SKIPPED_TAGS = new Set(['script', 'style', 'head'])
// What these hold is text to a browser, never tags.
const RAW_TEXT_TAGS = new Set(['title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes'])
const LINE_TAGS = new Set(['br', '/p', '/div', '/tr', '/li', '/h1', '/h2', '/h3', '/h4', '/h5', '/h6'])
const isBlank = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isLetter = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
// Only A to Z: other letters can change length (a Turkish dotted I), and places found in the
// lower-case text are used in the text itself.
const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase())
// One tag: attributes in turn, with their quotes, the first href counting as in a browser.
// -> { name, end, href }, or null when the text ends before the tag does.
function readTag(s, open) {
  const n = s.length
  let at = open + 1
  const closing = s[at] === '/'
  if (closing) at++
  const begin = at
  while (at < n && !isBlank(s[at]) && s[at] !== '/' && s[at] !== '>') at++
  const name = `${closing ? '/' : ''}${asciiLower(s.slice(begin, at))}`
  let href = null
  while (true) {
    while (at < n && (isBlank(s[at]) || s[at] === '/')) at++
    if (at >= n) return null
    if (s[at] === '>') return { name, end: at + 1, href }
    const from = at
    at++
    while (at < n && !isBlank(s[at]) && s[at] !== '/' && s[at] !== '>' && s[at] !== '=') at++
    const attribute = asciiLower(s.slice(from, at))
    while (at < n && isBlank(s[at])) at++
    let value = ''
    let given = false
    if (s[at] === '=') {
      given = true
      at++
      while (at < n && isBlank(s[at])) at++
      const quote = s[at]
      if (quote === '"' || quote === "'") {
        const stop = s.indexOf(quote, at + 1)
        if (stop < 0) return null
        value = s.slice(at + 1, stop)
        at = stop + 1
      } else {
        const start = at
        while (at < n && !isBlank(s[at]) && s[at] !== '>') at++
        value = s.slice(start, at)
      }
    }
    if (attribute === 'href' && given && href === null) href = value.trim()
  }
}
export function htmlToText(html) {
  const whole = String(html || '')
  const s = whole.slice(0, MAX_HTML)
  const lower = asciiLower(s)
  // Where a word comes next: each one is looked for forward only, so hostile mail stays linear.
  const seen = new Map()
  const next = (word, from) => {
    const known = seen.get(word)
    if (known !== undefined && (known < 0 || known >= from)) return known
    const found = lower.indexOf(word, from)
    seen.set(word, found)
    return found
  }
  // Where what a skipped tag holds ends, or -1: then nothing is skipped.
  const skipEnd = (name, from) => {
    const closing = next(`</${name}`, from)
    if (name !== 'head') return closing
    const body = next('<body', from)
    return body >= 0 && (closing < 0 || body < closing) ? body : closing
  }
  let out = ''
  let link = null
  let at = 0
  while (at < s.length) {
    const open = s.indexOf('<', at)
    if (open < 0) {
      out += s.slice(at)
      break
    }
    out += s.slice(at, open)
    const first = s[open + 1]
    // A comment, or something else a browser does not show.
    if (first === '!' || first === '?' || (first === '/' && !isLetter(s[open + 2] || ''))) {
      if (s.startsWith('<!--', open)) {
        // Where a browser ends a comment: <!--> and <!---> are empty ones, and --!> ends one too.
        if (s[open + 4] === '>') {
          at = open + 5
          continue
        }
        if (s.startsWith('->', open + 4)) {
          at = open + 6
          continue
        }
        const plain = next('-->', open + 4)
        const bang = next('--!>', open + 4)
        const stop = plain < 0 ? bang : bang < 0 ? plain : Math.min(plain, bang)
        if (stop < 0) {
          out += s.slice(open)
          break
        }
        at = stop + (stop === plain ? 3 : 4)
        continue
      }
      const stop = s.indexOf('>', open + 2)
      if (stop < 0) {
        out += s.slice(open)
        break
      }
      at = stop + 1
      continue
    }
    // A < that starts nothing is a word: "if a < b".
    if (first !== '/' && !isLetter(first || '')) {
      out += '<'
      at = open + 1
      continue
    }
    const tag = readTag(s, open)
    if (!tag) {
      out += s.slice(open)
      break
    }
    at = tag.end
    const { name } = tag
    if (name === 'plaintext') {
      out += s.slice(at)
      break
    }
    if (RAW_TEXT_TAGS.has(name)) {
      const stop = next(`</${name}`, at)
      if (stop < 0) {
        out += s.slice(at)
        break
      }
      out += `${s.slice(at, stop)} `
      const closed = s.indexOf('>', stop)
      if (closed < 0) break
      at = closed + 1
      continue
    }
    if (SKIPPED_TAGS.has(name)) {
      const stop = skipEnd(name, at)
      if (stop >= 0) {
        // Past the closing tag; a <body> that ends a <head> is read as any tag.
        if (lower.startsWith(`</${name}`, stop)) {
          const closed = s.indexOf('>', stop)
          if (closed < 0) break
          at = closed + 1
        } else at = stop
      }
      out += ' '
      continue
    }
    if (LINE_TAGS.has(name)) out += '\n'
    else if (name === 'a') {
      if (link) out += ` (${link})`
      link = tag.href || null
    } else if (name === '/a') {
      if (link) out += ` (${link})`
      link = null
    } else out += ' '
  }
  if (link) out += ` (${link})`
  const text = out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((line) => line.split(/[ \t]+/).join(' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return whole.length > MAX_HTML ? `${text}\n[the rest is cut]` : text
}
