import { t } from '../i18n'
import { AppError, bad, count, createCall, cut, htmlToText, jsonBody as json, notifiedLine, pathId, publishedCard, publishedText, publishedTitle, query, shortened, shownLine, text } from './shared'

// tessel_apps: Jira and Confluence. One fixed host: api.atlassian.com, with the site's id in the path.
// That id only ever comes from Atlassian's own list of the sites this token can reach: what an agent
// gives is matched against that list, and is never put in an address. So no agent can make a token go
// to another host, or to a site the person did not allow.
//
// Writing asks only for Atlassian's narrower scopes, which do not include deleting an issue: the sets
// its OpenAPI gives for creating an issue and adding a comment (tessel-server: src/connect.js).
const API = 'https://api.atlassian.com'
const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISSUE_FIELDS = 'summary,status,assignee,issuetype,priority,updated,project'
const KEY = /^[A-Za-z][A-Za-z0-9_]*-\d{1,12}$/

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}
const siteLabel = (s) => (hostOf(s.url) ? `${s.name} (${hostOf(s.url)})` : s.name)
const person = (u) => u?.displayName || 'no one'
const issueLine = (i) => `${i.key} [${i.fields?.status?.name || '?'}] ${i.fields?.summary || ''}\n${i.fields?.issuetype?.name || '?'} in ${i.fields?.project?.key || '?'}, assigned to ${person(i.fields?.assignee)}, changed ${i.fields?.updated || '?'}\n`
const keyOf = (args) => {
  const key = text(args.key, 'key', { required: true, max: 100 })
  if (!KEY.test(key)) throw bad('"key" is an issue\'s key, like ABC-123.')
  return key
}

