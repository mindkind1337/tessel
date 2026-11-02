import { t } from '../i18n'
import { AppError, bad, count, createCall, cut, fileText, fitted, htmlToText, jsonBody as json, MAX_FILE_BYTES, moreWhen, oneLine, pathId, publishable, query, reachLines, shortened, shownAddress, shownAddresses, shownLine, shownList, text } from './shared'

export { AppError, htmlToText }

// tessel_apps: Gmail, Calendar and Drive, called straight from this computer with the person's
// own token (connections.js). What comes back is the person's own data, in full; what a mail or
// a file says is someone else's words, and the agent is told so (index.js).
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const DRIVE = 'https://www.googleapis.com/drive/v3'

const calendarOf = (args) => pathId(text(args.calendar, 'calendar', { max: 500 }) || 'primary', 'calendar')
// Words of a header that are not plain ASCII (RFC 2047).
const headerWords = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`)
const decodeBody = (data) => Buffer.from(String(data || ''), 'base64url').toString('utf8')

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
    cut(body)
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
  if (args.summary !== undefined) body.summary = shownLine(text(args.summary, 'summary', { max: 1000 }))
  if (args.description !== undefined) body.description = publishable(text(args.description, 'description', { max: 8000 }))
  if (args.location !== undefined) body.location = shownLine(text(args.location, 'location', { max: 1000 }))
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

// A calendar other than the person's own: someone else may be able to read what goes in it.
const otherCalendar = (args) => {
  const named = typeof args.calendar === 'string' ? args.calendar.trim() : ''
  return named && named !== 'primary' ? named : null
}
// What a change to an event is, for the card that asks: who could read it first. When someone else
// can read it, all of it is on the card, with what in it reaches further.
function describeEvent(args, { update = false, calendarLine = '' } = {}) {
  const lines = []
  const other = otherCalendar(args)
  const goesOut = update || !!other || (Array.isArray(args.attendees) && args.attendees.length > 0)
  const description = args.description === undefined ? '' : publishable(args.description)
  const show = goesOut ? shownLine : shortened
  if (calendarLine) lines.push(calendarLine)
  // Everyone who would get it: leaving some out would read as the whole list.
  if (Array.isArray(args.attendees) && args.attendees.length) {
    // On an update this list replaces the guests the event has.
    if (update) lines.push(t('main.apps.card.guestsBecome', 'Guests after this change: {{value}}', { value: shownList(args.attendees, Infinity) }))
    else lines.push(t('main.apps.card.invites', 'Invites: {{value}}', { value: shownList(args.attendees, Infinity) }))
  }
  else if (update && Array.isArray(args.attendees)) lines.push(t('main.apps.card.removesGuests', 'Removes all guests'))
  if (goesOut) lines.push(...reachLines(fitted(`${shownLine(args.summary)}\n${shownLine(args.location)}\n${description}`)))
  if (args.summary !== undefined) lines.push(t('main.apps.card.title', 'Title: {{value}}', { value: show(args.summary) }))
  if (args.start !== undefined || args.end !== undefined) lines.push(t('main.apps.card.when', 'When: {{start}} to {{end}}', { start: shortened(args.start, 40), end: shortened(args.end, 40) }))
  if (args.timeZone) lines.push(t('main.apps.card.timeZone', 'Time zone: {{value}}', { value: shortened(args.timeZone, 80) }))
  if (args.location !== undefined) lines.push(t('main.apps.card.where', 'Where: {{value}}', { value: show(args.location) }))
  if (args.description !== undefined) {
    if (goesOut) lines.push(t('main.apps.card.descriptionHeading', 'Description:'), description)
    else lines.push(t('main.apps.card.description', 'Description: {{value}}', { value: shortened(args.description) }))
  }
  return goesOut ? fitted(lines.join('\n')) : lines.join('\n')
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
  // Google's refusals say why under error.message.
  const call = createCall({ connections, provider: 'google', name: 'Google', hosts: ['gmail.googleapis.com', 'www.googleapis.com'], fetchFn })
  // Another calendar, as the person's list names it, with whose it is: an id says nothing to a person,
  // and one not on their list is said to be unknown. The agent never sees this answer.
  async function calendarLine(args) {
    const other = otherCalendar(args)
    if (!other) return ''
    let value = t('main.apps.card.notRead', '{{id}} (could not be read)', { id: shortened(other, 120) })
    try {
      const c = await call(args.account, `${CALENDAR}/users/me/calendarList/${pathId(other, 'calendar')}?fields=summary,summaryOverride,dataOwner`)
      const name = shortened(c.summaryOverride || c.summary)
      if (name) value = c.dataOwner ? t('main.apps.card.calendarOwned', '{{name}}, owned by {{owner}}', { name, owner: shownAddress(c.dataOwner) }) : name
    } catch {
      // the value above
    }
    return t('main.apps.card.calendar', 'Calendar: {{value}}', { value })
  }
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
        return `${list.map(summary).join('\n')}${moreWhen(found.nextPageToken)}`
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
          t('main.apps.card.to', 'To: {{value}}', { value: shownAddresses(args.to, Infinity) }),
          args.cc ? t('main.apps.card.cc', 'Cc: {{value}}', { value: shownAddresses(args.cc, Infinity) }) : '',
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
        const list = (found.items || []).map((c) => `${c.id}: ${c.summary}${c.primary ? ' (main)' : ''} [${c.accessRole}]`).join('\n')
        return list ? `${list}${moreWhen(found.nextPageToken)}` : 'No calendar.'
      }
    },
    calendar_events: {
      service: 'calendar',
      async run(args) {
        const id = calendarOf(args)
        const found = await call(args.account, `${CALENDAR}/calendars/${id}/events?${query({ timeMin: text(args.from, 'from', { max: 40 }) || new Date().toISOString(), timeMax: text(args.to, 'to', { max: 40 }), q: text(args.query, 'query', { max: 500 }), maxResults: count(args.max, 20, 100), singleEvents: 'true', orderBy: 'startTime' })}`)
        const events = found.items || []
        return events.length ? `${events.map(eventLine).join('\n')}${moreWhen(found.nextPageToken)}` : 'No event.'
      }
    },
    calendar_create_event: {
      service: 'calendar',
      writes: true,
      describe: async (args) => describeEvent(args, { calendarLine: await calendarLine(args) }),
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
      describe: async (args) => fitted(`${await eventNamed(args, 'main.apps.card.event', 'Event: {{value}}')}\n${describeEvent(args, { update: true, calendarLine: await calendarLine(args) })}`),
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
      describe: async (args) => [await eventNamed(args, 'main.apps.card.delete', 'Delete the event: {{value}}'), await calendarLine(args)].filter(Boolean).join('\n'),
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
        const found = await call(args.account, `${DRIVE}/files?${query({ q, pageSize: count(args.max, 20, 100), fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)', orderBy: given ? undefined : 'modifiedTime desc' })}`)
        const files = found.files || []
        return files.length ? `${files.map((f) => `id: ${f.id}\n${f.name} (${f.mimeType}${f.size ? `, ${f.size} bytes` : ''}, changed ${f.modifiedTime})\n${f.webViewLink || ''}\n`).join('\n')}${moreWhen(found.nextPageToken)}` : 'No file found.'
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
        const got = await fileText(await call(args.account, exportAs ? `${DRIVE}/files/${id}/export?${query({ mimeType: exportAs })}` : `${DRIVE}/files/${id}?alt=media`, {}, { raw: true }))
        if (!got) return `"${meta.name}" is not text: it cannot be read here. ${meta.webViewLink || ''}`
        return `${meta.name}\n\n${cut(got.text)}`
      }
    }
  }
}
