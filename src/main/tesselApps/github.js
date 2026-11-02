import { t } from '../i18n'
import { bad, count, createCall, cut, jsonBody as json, notifiedLine, pathId, publishedCard, publishedText, publishedTitle, query, shortened, text } from './shared'

// tessel_apps: GitHub, through a GitHub App: the token can do what the app's registration allows and
// the person can do, on repositories the app is installed on and public ones. One fixed host. There
// is no tool that deletes a repository, merges, pushes or starts a workflow, and the app's permissions
// do not allow them either.
const API = 'https://api.github.com'
const HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Tessel' }
const MAX_FILE_LIST = 100
const MAX_COMMENTS = 50

// "owner/name": two segments, each one only that.
function repoOf(args) {
  const given = text(args.repo, 'repo', { required: true, max: 200 }).trim()
  const parts = given.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw bad('"repo" is owner/name.')
  return { path: `${pathId(parts[0], 'repo')}/${pathId(parts[1], 'repo')}`, shown: given }
}
function numberOf(args) {
  const given = String(args.number ?? '')
  if (!/^[1-9]\d{0,9}$/.test(given)) throw bad('"number" is the number of an issue or a pull request.')
  return given
}
// A file's path: each segment on its own, never one that means the folder above.
function filePath(value) {
  const given = text(value, 'path', { max: 4000 })
  return given
    .split('/')
    .filter(Boolean)
    .map((part) => pathId(part, 'path'))
    .join('/')
}
const person = (u) => u?.login || '?'
const issueLine = (i) => `${i.repository_url ? `${i.repository_url.split('/').slice(-2).join('/')}` : ''}#${i.number} [${i.state}] ${i.title}\nBy ${person(i.user)}, changed ${i.updated_at}\n${i.html_url || ''}\n`
const issueText = (i) => [`#${i.number} [${i.state}] ${i.title}`, `By ${person(i.user)}, changed ${i.updated_at}`, ...(i.labels?.length ? [`Labels: ${i.labels.map((l) => l?.name).filter(Boolean).join(', ')}`] : []), i.html_url || '', '', cut(i.body || '(no text)')].join('\n')
// Whatever is left out is said: an agent must not take the start of a list for all of it.
const moreOf = (total, shown, what) => (Number(total) > shown ? `[${Number(total) - shown} more ${what}]` : '')
function commentsText(list, total) {
  const given = Array.isArray(list) ? list : []
  const more = moreOf(total, given.length, 'comments')
  const lines = given.map((c) => `${person(c.user)}, ${c.created_at}:\n${cut(c.body || '')}`)
  return `${given.length ? `\n\nComments:\n\n${lines.join('\n\n')}` : ''}${more ? `\n\n${more}` : ''}`
}
const foundText = (found, lines) => {
  const items = found.items || []
  const more = moreOf(found.total_count, items.length, 'found: ask for a narrower search')
  return items.length ? `${items.map(lines).join('\n')}${more ? `\n${more}` : ''}` : 'Nothing found.'
}
// GitHub answers 404 for a private repository the app is not installed on.
const hintOf = (status) =>
  status === 404
    ? 'If it is a private repository, the user may need to install Tessel\'s GitHub app on it: https://github.com/settings/installations'
    : status === 403
      ? 'The user may need to install Tessel\'s GitHub app on this repository (https://github.com/settings/installations). Tessel does not ask GitHub for the right to comment on pull requests, only on issues.'
      : ''

