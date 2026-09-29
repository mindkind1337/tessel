import { describe, it, expect } from 'vitest'
import {
  parseCronExpression,
  isValidSchedule,
  buildAutomationRrule,
  buildAutomationCronSchedule,
  nextOccurrenceAfter,
  latestOccurrenceAtOrBefore,
  describeSchedule,
  scheduleToDraft,
  draftToSchedule,
  missedBeyondGrace,
  pruneRuns,
  nextRunNumber,
  normalizeAutomationInput,
  automationLaunchArgs,
  wslPath,
  posixQuote,
  MAX_RUNS_PER_AUTOMATION
} from '../automations'

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

describe('schedules (Orca dialect)', () => {
  it('builds the preset RRULEs and crons', () => {
    expect(buildAutomationRrule({ preset: 'hourly', hour: 3, minute: 15 })).toBe('FREQ=HOURLY;BYMINUTE=15')
    expect(buildAutomationRrule({ preset: 'daily', hour: 9, minute: 0 })).toBe('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')
    expect(buildAutomationRrule({ preset: 'weekdays', hour: 9, minute: 30 })).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30')
    expect(buildAutomationRrule({ preset: 'weekly', hour: 14, minute: 0, dayOfWeek: 4 })).toBe('FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0')
    expect(buildAutomationCronSchedule({ preset: 'weekdays', hour: 9, minute: 5 })).toBe('5 9 * * 1-5')
  })

  it('validates crons like Orca: five fields, no oversized step, a date that exists', () => {
    expect(isValidSchedule('0 9 * * 1-5')).toBe(true)
    expect(isValidSchedule('*/15 * * * *')).toBe(true)
    expect(isValidSchedule('0 9 * *')).toBe(false)
    expect(isValidSchedule('*/90 * * * *')).toBe(false)
    expect(isValidSchedule('0 0 31 2 *')).toBe(false)
    expect(isValidSchedule('0 9 * * MON-FRI')).toBe(true)
    expect(isValidSchedule('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')).toBe(true)
    expect(isValidSchedule('FREQ=YEARLY')).toBe(false)
    // N/step is open-ended; a day field with a star is not restricted.
    expect([...parseCronExpression('5/20 * * * *').minutes]).toEqual([5, 25, 45])
    expect(parseCronExpression('0 0 */2 * 1').dayOfMonthRestricted).toBe(false)
  })

  it('finds the next and the latest occurrence', () => {
    const now = at(2026, 9, 29, 10, 7) // a Tuesday
    const daily = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'
    expect(nextOccurrenceAfter(daily, 0, now)).toBe(at(2026, 9, 30, 9, 0))
    expect(latestOccurrenceAtOrBefore(daily, 0, now)).toBe(at(2026, 9, 29, 9, 0))
    expect(nextOccurrenceAfter('FREQ=HOURLY;BYMINUTE=15', 0, now)).toBe(at(2026, 9, 29, 10, 15))
    expect(nextOccurrenceAfter('FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0', 0, now)).toBe(at(2026, 10, 5, 8, 0))
    expect(nextOccurrenceAfter('30 9 * * 1-5', 0, now)).toBe(at(2026, 9, 30, 9, 30))
    expect(latestOccurrenceAtOrBefore('30 9 * * 1-5', 0, now)).toBe(at(2026, 9, 29, 9, 30))
    // Not before its start.
    expect(latestOccurrenceAtOrBefore(daily, now, now)).toBe(null)
    expect(nextOccurrenceAfter('*/10 * * * *', 0, now)).toBe(at(2026, 9, 29, 10, 10))
  })

  it('describes a schedule without words (the window words it)', () => {
    expect(describeSchedule('FREQ=HOURLY;BYMINUTE=5')).toEqual({ kind: 'hourly', minute: 5 })
    expect(describeSchedule('0 9 * * 1-5')).toEqual({ kind: 'weekdays', hour: 9, minute: 0 })
    expect(describeSchedule('0 9 * * 3')).toEqual({ kind: 'weekly', hour: 9, minute: 0, dayOfWeek: 3 })
    expect(describeSchedule('0 9 1 * *')).toEqual({ kind: 'custom' })
    expect(describeSchedule('nope')).toEqual({ kind: 'invalid' })
  })

  it('goes between the editor fields and the stored schedule', () => {
    const d = scheduleToDraft('FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0')
    expect(d).toEqual({ preset: 'weekly', time: '14:00', dayOfWeek: 4, custom: '' })
    expect(draftToSchedule(d)).toBe('FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0')
    expect(scheduleToDraft('0 9 * * *')).toMatchObject({ preset: 'custom', custom: '0 9 * * *' })
  })
})

