import { t } from '../i18n'
import { AppError, count, createCall, cut, jsonBody as json, moreWhen, notifiedLine, publishedCard, publishedText, publishedTitle, shortened, shownLine, text } from './shared'

// tessel_apps: Linear, through its one GraphQL address. What an agent gives goes in variables, so it
// cannot change a query. The token's scopes read, and create issues and comments.
const GRAPHQL = 'https://api.linear.app/graphql'
const person = (u) => u?.name || u?.displayName || 'no one'
const issueLine = (i) => `${i.identifier} [${i.state?.name || '?'}] ${i.title}\nAssigned to ${person(i.assignee)}, changed ${i.updatedAt}\nid: ${i.id}\n${i.url || ''}\n`
const ISSUE_FIELDS = 'id identifier title url updatedAt state { name } assignee { name }'

export function createLinearTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'linear', name: 'Linear', hosts: ['api.linear.app'], fetchFn, wordsOf: (reason) => reason?.errors?.[0]?.message || '' })
  async function ask(account, query, variables) {
    const got = await call(account, GRAPHQL, json('POST', { query, variables }))
    // Linear says a refusal in an answer that is otherwise fine.
    if (Array.isArray(got.errors) && got.errors.length) throw new AppError('failed', 'Linear refused this.', shownLine(got.errors[0]?.message).slice(0, 400))
    return got.data || {}
  }
  return {
    linear_search: {
      service: 'linear',
      async run(args) {
        const found = await ask(args.account, `query Search($term: String!, $first: Int) { searchIssues(term: $term, first: $first) { pageInfo { hasNextPage } nodes { ${ISSUE_FIELDS} } } }`, { term: text(args.query, 'query', { required: true, max: 500 }), first: count(args.max, 20, 50) })
        const list = (found.searchIssues?.nodes || []).map(issueLine).join('\n')
        return list ? `${list}${found.searchIssues?.pageInfo?.hasNextPage ? '\n[more found: ask for a narrower search]' : ''}` : 'No issue found.'
      }
    },
    linear_read_issue: {
      service: 'linear',
      async run(args) {
        const found = await ask(args.account, `query Read($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description team { key name } comments(first: 50) { pageInfo { hasNextPage } nodes { body createdAt user { name } } } } }`, { id: text(args.id, 'id', { required: true, max: 100 }) })
        const i = found.issue
        if (!i) throw new AppError('not_found', 'No such issue.')
        const comments = (i.comments?.nodes || []).map((c) => `${person(c.user)}, ${c.createdAt}:\n${cut(c.body || '')}`).join('\n\n')
        return `${issueLine(i)}Team: ${i.team?.name || '?'}\n\n${cut(i.description || '(no text)')}${comments ? `\n\nComments:\n\n${comments}` : ''}${i.comments?.pageInfo?.hasNextPage ? '\n\n[more comments than these]' : ''}`
      }
    },
    linear_list_teams: {
      service: 'linear',
      async run(args) {
        const found = await ask(args.account, 'query Teams { teams(first: 100) { pageInfo { hasNextPage } nodes { id key name } } }', {})
        const list = (found.teams?.nodes || []).map((x) => `${x.id}: ${x.key} ${x.name}`).join('\n')
        return list ? `${list}${moreWhen(found.teams?.pageInfo?.hasNextPage)}` : 'No team.'
      }
    },
    linear_create_issue: {
      service: 'linear',
      writes: true,
      describe: async (args) => {
        const id = shortened(args.team, 60)
        let team = t('main.apps.card.notRead', '{{id}} (could not be read)', { id })
        try {
          const found = await ask(args.account, 'query Team($id: String!) { team(id: $id) { name key } }', { id: text(args.team, 'team', { required: true, max: 100 }) })
          if (found.team) team = shortened(`${found.team.key} ${found.team.name}`)
        } catch {
          // the value above
        }
        return publishedCard({ before: [t('main.apps.card.team', 'Team: {{value}}', { value: team }), notifiedLine()], title: args.title, body: args.description })
      },
      // A team's issues are read by the team, which is told of them: asked each time.
      eachTime: () => true,
      async run(args) {
        const found = await ask(args.account, 'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }', { input: { teamId: text(args.team, 'team', { required: true, max: 100 }), title: publishedTitle(args.title, 'title'), description: publishedText(args.description, 'description') || undefined } })
        if (!found.issueCreate?.success) throw new AppError('failed', 'Linear did not create the issue.')
        return `Issue created: ${found.issueCreate.issue?.identifier || ''} ${found.issueCreate.issue?.url || ''}`
      }
    },
    linear_comment: {
      service: 'linear',
      writes: true,
      describe: async (args) => {
        const id = shortened(args.id, 60)
        let on = t('main.apps.card.notRead', '{{id}} (could not be read)', { id })
        try {
          const found = await ask(args.account, 'query Named($id: String!) { issue(id: $id) { identifier title } }', { id: text(args.id, 'id', { required: true, max: 100 }) })
          if (found.issue) on = `${shortened(found.issue.identifier, 30)}: ${shortened(found.issue.title)}`
        } catch {
          // the value above
        }
        return publishedCard({ before: [t('main.apps.card.commentOn', 'Comment on: {{value}}', { value: on }), notifiedLine()], body: args.body })
      },
      eachTime: () => true,
      async run(args) {
        const found = await ask(args.account, 'mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }', { input: { issueId: text(args.id, 'id', { required: true, max: 100 }), body: publishedText(args.body, 'body', { required: true }) } })
        if (!found.commentCreate?.success) throw new AppError('failed', 'Linear did not add the comment.')
        return `Comment added: ${found.commentCreate.comment?.url || ''}`
      }
    }
  }
}
