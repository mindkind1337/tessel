// Starting and following the runs of scheduled automations in the window.
// The scheduler (src/main/automations.js) asks for a run; this opens the
// agent's pane the normal way (the user's settings for that agent: Yolo or
// not, its arguments, its account, the automation's model and effort), with
// its first prompt on its command line (nothing is typed into the agent),
// puts a card for it on the project's board, and reports how it went: after
// Orca's renderer dispatch (src/renderer/src/hooks/automation-dispatch-
// handler.ts, MIT, Copyright (c) 2026 Lovecast Inc.): dispatched when the
// agent is launched, completed when its turn ends, failed when it cannot
// start or its pane goes away first.
//
// deps (App.vue): findWorkspace(automation), agentFor(agentId),
// shellFor(ws), createWorktree(ws, title), openPane({ ws, agent, worktree,
// launchOptions, automationLaunch }), createCard(card), updateCard(id,
// patch), findLeaf(id), closePane(id), report(result), notify(note),
// automationById(id), cardOf(id).
import { t } from './i18n'
import { automationLaunchArgs } from '../../shared/automations'

export function createAutomationRunner(deps) {
  // paneId -> { runId, automationId, name, taskId, worktree, after, askedApproval }
  const following = new Map()

  function fail(run, status, errorCode, error = null) {
    return deps.report({ runId: run.id, status, errorCode, error })
  }

  function runTitle(automation, run) {
    return t('automations.run.title', '{{name}} · run {{number}}', { name: automation.name, number: run.runNumber || 1 })
  }

  async function dispatch({ automation, run, promptFile = null, promptDir = null } = {}) {
    if (!automation || !run) return
    const ws = deps.findWorkspace(automation)
    if (!ws) return fail(run, 'skipped_unavailable', 'project-gone')
    const agent = deps.agentFor(automation.agentId)
    if (!agent) return fail(run, 'dispatch_failed', 'agent-unavailable')
    const automationLaunch = automation.remote ? { inlinePrompt: automation.prompt } : { promptFile, promptDir }
    if (!automationLaunchArgs(automation.agentId, { ...automationLaunch, shellId: deps.shellFor(ws) })) return fail(run, 'dispatch_failed', 'unsafe-path')
    const title = runTitle(automation, run)
    let worktree = null
    if (automation.isolation === 'worktree' && !automation.remote) {
      let res
      try {
        res = await deps.createWorktree(ws, automation.name)
      } catch (err) {
        res = { error: (err && err.message) || '' }
      }
      if (!res || res.error || !res.worktree) return fail(run, 'dispatch_failed', 'copy-failed', (res && res.error) || '')
      worktree = res.worktree
    }
    let leaf = null
    try {
      leaf = await deps.openPane({
        ws,
        agent,
        worktree,
        launchOptions: automation.model ? { model: automation.model, effort: automation.effort || null } : null,
        automationLaunch
      })
    } catch {
      leaf = null
    }
    if (!leaf) return fail(run, 'dispatch_failed', 'pane-failed', worktree ? worktree.path : null)
    const taskId = deps.createCard({
      title,
      brief: automation.prompt,
      wsId: ws.id,
      paneId: leaf.id,
      worktree,
      automation: { id: automation.id, runId: run.id }
    })
    following.set(leaf.id, {
      runId: run.id,
      automationId: automation.id,
      name: automation.name,
      taskId,
      worktree,
      after: automation.after || { notify: true, closePane: false },
      askedApproval: false
    })
    await deps.report({ runId: run.id, status: 'dispatched', paneId: leaf.id, wsId: ws.id, taskId, branch: worktree ? worktree.branch : null })
  }

  // The agent in a run's pane ended its turn: the run is done.
  function turnDone(paneId) {
    const f = following.get(paneId)
    if (!f) return false
    following.delete(paneId)
    deps.report({ runId: f.runId, status: 'completed' })
    // Its own copy: the work waits in Review, as for any task.
    if (f.taskId) deps.updateCard(f.taskId, { column: f.worktree ? 'review' : 'done' })
    if (f.after.notify !== false)
      deps.notify({
        kind: 'done',
        title: t('automations.notify.doneTitle', 'Automation "{{name}}" finished', { name: f.name }),
        body: f.worktree
          ? t('automations.notify.doneReview', 'Its work waits for your review on branch {{branch}}.', { branch: f.worktree.branch })
          : t('automations.notify.doneBody', 'See its card on the board.'),
        paneId: f.after.closePane ? null : paneId
      })
    if (f.after.closePane) deps.closePane(paneId)
    return true
  }

  // Waiting for an approval (the agent runs without Yolo): said once.
  function approval(paneId, on) {
    const f = following.get(paneId)
    if (!f || !on || f.askedApproval) return
    f.askedApproval = true
    deps.notify({
      kind: 'attention',
      title: t('automations.notify.approvalTitle', 'Automation "{{name}}" waits for your approval', { name: f.name }),
      body: t('automations.notify.approvalBody', 'The run stops until you answer in its pane.'),
      paneId
    })
  }

  // Panes closed before their agent finished: those runs failed.
  function check() {
    for (const [paneId, f] of [...following]) {
      if (deps.findLeaf(paneId)) continue
      following.delete(paneId)
      deps.report({ runId: f.runId, status: 'dispatch_failed', errorCode: 'pane-closed' })
      if (f.taskId && deps.cardOf(f.taskId)?.column === 'doing') deps.updateCard(f.taskId, { column: 'todo' })
    }
  }

  // After Tessel restarts: the runs whose pane is still open are followed again.
  function resume(active = []) {
    for (const r of Array.isArray(active) ? active : []) {
      if (!r || !r.paneId || following.has(r.paneId)) continue
      const a = deps.automationById(r.automationId)
      const card = r.taskId ? deps.cardOf(r.taskId) : null
      following.set(r.paneId, {
        runId: r.id,
        automationId: r.automationId,
        name: a ? a.name : '',
        taskId: r.taskId || null,
        worktree: card && card.worktree ? card.worktree : null,
        after: (a && a.after) || { notify: true, closePane: false },
        askedApproval: false
      })
    }
  }

  return {
    dispatch,
    turnDone,
    approval,
    check,
    resume,
    runOfPane: (paneId) => following.get(paneId) || null,
    following
  }
}
