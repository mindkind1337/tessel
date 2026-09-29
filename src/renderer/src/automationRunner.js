// Starting and following the runs of scheduled automations in the window.
// The scheduler (src/main/automations.js) asks for a run; this opens the
// agent's pane the normal way (the user's settings for that agent: Yolo or
// not, its arguments, its account, the automation's model and effort), with
// its first prompt on its command line (nothing is typed into the agent),
// puts a card for it on the project's board, and reports how it went: after
// Orca's renderer dispatch (src/renderer/src/hooks/automation-dispatch-
// handler.ts, MIT, Copyright (c) 2026 Lovecast Inc.): dispatched when the
// agent is launched, completed when its turn ends, failed when it cannot
// start, its agent never shows up or exits, or its pane goes away first.
//
// Safety held here:
// - The run is acknowledged at once; right before its pane opens the window
//   asks whether it is still wanted (it may have timed out meanwhile), and a
//   pane opened for a run that already ended is closed again: never two runs
//   of one automation, never more than the cap.
// - It runs only with the permissions you confirmed (Yolo, arguments): if
//   they changed since, the run is skipped until you confirm again.
// - At most a few panes and copies left open by previous runs of one
//   automation; a copy made for a run that could not start is removed.
//
// deps (App.vue): findWorkspace(automation), agentFor(agentId),
// shellFor(ws), permissionSig(agentId), openPanesOf(automationId),
// copiesOf(automationId), createWorktree(ws, title), removeCopy(worktree),
// runStatus(runId), openPane({ ws, agent, worktree, launchOptions,
// automationLaunch }), createCard(card), updateCard(id, patch),
// removeCard(id), cardOf(id), findLeaf(id), closePane(id), screenProbe(id)
// -> { busy, ready, approval, limit } | null, agentProbe(id)
// -> { started: true | false | null, exited } (null: no way to tell, as on a
// remote host whose agent sends no hooks: only the scheduler's 24-hour limit
// applies), report(result), notify(note), automationById(id), now().
import { t } from './i18n'
import {
  automationLaunchArgs,
  AGENT_START_TIMEOUT_MS,
  MAX_OPEN_PANES_PER_AUTOMATION,
  MAX_COPIES_PER_AUTOMATION
} from '../../shared/automations'

// Is a run's agent there? -> { started: true | false | null, exited, screen }.
// - An agent with status hooks (Claude Code, Codex) that report: their signs,
//   their "closed" when it exits, and they tell when its turn ends.
// - The same agents where no hooks report (on a remote host: nothing comes
//   back over ssh; in WSL; hooks not set up): screen = true, the screen
//   tells when it works and when its prompt is back (see check below).
// - On a remote host or in WSL the program cannot be seen from Windows:
//   started null (the screen decides).
// - Otherwise: its program still running under the pane's shell (the
//   process tree, not the screen: the echo of the launch line or a shell
//   prompt is not an agent), looked at once the launch line had 2 seconds.
//   { leaf, managed, state, busy, waiting, now, runningWork() -> { running, unknown } }
export const LAUNCH_SETTLE_MS = 2000
export async function probeRunAgent({ leaf, managed = false, state = null, busy = false, waiting = false, now = Date.now(), runningWork }) {
  if (!leaf) return { started: null, exited: false, screen: false }
  const hooks = !!(managed && state && state.hookSeen && !leaf.remoteHostId)
  const screen = managed && !hooks
  if (managed) {
    if (hooks && state.state === 'closed') return { started: true, exited: true, screen }
    if (hooks || busy || waiting) return { started: true, exited: false, screen }
  }
  // A remote host or WSL: out of sight of Windows' process tree.
  if (leaf.remoteHostId || leaf.shellId === 'wsl') return { started: null, exited: false, screen }
  if (now - (leaf.launchedAt || 0) < LAUNCH_SETTLE_MS) return { started: false, exited: false, screen }
  let work
  try {
    work = await runningWork()
  } catch {
    work = { unknown: true }
  }
  if (!work || work.unknown) return { started: null, exited: false, screen }
  return { started: !!work.running, exited: !work.running, screen }
}

// On screen, a turn is over once its prompt has been back (and nothing works)
// at two checks in a row, and at least this long after the launch unless it
// was seen working first.
export const SCREEN_DONE_AFTER_MS = 60 * 1000

