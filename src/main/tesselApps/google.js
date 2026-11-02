import { t } from '../i18n'

// tessel_apps: Gmail, Calendar and Drive, called straight from this computer with the person's
// own token (connections.js). What comes back is the person's own data, in full; what a mail or
// a file says is someone else's words, and the agent is told so (index.js).
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const CALL_MS = 30 * 1000
const MAX_BODY = 200 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_HTML = 256 * 1024

export class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const bad = (message) => new AppError('invalid_argument', message)
function text(value, name, { required = false, max = 2000 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`Give "${name}".`)
    return ''
  }
  if (typeof value !== 'string') throw bad(`"${name}" must be text.`)
  if (value.length > max) throw bad(`"${name}" is at most ${max} characters.`)
  return value
}
const count = (value, fallback, max) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : fallback
}
// An id goes into a URL's path: one segment, and never one that means the folder above.
function pathId(value, name) {
  const id = text(value, name, { required: true, max: 1024 })
  if (id === '.' || id === '..') throw bad(`"${name}" is not valid.`)
  return encodeURIComponent(id)
}
const calendarOf = (args) => pathId(text(args.calendar, 'calendar', { max: 500 }) || 'primary', 'calendar')
// A header in a mail: on one line, whatever it was given.
const oneLine = (value) => String(value || '').replace(/[\r\n]+/g, ' ').trim()
// Words of a header that are not plain ASCII (RFC 2047).
const headerWords = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`)
const decodeBody = (data) => Buffer.from(String(data || ''), 'base64url').toString('utf8')

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

// The readable text of a message's parts, and its attachments' names.
export function messageParts(payload) {
  const plain = []
  const html = []
  const attachments = []
  const walk = (part, depth = 0) => {
    if (!part || depth > 20) return
    const type = String(part.mimeType || '').toLowerCase()
    if (part.filename) attachments.push(`${oneLine(part.filename)} (${type || 'file'}, ${Number(part.body?.size) || 0} bytes)`)
    else if (type === 'text/plain' && part.body?.data) plain.push(decodeBody(part.body.data))
    else if (type === 'text/html' && part.body?.data) html.push(decodeBody(part.body.data))
    for (const child of Array.isArray(part.parts) ? part.parts : []) walk(child, depth + 1)
  }
  walk(payload)
  return { text: plain.length ? plain.join('\n') : htmlToText(html.join('\n')), attachments }
}

const headersOf = (message) => {
  const out = {}
  for (const h of message.payload?.headers || []) if (h && typeof h.name === 'string') out[h.name.toLowerCase()] = oneLine(h.value)
  return out
}
const summary = (m) => {
  const h = headersOf(m)
  return `id: ${m.id}  thread: ${m.threadId}\nDate: ${h.date || '?'}\nFrom: ${h.from || '?'}\nTo: ${h.to || '?'}\nSubject: ${h.subject || '(none)'}\n${m.snippet ? `Snippet: ${m.snippet}\n` : ''}`
}
function fullMessage(m) {
  const h = headersOf(m)
  const { text: body, attachments } = messageParts(m.payload)
  return [
    `id: ${m.id}  thread: ${m.threadId}`,
    `Date: ${h.date || '?'}`,
    `From: ${h.from || '?'}`,
    `To: ${h.to || '?'}`,
    ...(h.cc ? [`Cc: ${h.cc}`] : []),
    `Subject: ${h.subject || '(none)'}`,
    ...(attachments.length ? [`Attachments: ${attachments.join('; ')}`] : []),
    '',
    body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[the rest is cut]` : body
  ].join('\n')
}

