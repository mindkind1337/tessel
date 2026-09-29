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
// automation runs unattended only once you confirmed it (confirmedAt, with
// the signature of the permissions you saw: confirmedSig), and a change of
// its agent, project, isolation or prompt asks again.
//
// The window answers a run at once (ack) before the slow part (a copy of the
// project, its setup script); a run it never answers fails after 3 minutes,
// one it answered after an hour, and before it opens the pane the window
// asks again whether the run is still wanted (status). A run that started
// fails when its agent never shows up or exits early (window side), and in
// any case after 24 hours, so a stuck run never blocks the others for good.
//
// Kept in userData/automations.json (bounded: 100 automations, 100 runs each,
// checked again when read), the prompt of each run in
// userData/automations/runs/<run id>/prompt.md (the agent reads it there;
// removed with the run, never while it may still be read). A remote
// project's prompt goes to <project>/.tessel/automations/<automation id>.md on
// its host through the remote session (writeRemotePrompt), so nothing of it
// is typed into the host's login shell.

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
  remotePromptFile,
  RUN_STATUSES,
  ACTIVE_STATUSES,
  MAX_AUTOMATIONS,
  MIN_INTERVAL_MINUTES,
  TICK_MS,
  DISPATCH_TIMEOUT_MS
} from '../shared/automations'

export const AUTOMATIONS_FILE = 'automations.json'
// A run the window answered (ack) but never started: an hour at most.
export const ACKED_TIMEOUT_MS = 60 * 60 * 1000
// A started run that never ended.
export const MAX_RUN_MS = 24 * 60 * 60 * 1000
const AUTO_ID = /^auto-[A-Za-z0-9-]{1,80}$/
const REMOTE_FILE = /^\.tessel\/automations\/auto-[A-Za-z0-9-]{1,80}\.md$/
const HOST_ID = /^[A-Za-z0-9._-]{1,100}$/
// An occurrence already handled is never run again after the clock went
// back, unless it lies this far ahead (the clock had jumped forward).
const DAY_MS = 24 * 60 * 60 * 1000
// Remote prompts waiting to be emptied (their host not connected then).
const MAX_PENDING_CLEARS = 200
const RUN_ID = /^run-[A-Za-z0-9-]{6,80}$/
const PANE_ID = /^[A-Za-z0-9._-]{1,100}$/
// What a changed automation must be confirmed for again.
const SENSITIVE = ['agentId', 'wsId', 'projectCwd', 'remote', 'isolation', 'prompt']

