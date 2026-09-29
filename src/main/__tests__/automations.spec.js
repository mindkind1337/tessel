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
  const make = () =>
    createAutomations({
      dir,
      now: () => clock,
      send: (channel, payload) => sent.push({ channel, payload }),
      timers: { setInterval: () => null, clearInterval: () => {} }
    })
  const dispatches = () => sent.filter((s) => s.channel === 'automations:dispatch').map((s) => s.payload)

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'automations-test-'))
    clock = at(8, 0)
    sent = []
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
    const { automation } = svc.create(input({ schedule: '*/10 * * * *' }))
    clock = at(8, 10) + 1000
    svc.tick()
    const first = dispatches()[0].run
    svc.markResult({ runId: first.id, status: 'dispatched', paneId: 'p1' })
    clock = at(8, 20) + 1000
    svc.tick()
    clock = at(8, 30) + 1000
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
    expect(again.reconcile(['pane-a'])).toEqual([{ id: ra.id, automationId: a.id, paneId: 'pane-a', taskId: null }])
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
    svc.runNow(a.id)
    const folder = dispatches()[0].promptDir
    expect(fs.existsSync(folder)).toBe(true)
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

  it('a remote project gets no prompt file (its prompt goes on the remote command line)', () => {
    svc.setWindowReady(true)
    const a = svc.create(input({ projectCwd: null, remote: { hostId: 'host-1', path: '/srv/app' } })).automation
    svc.runNow(a.id)
    expect(dispatches()[0]).toMatchObject({ promptFile: null, promptDir: null })
  })
})
