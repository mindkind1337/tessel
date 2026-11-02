import { AppError, count, createCall, cut, pathId, query, shownLine, text } from './shared'

// tessel_apps: Sentry, read only: the token's scopes read organizations, projects, issues and events,
// for the one organization the person picked. One fixed host, and which organization comes only from
// Sentry's own list: what an agent gives is matched against it, and is never put in an address.
const API = 'https://sentry.io/api/0'
const MAX_FRAMES = 30
const issueLine = (i) => `id: ${i.id}  ${i.shortId || ''}\n[${i.level || '?'}, ${i.status || '?'}] ${i.title}\n${i.count ?? '?'} events, ${i.userCount ?? '?'} users, last seen ${i.lastSeen || '?'}, in ${i.project?.slug || '?'}\n${i.permalink || ''}\n`
const frameLine = (f) => `  ${f.filename || f.module || '?'}:${f.lineNo ?? '?'} in ${f.function || '?'}`
// What an event says: its words and where it happened, nearest the failure last, as Sentry lists them.
function eventText(e) {
  const out = [`id: ${e.eventID || e.id}`, e.title || '', `When: ${e.dateCreated || '?'}`, ...(e.culprit ? [`Where: ${e.culprit}`] : []), ...(e.message ? [e.message] : [])]
  for (const entry of Array.isArray(e.entries) ? e.entries : []) {
    if (entry?.type !== 'exception') continue
    for (const v of entry.data?.values || []) {
      out.push(`${v.type || 'Error'}: ${v.value || ''}`)
      const frames = v.stacktrace?.frames || []
      if (frames.length > MAX_FRAMES) out.push(`  [${frames.length - MAX_FRAMES} earlier frames]`)
      out.push(...frames.slice(-MAX_FRAMES).map(frameLine))
    }
  }
  const tags = (e.tags || []).map((x) => `${x.key}=${x.value}`).join(', ')
  if (tags) out.push(`Tags: ${tags}`)
  return cut(out.filter(Boolean).join('\n'))
}

export function createSentryTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'sentry', name: 'Sentry', hosts: ['sentry.io'], fetchFn })
  // The one named, or the only one, as Sentry says.
  async function organizationOf(args) {
    const named = text(args.organization, 'organization', { max: 200 })
    const found = await call(args.account, `${API}/organizations/`)
    const slugs = (Array.isArray(found) ? found : []).map((o) => o?.slug).filter((s) => typeof s === 'string' && s)
    const list = slugs.map(shownLine).join(', ')
    if (!slugs.length) throw new AppError('not_found', 'This connection reaches no organization.')
    if (named && !slugs.includes(named)) throw new AppError('unknown_organization', 'This connection does not reach that organization. It reaches the ones named below.', list)
    if (!named && slugs.length > 1) throw new AppError('which_organization', 'Several organizations can be reached, named below. Pass one as "organization".', list)
    return pathId(named || slugs[0], 'organization')
  }
  return {
    sentry_list_projects: {
      service: 'sentry',
      async run(args) {
        const found = await call(args.account, `${API}/organizations/${await organizationOf(args)}/projects/`)
        return (Array.isArray(found) ? found : []).map((p) => `${p.slug}: ${p.name}${p.platform ? ` (${p.platform})` : ''}`).join('\n') || 'No project.'
      }
    },
    sentry_issues: {
      service: 'sentry',
      async run(args) {
        const found = await call(args.account, `${API}/organizations/${await organizationOf(args)}/issues/?${query({ query: text(args.query, 'query', { max: 1000 }), limit: count(args.max, 20, 100), statsPeriod: text(args.period, 'period', { max: 10 }), project: text(args.project, 'project', { max: 100 }) })}`)
        return (Array.isArray(found) ? found : []).map(issueLine).join('\n') || 'No issue found.'
      }
    },
    sentry_read_issue: {
      service: 'sentry',
      async run(args) {
        return issueLine(await call(args.account, `${API}/organizations/${await organizationOf(args)}/issues/${pathId(args.id, 'id')}/`))
      }
    },
    sentry_issue_events: {
      service: 'sentry',
      async run(args) {
        const found = await call(args.account, `${API}/organizations/${await organizationOf(args)}/issues/${pathId(args.id, 'id')}/events/?${query({ limit: count(args.max, 20, 100) })}`)
        return (Array.isArray(found) ? found : []).map((e) => `id: ${e.eventID || e.id}\n${e.title || ''} (${e.dateCreated || '?'})\n`).join('\n') || 'No event.'
      }
    },
    sentry_read_event: {
      service: 'sentry',
      async run(args) {
        const event = text(args.event, 'event', { max: 200 }) || 'latest'
        return eventText(await call(args.account, `${API}/organizations/${await organizationOf(args)}/issues/${pathId(args.id, 'id')}/events/${pathId(event, 'event')}/`))
      }
    }
  }
}
