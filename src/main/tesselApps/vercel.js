import { AppError, count, createCall, cut, pathId, query, shownLine, text } from './shared'

// tessel_apps: Vercel, read only: projects, deployments and build logs. Nothing here deploys, and the
// app asks only for read permissions. One fixed host, and a team's id comes only from Vercel's own
// list: what an agent gives is matched against it, and only ever goes in a query.
const API = 'https://api.vercel.com'
const when = (value) => {
  const at = new Date(value)
  return value && !Number.isNaN(at.getTime()) ? at.toISOString() : '?'
}
const deploymentLine = (d) => `id: ${d.uid || d.id}\n${d.name || ''} [${d.state || d.readyState || '?'}${d.target ? `, ${d.target}` : ''}] ${d.url ? `https://${d.url}` : ''}\nCreated ${when(d.created || d.createdAt)}${d.meta?.githubCommitMessage ? `\nCommit: ${d.meta.githubCommitMessage}` : ''}\n`

export function createVercelTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'vercel', name: 'Vercel', hosts: ['api.vercel.com'], fetchFn })
  // No team named: the personal account.
  async function teamOf(args) {
    const named = text(args.team, 'team', { max: 200 })
    if (!named) return undefined
    const teams = (await call(args.account, `${API}/v2/teams?${query({ limit: 100 })}`)).teams || []
    const found = teams.find((x) => x && (x.id === named || x.slug === named))
    if (!found) throw new AppError('unknown_team', 'This connection does not reach that team. It reaches the ones named below.', teams.map((x) => shownLine(x?.slug)).join(', ') || 'no team')
    return found.id
  }
  return {
    vercel_list_teams: {
      service: 'vercel',
      async run(args) {
        const found = await call(args.account, `${API}/v2/teams?${query({ limit: 100 })}`)
        return (found.teams || []).map((x) => `${x.id}: ${x.name} (${x.slug})`).join('\n') || 'No team: projects are in the personal account.'
      }
    },
    vercel_list_projects: {
      service: 'vercel',
      async run(args) {
        const found = await call(args.account, `${API}/v10/projects?${query({ teamId: await teamOf(args), search: text(args.query, 'query', { max: 200 }), limit: count(args.max, 20, 100) })}`)
        return (found.projects || []).map((p) => `id: ${p.id}\n${p.name}${p.framework ? ` (${p.framework})` : ''}\n`).join('\n') || 'No project.'
      }
    },
    vercel_list_deployments: {
      service: 'vercel',
      async run(args) {
        const found = await call(args.account, `${API}/v7/deployments?${query({ teamId: await teamOf(args), projectId: text(args.project, 'project', { max: 200 }), state: text(args.state, 'state', { max: 40 }), target: text(args.target, 'target', { max: 40 }), limit: count(args.max, 20, 100) })}`)
        return (found.deployments || []).map(deploymentLine).join('\n') || 'No deployment.'
      }
    },
    vercel_read_deployment: {
      service: 'vercel',
      async run(args) {
        const d = await call(args.account, `${API}/v13/deployments/${pathId(args.id, 'id')}?${query({ teamId: await teamOf(args) })}`)
        return `${deploymentLine(d)}${d.errorMessage ? `Error: ${d.errorMessage}\n` : ''}`
      }
    },
    vercel_logs: {
      service: 'vercel',
      async run(args) {
        // The build's log, as a list and not a stream: it does not wait for what comes next.
        const found = await call(args.account, `${API}/v3/deployments/${pathId(args.id, 'id')}/events?${query({ teamId: await teamOf(args), limit: count(args.max, 200, 1000), direction: 'backward', follow: 0 })}`)
        const lines = (Array.isArray(found) ? found : []).map((e) => `${when(e.created)} ${e.text ?? e.payload?.text ?? ''}`.trim())
        return lines.length ? cut(lines.reverse().join('\n')) : 'No log.'
      }
    }
  }
}
