// Agent sleep (Settings > Agents): which agent panes may have their terminal
// stopped to free memory. Pure, so every rule is tested (agentSleep.spec.js).
//
// leaf:   { kind, agentId, agentCommand, sessionId, sleeping, failed, inTeam }
// state:  its resolved state now ('idle' only; unknown never counts)
// since:  when that idle state began (ms); lastKey: your last keystroke there
// draft:  something typed and not sent (or not known)
// active: the pane you are in; restarting: being restarted now
// -> '' when it may sleep, else why not (for the log and tests).
export function sleepBlocker({ leaf, resumable, state, trackedState, since, lastKey = 0, draft, active, restarting, minutes, now }) {
  if (!leaf || leaf.kind !== 'agent' || !leaf.agentCommand) return 'not an agent'
  if (leaf.sleeping) return 'asleep'
  if (leaf.failed) return 'failed'
  // Only an agent whose conversation Tessel can resume.
  if (!resumable) return 'no conversation to resume'
  // Teammates must answer messages.
  if (leaf.inTeam) return 'in a team'
  if (state !== 'idle') return `state ${state}`
  if (trackedState !== 'idle' || !Number.isFinite(since)) return 'idle time unknown'
  const wait = minutes * 60 * 1000
  if (now - since < wait) return 'not idle long enough'
  if (now - lastKey < wait) return 'typed in lately'
  if (draft) return 'something typed'
  if (active) return 'the pane you are in'
  if (restarting) return 'restarting'
  return ''
}
export const sleepEligible = (q) => sleepBlocker(q) === ''
