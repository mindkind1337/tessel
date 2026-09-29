// Words for scheduled automations in the interface's language: schedules,
// run statuses and reasons, the grace choices and the templates (Orca's
// automation-schedule-label.ts, automation-page-parts.tsx,
// AutomationMissedRunGraceField.tsx and automation-templates.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.).
import { t, intlLocale } from './i18n'
import { describeSchedule, MAX_OPEN_PANES_PER_AUTOMATION, MAX_COPIES_PER_AUTOMATION } from '../../shared/automations'

export function weekdayNames() {
  const fmt = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long' })
  // 2023-01-01 was a Sunday.
  return [0, 1, 2, 3, 4, 5, 6].map((d) => fmt.format(new Date(2023, 0, 1 + d, 12)))
}

export function formatTime(hour, minute) {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  return new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric', minute: '2-digit' }).format(d)
}

export function scheduleLabel(schedule) {
  const d = describeSchedule(schedule)
  if (d.kind === 'invalid') return t('automations.schedule.invalid', 'Invalid schedule')
  if (d.kind === 'custom') return t('automations.schedule.custom', 'Custom schedule')
  if (d.kind === 'hourly') return t('automations.schedule.hourlyAt', 'Hourly at :{{minute}}', { minute: String(d.minute).padStart(2, '0') })
  const time = formatTime(d.hour, d.minute)
  if (d.kind === 'daily') return t('automations.schedule.dailyAt', 'Daily at {{time}}', { time })
  if (d.kind === 'weekdays') return t('automations.schedule.weekdaysAt', 'Weekdays at {{time}}', { time })
  return t('automations.schedule.weeklyAt', '{{day}}s at {{time}}', { day: weekdayNames()[d.dayOfWeek], time })
}

export function presetLabel(preset) {
  switch (preset) {
    case 'hourly':
      return t('automations.preset.hourly', 'Hourly')
    case 'daily':
      return t('automations.preset.daily', 'Daily')
    case 'weekdays':
      return t('automations.preset.weekdays', 'Weekdays')
    case 'weekly':
      return t('automations.preset.weekly', 'Weekly')
    default:
      return t('automations.preset.custom', 'Custom cron')
  }
}

export function graceLabel(minutes) {
  switch (minutes) {
    case 0:
      return t('automations.grace.none', 'No grace')
    case 30:
      return t('automations.grace.30m', '30 minutes')
    case 60:
      return t('automations.grace.1h', '1 hour')
    case 180:
      return t('automations.grace.3h', '3 hours')
    case 720:
      return t('automations.grace.12h', '12 hours')
    case 1440:
      return t('automations.grace.24h', '24 hours')
    default:
      return t('automations.grace.48h', '48 hours')
  }
}

export function statusLabel(status) {
  switch (status) {
    case 'pending':
      return t('automations.status.pending', 'Queued')
    case 'dispatching':
      return t('automations.status.dispatching', 'Starting')
    case 'dispatched':
      return t('automations.status.dispatched', 'Running')
    case 'completed':
      return t('automations.status.completed', 'Done')
    case 'skipped_missed':
    case 'skipped_unavailable':
      return t('automations.status.skipped', 'Skipped')
    default:
      return t('automations.status.failed', 'Failed')
  }
}

// 'ok' | 'running' | 'skipped' | 'failed', for the badge color.
export function statusTone(status) {
  if (status === 'completed') return 'ok'
  if (status === 'pending' || status === 'dispatching' || status === 'dispatched') return 'running'
  if (status === 'dispatch_failed') return 'failed'
  return 'skipped'
}

