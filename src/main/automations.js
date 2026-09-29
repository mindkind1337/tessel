// Scheduled automations, the scheduler (main process). After Orca's
// AutomationService (MIT, Copyright (c) 2026 Lovecast Inc.:
// src/main/automations/service.ts, automation-run-writer.ts,
// dispatch-refusal.ts, src/main/persistence/scheduling-automations/): a tick
// every minute finds the automations that are due, skips an occurrence found
// past its missed-run grace, and asks the window to start the run (the window
// opens the agent's pane, src/renderer/src/automationRunner.js), which then
// reports how it went.
//
// Tessel's rules on top: runs happen only while Tessel is open (no Windows
// scheduler; an occurrence missed while it was closed runs once when it
// opens, within the grace); never two runs of the same automation at once;
// at most `maxConcurrent` runs at a time, the others wait their turn; an
// automation runs unattended only once you confirmed it (confirmedAt).
//
// Kept in userData/automations.json (bounded: 100 automations, 100 runs each),
// the prompt of each run in userData/automations/runs/<run id>/prompt.md (the
// agent reads it there; removed with the run).

import fs from 'fs'
import { join } from 'path'
import crypto from 'crypto'
import { writeJsonSafe, readJsonSafe } from './safeJson'
import { t } from './i18n'
import {
  normalizeAutomationInput,
  nextOccurrenceAfter,
  latestOccurrenceAtOrBefore,
  missedBeyondGrace,
  pruneRuns,
  nextRunNumber,
  isFinalRunStatus,
  resolveMaxConcurrent,
  RUN_STATUSES,
  ACTIVE_STATUSES,
  MAX_AUTOMATIONS,
  TICK_MS,
  DISPATCH_TIMEOUT_MS
} from '../shared/automations'

export const AUTOMATIONS_FILE = 'automations.json'
const RUN_ID = /^run-[A-Za-z0-9-]{6,80}$/
const PANE_ID = /^[A-Za-z0-9._-]{1,100}$/

const isState = (d) => !!d && typeof d === 'object' && Array.isArray(d.automations) && Array.isArray(d.runs)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null)

