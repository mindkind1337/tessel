import { t } from '../i18n'
import { AppError, bad, count, createCall, cut, fileText, htmlToText, jsonBody as json, MAX_FILE_BYTES, pathId, query, shortened, shownAddresses, shownLine, text } from './shared'

// tessel_apps: Outlook mail, Outlook Calendar and OneDrive, through Microsoft Graph. One fixed host:
// every call is about "me", so no tenant or address comes from anywhere.
//
// No mail leaves through these tools. Mail.ReadWrite cannot send (Mail.Send can, and is not asked),
// and Outlook mails guests as soon as an event with guests is created, changed or deleted, with no
// way to turn that off. So these tools make no event with guests, and leave one that has guests alone.
const GRAPH = 'https://graph.microsoft.com/v1.0'
const NO_GUESTS = 'Outlook emails an event\'s guests as soon as it is created, changed or deleted, and Tessel has no tool that sends mail. Make the event without guests, and the user adds them in Outlook.'
const HAS_GUESTS = 'This event has guests, and Outlook would email them about this. Tessel has no tool that sends mail: the user does it in Outlook.'
const TEXT_BODY = { prefer: 'outlook.body-content-type="text"' }
const READABLE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|csv|octet-stream)$)/
const WHO = 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isRead'
const EVENT_FIELDS = 'id,subject,start,end,location,attendees,bodyPreview,isAllDay,seriesMasterId,type,recurrence,webLink'

const addressOf = (r) => r?.emailAddress?.address || r?.emailAddress?.name || '?'
const peopleOf = (list) => (Array.isArray(list) ? list.map(addressOf).join(', ') : '')
const firstLines = (m) => [`id: ${m.id}  conversation: ${m.conversationId || '?'}`, `Date: ${m.receivedDateTime || '?'}`, `From: ${addressOf(m.from)}`, `To: ${peopleOf(m.toRecipients) || '?'}`]

// What goes on a draft: "Name <a@b.c>" or a@b.c, a list of them. Anything else is refused rather than
// sent on: the card shows what was asked, and this is what goes.
function recipients(value, name) {
  const given = text(value, name, { max: 2000 })
  if (!given) return []
  return given
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const inside = /<([^<>]+)>$/.exec(part)
      const address = (inside ? inside[1] : part).trim()
      if (!/^[^\s@]+@[^\s@]+$/.test(address)) throw bad(`"${name}" has something that is not an address.`)
      return { emailAddress: { address } }
    })
}

const calendarOf = (args) => {
  const named = text(args.calendar, 'calendar', { max: 500 })
  return named ? `/me/calendars/${pathId(named, 'calendar')}` : '/me'
}
const otherCalendar = (args) => (typeof args.calendar === 'string' && args.calendar.trim() ? args.calendar.trim() : null)

// A time as Outlook takes it: a date and time, and a zone apart.
function timeOf(value, name, zone) {
  const given = text(value, name, { max: 40 })
  if (!given) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(given)) return { allDay: true, at: { dateTime: `${given}T00:00:00`, timeZone: zone || 'UTC' } }
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(given)) {
    const at = new Date(given)
    if (Number.isNaN(at.getTime())) throw bad(`"${name}" is not a time.`)
    return { at: { dateTime: at.toISOString().replace(/\.\d+Z$/, ''), timeZone: 'UTC' } }
  }
  return { at: { dateTime: given, timeZone: zone || 'UTC' } }
}
function eventBody(args) {
  if (args.attendees !== undefined) throw bad(NO_GUESTS)
  const zone = text(args.timeZone, 'timeZone', { max: 80 })
  const body = {}
  if (args.summary !== undefined) body.subject = text(args.summary, 'summary', { max: 1000 })
  if (args.description !== undefined) body.body = { contentType: 'text', content: text(args.description, 'description', { max: 8000 }) }
  if (args.location !== undefined) body.location = { displayName: text(args.location, 'location', { max: 1000 }) }
  const start = timeOf(args.start, 'start', zone)
  const end = timeOf(args.end, 'end', zone)
  if (start) body.start = start.at
  if (end) body.end = end.at
  if (start?.allDay && end?.allDay) body.isAllDay = true
  return body
}
const eventLine = (e) => {
  const when = (x) => (x?.dateTime ? `${x.dateTime}${x.timeZone ? ` (${x.timeZone})` : ''}` : '?')
  return `id: ${e.id}\n${when(e.start)} to ${when(e.end)}: ${e.subject || '(no title)'}${e.location?.displayName ? `\nWhere: ${e.location.displayName}` : ''}${e.attendees?.length ? `\nWith: ${peopleOf(e.attendees)}` : ''}${e.bodyPreview ? `\n${e.bodyPreview}` : ''}\n`
}
// What a change to an event is, for the card that asks.
function describeEvent(args) {
  const lines = []
  const other = otherCalendar(args)
  if (other) lines.push(t('main.apps.card.calendar', 'Calendar: {{value}}', { value: shortened(other) }))
  if (args.summary !== undefined) lines.push(t('main.apps.card.title', 'Title: {{value}}', { value: shortened(args.summary) }))
  if (args.start !== undefined || args.end !== undefined) lines.push(t('main.apps.card.when', 'When: {{start}} to {{end}}', { start: shortened(args.start, 40), end: shortened(args.end, 40) }))
  if (args.timeZone) lines.push(t('main.apps.card.timeZone', 'Time zone: {{value}}', { value: shortened(args.timeZone, 80) }))
  if (args.location !== undefined) lines.push(t('main.apps.card.where', 'Where: {{value}}', { value: shortened(args.location) }))
  if (args.description !== undefined) lines.push(t('main.apps.card.description', 'Description: {{value}}', { value: shortened(args.description) }))
  return lines.join('\n')
}

