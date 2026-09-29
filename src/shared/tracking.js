// Agent tracking: what each agent is doing, for how long, and whether it looks
// stuck. Pure, so the sidebar, the task cards, the pane header and the tests
// share the same rules.
//
// Levels: 'ok' (nothing to note), 'info' (worth knowing, not a problem),
// 'warn' (worth a look), 'alert' (needs you). The thresholds are starting
// values, not a standard (see Codex's research in .tessel/notes.md): a quiet
// agent may be compiling and a spinner may turn without progress, so nothing
// here claims an agent is stuck for sure.

import { english } from './i18nText'

export const TRACK = {
  approvalWarnMin: 2, // waiting for your approval
  approvalAlertMin: 10,
  idleOnTaskWarnMin: 10, // quiet while its task is still in Doing
  idleOnTaskAlertMin: 30,
  longTaskMin: 60 // one task in Doing for a long time (information only)
}

const MIN = 60 * 1000

// 45 s -> '<1 min', 12 min -> '12 min', 65 min -> '1 h 05'. t: the
// interface's t() (English without it).
export function formatSpan(ms, t = english) {
  const m = Math.floor(Math.max(0, ms) / MIN)
  if (m < 1) return t('tracking.span.underMinute', '<1 min')
  if (m < 60) return t('tracking.span.minutes', '{{m}} min', { m })
  const h = Math.floor(m / 60)
  return t('tracking.span.hours', '{{h}} h {{mm}}', { h, mm: String(m % 60).padStart(2, '0') })
}

function stateWord(state, t) {
  switch (state) {
    case 'unknown':
      return t('tracking.state.unknown', 'Status unknown')
    case 'working':
      return t('tracking.state.working', 'Working')
    case 'approval':
      return t('tracking.state.approval', 'Waiting for your approval')
    case 'limited':
      return t('tracking.state.limited', 'Usage limit')
    case 'sleeping':
      return t('tracking.state.sleeping', 'Asleep')
    default:
      return t('tracking.state.idle', 'Idle')
  }
}

// agent: { state: 'working'|'idle'|'approval'|'limited', since (ms), reset,
//          sinceStart: true when the state began before Tessel started and
//          its real start is unknown (the time shown is a minimum) }
// task: the task it is on ({ id, title, column, doingSince, startedAt }) or null
// t: the interface's t() (English without it)
// -> { text, level, kind ('approval'|'limit'|'quiet'|'long'|''), reason,
//      minutes, task, onTask }
export function trackAgent(agent, task, now = Date.now(), t = english) {
  const state = (agent && agent.state) || 'idle'
  const inState = now - ((agent && agent.since) || now)
  const mins = Math.floor(inState / MIN)
  const plus = agent && agent.sinceStart ? '+' : ''
  const span = (ms) => formatSpan(ms, t)
  let text = `${stateWord(state, t)} · ${span(inState)}${plus}`
  // The reset time the agent printed; it is not taken as over just because
  // that time has passed (the limit clears when the agent works again).
  if (state === 'limited' && agent.reset) text = t('tracking.limitResets', 'Usage limit · resets {{reset}}', { reset: agent.reset })
  let level = 'ok'
  let kind = ''
  let reason = ''
  const doing = task && task.column === 'doing'
  const taskStart = doing ? task.doingSince || task.startedAt || now : now
  const onTask = doing ? now - taskStart : 0
  // Quiet on the task: only the time it has been both quiet AND on this task
  // (an agent idle before the task began is not "stuck on it").
  const quietOnTask = doing ? now - Math.max(taskStart, (agent && agent.since) || now) : 0
  const quietMins = Math.floor(quietOnTask / MIN)

  if (state === 'approval' && mins >= TRACK.approvalWarnMin) {
    level = mins >= TRACK.approvalAlertMin ? 'alert' : 'warn'
    kind = 'approval'
    reason = t('tracking.reason.approval', 'Waiting for your approval for {{time}}.', { time: `${span(inState)}${plus}` })
  } else if (state === 'limited') {
    level = 'warn'
    kind = 'limit'
    reason = agent.reset
      ? t('tracking.reason.limitReset', 'Out of usage (reset shown: {{reset}}).', { reset: agent.reset })
      : t('tracking.reason.limit', 'Out of usage.')
  } else if (doing && state === 'idle' && quietMins >= TRACK.idleOnTaskWarnMin && agent && agent.answered) {
    // Its turn ended normally (it answered): it waits for you, it is not
    // stuck. Worth knowing, no warning, no notification.
    level = 'info'
    kind = 'waiting'
    reason = t('tracking.reason.waiting', 'Waiting for your answer for {{time}} ("{{task}}" is not finished).', {
      time: span(quietOnTask),
      task: task.title
    })
  } else if (doing && state === 'idle' && quietMins >= TRACK.idleOnTaskWarnMin) {
    level = quietMins >= TRACK.idleOnTaskAlertMin ? 'alert' : 'warn'
    kind = 'quiet'
    reason = t('tracking.reason.quiet', 'Quiet for {{time}} while "{{task}}" is not finished: it may be stuck or waiting for you.', {
      time: span(quietOnTask),
      task: task.title
    })
  } else if (doing && onTask >= TRACK.longTaskMin * MIN) {
    level = 'info'
    kind = 'long'
    reason = t('tracking.reason.long', 'Long-running task: on "{{task}}" for {{time}}.', { task: task.title, time: span(onTask) })
  }
  return {
    text,
    level,
    kind,
    reason,
    minutes: kind === 'quiet' ? quietMins : mins,
    task: task ? task.title : '',
    taskId: task ? task.id || task.title : '',
    onTask: doing ? span(onTask) : ''
  }
}