// Why a run was skipped or failed. `error` is the detail the window gave.
export function runReason(run) {
  if (!run) return ''
  const detail = run.error || ''
  switch (run.errorCode) {
    case 'missed':
      return t('automations.reason.missed', 'This run was past its missed-run grace window when Tessel next checked.')
    case 'overlap':
      return t('automations.reason.overlap', 'The previous run of this automation was still going.')
    case 'paused':
      return t('automations.reason.paused', 'The automation was paused before this run started.')
    case 'deleted':
      return t('automations.reason.deleted', 'The automation was deleted before this run started.')
    case 'interrupted':
      return t('automations.reason.interrupted', 'Tessel closed while this run was starting.')
    case 'pane-gone':
      return t('automations.reason.paneGone', 'Its pane was gone when Tessel reopened.')
    case 'pane-closed':
      return t('automations.reason.paneClosed', 'Its pane was closed before the agent finished.')
    case 'no-answer':
      return t('automations.reason.noAnswer', 'The window did not start this run.')
    case 'unevaluable':
      return t('automations.reason.unevaluable', 'Tessel could not evaluate this automation and skipped the occurrence.')
    case 'prompt-file':
      return t('automations.reason.promptFile', 'The prompt file could not be written: {{error}}', { error: detail })
    case 'project-gone':
      return t('automations.reason.projectGone', 'The target project is no longer available.')
    case 'agent-unavailable':
      return t('automations.reason.agentUnavailable', 'The agent is not available (turned off in Settings > Agents, or not installed).')
    case 'copy-failed':
      return t('automations.reason.copyFailed', 'Its own copy of the project could not be made: {{error}}', { error: detail })
    case 'pane-failed':
      return t('automations.reason.paneFailed', 'Its pane could not be opened.')
    case 'unsafe-path':
      return t('automations.reason.unsafePath', 'The prompt could not be put on the agent\'s command line safely (the path of Tessel\'s data folder has unusual characters).')
    case 'permissions-changed':
      return t('automations.reason.permissionsChanged', "Its agent's permissions changed since you confirmed it (Settings > Agents): confirm it again to let it run.")
    case 'too-many-panes':
      return t('automations.reason.tooManyPanes', 'Panes of its previous runs are still open ({{max}} at most): close them to let it run again.', { max: MAX_OPEN_PANES_PER_AUTOMATION })
    case 'too-many-copies':
      return t('automations.reason.tooManyCopies', 'Copies made by its previous runs wait for your review ({{max}} at most): merge or discard them to let it run again.', { max: MAX_COPIES_PER_AUTOMATION })
    case 'agent-exited':
      return t('automations.reason.agentExited', 'Its agent exited before it finished.')
    case 'agent-no-start':
      return t('automations.reason.agentNoStart', 'Its agent did not start (no sign of it after 5 minutes). Its pane stays open so you can see why.')
    case 'stale':
      return t('automations.reason.stale', 'It had not finished after 24 hours.')
    case 'clock-change':
      return t('automations.reason.clockChange', "Not run again: the computer's clock went back after this time had already been handled.")
    case 'remote-prompt-link':
      return t('automations.reason.remotePromptLink', 'Its prompt was not written on the remote host: .tessel/automations (or a file in it) is a link in the project. Tessel writes only to a real folder there.')
    case 'remote-prompt':
      return t('automations.reason.remotePrompt', 'Its prompt could not be written on the remote host: {{error}}', { error: detail })
    default:
      return detail
  }
}

export function triggerLabel(trigger) {
  return trigger === 'manual' ? t('automations.trigger.manual', 'Run now') : t('automations.trigger.scheduled', 'Scheduled')
}

export function formatDateTime(ms) {
  if (!ms) return t('automations.never', 'Never')
  return new Intl.DateTimeFormat(intlLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms)
}

// "in 5 min", "3 h ago" (Orca's formatAutomationRelativeTime, in words).
export function relativeTime(ms, now = Date.now()) {
  if (!ms) return ''
  try {
    const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto', style: 'short' })
    const diff = ms - now
    const abs = Math.abs(diff)
    if (abs < 60000) return rtf.format(0, 'minute')
    if (abs < 3600000) return rtf.format(Math.round(diff / 60000), 'minute')
    if (abs < 86400000) return rtf.format(Math.round(diff / 3600000), 'hour')
    return rtf.format(Math.round(diff / 86400000), 'day')
  } catch {
    return ''
  }
}

// Orca's templates: { id, name, prompt, preset, time, dayOfWeek, grace }.
export function automationTemplates() {
  return [
    {
      id: 'repo-health-weekday',
      label: t('automations.templates.repoHealth.label', 'Weekday repo audit'),
      description: t('automations.templates.repoHealth.description', 'Check dependencies, failing tests, and risky open changes each weekday.'),
      name: t('automations.templates.repoHealth.name', 'Weekday repo audit'),
      prompt: t('automations.templates.repoHealth.prompt', 'Review the repository health. Check dependency updates, failing tests, lint/typecheck status, and risky open changes. Summarize findings and suggest the next action.'),
      preset: 'weekdays',
      time: '09:00',
      grace: 720
    },
    {
      id: 'release-prep-weekly',
      label: t('automations.templates.releasePrep.label', 'Release readiness'),
      description: t('automations.templates.releasePrep.description', 'Prepare a weekly release risk summary from the current project state.'),
      name: t('automations.templates.releasePrep.name', 'Release readiness review'),
      prompt: t('automations.templates.releasePrep.prompt', 'Prepare a release readiness summary. Look for blockers, unmerged risky changes, missing validation, and documentation gaps. End with a concise release/no-release recommendation.'),
      preset: 'weekly',
      time: '14:00',
      dayOfWeek: 4,
      grace: 1440
    },
    {
      id: 'recurring-review-daily',
      label: t('automations.templates.recurringReview.label', 'Daily change review'),
      description: t('automations.templates.recurringReview.description', 'Scan recent work and call out correctness, UX, and test coverage risks.'),
      name: t('automations.templates.recurringReview.name', 'Daily change review'),
      prompt: t('automations.templates.recurringReview.prompt', 'Review recent changes in this workspace. Focus on correctness risks, UX regressions, missing tests, and follow-up tasks. Keep the report short and actionable.'),
      preset: 'daily',
      time: '16:30',
      grace: 180
    },
    {
      id: 'maintenance-hourly',
      label: t('automations.templates.maintenance.label', 'Hourly queue check'),
      description: t('automations.templates.maintenance.description', 'Look for stuck work, stale generated files, and failed local validation.'),
      name: t('automations.templates.maintenance.name', 'Hourly maintenance check'),
      prompt: t('automations.templates.maintenance.prompt', 'Check for stuck work, stale generated files, failing validation, and anything that needs human attention. Report only actionable issues.'),
      preset: 'hourly',
      time: '00:15',
      grace: 30
    }
  ]
}