export function createAtlassianTools({ connections, fetchFn = fetch }) {
  const wordsOf = (reason) => {
    if (Array.isArray(reason?.errorMessages) && reason.errorMessages.length) return reason.errorMessages.join(' ')
    if (reason?.errors && typeof reason.errors === 'object') return Object.values(reason.errors).join(' ')
    return reason?.message || ''
  }
  const call = createCall({ connections, provider: 'atlassian', name: 'Atlassian', hosts: ['api.atlassian.com'], fetchFn, wordsOf })
  // The site to use: the one named, or the only one. -> { id, name, url, base }
  async function siteOf(args, product) {
    const answer = await call(args.account, `${API}/oauth/token/accessible-resources`)
    const sites = (Array.isArray(answer) ? answer : []).filter((s) => s && SITE_ID.test(String(s.id)) && Array.isArray(s.scopes) && s.scopes.some((x) => String(x).includes(product)))
    const names = sites.map((s) => `"${shownLine(s.name)}"`).join(', ')
    if (!sites.length) throw new AppError('not_found', `No ${product === 'jira' ? 'Jira' : 'Confluence'} site was given access. The user chooses one when connecting, in Tessel: Settings > Connections.`)
    const named = text(args.site, 'site', { max: 300 }).trim().toLowerCase()
    const found = named ? sites.filter((s) => String(s.name).toLowerCase() === named || hostOf(s.url) === named) : sites
    if (named && !found.length) throw new AppError('unknown_site', 'That site is not one this connection can reach. It can reach the sites named below.', names)
    if (found.length > 1) throw new AppError('which_site', 'Several sites can be reached, named below. Ask the user which one, then pass it as "site".', names)
    return { ...found[0], base: `${API}/ex/${product}/${found[0].id}` }
  }
  // Where it goes, for the card: the site as Atlassian names it. The agent never sees this answer.
  async function siteLine(args, product) {
    let value = t('main.apps.card.notRead', '{{id}} (could not be read)', { id: shortened(args.site || product, 120) })
    try {
      value = shortened(siteLabel(await siteOf(args, product)))
    } catch {
      // the value above
    }
    return t('main.apps.card.site', 'Site: {{value}}', { value })
  }

  return {
    jira_search: {
      service: 'jira',
      async run(args) {
        const site = await siteOf(args, 'jira')
        const found = await call(args.account, `${site.base}/rest/api/2/search/jql?${query({ jql: text(args.jql, 'jql', { required: true, max: 4000 }), maxResults: count(args.max, 20, 50), fields: ISSUE_FIELDS })}`)
        const list = (found.issues || []).map(issueLine).join('\n')
        return list ? `${list}${found.nextPageToken ? '\n[more found: ask for a narrower search]' : ''}` : 'No issue found.'
      }
    },
    jira_read: {
      service: 'jira',
      async run(args) {
        const site = await siteOf(args, 'jira')
        const i = await call(args.account, `${site.base}/rest/api/2/issue/${pathId(keyOf(args), 'key')}?${query({ fields: `${ISSUE_FIELDS},description,reporter,labels,comment` })}`)
        const listed = i.fields?.comment?.comments || []
        const comments = listed.map((c) => `${person(c.author)}, ${c.created}:\n${cut(c.body || '')}`).join('\n\n')
        const more = Number(i.fields?.comment?.total) > listed.length ? `\n\n[${Number(i.fields.comment.total) - listed.length} more comments]` : ''
        return `${issueLine(i)}Reported by ${person(i.fields?.reporter)}\n${i.fields?.labels?.length ? `Labels: ${i.fields.labels.join(', ')}\n` : ''}\n${cut(i.fields?.description || '(no text)')}${comments ? `\n\nComments:\n\n${comments}` : ''}${more}`
      }
    },
    jira_create: {
      service: 'jira',
      writes: true,
      describe: async (args) =>
        publishedCard({
          before: [await siteLine(args, 'jira'), notifiedLine(), t('main.apps.card.project', 'Project: {{value}}', { value: shortened(args.project, 60) }), t('main.apps.card.issueType', 'Type: {{value}}', { value: shortened(args.type || 'Task', 60) })],
          title: args.summary,
          body: args.description
        }),
      // A project's issues are read by its people, who are told of them: asked each time.
      eachTime: () => true,
      async run(args) {
        const site = await siteOf(args, 'jira')
        const made = await call(args.account, `${site.base}/rest/api/2/issue`, json('POST', { fields: { project: { key: text(args.project, 'project', { required: true, max: 100 }) }, issuetype: { name: text(args.type, 'type', { max: 100 }) || 'Task' }, summary: publishedTitle(args.summary, 'summary', { max: 255 }), ...(args.description ? { description: publishedText(args.description, 'description') } : {}) } }))
        return `Issue created: ${made.key || made.id}`
      }
    },
    jira_comment: {
      service: 'jira',
      writes: true,
      describe: async (args) => {
        const key = shortened(args.key, 60)
        let on = t('main.apps.card.notRead', '{{id}} (could not be read)', { id: key })
        try {
          const site = await siteOf(args, 'jira')
          const i = await call(args.account, `${site.base}/rest/api/2/issue/${pathId(keyOf(args), 'key')}?${query({ fields: 'summary' })}`)
          on = `${shortened(i.key, 30)}: ${shortened(i.fields?.summary)}`
        } catch {
          // the value above
        }
        return publishedCard({ before: [await siteLine(args, 'jira'), t('main.apps.card.commentOn', 'Comment on: {{value}}', { value: on }), notifiedLine()], body: args.body })
      },
      eachTime: () => true,
      async run(args) {
        const site = await siteOf(args, 'jira')
        await call(args.account, `${site.base}/rest/api/2/issue/${pathId(keyOf(args), 'key')}/comment`, json('POST', { body: publishedText(args.body, 'body', { required: true }) }))
        return `Comment added to ${args.key}.`
      }
    },
    confluence_search: {
      service: 'confluence',
      async run(args) {
        const site = await siteOf(args, 'confluence')
        const given = text(args.query, 'query', { required: true, max: 2000 })
        // Confluence's own query language, or plain words looked for in the pages.
        const cql = args.raw === true ? given : `text ~ "${given.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        const found = await call(args.account, `${site.base}/wiki/rest/api/search?${query({ cql, limit: count(args.max, 20, 50) })}`)
        const items = found.results || []
        const more = Number(found.totalSize) > items.length ? `\n[${Number(found.totalSize) - items.length} more found: ask for a narrower search]` : ''
        return items.length ? `${items.map((r) => `id: ${r.content?.id || '?'}\n${r.title || r.content?.title || '(no title)'} (changed ${r.lastModified || '?'})\n${r.excerpt ? `${htmlToText(r.excerpt)}\n` : ''}`).join('\n')}${more}` : 'No page found.'
      }
    },
    confluence_read: {
      service: 'confluence',
      async run(args) {
        const site = await siteOf(args, 'confluence')
        const page = await call(args.account, `${site.base}/wiki/api/v2/pages/${pathId(args.id, 'id')}?${query({ 'body-format': 'storage' })}`)
        return `${page.title || '(no title)'}\n\n${cut(htmlToText(page.body?.storage?.value || ''))}`
      }
    }
  }
}
