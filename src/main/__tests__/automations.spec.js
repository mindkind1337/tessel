import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import { createAutomations, AUTOMATIONS_FILE } from '../automations'

const MIN = 60 * 1000
const at = (h, m = 0) => new Date(2026, 8, 29, h, m, 0, 0).getTime()

function input(over = {}) {
  return {
    name: 'Nightly audit',
    prompt: 'Check the repo.\nReport risks.',
    agentId: 'claude',
    wsId: 'ws-1',
    projectName: 'App',
    projectCwd: 'C:\\code\\app',
    isolation: 'project',
    schedule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    missedRunGraceMinutes: 60,
    confirmed: true,
    ...over
  }
}

describe('automations scheduler (main)', () => {
  let dir, clock, sent, svc
  let remoteWrites = []
  let remoteAnswer = { ok: true }
  const make = () =>
    createAutomations({
      dir,
      now: () => clock,
      send: (channel, payload) => sent.push({ channel, payload }),
      timers: { setInterval: () => null, clearInterval: () => {} },
      writeRemotePrompt: async (q) => {
        remoteWrites.push(q)
        return remoteAnswer
      }
    })
  const dispatches = () => sent.filter((s) => s.channel === 'automations:dispatch').map((s) => s.payload)

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'automations-test-'))
    clock = at(8, 0)
    sent = []
    remoteWrites = []
    remoteAnswer = { ok: true }
    svc = make()
    svc.start()
  })
  afterEach(() => {
    svc.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('an enabled automation needs your confirmation; a paused one does not', () => {
    const refused = svc.create(input({ confirmed: false }))
    expect(refused).toMatchObject({ ok: false, code: 'needs-confirm' })
    expect(refused.error).toMatch(/unattended/)
    const paused = svc.create(input({ confirmed: false, enabled: false }))
    expect(paused.ok).toBe(true)
    expect(paused.automation.confirmedAt).toBe(null)
    // Turning it on later asks again.
    expect(svc.setEnabled(paused.automation.id, true).code).toBe('needs-confirm')
    expect(svc.setEnabled(paused.automation.id, true, true).ok).toBe(true)
  })

  it('refuses what is not valid, with words for the window', () => {
    expect(svc.create(input({ schedule: 'nope' }))).toMatchObject({ ok: false, code: 'schedule-invalid' })
    expect(svc.create(input({ agentId: 'aider' }))).toMatchObject({ ok: false, code: 'agent-invalid' })
  })

  it('runs only once the window is ready, when due; writes the prompt file for the agent', () => {
    const { automation } = svc.create(input())
    expect(automation.nextRunAt).toBe(at(9, 0))
    clock = at(9, 0) + 5000
    svc.tick()
    expect(dispatches()).toHaveLength(0) // no window yet
    svc.setWindowReady(true)
    expect(dispatches()).toHaveLength(1)
    const d = dispatches()[0]
    expect(d.run).toMatchObject({ automationId: automation.id, trigger: 'scheduled', status: 'dispatching', runNumber: 1, scheduledFor: at(9, 0) })
    expect(fs.readFileSync(d.promptFile, 'utf8')).toBe('Check the repo.\nReport risks.\n')
    expect(d.promptDir).toBe(join(dir, 'automations', 'runs', d.run.id))
    const snap = svc.snapshot()
    expect(snap.automations[0].nextRunAt).toBe(new Date(2026, 8, 30, 9, 0).getTime())
    expect(snap.automations[0].lastRunAt).toBe(clock)
  })

  it('follows the window reports; a final run never changes again', () => {
    svc.setWindowReady(true)
    const { automation } = svc.create(input())
    const { run } = svc.runNow(automation.id)
    expect(dispatches()).toHaveLength(1)
    expect(svc.markResult({ runId: run.id, status: 'dispatched', paneId: 'pane-3-1', taskId: 'task-9' }).run).toMatchObject({ status: 'dispatched', paneId: 'pane-3-1', taskId: 'task-9' })
    expect(svc.runNow(automation.id).code).toBe('busy')
    expect(svc.markResult({ runId: run.id, status: 'completed' }).run.status).toBe('completed')
    expect(svc.markResult({ runId: run.id, status: 'dispatch_failed' }).run.status).toBe('completed')
    expect(svc.runNow(automation.id).ok).toBe(true)
  })

  it('never two runs of the same automation: an occurrence while one runs is skipped (folded)', () => {
    svc.setWindowReady(true)
    const { automation } = svc.create(input({ schedule: '*/15 * * * *' }))
    clock = at(8, 15) + 1000
    svc.tick()
    const first = dispatches()[0].run
    svc.markResult({ runId: first.id, status: 'dispatched', paneId: 'p1' })
    clock = at(8, 30) + 1000
    svc.tick()
    clock = at(8, 45) + 1000
    svc.tick()
    expect(dispatches()).toHaveLength(1)
    const runs = svc.snapshot().runs.filter((r) => r.automationId === automation.id)
    const skipped = runs.filter((r) => r.errorCode === 'overlap')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatchObject({ status: 'skipped_unavailable', occurrenceCount: 2 })
  })

  it('a run missed past its grace is skipped; one within it runs once', () => {
    svc.create(input({ missedRunGraceMinutes: 30 }))
    // Tessel was closed from 8:00 to 11:00.
    clock = at(11, 0)
    svc.setWindowReady(true)
    expect(dispatches()).toHaveLength(0)
    expect(svc.snapshot().runs[0]).toMatchObject({ status: 'skipped_missed', errorCode: 'missed' })
    const b = svc.create(input({ name: 'Other', missedRunGraceMinutes: 720 }))
    // Due tomorrow 9:00; Tessel reopens at 10:00.
    clock = new Date(2026, 8, 30, 10, 0).getTime()
    svc.tick()
    const d = dispatches().filter((x) => x.automation.id === b.automation.id)
    expect(d).toHaveLength(1)
    expect(d[0].run.scheduledFor).toBe(new Date(2026, 8, 30, 9, 0).getTime())
  })

  it('at most maxConcurrent runs at a time, the others wait their turn', () => {
    svc.setWindowReady(true)
    svc.setSettings({ maxConcurrent: 1 })
    const a = svc.create(input({ name: 'A' })).automation
    const b = svc.create(input({ name: 'B' })).automation
    svc.runNow(a.id)
    svc.runNow(b.id)
    expect(dispatches()).toHaveLength(1)
    expect(svc.snapshot().runs.find((r) => r.automationId === b.id).status).toBe('pending')
    svc.markResult({ runId: dispatches()[0].run.id, status: 'completed' })
    expect(dispatches()).toHaveLength(2)
    expect(dispatches()[1].automation.id).toBe(b.id)
  })

  it('after a restart: a run still in its pane is followed, the others ended', () => {
    svc.setWindowReady(true)
    const a = svc.create(input({ name: 'A' })).automation
    const b = svc.create(input({ name: 'B' })).automation
    const ra = svc.runNow(a.id).run
    const rb = svc.runNow(b.id).run
    svc.markResult({ runId: ra.id, status: 'dispatched', paneId: 'pane-a' })
    svc.markResult({ runId: rb.id, status: 'dispatched', paneId: 'pane-b' })
    svc.stop()
    const again = make()
    again.start()
    expect(again.reconcile(['pane-a'])).toEqual([{ id: ra.id, automationId: a.id, paneId: 'pane-a', taskId: null, dispatchedAt: clock }])
    const runs = again.snapshot().runs
    expect(runs.find((r) => r.id === rb.id)).toMatchObject({ status: 'dispatch_failed', errorCode: 'pane-gone' })
    expect(JSON.parse(fs.readFileSync(join(dir, AUTOMATIONS_FILE), 'utf8')).automations).toHaveLength(2)
  })

  it('a run the window never answered for fails after a while', () => {
    svc.setWindowReady(true)
    const a = svc.create(input()).automation
    svc.runNow(a.id)
    clock += 4 * MIN
    svc.tick()
    expect(svc.snapshot().runs[0]).toMatchObject({ status: 'dispatch_failed', errorCode: 'no-answer' })
  })

  it('deleting an automation removes its history and prompt files', () => {
    svc.setWindowReady(true)
    const a = svc.create(input()).automation
    const { run } = svc.runNow(a.id)
    const folder = dispatches()[0].promptDir
    expect(fs.existsSync(folder)).toBe(true)
    svc.markResult({ runId: run.id, status: 'completed' })
    expect(svc.remove(a.id).ok).toBe(true)
    expect(fs.existsSync(folder)).toBe(false)
    expect(svc.snapshot()).toMatchObject({ automations: [], runs: [] })
  })

  it('pausing drops the scheduled runs waiting their turn', () => {
    svc.setWindowReady(true)
    svc.setSettings({ maxConcurrent: 1 })
    const a = svc.create(input({ name: 'A' })).automation
    const b = svc.create(input({ name: 'B' })).automation
    svc.runNow(a.id)
    clock = at(9, 0) + 1000
    svc.tick() // b is due, waits for a slot
    expect(svc.snapshot().runs.find((r) => r.automationId === b.id).status).toBe('pending')
    svc.setEnabled(b.id, false)
    expect(svc.snapshot().runs.find((r) => r.automationId === b.id)).toMatchObject({ status: 'skipped_unavailable', errorCode: 'paused' })
  })

  it('a remote project: its prompt is written in its folder on the host first, then the run is sent', async () => {
    svc.setWindowReady(true)
    const a = svc.create(input({ projectCwd: null, remote: { hostId: 'ssh-host-1', path: '/srv/app' } })).automation
    svc.runNow(a.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(remoteWrites).toEqual([{ hostId: 'ssh-host-1', path: '/srv/app', file: `.tessel/automations/${a.id}.md`, text: 'Check the repo.\nReport risks.\n' }])
    expect(dispatches()[0]).toMatchObject({ promptFile: null, promptDir: null, remoteFile: `.tessel/automations/${a.id}.md` })
    // The host refused the file: the run fails, nothing is sent.
    remoteAnswer = { ok: false, error: 'Permission denied' }
    svc.markResult({ runId: dispatches()[0].run.id, status: 'completed' })
    svc.runNow(a.id)
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatches()).toHaveLength(1)
    expect(svc.snapshot().runs.find((r) => r.errorCode === 'remote-prompt')).toMatchObject({ status: 'dispatch_failed', error: 'Permission denied' })
  })

  // Review 1: a slow start (copy + setup script) must never let a second run
  // of the same automation, or one over the cap, start meanwhile.
  it('a run the window took (ack) is not timed out at 3 minutes; the late pane of a failed run is refused', () => {
    svc.setWindowReady(true)
    svc.create(input({ schedule: '*/15 * * * *' }))
    clock = at(8, 15) + 1000
    svc.tick()
    const run = dispatches()[0].run
    svc.markResult({ runId: run.id, status: 'ack' })
    clock += 4 * MIN
    svc.tick()
    expect(svc.status(run.id)).toBe('dispatching')
    clock = at(8, 30) + 1000
    svc.tick()
    expect(dispatches()).toHaveLength(1) // the next occurrence is an overlap
    // Past an hour even an acknowledged start fails, and its late pane is told so.
    clock += 61 * MIN
    svc.tick()
    expect(svc.status(run.id)).toBe('dispatch_failed')
    const late = svc.markResult({ runId: run.id, status: 'dispatched', paneId: 'pane-late' })
    expect(late.run.status).toBe('dispatch_failed')
  })

  it('an unanswered run fails after 3 minutes; the window then sees it is no longer wanted', () => {
    svc.setWindowReady(true)
    const a = svc.create(input()).automation
    const { run } = svc.runNow(a.id)
    clock += 4 * MIN
    svc.tick()
    expect(svc.status(run.id)).toBe('dispatch_failed')
    expect(svc.markResult({ runId: run.id, status: 'dispatched', paneId: 'p' }).run.status).toBe('dispatch_failed')
  })

  // Review 2: a started run never holds its slot forever.
  it('a started run that never ends fails after 24 hours and frees the automation', () => {
    svc.setWindowReady(true)
    const a = svc.create(input()).automation
    const { run } = svc.runNow(a.id)
    svc.markResult({ runId: run.id, status: 'dispatched', paneId: 'p' })
    clock += 25 * 60 * MIN
    svc.tick()
    expect(svc.snapshot().runs.find((r) => r.id === run.id)).toMatchObject({ status: 'dispatch_failed', errorCode: 'stale' })
    // Its next occurrence (9:00, within grace) runs again.
    expect(dispatches()).toHaveLength(2)
    expect(dispatches()[1].automation.id).toBe(a.id)
  })

  // Review 5: a clock that jumped forward and came back.
  it('the schedule follows the clock back after a jump forward', () => {
    svc.setWindowReady(true)
    const a = svc.create(input()).automation
    const real = clock
    clock = new Date(2031, 0, 1, 12, 0).getTime()
    svc.tick()
    expect(svc.snapshot().automations[0].nextRunAt).toBeGreaterThan(new Date(2031, 0, 1).getTime())
    clock = real + MIN
    svc.tick()
    const back = svc.snapshot().automations.find((x) => x.id === a.id)
    expect(back.nextRunAt).toBe(at(9, 0))
    expect(back.dtstart).toBeLessThanOrEqual(clock)
  })

  // Review 6: what you confirmed is what runs.
  it('changing the agent, project, place or prompt asks for a new confirmation; the permissions you saw are kept', () => {
    const a = svc.create(input({ confirmSig: 'p1:aaaa:10' })).automation
    expect(a.confirmedSig).toBe('p1:aaaa:10')
    expect(svc.update(a.id, { name: 'Renamed' }).ok).toBe(true)
    expect(svc.snapshot().automations[0].confirmedAt).not.toBe(null)
    for (const change of [{ agentId: 'codex' }, { prompt: 'Something else' }, { isolation: 'worktree' }, { wsId: 'ws-2' }, { projectCwd: 'C:\\other' }]) {
      expect(svc.update(a.id, change).code).toBe('needs-confirm')
    }
    expect(svc.update(a.id, { agentId: 'codex', enabled: false }).ok).toBe(true)
    expect(svc.snapshot().automations[0]).toMatchObject({ confirmedAt: null, confirmedSig: null, enabled: false })
    expect(svc.setEnabled(a.id, true).code).toBe('needs-confirm')
    expect(svc.setEnabled(a.id, true, true, 'p1:bbbb:12').ok).toBe(true)
    expect(svc.snapshot().automations[0].confirmedSig).toBe('p1:bbbb:12')
  })

  it('the same refusal from the window, run after run, is one row', () => {
    svc.setWindowReady(true)
    const a = svc.create(input({ schedule: '*/15 * * * *' })).automation
    for (const m of [15, 30, 45]) {
      clock = at(8, m) + 1000
      svc.tick()
      const run = dispatches().at(-1).run
      svc.markResult({ runId: run.id, status: 'skipped_unavailable', errorCode: 'permissions-changed' })
    }
    const rows = svc.snapshot().runs.filter((r) => r.automationId === a.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ errorCode: 'permissions-changed', occurrenceCount: 3 })
  })

  // Review 8: a deleted automation's running run keeps its prompt file.
  it('deleting while a run starts keeps its prompt until the run ends', () => {
    svc.setWindowReady(true)
    const a = svc.create(input()).automation
    const { run } = svc.runNow(a.id)
    const file = dispatches()[0].promptFile
    svc.remove(a.id)
    expect(fs.existsSync(file)).toBe(true)
    svc.markResult({ runId: run.id, status: 'dispatched', paneId: 'p' })
    svc.markResult({ runId: run.id, status: 'completed' })
    expect(fs.existsSync(file)).toBe(false)
    expect(svc.snapshot().runs).toEqual([])
  })

  it('reading the file checks every record again', () => {
    const good = svc.create(input()).automation
    svc.stop()
    const data = JSON.parse(fs.readFileSync(join(dir, AUTOMATIONS_FILE), 'utf8'))
    data.automations.push({ ...good, id: 'auto-bad-1', agentId: 'rm -rf' })
    data.automations.push({ ...good, id: 'not an id' })
    data.automations.push({ ...good, id: 'auto-noconfirm-1', confirmedAt: null, enabled: true })
    data.automations.push({ ...good, id: 'auto-often-1', schedule: '* * * * *' })
    data.runs.push({ id: 'run-bogus-123456', automationId: good.id, status: 'hacked', createdAt: 1 })
    data.runs.push({ id: 'run-okrun-123456', automationId: good.id, status: 'completed', createdAt: 1, paneId: 'a b;c', error: 'x'.repeat(5000) })
    fs.writeFileSync(join(dir, AUTOMATIONS_FILE), JSON.stringify(data))
    const again = make()
    again.start()
    const snap = again.snapshot()
    expect(snap.automations.map((x) => x.id).sort()).toEqual([good.id, 'auto-noconfirm-1'].sort())
    expect(snap.automations.find((x) => x.id === 'auto-noconfirm-1').enabled).toBe(false)
    expect(snap.runs.map((r) => r.id)).toEqual(['run-okrun-123456'])
    expect(snap.runs[0].paneId).toBe(null)
    expect(snap.runs[0].error).toHaveLength(2000)
    again.stop()
  })

  it('refuses a schedule that would open a pane every few minutes', () => {
    const res = svc.create(input({ schedule: '* * * * *' }))
    expect(res).toMatchObject({ ok: false, code: 'schedule-too-frequent' })
    expect(res.error).toMatch(/15 minutes/)
  })
})