// An RFC 5322 message for a draft: every header on one line, whatever the agent sent.
export function draftMessage({ to, cc, subject, body, inReplyTo }) {
  const lines = ['MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', `To: ${oneLine(to)}`]
  if (cc) lines.push(`Cc: ${oneLine(cc)}`)
  lines.push(`Subject: ${headerWords(oneLine(subject))}`)
  if (inReplyTo) lines.push(`In-Reply-To: ${oneLine(inReplyTo)}`, `References: ${oneLine(inReplyTo)}`)
  const encoded = Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${encoded}`, 'utf8').toString('base64url')
}

const eventLine = (e) => {
  const start = e.start?.dateTime || e.start?.date || '?'
  const end = e.end?.dateTime || e.end?.date || '?'
  return `id: ${e.id}\n${start} to ${end}: ${e.summary || '(no title)'}${e.location ? `\nWhere: ${e.location}` : ''}${e.attendees?.length ? `\nWith: ${e.attendees.map((a) => a.email).filter(Boolean).join(', ')}` : ''}${e.description ? `\n${e.description}` : ''}\n`
}
function eventBody(args) {
  const body = {}
  const when = (value, name) => {
    const t = text(value, name, { max: 40 })
    if (!t) return null
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { date: t } : { dateTime: t, ...(args.timeZone ? { timeZone: text(args.timeZone, 'timeZone', { max: 80 }) } : {}) }
  }
  if (args.summary !== undefined) body.summary = text(args.summary, 'summary', { max: 1000 })
  if (args.description !== undefined) body.description = text(args.description, 'description', { max: 8000 })
  if (args.location !== undefined) body.location = text(args.location, 'location', { max: 1000 })
  const start = when(args.start, 'start')
  const end = when(args.end, 'end')
  if (start) body.start = start
  if (end) body.end = end
  if (args.attendees !== undefined) {
    if (!Array.isArray(args.attendees) || args.attendees.length > 100) throw bad('"attendees" is a list of at most 100 addresses.')
    body.attendees = args.attendees.map((email) => ({ email: text(email, 'attendees', { required: true, max: 320 }) }))
  }
  return body
}

// What a card shows: on one line, with nothing that hides or turns text around, and spaces that
// cannot push a word to look like a line of its own.
const shownLine = (value) => oneLine(value).replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim()
// A value on a card, and if it is cut the card says how much was left out.
const shortened = (value, max = 200) => {
  const line = shownLine(value)
  return line.length > max ? `${line.slice(0, max)} ${t('main.apps.card.more', '[{{count}} more characters]', { count: line.length - max })}` : line
}
// A calendar other than the person's own: someone else may be able to read what goes in it.
const otherCalendar = (args) => {
  const named = typeof args.calendar === 'string' ? args.calendar.trim() : ''
  return named && named !== 'primary' ? named : null
}
// A list of addresses on a card: each one bounded, and how many more if there are too many.
// (Cut in the middle: its end says where it goes. Letters that only look like plain ones are said.)
const shownAddress = (value) => {
  const line = shownLine(value)
  const cut = line.length > 80 ? `${line.slice(0, 30)}...${line.slice(-45)}` : line
  return /[^\x20-\x7e]/.test(line) ? `${cut} ${t('main.apps.card.notPlain', '[not plain ASCII]')}` : cut
}
const domainOf = (value) => {
  const found = /@([^\s@>,]+)/.exec(shownLine(value))
  return found ? found[1].toLowerCase() : null
}
const shownList = (values, most = 20) => {
  const list = values.slice(0, most).map(shownAddress)
  const hidden = values.slice(most)
  if (!hidden.length) return list.join(', ')
  const domains = [...new Set(hidden.map(domainOf).filter(Boolean))].slice(0, 5).map((d) => shortened(d, 60))
  return `${list.join(', ')} ${t('main.apps.card.andMore', 'and {{count}} more', { count: hidden.length })}${domains.length ? ` (${domains.join(', ')})` : ''}`
}
// A To or Cc line: every address of it, as a list.
const shownAddresses = (value) => shownList(shownLine(value).split(/[,;]\s*/).filter(Boolean))
// What a change to an event is, for the card that asks: who could read it first.
function describeEvent(args, { update = false } = {}) {
  const lines = []
  const other = otherCalendar(args)
  if (other) lines.push(t('main.apps.card.calendar', 'Calendar: {{value}}', { value: shortened(other) }))
  if (Array.isArray(args.attendees) && args.attendees.length) {
    // On an update this list replaces the guests the event has.
    if (update) lines.push(t('main.apps.card.guestsBecome', 'Guests after this change: {{value}}', { value: shownList(args.attendees) }))
    else lines.push(t('main.apps.card.invites', 'Invites: {{value}}', { value: shownList(args.attendees) }))
  }
  else if (update && Array.isArray(args.attendees)) lines.push(t('main.apps.card.removesGuests', 'Removes all guests'))
  if (args.summary !== undefined) lines.push(t('main.apps.card.title', 'Title: {{value}}', { value: shortened(args.summary) }))
  if (args.start !== undefined || args.end !== undefined) lines.push(t('main.apps.card.when', 'When: {{start}} to {{end}}', { start: shortened(args.start, 40), end: shortened(args.end, 40) }))
  if (args.timeZone) lines.push(t('main.apps.card.timeZone', 'Time zone: {{value}}', { value: shortened(args.timeZone, 80) }))
  if (args.location !== undefined) lines.push(t('main.apps.card.where', 'Where: {{value}}', { value: shortened(args.location) }))
  if (args.description !== undefined) lines.push(t('main.apps.card.description', 'Description: {{value}}', { value: shortened(args.description) }))
  return lines.join('\n')
}

// Files Google keeps in its own formats, and what they read as.
const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain'
}
const READABLE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|csv|x-www-form-urlencoded)$)/

// The tools, by name: which part of the connection they use, whether they change anything, and
// what they do. connections: connections.js, fetchFn: fetch.
export function createGoogleTools({ connections, fetchFn = fetch }) {
  // A call with the person's token, renewed once if the service says it ended.
  async function call(account, url, init = {}, { raw = false } = {}) {
    const got = await connections.access('google', account)
    const ask = (token) => fetchFn(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(CALL_MS) })
    let res
    try {
      res = await ask(got.token)
      if (res.status === 401) res = await ask(await got.refreshed())
    } catch (err) {
      if (err && err.code) throw err
      throw new AppError('offline', 'Could not reach Google.')
    }
    if (!res.ok) {
      const reason = await res.json().catch(() => null)
      const message = String(reason?.error?.message || `Google answered ${res.status}.`).slice(0, 400)
      throw new AppError(res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate_limited' : 'failed', message)
    }
    if (raw) return res
    return res.status === 204 ? {} : res.json()
  }
  const query = (params) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
    return q.toString()
  }
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  // An event as the card names it: its title and date, read by Tessel for the person. An opaque
  // id says nothing about what they agree to change. The agent never sees this answer.
  async function eventNamed(args, key, english) {
    const id = shortened(args.id, 60)
    // Not readable now: its id, said as such, never the agent's words taken for its name.
    let value = t('main.apps.card.notRead', '{{id}} (could not be read)', { id })
    try {
      const e = await call(args.account, `${CALENDAR}/calendars/${calendarOf(args)}/events/${pathId(args.id, 'id')}?fields=summary,start,attendees(email),recurrence,recurringEventId`)
      const when = e.start?.dateTime || e.start?.date || ''
      const guests = Array.isArray(e.attendees) ? e.attendees.length : 0
      const repeats = (Array.isArray(e.recurrence) && e.recurrence.length) || e.recurringEventId
      value = [shortened(e.summary || id), shortened(when, 40), guests ? t('main.apps.card.guests', '{{count}} guests', { count: guests }) : '', repeats ? t('main.apps.card.repeats', 'repeating event') : ''].filter(Boolean).join(', ')
    } catch {
      // the value above
    }
    return t(key, english, { value })
  }

  return {
    gmail_search: {
      service: 'gmail',
      async run(args) {
        const q = text(args.query, 'query', { max: 1000 })
        const found = await call(args.account, `${GMAIL}/messages?${query({ q, maxResults: count(args.max, 10, 50) })}`)
        const ids = (found.messages || []).map((m) => m.id)
        if (!ids.length) return 'No message found.'
        const list = await Promise.all(ids.map((id) => call(args.account, `${GMAIL}/messages/${encodeURIComponent(id)}?${query({ format: 'metadata' })}&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)))
        return list.map(summary).join('\n')
      }
    },
    gmail_read: {
      service: 'gmail',
      async run(args) {
        return fullMessage(await call(args.account, `${GMAIL}/messages/${pathId(args.id, 'id')}?format=full`))
      }
    },
    gmail_read_thread: {
      service: 'gmail',
      async run(args) {
        const thread = await call(args.account, `${GMAIL}/threads/${pathId(args.id, 'id')}?format=full`)
        return (thread.messages || []).map(fullMessage).join('\n\n----\n\n')
      }
    },
    gmail_list_labels: {
      service: 'gmail',
      async run(args) {
        const found = await call(args.account, `${GMAIL}/labels`)
        return (found.labels || []).map((l) => `${l.id}: ${l.name}`).join('\n') || 'No label.'
      }
    },
    gmail_create_draft: {
      service: 'gmail',
      writes: true,
      // Saved, not sent: what the person sends is theirs to read in Gmail.
      describe: (args) =>
        [
          t('main.apps.card.to', 'To: {{value}}', { value: shownAddresses(args.to) }),
          args.cc ? t('main.apps.card.cc', 'Cc: {{value}}', { value: shownAddresses(args.cc) }) : '',
          t('main.apps.card.subject', 'Subject: {{value}}', { value: shortened(args.subject) })
        ]
          .filter(Boolean)
          .join('\n'),
      async run(args) {
        const to = text(args.to, 'to', { required: true, max: 2000 })
        const raw = draftMessage({ to, cc: text(args.cc, 'cc', { max: 2000 }), subject: text(args.subject, 'subject', { max: 1000 }), body: text(args.body, 'body', { max: 200000 }), inReplyTo: text(args.inReplyTo, 'inReplyTo', { max: 1000 }) })
        const threadId = text(args.threadId, 'threadId', { max: 200 })
        const made = await call(args.account, `${GMAIL}/drafts`, json('POST', { message: { raw, ...(threadId ? { threadId } : {}) } }))
        return `Draft saved in Gmail, not sent (id ${made.id}). The user sends it from Gmail.`
      }
    },
    calendar_list: {
      service: 'calendar',
      async run(args) {
        const found = await call(args.account, `${CALENDAR}/users/me/calendarList`)
        return (found.items || []).map((c) => `${c.id}: ${c.summary}${c.primary ? ' (main)' : ''} [${c.accessRole}]`).join('\n') || 'No calendar.'
      }
    },
    calendar_events: {
      service: 'calendar',
      async run(args) {
        const id = calendarOf(args)
        const found = await call(args.account, `${CALENDAR}/calendars/${id}/events?${query({ timeMin: text(args.from, 'from', { max: 40 }) || new Date().toISOString(), timeMax: text(args.to, 'to', { max: 40 }), q: text(args.query, 'query', { max: 500 }), maxResults: count(args.max, 20, 100), singleEvents: 'true', orderBy: 'startTime' })}`)
        const events = found.items || []
        return events.length ? events.map(eventLine).join('\n') : 'No event.'
      }
    },
    calendar_create_event: {
      service: 'calendar',
      writes: true,
      describe: describeEvent,
      // Someone else can then read it, what the agent wrote in it included: asked each time.
      eachTime: (args) => (Array.isArray(args.attendees) && args.attendees.length > 0) || !!otherCalendar(args),
      async run(args) {
        const body = eventBody(args)
        if (!body.summary || !body.start || !body.end) throw bad('Give "summary", "start" and "end".')
        const id = calendarOf(args)
        const made = await call(args.account, `${CALENDAR}/calendars/${id}/events`, json('POST', body))
        return `Event created (id ${made.id}): ${made.htmlLink || ''}`
      }
    },
    calendar_update_event: {
      service: 'calendar',
      writes: true,
      describe: async (args) => `${await eventNamed(args, 'main.apps.card.event', 'Event: {{value}}')}\n${describeEvent(args, { update: true })}`,
      // An event can have people on it who would see the change.
      eachTime: () => true,
      async run(args) {
        const id = calendarOf(args)
        const made = await call(args.account, `${CALENDAR}/calendars/${id}/events/${pathId(args.id, 'id')}`, json('PATCH', eventBody(args)))
        return `Event changed (id ${made.id}).`
      }
    },
    calendar_delete_event: {
      service: 'calendar',
      writes: true,
      describe: async (args) => {
        const other = otherCalendar(args)
        return [await eventNamed(args, 'main.apps.card.delete', 'Delete the event: {{value}}'), other ? t('main.apps.card.calendar', 'Calendar: {{value}}', { value: shortened(other) }) : ''].filter(Boolean).join('\n')
      },
      eachTime: () => true,
      async run(args) {
        const id = calendarOf(args)
        await call(args.account, `${CALENDAR}/calendars/${id}/events/${pathId(args.id, 'id')}`, { method: 'DELETE' })
        return 'Event deleted.'
      }
    },
    drive_search: {
      service: 'drive',
      async run(args) {
        // Drive's own query language, or plain words looked for in the files.
        const given = text(args.query, 'query', { max: 1000 })
        const q = args.raw === true ? given : given ? `fullText contains '${given.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false` : 'trashed = false'
        const found = await call(args.account, `${DRIVE}/files?${query({ q, pageSize: count(args.max, 20, 100), fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)', orderBy: given ? undefined : 'modifiedTime desc' })}`)
        const files = found.files || []
        return files.length ? files.map((f) => `id: ${f.id}\n${f.name} (${f.mimeType}${f.size ? `, ${f.size} bytes` : ''}, changed ${f.modifiedTime})\n${f.webViewLink || ''}\n`).join('\n') : 'No file found.'
      }
    },
    drive_read: {
      service: 'drive',
      async run(args) {
        const id = pathId(args.id, 'id')
        const meta = await call(args.account, `${DRIVE}/files/${id}?fields=id,name,mimeType,size,webViewLink`)
        const exportAs = Object.hasOwn(EXPORTS, meta.mimeType) ? EXPORTS[meta.mimeType] : null
        if (!exportAs && !READABLE.test(String(meta.mimeType))) return `"${meta.name}" (${meta.mimeType}) is not text: it cannot be read here. ${meta.webViewLink || ''}`
        if (!exportAs && Number(meta.size) > MAX_FILE_BYTES) return `"${meta.name}" is too big to read here (${meta.size} bytes). ${meta.webViewLink || ''}`
        const res = await call(args.account, exportAs ? `${DRIVE}/files/${id}/export?${query({ mimeType: exportAs })}` : `${DRIVE}/files/${id}?alt=media`, {}, { raw: true })
        const body = await res.text()
        return `${meta.name}\n\n${body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[the rest is cut]` : body}`
      }
    }
  }
}