export function createAutomationRunner(deps) {
  const now = deps.now || Date.now
  // paneId -> { runId, automationId, name, taskId, worktree, after, askedApproval, dispatchedAt, started }
  const following = new Map()
  // Automations already told about changed permissions (once per session).
  const toldPermissions = new Set()

  const report = (result) => Promise.resolve(deps.report(result)).catch(() => null)
  function fail(run, status, errorCode, error = null) {
    return report({ runId: run.id, status, errorCode, error })
  }
  async function dropCopy(worktree) {
    if (!worktree) return
    try {
      await deps.removeCopy(worktree)
    } catch {
      // kept; the board has no card for it: said in the log by App
    }
  }

  function runTitle(automation, run) {
    return t('automations.run.title', '{{name}} · run {{number}}', { name: automation.name, number: run.runNumber || 1 })
  }

  async function dispatch({ automation, run, promptFile = null, promptDir = null, remoteFile = null } = {}) {
    if (!automation || !run) return
    // Taken: the scheduler no longer times it out for want of an answer.
    await report({ runId: run.id, status: 'ack' })
    const ws = deps.findWorkspace(automation)
    if (!ws) return fail(run, 'skipped_unavailable', 'project-gone')
    const agent = deps.agentFor(automation.agentId)
    if (!agent) return fail(run, 'dispatch_failed', 'agent-unavailable')
    // Only with the permissions you confirmed.
    if (!automation.confirmedSig || automation.confirmedSig !== deps.permissionSig(automation.agentId)) {
      if (!toldPermissions.has(automation.id)) {
        toldPermissions.add(automation.id)
        deps.notify({
          kind: 'attention',
          title: t('automations.notify.permsTitle', 'Automation "{{name}}" needs your confirmation again', { name: automation.name }),
          body: t('automations.notify.permsBody', "Its agent's permissions changed since you confirmed it (Settings > Agents). It is skipped until you confirm it in Settings > Automations."),
          paneId: null
        })
      }
      return fail(run, 'skipped_unavailable', 'permissions-changed')
    }
    if (deps.openPanesOf(automation.id) >= MAX_OPEN_PANES_PER_AUTOMATION) return fail(run, 'skipped_unavailable', 'too-many-panes')
    const isolated = automation.isolation === 'worktree' && !automation.remote
    if (isolated && deps.copiesOf(automation.id) >= MAX_COPIES_PER_AUTOMATION) return fail(run, 'skipped_unavailable', 'too-many-copies')
    const automationLaunch = automation.remote ? { remoteFile } : { promptFile, promptDir }
    if (!automationLaunchArgs(automation.agentId, { ...automationLaunch, shellId: deps.shellFor(ws) })) return fail(run, 'dispatch_failed', 'unsafe-path')
    const title = runTitle(automation, run)
    let worktree = null
    if (isolated) {
      let res
      try {
        res = await deps.createWorktree(ws, automation.name)
      } catch (err) {
        res = { error: (err && err.message) || '' }
      }
      if (!res || res.error || !res.worktree) return fail(run, 'dispatch_failed', 'copy-failed', (res && res.error) || '')
      worktree = res.worktree
    }
    // Still wanted? (A long copy or setup script may have outlived it.)
    let status = null
    try {
      status = await deps.runStatus(run.id)
    } catch {
      status = null
    }
    if (status !== 'dispatching') {
      await dropCopy(worktree)
      return
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
    if (!leaf) {
      await dropCopy(worktree)
      return fail(run, 'dispatch_failed', 'pane-failed')
    }
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
      askedApproval: false,
      dispatchedAt: now(),
      started: false
    })
    const res = await report({ runId: run.id, status: 'dispatched', paneId: leaf.id, wsId: ws.id, taskId, branch: worktree ? worktree.branch : null })
    // The run ended meanwhile (timed out): this pane must not run it.
    if (res && res.run && res.run.status !== 'dispatched') {
      following.delete(leaf.id)
      deps.closePane(leaf.id)
      if (taskId) deps.removeCard(taskId)
      await dropCopy(worktree)
    }
  }

  // The agent in a run's pane ended its turn: the run is done.
  function turnDone(paneId) {
    const f = following.get(paneId)
    if (!f) return false
    following.delete(paneId)
    report({ runId: f.runId, status: 'completed' })
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

  function end(paneId, f, errorCode) {
    following.delete(paneId)
    report({ runId: f.runId, status: 'dispatch_failed', errorCode })
    if (f.taskId && deps.cardOf(f.taskId)?.column === 'doing') deps.updateCard(f.taskId, { column: 'todo' })
  }

  // Runs whose pane closed, whose agent exited, or whose agent never showed
  // up: those runs failed (their pane, if any, stays for you to look at).
  let checking = false
  async function check() {
    if (checking) return
    checking = true
    try {
      for (const [paneId, f] of [...following]) {
        if (!deps.findLeaf(paneId)) {
          end(paneId, f, 'pane-closed')
          continue
        }
        let probe
        try {
          probe = (await deps.agentProbe(paneId)) || {}
        } catch {
          probe = {}
        }
        // Ended meanwhile (its turn, its pane).
        if (following.get(paneId) !== f) continue
        if (probe.started === true) f.started = true
        if (probe.exited && f.started) {
          end(paneId, f, 'agent-exited')
          continue
        }
        // Where no hooks report: what the screen shows.
        let seen = false
        if (probe.started === null || probe.screen) {
          let obs = null
          try {
            obs = deps.screenProbe ? deps.screenProbe(paneId) : null
          } catch {
            obs = null
          }
          if (obs) {
            seen = true
            if (obs.busy || obs.approval || obs.limit) {
              f.started = true
              f.sawBusy = f.sawBusy || !!obs.busy
              f.readySeen = 0
            } else if (obs.ready) {
              f.started = true
              f.readySeen = (f.readySeen || 0) + 1
              if (probe.screen && f.readySeen >= 2 && (f.sawBusy || now() - f.dispatchedAt >= SCREEN_DONE_AFTER_MS)) {
                turnDone(paneId)
                continue
              }
            } else f.readySeen = 0
          }
        }
        const unknown = probe.started === null && !seen
        if (!unknown && probe.started !== true && !f.started && now() - f.dispatchedAt > AGENT_START_TIMEOUT_MS) end(paneId, f, 'agent-no-start')
      }
    } finally {
      checking = false
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
        askedApproval: false,
        dispatchedAt: typeof r.dispatchedAt === 'number' ? r.dispatchedAt : now(),
        started: false
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