const isState = (d) => !!d && typeof d === 'object' && Array.isArray(d.automations) && Array.isArray(d.runs)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function createAutomations({
  dir,
  send = () => {},
  now = Date.now,
  log = null,
  tickMs = TICK_MS,
  timers = { setInterval, clearInterval },
  writeRemotePrompt = null,
  clearRemotePrompt = null
} = {}) {
  if (!dir) throw new Error('createAutomations requires a folder') // i18n-ignore programming error
  const file = join(dir, AUTOMATIONS_FILE)
  const runsDir = join(dir, 'automations', 'runs')
  let state = { version: 1, automations: [], runs: [], settings: { maxConcurrent: resolveMaxConcurrent(null) }, pendingClears: [] }
  let loaded = false
  let loadError = null
  let windowReady = false
  let timer = null
  let evaluating = false

  // --- Reading the file: every record checked again ---------------------------------
  function restoreAutomation(a) {
    if (!a || typeof a !== 'object' || !AUTO_ID.test(String(a.id))) return null
    const n = normalizeAutomationInput(a)
    if (n.error) {
      if (log) log.warn('automations', `dropped ${a.id} when reading: ${n.error}`)
      return null
    }
    const at = now()
    const confirmedAt = num(a.confirmedAt)
    const dtstart = num(a.dtstart) ?? at
    let nextRunAt = num(a.nextRunAt)
    if (nextRunAt === null) {
      try {
        nextRunAt = nextOccurrenceAfter(n.value.schedule, dtstart, at)
      } catch {
        return null
      }
    }
    return {
      id: a.id,
      ...n.value,
      // Never on without a confirmation.
      enabled: a.enabled === true && confirmedAt !== null,
      confirmedAt,
      confirmedSig: str(a.confirmedSig, 500),
      dtstart,
      nextRunAt,
      lastRunAt: num(a.lastRunAt),
      lastScheduledFor: num(a.lastScheduledFor),
      missedRunPolicy: 'run_once_within_grace',
      createdAt: num(a.createdAt) ?? at,
      updatedAt: num(a.updatedAt) ?? at
    }
  }
  function restoreRun(r) {
    if (!r || typeof r !== 'object' || !RUN_ID.test(String(r.id)) || !AUTO_ID.test(String(r.automationId)) || !RUN_STATUSES.includes(r.status)) return null
    return {
      id: r.id,
      automationId: r.automationId,
      runNumber: Number.isSafeInteger(r.runNumber) && r.runNumber > 0 ? r.runNumber : 1,
      name: str(r.name, 200) || '',
      scheduledFor: num(r.scheduledFor) ?? 0,
      trigger: r.trigger === 'manual' ? 'manual' : 'scheduled',
      status: r.status,
      createdAt: num(r.createdAt) ?? 0,
      startedAt: num(r.startedAt),
      ackedAt: num(r.ackedAt),
      dispatchedAt: num(r.dispatchedAt),
      finishedAt: num(r.finishedAt),
      paneId: typeof r.paneId === 'string' && PANE_ID.test(r.paneId) ? r.paneId : null,
      wsId: typeof r.wsId === 'string' && PANE_ID.test(r.wsId) ? r.wsId : null,
      taskId: str(r.taskId, 120),
      branch: str(r.branch, 300),
      errorCode: str(r.errorCode, 60),
      error: str(r.error, 2000),
      ...(typeof r.remoteFile === 'string' && REMOTE_FILE.test(r.remoteFile) && r.remoteHost && HOST_ID.test(String(r.remoteHost.hostId)) && typeof r.remoteHost.path === 'string'
        ? { remoteFile: r.remoteFile, remoteHost: { hostId: r.remoteHost.hostId, path: r.remoteHost.path.slice(0, 1024) } }
        : {}),
      ...(Number.isSafeInteger(r.occurrenceCount) && r.occurrenceCount > 1 ? { occurrenceCount: r.occurrenceCount } : {}),
      ...(num(r.lastOccurrenceAt) !== null ? { lastOccurrenceAt: r.lastOccurrenceAt } : {})
    }
  }

  function restoreClear(c) {
    if (!c || typeof c !== 'object' || !REMOTE_FILE.test(String(c.file)) || !HOST_ID.test(String(c.hostId)) || typeof c.path !== 'string') return null
    return { hostId: c.hostId, path: c.path.slice(0, 1024), file: c.file }
  }

  function load() {
    try {
      const res = readJsonSafe(file, isState)
      if (res.data) {
        const automations = res.data.automations.map(restoreAutomation).filter(Boolean).slice(0, MAX_AUTOMATIONS)
        state = {
          version: 1,
          automations,
          runs: pruneRuns(res.data.runs.map(restoreRun).filter(Boolean)),
          settings: { maxConcurrent: resolveMaxConcurrent(res.data.settings && res.data.settings.maxConcurrent) },
          pendingClears: (Array.isArray(res.data.pendingClears) ? res.data.pendingClears : []).map(restoreClear).filter(Boolean).slice(-MAX_PENDING_CLEARS)
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
      case 'schedule-invalid':
        return t('main.automations.scheduleInvalid', 'Enter a valid schedule before saving.')
      case 'schedule-too-frequent':
        return t('main.automations.scheduleTooFrequent', 'Runs must be at least {{min}} minutes apart: each one opens a pane (and a copy of the project).', { min: MIN_INTERVAL_MINUTES })
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
    const confirmed = input.confirmed === true
    if (enabled && !confirmed) return fail('needs-confirm')
    const a = {
      id: newId('auto'),
      ...n.value,
      enabled,
      confirmedAt: confirmed ? at : null,
      confirmedSig: confirmed ? str(input.confirmSig, 500) : null,
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
    const confirmed = input.confirmed === true
    const at = now()
    // A different agent, project, place or prompt was not what you confirmed.
    const changed = SENSITIVE.some((k) => !same(n.value[k], a[k]))
    const confirmedAt = confirmed ? at : changed ? null : a.confirmedAt
    if (enabled && !confirmedAt) return fail('needs-confirm')
    const scheduleChanged = n.value.schedule !== a.schedule
    Object.assign(a, n.value, {
      enabled,
      confirmedAt,
      confirmedSig: confirmed ? str(input.confirmSig, 500) : changed ? null : a.confirmedSig,
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

  function setEnabled(id, enabled, confirmed = false, confirmSig = null) {
    return update(id, { enabled: !!enabled, confirmed, confirmSig })
  }

  // Its history goes with it; a run still starting or going keeps its row
  // (and its prompt file, the agent may still read it) until it ends.
  function remove(id) {
    if (!loaded) return fail('unreadable')
    const a = find(id)
    if (!a) return fail('not-found')
    state.automations = state.automations.filter((x) => x.id !== id)
    for (const r of runsOf(id)) if (r.status === 'pending') finish(r, 'skipped_unavailable', 'deleted')
    for (const r of runsOf(id)) if (isFinalRunStatus(r.status)) removeRunFiles(r.id)
    state.runs = state.runs.filter((r) => r.automationId !== id || !isFinalRunStatus(r.status))
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
      ackedAt: null,
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
    if (trigger === 'scheduled') a.lastScheduledFor = Math.max(a.lastScheduledFor ?? -Infinity, scheduledFor)
    trimRuns()
    return run
  }

  function finish(run, status, errorCode = null, error = null) {
    run.status = status
    run.errorCode = errorCode
    run.error = error
    run.finishedAt = now()
    if (!run.startedAt) run.startedAt = run.finishedAt
    // Its prompt on a remote host: emptied, now if a session to that host is
    // open, else later (the .gitignore keeps it out of git meanwhile).
    if (run.remoteFile && run.remoteHost) {
      queueClear({ hostId: run.remoteHost.hostId, path: run.remoteHost.path, file: run.remoteFile })
      run.remoteFile = null
    }
  }

  const sameClear = (a, b) => a.hostId === b.hostId && a.path === b.path && a.file === b.file
  function queueClear(c) {
    state.pendingClears = state.pendingClears.filter((x) => !sameClear(x, c))
    state.pendingClears.push(c)
    if (state.pendingClears.length > MAX_PENDING_CLEARS) state.pendingClears = state.pendingClears.slice(-MAX_PENDING_CLEARS)
    Promise.resolve().then(flushClears)
  }
  let flushing = false
  async function flushClears() {
    if (flushing || !clearRemotePrompt || !state.pendingClears.length) return
    flushing = true
    let changed = false
    try {
      for (const c of [...state.pendingClears]) {
        let res
        try {
          res = await clearRemotePrompt(c)
        } catch {
          res = { ok: false, later: true }
        }
        if (res && res.later) continue
        state.pendingClears = state.pendingClears.filter((x) => !sameClear(x, c))
        changed = true
      }
    } finally {
      flushing = false
    }
    if (changed) save()
  }

  // A skip that repeats (the same reason, run after run) folds into the
  // previous row instead of one row each (Orca's recordRepeatedAutomationSkip).
  function foldTarget(automationId, status, errorCode, except = null) {
    // The last row written (not the latest time: the clock may have gone back).
    const rows = runsOf(automationId).filter((r) => r !== except)
    const latest = rows.length ? rows[rows.length - 1] : null
    return latest && latest.status === status && latest.errorCode === errorCode && latest.trigger === 'scheduled' ? latest : null
  }
  function fold(latest, scheduledFor) {
    if ((latest.lastOccurrenceAt ?? latest.scheduledFor) !== scheduledFor) {
      latest.occurrenceCount = (latest.occurrenceCount || 1) + 1
      latest.lastOccurrenceAt = scheduledFor
    }
    return latest
  }
  function recordSkip(a, scheduledFor, status, errorCode) {
    a.lastScheduledFor = Math.max(a.lastScheduledFor ?? -Infinity, scheduledFor)
    const latest = foldTarget(a.id, status, errorCode)
    if (latest) return fold(latest, scheduledFor)
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
    // A finished run of a deleted automation is not kept.
    state.runs = pruneRuns(state.runs.filter((r) => !isFinalRunStatus(r.status) || find(r.automationId)))
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
  function runNow(id, confirmed = false, confirmSig = null) {
    if (!loaded) return fail('unreadable')
    const a = find(id)
    if (!a) return fail('not-found')
    if (!a.confirmedAt && confirmed !== true) return fail('needs-confirm')
    if (activeRunOf(id)) return fail('busy')
    if (confirmed === true) {
      a.confirmedAt = now()
      a.confirmedSig = str(confirmSig, 500)
    }
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
    if (changed) {
      trimRuns()
      commit()
    }
  }

  // The run holds its slot from here (dispatching) until it ends.
  function dispatch(a, run) {
    run.status = 'dispatching'
    run.startedAt = now()
    const payload = { automation: { ...a }, run: { ...run }, promptFile: null, promptDir: null, remoteFile: null }
    if (a.remote) {
      writeRemote(a, run, payload)
      return true
    }
    const folder = runFolder(run.id)
    try {
      fs.mkdirSync(folder, { recursive: true })
      payload.promptFile = join(folder, 'prompt.md')
      payload.promptDir = folder
      fs.writeFileSync(payload.promptFile, `${a.prompt}\n`, 'utf8')
    } catch (err) {
      finish(run, 'dispatch_failed', 'prompt-file', err.message)
      return false
    }
    sendDispatch(a, run, payload)
    return true
  }

  function sendDispatch(a, run, payload) {
    send('automations:dispatch', payload)
    if (log) log.info('automations', `run ${run.id} of ${a.id} (${run.trigger}) sent to the window`)
  }

  // A remote project's prompt: a file in its folder on the host, written
  // through the remote session (never typed into its shell).
  async function writeRemote(a, run, payload) {
    const rel = remotePromptFile(a.id)
    state.pendingClears = state.pendingClears.filter((x) => !sameClear(x, { hostId: a.remote.hostId, path: a.remote.path, file: rel }))
    let res
    try {
      res = writeRemotePrompt
        ? await writeRemotePrompt({ hostId: a.remote.hostId, path: a.remote.path, file: rel, text: `${a.prompt}\n` })
        : { ok: false, error: '' }
    } catch (err) {
      res = { ok: false, error: (err && err.message) || '' }
    }
    if (run.status !== 'dispatching') return
    if (!res || !res.ok) {
      if (res && res.error === 'link') finish(run, 'dispatch_failed', 'remote-prompt-link')
      else finish(run, 'dispatch_failed', 'remote-prompt', (res && res.error) || '')
      trimRuns()
      commit()
      pump()
      return
    }
    payload.remoteFile = rel
    run.remoteFile = rel
    run.remoteHost = { hostId: a.remote.hostId, path: a.remote.path }
    save()
    sendDispatch(a, run, payload)
  }

  // The window's report: { runId, status, paneId?, wsId?, taskId?, branch?,
  // errorCode?, error? }. 'ack': the window took the run (no status change).
  // A run never leaves a final status: the answer carries the run as it is,
  // so a window that opened a pane for a run already ended closes it.
  function markResult(result = {}) {
    const run = state.runs.find((r) => r.id === result.runId)
    if (!run) return fail('not-found')
    if (isFinalRunStatus(run.status)) return { ok: true, run: { ...run } }
    if (result.status === 'ack') {
      if (run.status === 'dispatching' && !run.ackedAt) {
        run.ackedAt = now()
        save()
      }
      return { ok: true, run: { ...run } }
    }
    if (!['dispatched', 'completed', 'dispatch_failed', 'skipped_unavailable'].includes(result.status)) return fail('invalid')
    if (typeof result.paneId === 'string' && PANE_ID.test(result.paneId)) run.paneId = result.paneId
    if (typeof result.wsId === 'string' && PANE_ID.test(result.wsId)) run.wsId = result.wsId
    if (typeof result.taskId === 'string' && result.taskId.length <= 120) run.taskId = result.taskId
    if (typeof result.branch === 'string') run.branch = result.branch.slice(0, 300)
    if (result.status === 'dispatched') {
      run.status = 'dispatched'
      run.dispatchedAt = now()
    } else finish(run, result.status, str(result.errorCode, 60), str(result.error, 2000))
    // The same refusal again and again (a limit, changed permissions): one row.
    if (run.status === 'skipped_unavailable' && run.trigger === 'scheduled') {
      const prev = foldTarget(run.automationId, run.status, run.errorCode, run)
      if (prev) {
        fold(prev, run.scheduledFor)
        state.runs = state.runs.filter((r) => r !== run)
        removeRunFiles(run.id)
      }
    }
    if (isFinalRunStatus(run.status)) trimRuns()
    commit()
    pump()
    return { ok: true, run: { ...run } }
  }

  // The window asks before it opens a run's pane: is the run still wanted?
  function status(runId) {
    const run = state.runs.find((r) => r.id === runId)
    return run ? run.status : null
  }

  // After the window (re)loads its panes: a run whose pane is still there is
  // followed again; one that was starting, or whose pane is gone, ended when
  // Tessel closed. -> the runs still going ({ id, automationId, paneId, taskId, dispatchedAt }).
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
    return state.runs
      .filter((r) => r.status === 'dispatched')
      .map((r) => ({ id: r.id, automationId: r.automationId, paneId: r.paneId, taskId: r.taskId, dispatchedAt: r.dispatchedAt }))
  }

  // --- The tick ------------------------------------------------------------------------
  function tick() {
    if (!loaded || !windowReady || evaluating) return
    evaluating = true
    let changed = false
    const before = JSON.stringify(state)
    try {
      const at = now()
      for (const r of state.runs) {
        // A run the window never answered for, or never started.
        if (r.status === 'dispatching') {
          const waited = at - (r.startedAt || at)
          if ((!r.ackedAt && waited > DISPATCH_TIMEOUT_MS) || waited > ACKED_TIMEOUT_MS) {
            finish(r, 'dispatch_failed', 'no-answer')
            changed = true
          }
        } else if (r.status === 'dispatched' && at - (r.dispatchedAt || r.startedAt || at) > MAX_RUN_MS) {
          finish(r, 'dispatch_failed', 'stale')
          changed = true
        }
      }
      for (const a of state.automations) {
        if (!a.enabled) continue
        // The clock went back (after a jump forward): the schedule follows it
        // instead of waiting for a date far ahead.
        try {
          if (a.dtstart > at) {
            a.dtstart = at
            changed = true
          }
          if (a.lastScheduledFor != null && a.lastScheduledFor > at + DAY_MS) {
            a.lastScheduledFor = null
            changed = true
          }
          const expected = nextOccurrenceAfter(a.schedule, a.dtstart, at)
          if (a.nextRunAt > expected) {
            a.nextRunAt = expected
            changed = true
          }
        } catch {
          // unreadable schedule: said below
        }
        if (!(a.nextRunAt <= at)) continue
        changed = true
        try {
          evaluate(a, at)
        } catch (err) {
          // An unreadable schedule: said once (folded), retried each tick.
          recordSkip(a, a.nextRunAt, 'skipped_unavailable', 'unevaluable')
          if (log) log.error('automations', `could not evaluate ${a.id}: ${err.message}`)
        }
      }
      if (changed) trimRuns()
      // Only when something really changed (a due automation may be looked
      // at again without any news).
      if (changed && JSON.stringify(state) !== before) commit()
      pump()
    } finally {
      evaluating = false
    }
    flushClears()
  }

  // A row for an occurrence not run because of a clock change (folded).
  function clockSkip(a, scheduledFor) {
    const latest = foldTarget(a.id, 'skipped_unavailable', 'clock-change')
    if (latest) return fold(latest, scheduledFor)
    const keep = a.lastScheduledFor
    const run = createRun(a, scheduledFor, 'scheduled')
    finish(run, 'skipped_unavailable', 'clock-change')
    a.lastScheduledFor = keep
    return run
  }

  function advance(a, at) {
    a.nextRunAt = nextOccurrenceAfter(a.schedule, a.dtstart, at)
  }

  function evaluate(a, at) {
    const scheduledFor = latestOccurrenceAtOrBefore(a.schedule, a.dtstart, at)
    if (scheduledFor === null) return advance(a, at)
    // Already handled (the clock went back after it): not again, said once.
    if (a.lastScheduledFor != null && scheduledFor <= a.lastScheduledFor) {
      clockSkip(a, scheduledFor)
      return advance(a, at)
    }
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
    status,
    reconcile,
    setWindowReady,
    file
  }
}
