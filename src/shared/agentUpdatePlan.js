// Agent updates (Settings > Agents): when a pane running an agent may be
// stopped and restarted in place for an update, and which panes an update
// restarts. Pure, so every rule is tested (agentUpdatePlan.spec.js).
//
// An update never stops a working agent, one waiting for an approval or at
// its usage limit, one whose idle state is not confirmed (Claude Code and
// Codex report theirs through hooks), a pane with something typed in it or
// typed in lately, the pane you are in, nor one a team message is being
// delivered to. Such panes wait; the others are restarted with their
// conversation resumed.

export const UPDATE_QUIET_MS = 30 * 1000 // idle at least this long
export const UPDATE_USER_AWAY_MS = 30 * 1000 // no key typed there for this long

// pane: { kind, agentId, agentCommand, sleeping, failed }
// resumable: its conversation can be resumed (restarted without losing it)
// managed: its state comes from its own hooks (Claude Code, Codex);
//   confirmed: that state is fresh for this launch
// state: its resolved state ('idle', 'working', 'approval', 'limited', ...)
// trackedState/since: Tessel's tracked state and since when (ms)
// approval, limited, draft (typed and not sent, or not known), lastKey (your
// last keystroke there), focused (the pane you are in, window focused),
// delivering (a team message being typed/sent there, or waiting to be),
// recentReminder (a wake-up line typed there a moment ago), restarting
// -> '' when it may be restarted now, else why not (shown to the user).
export function updateBlocker({
  pane,
  resumable,
  managed,
  confirmed,
  state,
  trackedState,
  since,
  approval,
  limited,
  draft,
  lastKey = 0,
  focused,
  delivering,
  recentReminder,
  restarting,
  now,
  quietMs = UPDATE_QUIET_MS,
  awayMs = UPDATE_USER_AWAY_MS
}) {
  if (!pane || pane.kind !== 'agent' || !pane.agentCommand) return 'not an agent pane'
  if (restarting) return 'being restarted'
  if (!resumable) return 'its conversation cannot be resumed'
  if (approval || state === 'approval') return 'waiting for an approval'
  if (limited || state === 'limited') return 'at its usage limit'
  if (managed && !confirmed) return 'its idle state is not confirmed yet'
  if (state !== 'idle') return state === 'working' ? 'working' : `state ${state || 'unknown'}`
  if (trackedState !== 'idle' || !Number.isFinite(since)) return 'idle time unknown'
  if (now - since < quietMs) return 'just finished working'
  if (draft) return 'something is typed in it'
  if (now - lastKey < awayMs) return 'you typed there lately'
  if (focused) return 'you are in this pane'
  if (delivering) return 'a team message is being delivered'
  if (recentReminder) return 'a reminder was just typed there'
  return ''
}

// The panes running one agent, each { id, label, sleeping, blocker }.
// -> { running, ready, waiting, manual, allReady }
//   running: panes whose agent process runs (a sleeping pane runs nothing:
//            it starts the new version when woken)
//   ready:   may be restarted in place now
//   waiting: [{ id, label, why }] safe later (working, typed in, ...)
//   manual:  [{ id, label, why }] never restarted by Tessel (no conversation
//            to resume): you restart them yourself
//   allReady: every running pane may be stopped now (needed to stop them
//            all before an update whose files they lock)
export function planUpdate(panes) {
  const running = (Array.isArray(panes) ? panes : []).filter((p) => p && !p.sleeping)
  const ready = []
  const waiting = []
  const manual = []
  for (const p of running) {
    if (!p.blocker) ready.push(p.id)
    else if (p.blocker === 'its conversation cannot be resumed' || p.blocker === 'not an agent pane')
      manual.push({ id: p.id, label: p.label, why: p.blocker })
    else waiting.push({ id: p.id, label: p.label, why: p.blocker })
  }
  return { running: running.map((p) => p.id), ready, waiting, manual, allReady: ready.length === running.length }
}

// Automatic updates (Settings > Agents, off by default) start only at a safe
// moment: no pane runs that agent, or every one that does may be restarted
// now; and you have not typed anywhere for a while (the update opens a pane).
export function autoUpdateMoment({ plan, lastAnyKey = 0, now, awayMs = 60 * 1000 }) {
  if (now - lastAnyKey < awayMs) return 'you are typing'
  if (!plan) return ''
  if (plan.manual.length) return 'a pane runs it without a conversation to resume'
  if (!plan.allReady) return 'a pane running it is busy'
  return ''
}

// "#2 Claude Code, #3 Codex CLI (working)" for toasts.
export function describeWaiting(list) {
  return (Array.isArray(list) ? list : []).map((w) => `${w.label} (${w.why})`).join(', ')
}