export function createMicrosoftTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'microsoft', name: 'Microsoft', hosts: ['graph.microsoft.com'], fetchFn })
  const eventUrl = (args) => `${GRAPH}${calendarOf(args)}/events/${pathId(args.id, 'id')}`
  const readEvent = (args) => call(args.account, `${eventUrl(args)}?${query({ $select: 'subject,start,attendees,recurrence,seriesMasterId,type' })}`)
  // An event as the card names it, read by Tessel for the person. The agent never sees this answer.
  async function eventNamed(args, key, english) {
    const id = shortened(args.id, 60)
    let value = t('main.apps.card.notRead', '{{id}} (could not be read)', { id })
    try {
      const e = await readEvent(args)
      const repeats = e.recurrence || e.seriesMasterId || e.type === 'seriesMaster'
      value = [shortened(e.subject || id), shortened(e.start?.dateTime, 40), e.attendees?.length ? t('main.apps.card.guests', '{{count}} guests', { count: e.attendees.length }) : '', repeats ? t('main.apps.card.repeats', 'repeating event') : ''].filter(Boolean).join(', ')
    } catch {
      // the value above
    }
    return t(key, english, { value })
  }
  async function refuseWithGuests(args) {
    const e = await readEvent(args)
    if (Array.isArray(e.attendees) && e.attendees.length) throw new AppError('has_guests', HAS_GUESTS)
  }

  return {
    outlook_mail_search: {
      service: 'outlook_mail',
      async run(args) {
        const words = text(args.query, 'query', { max: 1000 })
        const params = { $top: count(args.max, 10, 50), $select: WHO }
        // Outlook's search words, in the quotes it wants them in.
        if (words) params.$search = `"${words.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        else params.$orderby = 'receivedDateTime desc'
        const found = await call(args.account, `${GRAPH}/me/messages?${query(params)}`)
        const list = found.value || []
        return list.length ? list.map((m) => [...firstLines(m), `Subject: ${m.subject || '(none)'}`, ...(m.bodyPreview ? [`Snippet: ${m.bodyPreview}`] : []), ''].join('\n')).join('\n') : 'No message found.'
      }
    },
    outlook_mail_read: {
      service: 'outlook_mail',
      async run(args) {
        const m = await call(args.account, `${GRAPH}/me/messages/${pathId(args.id, 'id')}?${query({ $select: `${WHO},body,hasAttachments`, $expand: 'attachments($select=name,contentType,size)' })}`, { headers: TEXT_BODY })
        const body = String(m.body?.contentType).toLowerCase() === 'html' ? htmlToText(m.body?.content) : String(m.body?.content ?? '')
        const attachments = (m.attachments || []).map((a) => `${shownLine(a.name)} (${a.contentType || 'file'}, ${Number(a.size) || 0} bytes)`)
        return [...firstLines(m), ...(m.ccRecipients?.length ? [`Cc: ${peopleOf(m.ccRecipients)}`] : []), `Subject: ${m.subject || '(none)'}`, ...(attachments.length ? [`Attachments: ${attachments.join('; ')}`] : []), '', cut(body)].join('\n')
      }
    },
    outlook_mail_create_draft: {
      service: 'outlook_mail',
      writes: true,
      // Saved, not sent: what the person sends is theirs to read in Outlook.
      describe: (args) =>
        [
          t('main.apps.card.to', 'To: {{value}}', { value: shownAddresses(args.to) }),
          args.cc ? t('main.apps.card.cc', 'Cc: {{value}}', { value: shownAddresses(args.cc) }) : '',
          t('main.apps.card.subject', 'Subject: {{value}}', { value: shortened(args.subject) })
        ]
          .filter(Boolean)
          .join('\n'),
      async run(args) {
        const toRecipients = recipients(args.to, 'to')
        if (!toRecipients.length) throw bad('Give "to".')
        const made = await call(args.account, `${GRAPH}/me/messages`, json('POST', { subject: text(args.subject, 'subject', { max: 1000 }), body: { contentType: 'text', content: text(args.body, 'body', { max: 200000 }) }, toRecipients, ccRecipients: recipients(args.cc, 'cc') }))
        return `Draft saved in Outlook, not sent (id ${made.id}). The user sends it from Outlook.`
      }
    },
    outlook_calendar_list: {
      service: 'outlook_calendar',
      async run(args) {
        const found = await call(args.account, `${GRAPH}/me/calendars?${query({ $select: 'id,name,isDefaultCalendar,canEdit' })}`)
        return (found.value || []).map((c) => `${c.id}: ${c.name}${c.isDefaultCalendar ? ' (main)' : ''}${c.canEdit === false ? ' [read only]' : ''}`).join('\n') || 'No calendar.'
      }
    },
    outlook_calendar_events: {
      service: 'outlook_calendar',
      async run(args) {
        const from = text(args.from, 'from', { max: 40 }) || new Date().toISOString()
        if (Number.isNaN(Date.parse(from))) throw bad('"from" is not a time.')
        const until = text(args.to, 'to', { max: 40 }) || new Date(Date.parse(from) + 30 * 24 * 3600 * 1000).toISOString()
        const found = await call(args.account, `${GRAPH}${calendarOf(args)}/calendarView?${query({ startDateTime: from, endDateTime: until, $top: count(args.max, 20, 100), $orderby: 'start/dateTime', $select: EVENT_FIELDS })}`, { headers: TEXT_BODY })
        const events = found.value || []
        return events.length ? events.map(eventLine).join('\n') : 'No event.'
      }
    },
    outlook_calendar_create_event: {
      service: 'outlook_calendar',
      writes: true,
      describe: describeEvent,
      // Someone else can then read it, what the agent wrote in it included: asked each time.
      eachTime: (args) => !!otherCalendar(args),
      async run(args) {
        const body = eventBody(args)
        if (!body.subject || !body.start || !body.end) throw bad('Give "summary", "start" and "end".')
        const made = await call(args.account, `${GRAPH}${calendarOf(args)}/events`, json('POST', body))
        return `Event created (id ${made.id}): ${made.webLink || ''}`
      }
    },
    outlook_calendar_update_event: {
      service: 'outlook_calendar',
      writes: true,
      describe: async (args) => `${await eventNamed(args, 'main.apps.card.event', 'Event: {{value}}')}\n${describeEvent(args)}`,
      eachTime: () => true,
      async run(args) {
        const body = eventBody(args)
        await refuseWithGuests(args)
        const made = await call(args.account, eventUrl(args), json('PATCH', body))
        return `Event changed (id ${made.id}).`
      }
    },
    outlook_calendar_delete_event: {
      service: 'outlook_calendar',
      writes: true,
      describe: async (args) => {
        const other = otherCalendar(args)
        return [await eventNamed(args, 'main.apps.card.delete', 'Delete the event: {{value}}'), other ? t('main.apps.card.calendar', 'Calendar: {{value}}', { value: shortened(other) }) : ''].filter(Boolean).join('\n')
      },
      eachTime: () => true,
      async run(args) {
        await refuseWithGuests(args)
        await call(args.account, eventUrl(args), { method: 'DELETE' })
        return 'Event deleted.'
      }
    },
    onedrive_search: {
      service: 'onedrive',
      async run(args) {
        const words = text(args.query, 'query', { required: true, max: 500 })
        const found = await call(args.account, `${GRAPH}/me/drive/root/search(q='${encodeURIComponent(words.replace(/'/g, "''"))}')?${query({ $top: count(args.max, 20, 100), $select: 'id,name,size,file,folder,lastModifiedDateTime,webUrl' })}`)
        const files = found.value || []
        return files.length ? files.map((f) => `id: ${f.id}\n${f.name} (${f.folder ? 'folder' : f.file?.mimeType || 'file'}${f.size ? `, ${f.size} bytes` : ''}, changed ${f.lastModifiedDateTime})\n${f.webUrl || ''}\n`).join('\n') : 'No file found.'
      }
    },
    onedrive_read: {
      service: 'onedrive',
      async run(args) {
        const id = pathId(args.id, 'id')
        const meta = await call(args.account, `${GRAPH}/me/drive/items/${id}?${query({ $select: 'id,name,size,file,folder,webUrl' })}`)
        const link = meta.webUrl || ''
        if (meta.folder) return `"${meta.name}" is a folder: it cannot be read here. ${link}`
        const type = String(meta.file?.mimeType || '')
        if (!READABLE.test(type)) return `"${meta.name}" (${type || 'file'}) is not text: it cannot be read here. ${link}`
        if (Number(meta.size) > MAX_FILE_BYTES) return `"${meta.name}" is too big to read here (${meta.size} bytes). ${link}`
        // OneDrive answers with a one-time address on another host: the token does not go there.
        const got = await fileText(await call(args.account, `${GRAPH}/me/drive/items/${id}/content`, {}, { raw: true }))
        if (!got) return `"${meta.name}" is not text: it cannot be read here. ${link}`
        return `${meta.name}\n\n${cut(got.text)}`
      }
    }
  }
}
