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
  quoteGlobArgs,
  minIntervalMinutes,
  permissionFingerprint,
  remotePromptFile,
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

  it('a time skipped when clocks go forward runs an hour later, cron and RRULE alike', () => {
    // Find a spring-forward day in this machine's time zone (none: nothing to check).
    let day = null
    for (let d = 0; d < 400 && day === null; d++) {
      const a = new Date(2026, 0, 1 + d, 0, 0).getTime()
      const b = new Date(2026, 0, 2 + d, 0, 0).getTime()
      if (b - a < 24 * 3600_000) day = new Date(2026, 0, 1 + d)
    }
    if (!day) return
    // The skipped hour: the one whose wall time does not exist that day.
    let hour = 0
    for (let h = 0; h < 24; h++) if (new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 30).getHours() !== h) hour = h
    const before = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0).getTime()
    const cron = nextOccurrenceAfter(`30 ${hour} * * *`, 0, before)
    const rrule = nextOccurrenceAfter(`FREQ=DAILY;BYHOUR=${hour};BYMINUTE=30`, 0, before)
    expect(cron).toBe(rrule)
    expect(new Date(cron).getDate()).toBe(day.getDate())
  })

  // Recheck B1: the repeated hour when clocks go back.
  it('an hourly schedule runs in both copies of a repeated hour; a daily time once', () => {
    let day = null
    for (let d = 0; d < 400 && day === null; d++) {
      const a = new Date(2026, 0, 1 + d, 0, 0).getTime()
      const b = new Date(2026, 0, 2 + d, 0, 0).getTime()
      if (b - a > 24 * 3600_000) day = new Date(2026, 0, 1 + d)
    }
    if (!day) return
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0).getTime()
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0).getTime()
    const count = (schedule) => {
      let n = 0
      let at = start - 1
      for (;;) {
        const c = nextOccurrenceAfter(schedule, 0, at)
        if (c >= end) return n
        expect(c).toBeGreaterThan(at)
        n++
        at = c
      }
    }
    expect(count('FREQ=HOURLY;BYMINUTE=0')).toBe(25)
    expect(count('0 * * * *')).toBe(25)
    const repeated = [...Array(24).keys()].find((h) => {
      const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0).getTime()
      return new Date(t + 3600_000).getHours() === h
    })
    expect(count(`0 ${repeated} * * *`)).toBe(1)
    // Inside the second copy of that hour: the occurrence found is that one, and the next is ahead.
    const first = new Date(day.getFullYear(), day.getMonth(), day.getDate(), repeated, 0).getTime()
    const second = first + 3600_000
    expect(latestOccurrenceAtOrBefore('FREQ=HOURLY;BYMINUTE=0', 0, second + 10_000)).toBe(second)
    expect(nextOccurrenceAfter('FREQ=HOURLY;BYMINUTE=0', 0, second + 10_000)).toBe(second + 3600_000)
    expect(latestOccurrenceAtOrBefore('0 * * * *', 0, second + 10_000)).toBe(second)
  })

  it('measures the shortest time between runs', () => {
    expect(minIntervalMinutes('FREQ=HOURLY;BYMINUTE=0')).toBe(60)
    expect(minIntervalMinutes('*/15 * * * *')).toBe(15)
    expect(minIntervalMinutes('* * * * *')).toBe(1)
    expect(minIntervalMinutes('0 9 * * 1-5')).toBeGreaterThanOrEqual(24 * 60)
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
    // A pane (and a copy) every minute: refused.
    expect(normalizeAutomationInput({ ...base, schedule: '* * * * *' }).error).toBe('schedule-too-frequent')
    expect(normalizeAutomationInput({ ...base, schedule: '0,5 9 * * *' }).error).toBe('schedule-too-frequent')
    expect(normalizeAutomationInput({ ...base, schedule: '*/15 * * * *' }).error).toBeUndefined()
    expect(normalizeAutomationInput({ ...base, remote: { hostId: 'h1', path: '/srv/app' }, isolation: 'project', prompt: 'x'.repeat(4000) }).error).toBeUndefined()
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
  it('a remote project reads its prompt from a file in its folder: no prompt text on the command line', () => {
    const rel = remotePromptFile('auto-1b2c-3d')
    expect(rel).toBe('.tessel/automations/auto-1b2c-3d.md')
    expect(automationLaunchArgs('claude', { remoteFile: rel })).toBe(' "Tessel automation run. Read the file .tessel/automations/auto-1b2c-3d.md and carry out the task it describes."')
    expect(automationLaunchArgs('gemini', { remoteFile: rel })).toMatch(/^ -i "Tessel automation run/)
    // The reviewer's fish/tcsh cases never reach a shell: only this shape is taken.
    expect(automationLaunchArgs('claude', { remoteFile: ".tessel/automations/x\\' ; touch /tmp/pwned ; echo '.md" })).toBe('')
    expect(automationLaunchArgs('claude', { remoteFile: '.tessel/automations/auto-a!b.md' })).toBe('')
    expect(automationLaunchArgs('claude', { inlinePrompt: 'x' })).toBe('')
  })
  it('accepts accented, apostrophe and parenthesis folders (French user names), refuses shell metacharacters', () => {
    const B = '\\'
    const dir = ['C:', 'Users', "Jérôme O'Neil (perso)", 'AppData', 'Roaming', 'tessel', 'automations', 'runs', 'run-1'].join(B)
    const out = automationLaunchArgs('claude', { promptFile: `${dir}${B}prompt.md`, promptDir: dir })
    expect(out).toContain(`Read the file ${dir}${B}prompt.md`)
    expect(automationLaunchArgs('codex', { promptFile: `${dir}${B}prompt.md`, promptDir: dir, shellId: 'wsl' })).toContain("/mnt/c/Users/Jérôme O'Neil (perso)/")
    for (const bad of ['a%b', 'a&b', 'a`b', 'a!b', 'a;b', 'a^b', 'a$b', 'a"b', 'a’b']) {
      expect(automationLaunchArgs('claude', { promptFile: `C:${B}Users${B}${bad}${B}p.md`, promptDir: `C:${B}Users${B}${bad}` })).toBe('')
    }
  })
  it('quotes glob characters of launch flags for a remote shell (zsh "no matches found")', () => {
    expect(quoteGlobArgs(' --model opus[1m] --effort high')).toBe(' --model "opus[1m]" --effort high')
    expect(quoteGlobArgs(' -m gpt-5')).toBe(' -m gpt-5')
  })
  it('fingerprints the permissions without keeping their values', () => {
    const a = permissionFingerprint('["claude","--dangerously-skip-permissions",["KEY=secret"]]')
    expect(a).toMatch(/^p1:[0-9a-f]{8}:\d+$/)
    expect(a).not.toContain('secret')
    expect(permissionFingerprint('["claude","",[]]')).not.toBe(a)
  })
})