export function createGitHubTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'github', name: 'GitHub', hosts: ['api.github.com'], fetchFn, headers: HEADERS, hintOf })
  // Who can read what goes there, read by Tessel for the person. The agent never sees this answer.
  async function repoNamed(args) {
    const shown = shortened(args.repo, 120)
    let value = t('main.apps.card.notRead', '{{id}} (could not be read)', { id: shown })
    try {
      const r = await call(args.account, `${API}/repos/${repoOf(args).path}`)
      value = r.private ? t('main.apps.card.privateRepo', '{{value}} (private: whoever has access can read this)', { value: shown }) : t('main.apps.card.publicRepo', '{{value}} (public: anyone can read this)', { value: shown })
    } catch {
      // the value above
    }
    return t('main.apps.card.repository', 'Repository: {{value}}', { value })
  }

  return {
    github_search: {
      service: 'github',
      async run(args) {
        const words = text(args.query, 'query', { required: true, max: 1000 })
        const per_page = count(args.max, 20, 50)
        const kind = text(args.kind, 'kind', { max: 20 }) || 'issues'
        if (kind === 'repos') {
          const found = await call(args.account, `${API}/search/repositories?${query({ q: words, per_page })}`)
          return foundText(found, (r) => `${r.full_name}${r.private ? ' (private)' : ''}: ${r.description || ''}\n${r.html_url}\n`)
        }
        if (kind === 'code') {
          const found = await call(args.account, `${API}/search/code?${query({ q: words, per_page })}`)
          return foundText(found, (c) => `${c.repository?.full_name}: ${c.path}\n${c.html_url}\n`)
        }
        if (kind !== 'issues' && kind !== 'prs') throw bad('"kind" is issues, prs, repos or code.')
        // A GitHub App's token has to say which of the two.
        const q = /\bis:(issue|pr|pull-request)\b/i.test(words) ? words : `${words} ${kind === 'prs' ? 'is:pr' : 'is:issue'}`
        const found = await call(args.account, `${API}/search/issues?${query({ q, per_page })}`)
        return foundText(found, issueLine)
      }
    },
    github_list_repos: {
      service: 'github',
      async run(args) {
        const found = await call(args.account, `${API}/user/repos?${query({ sort: 'updated', per_page: count(args.max, 30, 100) })}`)
        return (Array.isArray(found) ? found : []).map((r) => `${r.full_name}${r.private ? ' (private)' : ''}: ${r.description || ''}`).join('\n') || 'No repository.'
      }
    },
    github_read_repo: {
      service: 'github',
      async run(args) {
        const r = await call(args.account, `${API}/repos/${repoOf(args).path}`)
        return [`${r.full_name}${r.private ? ' (private)' : ''}`, r.description || '', `Default branch: ${r.default_branch}`, `Language: ${r.language || '?'}, ${r.open_issues_count ?? '?'} open issues, changed ${r.pushed_at}`, r.html_url].join('\n')
      }
    },
    github_read_issue: {
      service: 'github',
      async run(args) {
        const repo = repoOf(args)
        const number = numberOf(args)
        const issue = await call(args.account, `${API}/repos/${repo.path}/issues/${number}`)
        const comments = await call(args.account, `${API}/repos/${repo.path}/issues/${number}/comments?${query({ per_page: MAX_COMMENTS })}`)
        return `${issueText(issue)}${commentsText(comments, issue.comments)}`
      }
    },
    github_read_pr: {
      service: 'github',
      async run(args) {
        const repo = repoOf(args)
        const number = numberOf(args)
        const pr = await call(args.account, `${API}/repos/${repo.path}/pulls/${number}`)
        const files = await call(args.account, `${API}/repos/${repo.path}/pulls/${number}/files?${query({ per_page: MAX_FILE_LIST })}`)
        const comments = await call(args.account, `${API}/repos/${repo.path}/issues/${number}/comments?${query({ per_page: MAX_COMMENTS })}`)
        const listed = Array.isArray(files) ? files : []
        const changes = listed.map((f) => `${f.status} ${f.filename} (+${f.additions} -${f.deletions})${f.patch ? `\n${f.patch}` : '\n[GitHub gives no diff for this file]'}`).join('\n\n')
        const moreFiles = moreOf(pr.changed_files, listed.length, 'files')
        return `${issueText(pr)}\n\nFrom ${pr.head?.label || '?'} into ${pr.base?.label || '?'}${pr.merged_at ? `, merged ${pr.merged_at}` : ''}\n\nFiles:\n\n${cut(changes)}${moreFiles ? `\n\n${moreFiles}` : ''}${commentsText(comments, pr.comments)}`
      }
    },
    github_read_file: {
      service: 'github',
      async run(args) {
        const repo = repoOf(args)
        const found = await call(args.account, `${API}/repos/${repo.path}/contents/${filePath(args.path)}?${query({ ref: text(args.ref, 'ref', { max: 250 }) })}`)
        if (Array.isArray(found)) return found.map((f) => `${f.type === 'dir' ? `${f.path}/` : f.path}`).join('\n') || 'An empty folder.'
        if (found.type !== 'file') return `"${found.path}" is a ${found.type}: it cannot be read here. ${found.html_url || ''}`
        if (found.encoding !== 'base64') return `"${found.path}" is too big to read here (${found.size} bytes). ${found.html_url || ''}`
        const bytes = Buffer.from(String(found.content), 'base64')
        if (bytes.subarray(0, 8192).includes(0)) return `"${found.path}" is not text: it cannot be read here. ${found.html_url || ''}`
        return `${found.path}\n\n${cut(bytes.toString('utf8'))}`
      }
    },
    github_create_issue: {
      service: 'github',
      writes: true,
      describe: async (args) => publishedCard({ before: [await repoNamed(args), notifiedLine()], title: args.title, body: args.body }),
      // Whoever can read the repository reads this, and is told of it: asked each time.
      eachTime: () => true,
      async run(args) {
        const repo = repoOf(args)
        const made = await call(args.account, `${API}/repos/${repo.path}/issues`, json('POST', { title: publishedTitle(args.title, 'title', { max: 256 }), body: publishedText(args.body, 'body') }))
        return `Issue created: #${made.number} ${made.html_url || ''}`
      }
    },
    github_comment: {
      service: 'github',
      writes: true,
      describe: async (args) => {
        const number = String(args.number ?? '')
        let on = t('main.apps.card.notRead', '{{id}} (could not be read)', { id: `#${shortened(number, 12)}` })
        try {
          const issue = await call(args.account, `${API}/repos/${repoOf(args).path}/issues/${numberOf(args)}`)
          on = `#${issue.number}: ${shortened(issue.title)}`
        } catch {
          // the value above
        }
        return publishedCard({ before: [await repoNamed(args), t('main.apps.card.commentOn', 'Comment on: {{value}}', { value: on }), notifiedLine()], body: args.body })
      },
      eachTime: () => true,
      async run(args) {
        const repo = repoOf(args)
        const made = await call(args.account, `${API}/repos/${repo.path}/issues/${numberOf(args)}/comments`, json('POST', { body: publishedText(args.body, 'body', { required: true }) }))
        return `Comment added: ${made.html_url || ''}`
      }
    }
  }
}
