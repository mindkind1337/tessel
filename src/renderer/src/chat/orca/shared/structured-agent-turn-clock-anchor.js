// After Orca's structured-agent-turn-clock-anchor.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// The client half of a turn's elapsed time: one host-to-local clock conversion,
// latched at first sight of the turn and kept for the rest of it. Desktop and
// mobile both drive this; neither owns a copy.
//
// The offset is latched rather than re-derived because `receivedAt - hostNow` is
// skew PLUS the one-way delivery latency of that one sample, and the reducer
// replaces the sample on every frame carrying one. Re-deriving later would
// import fresh transport jitter and could move the anchor LATER, running the
// counter backwards. With the offset fixed, an origin that improves moves the
// anchor earlier by exactly that much, so displayed elapsed only ever grows.

import { structuredAgentTurnLocalStartedAt } from './structured-agent-session-turn-timing.js'

/** One turn's conversion basis: the client instant it was first seen, and the
 *  host's own clock advanced to that instant. Both stamped once, per turn. */

export function latchStructuredAgentTurnClock(turnId, now, hostClock) {
  return {
    turnId,
    firstSeenAt: now,
    ...(hostClock ? { hostNow: hostClock.hostNow + (now - hostClock.receivedAt) } : {}),
  }
}

/** Reads the clock. Taken as a thunk because a turn that is already latched must
 *  not read it at all — the conversion is fixed and a render is not a new sighting. */

/** The live counter's anchor for one render. Returns the latch it was given,
 *  unchanged, while the turn holds, so a caller can compare by reference. */
export function stepStructuredAgentTurnClock(input) {
  const { timing, turnId, latch } = input
  if (turnId === null) {
    return { latch: null, workingStartedAt: null }
  }
  const next =
    latch?.turnId === turnId
      ? latch
      : latchStructuredAgentTurnClock(turnId, input.now(), input.hostClock)
  return {
    latch: next,
    workingStartedAt: timing
      ? structuredAgentTurnLocalStartedAt(timing, next.firstSeenAt, next.hostNow)
      : null,
  }
}
