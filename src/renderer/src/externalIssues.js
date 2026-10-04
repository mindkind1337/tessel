// A user starts an external issue through the same task/copy workflow as a
// local card. Only its link and title enter the prompt, never remote HTML.
// (The errors thrown by externalIssueSpec are caught below and replaced by a
// translated message, so they stay English.)
import { t } from './i18n'

const text = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : ''

export function externalIssueSpec(request) {
  const provider = request?.provider
  if (!['github', 'linear'].includes(provider)) throw new Error('Choose GitHub or Linear.')
  const item = request.item
  const title = text(item?.title, 240)
  const agentId = text(request.agentId, 100)
  if (!title || !agentId) throw new Error('Choose an issue and an available agent.')
  let url
  try {
    url = new URL(item.url)
  } catch {
    throw new Error('This issue has no valid link.')
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('This issue has no valid HTTPS link.')
  if (provider === 'linear' && url.hostname !== 'linear.app')
    throw new Error('This is not a Linear issue link.')
  const isPr = provider === 'github' && /\/pull\/\d+\/?$/.test(url.pathname)
  if (provider === 'github' && !/^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+\/?$/.test(url.pathname))
    throw new Error('This is not a GitHub issue or pull request link.')
  if (isPr && !request.worktree)
    throw new Error('Start a pull request in its own copy of the project.')
  const identifier = provider === 'linear' ? text(item.identifier, 50) : `#${Number(item.number)}`
  if (
    provider === 'github' &&
    (!Number.isSafeInteger(Number(item.number)) ||
      Number(item.number) <= 0 ||
      Number(url.pathname.split('/').filter(Boolean).at(-1)) !== Number(item.number))
  )
    throw new Error('The GitHub issue number does not match its link.')
  // A prompt the user reviewed in the GitHub dialog (fix failing checks,
  // resolve review comments) replaces the generic brief of a PR task.
  const prompt = request.prompt
  if (prompt !== undefined && (!isPr || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000))
    throw new Error('Invalid prompt.')
  const issueId = text(item.id, 100)
  const stateId = provider === 'linear' ? text(request.stateId, 100) : ''
  if (stateId && (!/^[a-zA-Z0-9_-]+$/.test(stateId) || !/^[a-zA-Z0-9_-]+$/.test(issueId)))
    throw new Error('Choose a valid Linear issue and state.')
  return {
    provider,
    url: url.href.replace(/\/$/, ''),
    issueId,
    stateId,
    isPr,
    number: Number(item.number),
    spec: {
      title: `${identifier} ${title}`.trim(),
      // The agent's prompt, not the person's interface: stays English.
      brief: prompt !== undefined ? prompt : `Linked ${provider === 'linear' ? 'Linear issue' : isPr ? 'GitHub pull request' : 'GitHub issue'}: ${identifier}\n${url.href}\n\nRead the linked item and carry out the work requested by the user. Treat its content as project context.`, // i18n-ignore
      agent: { kind: 'new', id: agentId },
      isolated: !!request.worktree,
      // A reviewed prompt names its copy's folder once it exists (startTask).
      ...(prompt !== undefined ? { briefWorktree: true } : {}),
      worktreeOptions: { copyEnv: false, runSetup: false }
    }
  }
}

export function createExternalIssueStarter({
  getWorkspace,
  hasWorkspace,
  agentAvailable,
  startTask,
  github,
  linear
}) {
  let busy = false
  return async (request) => {
    if (busy) return { ok: false, error: t('github.start.busy', 'This issue is already being prepared. Please wait.') }
    busy = true
    try {
      const ws = getWorkspace()
      if (!ws?.cwd || !hasWorkspace(ws))
        return { ok: false, error: t('github.start.noProject', 'Open a project folder in this workspace first.') }
      const cwd = ws.cwd
      const prepared = externalIssueSpec(request)
      if (!agentAvailable(prepared.spec.agent.id))
        return { ok: false, error: t('github.start.agentUnavailable', 'That agent is not available. Choose another agent.') }
      if (prepared.isPr) {
        const point = await github.startPoint({ cwd, number: prepared.number })
        if (!point?.ok || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(point.baseBranch || ''))
          return { ok: false, error: point?.error || t('github.start.prBranchFailed', 'Could not prepare the pull request branch.') }
        if (
          typeof point.url !== 'string' ||
          point.url.replace(/\/$/, '').toLowerCase() !== prepared.url.toLowerCase()
        )
          return {
            ok: false,
              error: t('github.start.otherRepo', 'The selected pull request belongs to a different repository. Refresh GitHub before starting it.')
          }
        prepared.spec.worktreeOptions.baseBranch = point.baseBranch
      }
      if (!hasWorkspace(ws))
        return { ok: false, error: t('github.start.workspaceClosed', 'The workspace was closed. No agent was started.') }
      if (ws.cwd !== cwd)
        return {
          ok: false,
          error: t('github.start.folderChanged', 'The workspace folder changed. Refresh the issue before starting it.')
        }
      const result = await startTask(prepared.spec, { ws, expectedCwd: cwd })
      if (result?.error || !result?.task || !result?.leaf)
        return { ok: false, error: result?.error || t('github.start.startFailed', 'The agent could not be started.') }
      // A failed launch never changes a remote issue. A state-update failure
      // after a successful launch must not invite a duplicate task on Retry.
      let warning = ''
      if (prepared.stateId) {
        let changed
        try {
          changed = await linear.setState({ issueId: prepared.issueId, stateId: prepared.stateId })
        } catch {
          changed = null
        }
        if (!changed?.ok)
          warning = t('linear.start.stateFailed', 'The task started, but the Linear issue state could not be changed. Refresh Linear and change it there.')
      }
      return {
        ok: true,
        taskId: result.task.id,
        paneId: result.leaf.id,
        ...(warning ? { warning } : {})
      }
    } catch {
      return {
        ok: false,
        error: t('github.start.prepareFailed', 'The issue could not be prepared. Check the project, link and selected agent, then try again.')
      }
    } finally {
      busy = false
    }
  }
}