describe('missed runs and history', () => {
  it('skips an occurrence found past grace plus two ticks', () => {
    const scheduledFor = 1_000_000
    expect(missedBeyondGrace({ graceMinutes: 0, scheduledFor, now: scheduledFor + 90_000, tickMs: 60_000 })).toBe(false)
    expect(missedBeyondGrace({ graceMinutes: 0, scheduledFor, now: scheduledFor + 121_000, tickMs: 60_000 })).toBe(true)
    expect(missedBeyondGrace({ graceMinutes: 720, scheduledFor, now: scheduledFor + 11 * 3600_000, tickMs: 60_000 })).toBe(false)
  })

  it('keeps the newest final runs of each automation, and every unfinished one', () => {
    const runs = []
    for (let i = 0; i < MAX_RUNS_PER_AUTOMATION + 5; i++) runs.push({ id: `a${i}`, automationId: 'a', status: 'completed', createdAt: i, scheduledFor: i })
    runs.push({ id: 'live', automationId: 'a', status: 'dispatched', createdAt: -1, scheduledFor: -1 })
    runs.push({ id: 'b0', automationId: 'b', status: 'completed', createdAt: 0, scheduledFor: 0 })
    const kept = pruneRuns(runs)
    expect(kept.filter((r) => r.automationId === 'a' && r.status === 'completed')).toHaveLength(MAX_RUNS_PER_AUTOMATION)
    expect(kept.some((r) => r.id === 'a0')).toBe(false)
    expect(kept.some((r) => r.id === 'live')).toBe(true)
    expect(kept.some((r) => r.id === 'b0')).toBe(true)
    expect(nextRunNumber([{ runNumber: 7 }, { runNumber: 3 }])).toBe(8)
  })
})

describe('an automation from the window', () => {
  const base = {
    name: '  Nightly   audit ',
    prompt: 'Check things',
    agentId: 'claude',
    wsId: 'ws-1-2',
    projectName: 'App',
    projectCwd: 'C:\\code\\app',
    isolation: 'worktree',
    schedule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
    missedRunGraceMinutes: 60
  }
  it('is normalized', () => {
    const { value } = normalizeAutomationInput(base)
    expect(value).toMatchObject({ name: 'Nightly audit', agentId: 'claude', isolation: 'worktree', missedRunGraceMinutes: 60, after: { notify: true, closePane: false } })
  })
  it('is refused with a reason', () => {
    expect(normalizeAutomationInput({ ...base, name: ' ' }).error).toBe('name-required')
    expect(normalizeAutomationInput({ ...base, agentId: 'aider' }).error).toBe('agent-invalid')
    expect(normalizeAutomationInput({ ...base, schedule: '* *' }).error).toBe('schedule-invalid')
    expect(normalizeAutomationInput({ ...base, projectCwd: null }).error).toBe('project-required')
    expect(normalizeAutomationInput({ ...base, remote: { hostId: 'h1', path: '/srv/app' } }).error).toBe('remote-worktree')
    expect(normalizeAutomationInput({ ...base, remote: { hostId: 'h1', path: '/srv/app' }, isolation: 'project', prompt: 'x'.repeat(4000) }).error).toBe('remote-prompt-too-long')
  })
})

describe("the agent's command line", () => {
  const promptFile = 'C:\\Users\\me\\AppData\\Roaming\\tessel\\automations\\runs\\run-1\\prompt.md'
  const promptDir = 'C:\\Users\\me\\AppData\\Roaming\\tessel\\automations\\runs\\run-1'
  it('points the agent at the prompt file, with its folder readable', () => {
    const claude = automationLaunchArgs('claude', { promptFile, promptDir })
    expect(claude).toBe(` "Tessel automation run. Read the file ${promptFile} and carry out the task it describes." --add-dir "${promptDir}"`)
    expect(automationLaunchArgs('codex', { promptFile, promptDir })).toMatch(/^ "Tessel automation run\. Read the file C:\\/)
    expect(automationLaunchArgs('gemini', { promptFile, promptDir })).toMatch(/^ --include-directories ".*" -i "Tessel/)
  })
  it('refuses a path a shell could misread, and unknown agents', () => {
    expect(automationLaunchArgs('claude', { promptFile: 'C:\\Users\\a$b\\p.md', promptDir: 'C:\\Users\\a$b' })).toBe('')
    expect(automationLaunchArgs('claude', { promptFile: 'C:\\Users\\a"b\\p.md', promptDir: 'C:\\x' })).toBe('')
    expect(automationLaunchArgs('aider', { promptFile, promptDir })).toBe('')
  })
  it('uses /mnt paths in WSL', () => {
    expect(wslPath('C:\\Users\\me\\x.md')).toBe('/mnt/c/Users/me/x.md')
    expect(automationLaunchArgs('codex', { promptFile, promptDir, shellId: 'wsl' })).toContain('/mnt/c/Users/me/AppData/Roaming/tessel/automations/runs/run-1/prompt.md')
  })
  it('quotes a remote prompt for a POSIX shell, on one line', () => {
    expect(posixQuote("it's")).toBe(`'it'\\''s'`)
    expect(automationLaunchArgs('claude', { inlinePrompt: "Fix it's\nbugs; rm -rf $HOME" })).toBe(` 'Fix it'\\''s bugs; rm -rf $HOME'`)
    expect(automationLaunchArgs('gemini', { inlinePrompt: 'hi' })).toBe(" -i 'hi'")
    expect(automationLaunchArgs('claude', { inlinePrompt: 'x'.repeat(4000) })).toBe('')
  })
})