export function createAutomations({ dir, send = () => {}, now = Date.now, log = null, tickMs = TICK_MS, timers = { setInterval, clearInterval } } = {}) {
  if (!dir) throw new Error('createAutomations requires a folder') // i18n-ignore programming error
  const file = join(dir, AUTOMATIONS_FILE)
  const runsDir = join(dir, 'automations', 'runs')
  let state = { version: 1, automations: [], runs: [], settings: { maxConcurrent: resolveMaxConcurrent(null) } }
  let loaded = false
  let loadError = null
  let windowReady = false
  let timer = null
  let evaluating = false

  function load() {
    try {
      const res = readJsonSafe(file, isState)
      if (res.data) {
        state = {
          version: 1,
          automations: res.data.automations.filter((a) => a && typeof a.id === 'string').slice(0, MAX_AUTOMATIONS),
          runs: res.data.runs.filter((r) => r && typeof r.id === 'string' && RUN_STATUSES.includes(r.status)),
          settings: { maxConcurrent: resolveMaxConcurrent(res.data.settings && res.data.settings.maxConcurrent) }
        }
      }
      loaded = true
      loadError = null
    } catch (err) {
      // Unread is not empty: nothing is saved over it, nothing runs.
      loaded = false
      loadError = err && err.message
      if (log) log.error('automations', `load failed: ${loadError}`)
    }
  }

  function save() {
    if (!loaded) return false
    try {
      fs.mkdirSync(dir, { recursive: true })
      writeJsonSafe(file, state, isState)
      return true
    } catch (err) {
      if (log) log.error('automations', `save failed: ${err.message}`)
      return false
    }
  }

  function snapshot() {
    return {
      loaded,
      error: loaded ? null : t('main.automations.unreadable', 'Your automations could not be read: {{error}}. Nothing runs until Tessel reads them.', { error: loadError || '?' }),
      automations: state.automations.map((a) => ({ ...a })),
      runs: [...state.runs].sort((a, b) => b.createdAt - a.createdAt).map((r) => ({ ...r })),
      settings: { ...state.settings }
    }
  }

  function publish() {
    send('automations:changed', snapshot())
  }

  function commit() {
    save()
    publish()
  }

  const find = (id) => state.automations.find((a) => a.id === id) || null
  const runsOf = (id) => state.runs.filter((r) => r.automationId === id)
  const activeRunOf = (id) => state.runs.find((r) => r.automationId === id && !isFinalRunStatus(r.status)) || null
  const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`

  function errorText(code) {
    switch (code) {
      case 'name-required':
        return t('main.automations.nameRequired', 'Give the automation a name.')
      case 'name-too-long':
        return t('main.automations.nameTooLong', 'The name is too long.')
      case 'prompt-required':
        return t('main.automations.promptRequired', 'Enter a prompt before saving.')
      case 'prompt-too-long':
        return t('main.automations.promptTooLong', 'The prompt is too long.')
      case 'agent-invalid':
        return t('main.automations.agentInvalid', 'Choose an agent that can run automations.')
      case 'project-required':
        return t('main.automations.projectRequired', 'Choose a project.')
      case 'remote-worktree':
        return t('main.automations.remoteWorktree', 'A remote project runs in its project folder (no separate copy).')
      case 'remote-prompt-too-long':
        return t('main.automations.remotePromptTooLong', 'On a remote project the prompt goes on the command line: at most 3000 characters.')
      case 'schedule-invalid':
        return t('main.automations.scheduleInvalid', 'Enter a valid schedule before saving.')
      case 'too-many':
        return t('main.automations.tooMany', 'You have the most automations Tessel keeps ({{max}}).', { max: MAX_AUTOMATIONS })
      case 'not-found':
        return t('main.automations.notFound', 'Automation not found.')
      case 'needs-confirm':
        return t('main.automations.needsConfirm', 'Confirm that this automation may run unattended first.')
      case 'busy':
        return t('main.automations.busy', 'This automation is already running.')
      case 'unreadable':
        return t('main.automations.notLoaded', 'Your automations could not be read. Restart Tessel.')
      default:
        return t('main.automations.invalid', 'This automation is not valid.')
    }
  }
  const fail = (code) => ({ ok: false, code, error: errorText(code) })

  // --- The automations ---------------------------------------------------------------
  function create(input = {}) {
    if (!loaded) return fail('unreadable')
    const n = normalizeAutomationInput(input)
    if (n.error) return fail(n.error)
    if (state.automations.length >= MAX_AUTOMATIONS) return fail('too-many')
    const at = now()
    const enabled = input.enabled !== false
    if (enabled && input.confirmed !== true) return fail('needs-confirm')
    const a = {
      id: newId('auto'),
      ...n.value,
      enabled,
      confirmedAt: input.confirmed === true ? at : null,
      dtstart: at,
      nextRunAt: nextOccurrenceAfter(n.value.schedule, at, at),
      lastRunAt: null,
      missedRunPolicy: 'run_once_within_grace',
      createdAt: at,
      updatedAt: at
    }
    state.automations.push(a)
    commit()
    return { ok: true, automation: { ...a } }
  }

  function update(id, input = {}) {
    if (!loaded) return fail('unreadable')
    const a = find(id)
    if (!a) return fail('not-found')
    const n = normalizeAutomationInput({ ...a, ...input })
    if (n.error) return fail(n.error)
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : a.enabled
    const at = now()
    if (enabled && !a.confirmedAt && input.confirmed !== true) return fail('needs-confirm')
    const scheduleChanged = n.value.schedule !== a.schedule
    Object.assign(a, n.value, {
      enabled,
      confirmedAt: a.confirmedAt || (input.confirmed === true ? at : null),
      updatedAt: at
    })
    // A new schedule starts now; turned back on, the next occurrence from now
    // (occurrences while it was off are not caught up).
    if (scheduleChanged) a.dtstart = at
    if (scheduleChanged || (enabled && a.nextRunAt <= at)) a.nextRunAt = nextOccurrenceAfter(a.schedule, a.dtstart, at)
    if (!enabled) dropPending(a.id)
    commit()
    pump()
    return { ok: true, automation: { ...a } }
  }

  function setEnabled(id, enabled, confirmed = false) {
    return update(id, { enabled: !!enabled, confirmed })
  }

  function remove(id) {
    if (!loaded) return fail('unreadable')
    const a = find(id)
    if (!a) return fail('not-found')
    state.automations = state.automations.filter((x) => x.id !== id)
    for (const r of runsOf(id)) removeRunFiles(r.id)
    state.runs = state.runs.filter((r) => r.automationId !== id)
    commit()
    pump()
    return { ok: true }
  }

  function setSettings(patch = {}) {
    if (!loaded) return fail('unreadable')
    if (patch.maxConcurrent !== undefined) state.settings.maxConcurrent = resolveMaxConcurrent(Number(patch.maxConcurrent))
    commit()
    pump()
    return { ok: true, settings: { ...state.settings } }
  }

  // --- Runs --------------------------------------------------------------------------
  function createRun(a, scheduledFor, trigger) {
    const number = nextRunNumber(runsOf(a.id))
    const run = {
      id: newId('run'),
      automationId: a.id,
      runNumber: number,
      name: a.name,
      scheduledFor,
      trigger,
      status: 'pending',
      createdAt: now(),
      startedAt: null,
      dispatchedAt: null,
      finishedAt: null,
      paneId: null,
      wsId: a.wsId,
      taskId: null,
      branch: null,
      errorCode: null,
      error: null
    }
    state.runs.push(run)
    a.lastRunAt = run.createdAt
    trimRuns()
    return run
  }

  function finish(run, status, errorCode = null, error = null) {
    run.status = status
    run.errorCode = errorCode
    run.error = error
    run.finishedAt = now()
    if (!run.startedAt) run.startedAt = run.finishedAt
  }

  // A skip that repeats (the same reason, run after run) folds into the
  // previous row instead of one row each (Orca's recordRepeatedAutomationSkip).
  function recordSkip(a, scheduledFor, status, errorCode) {
    const latest = runsOf(a.id).reduce((n, r) => (!n || r.createdAt > n.createdAt ? r : n), null)
    if (latest && latest.status === status && latest.errorCode === errorCode && latest.trigger === 'scheduled') {
      if ((latest.lastOccurrenceAt ?? latest.scheduledFor) !== scheduledFor) {
        latest.occurrenceCount = (latest.occurrenceCount || 1) + 1
        latest.lastOccurrenceAt = scheduledFor
      }
      return latest
    }
    const run = createRun(a, scheduledFor, 'scheduled')
    finish(run, status, errorCode)
    return run
  }

  function dropPending(automationId) {
    for (const r of state.runs) {
      if (r.automationId === automationId && r.status === 'pending' && r.trigger === 'scheduled') finish(r, 'skipped_unavailable', 'paused')
    }
  }

  function trimRuns() {
    const before = new Set(state.runs.map((r) => r.id))
    state.runs = pruneRuns(state.runs)
    const after = new Set(state.runs.map((r) => r.id))
    for (const id of before) if (!after.has(id)) removeRunFiles(id)
  }

  function runFolder(runId) {
    return RUN_ID.test(runId) ? join(runsDir, runId) : null
  }
  function removeRunFiles(runId) {
    const folder = runFolder(runId)
    if (!folder) return
    try {
      fs.rmSync(folder, { recursive: true, force: true })
    } catch {
      // kept: removed with a later cleanup
    }
  }

  // Run now (Orca's runNow): even when paused, never while one runs.
  function runNow(id, confirmed = false) {
    if (!loaded) return fail('unreadable')
    const a = find(id)
    if (!a) return fail('not-found')
    if (!a.confirmedAt && confirmed !== true) return fail('needs-confirm')
    if (activeRunOf(id)) return fail('busy')
    if (!a.confirmedAt) a.confirmedAt = now()
    const run = createRun(a, now(), 'manual')
    commit()
    pump()
    return { ok: true, run: { ...run } }
  }

  // Start the runs waiting, oldest first, while slots are free.
  function pump() {
    if (!loaded || !windowReady) return
    let active = state.runs.filter((r) => ACTIVE_STATUSES.includes(r.status)).length
    const max = state.settings.maxConcurrent
    const pending = state.runs.filter((r) => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
    let changed = false
    for (const run of pending) {
      if (active >= max) break
      if (state.runs.some((r) => r.automationId === run.automationId && ACTIVE_STATUSES.includes(r.status))) continue
      const a = find(run.automationId)
      if (!a) {
        finish(run, 'skipped_unavailable', 'deleted')
        changed = true
        continue
      }
      if (dispatch(a, run)) active++
      changed = true
    }
    if (changed) commit()
  }

  function dispatch(a, run) {
    const folder = runFolder(run.id)
    let promptFile = null
    if (!a.remote) {
      try {
        fs.mkdirSync(folder, { recursive: true })
        promptFile = join(folder, 'prompt.md')
        fs.writeFileSync(promptFile, `${a.prompt}\n`, 'utf8')
      } catch (err) {
        finish(run, 'dispatch_failed', 'prompt-file', err.message)
        return false
      }
    }
    run.status = 'dispatching'
    run.startedAt = now()
    send('automations:dispatch', {
      automation: { ...a },
      run: { ...run },
      promptFile,
      promptDir: promptFile ? folder : null
    })
    if (log) log.info('automations', `run ${run.id} of ${a.id} (${run.trigger}) sent to the window`)
    return true
  }

  // The window's report: { runId, status, paneId?, wsId?, taskId?, branch?,
  // errorCode?, error? }. A run never leaves a final status.
  function markResult(result = {}) {
    const run = state.runs.find((r) => r.id === result.runId)
    if (!run) return fail('not-found')
    if (isFinalRunStatus(run.status)) return { ok: true, run: { ...run } }
    if (!['dispatched', 'completed', 'dispatch_failed', 'skipped_unavailable'].includes(result.status)) return fail('invalid')
    if (typeof result.paneId === 'string' && PANE_ID.test(result.paneId)) run.paneId = result.paneId
    if (typeof result.wsId === 'string' && PANE_ID.test(result.wsId)) run.wsId = result.wsId
    if (typeof result.taskId === 'string' && result.taskId.length <= 120) run.taskId = result.taskId
    if (typeof result.branch === 'string') run.branch = result.branch.slice(0, 300)
    if (result.status === 'dispatched') {
      run.status = 'dispatched'
      run.dispatchedAt = now()
    } else finish(run, result.status, str(result.errorCode, 60), str(result.error, 2000))
    if (isFinalRunStatus(run.status)) trimRuns()
    commit()
    pump()
    return { ok: true, run: { ...run } }
  }

  // After the window (re)loads its panes: a run whose pane is still there is
  // followed again; one that was starting, or whose pane is gone, ended when
  // Tessel closed. -> the runs still going ({ id, automationId, paneId, taskId }).
  function reconcile(livePaneIds = []) {
    if (!loaded) return []
    const live = new Set((Array.isArray(livePaneIds) ? livePaneIds : []).filter((x) => typeof x === 'string'))
    let changed = false
    for (const r of state.runs) {
      if (r.status === 'dispatching') {
        finish(r, 'dispatch_failed', 'interrupted')
        changed = true
      } else if (r.status === 'dispatched' && !(r.paneId && live.has(r.paneId))) {
        finish(r, 'dispatch_failed', 'pane-gone')
        changed = true
      }
    }
    if (changed) {
      trimRuns()
      commit()
    }
    return state.runs.filter((r) => r.status === 'dispatched').map((r) => ({ id: r.id, automationId: r.automationId, paneId: r.paneId, taskId: r.taskId }))
  }

  // --- The tick ------------------------------------------------------------------------
  function tick() {
    if (!loaded || !windowReady || evaluating) return
    evaluating = true
    let changed = false
    try {
      const at = now()
      // A run the window never answered for.
      for (const r of state.runs) {
        if (r.status === 'dispatching' && at - (r.startedAt || at) > DISPATCH_TIMEOUT_MS) {
          finish(r, 'dispatch_failed', 'no-answer')
          changed = true
        }
      }
      for (const a of state.automations) {
        if (!a.enabled || !(a.nextRunAt <= at)) continue
        changed = true
        try {
          evaluate(a, at)
        } catch (err) {
          // An unreadable schedule: said once (folded), retried each tick.
          recordSkip(a, a.nextRunAt, 'skipped_unavailable', 'unevaluable')
          if (log) log.error('automations', `could not evaluate ${a.id}: ${err.message}`)
        }
      }
      if (changed) {
        trimRuns()
        commit()
      }
      pump()
    } finally {
      evaluating = false
    }
  }

  function advance(a, at) {
    a.nextRunAt = nextOccurrenceAfter(a.schedule, a.dtstart, at)
  }

  function evaluate(a, at) {
    const scheduledFor = latestOccurrenceAtOrBefore(a.schedule, a.dtstart, at)
    if (scheduledFor === null) return advance(a, at)
    if (missedBeyondGrace({ graceMinutes: a.missedRunGraceMinutes, scheduledFor, now: at, tickMs })) {
      recordSkip(a, scheduledFor, 'skipped_missed', 'missed')
      return advance(a, at)
    }
    // Never two runs of the same automation at once.
    if (activeRunOf(a.id)) {
      recordSkip(a, scheduledFor, 'skipped_unavailable', 'overlap')
      return advance(a, at)
    }
    createRun(a, scheduledFor, 'scheduled')
    advance(a, at)
  }

  function setWindowReady(ready) {
    windowReady = !!ready
    if (windowReady) tick()
  }

  function start() {
    load()
    if (timer) return
    timer = timers.setInterval(tick, tickMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    if (timer) timers.clearInterval(timer)
    timer = null
    windowReady = false
  }

  return {
    start,
    stop,
    load,
    tick,
    snapshot,
    create,
    update,
    setEnabled,
    remove,
    setSettings,
    runNow,
    markResult,
    reconcile,
    setWindowReady,
    file
  }
}
