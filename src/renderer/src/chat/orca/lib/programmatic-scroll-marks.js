// After Orca's programmatic-scroll-marks.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
const SCROLL_MARK_MATCH_EPSILON = 2
// Why: a bounded queue is the staleness limit. Wall-clock expiry would
// reintroduce the timing assumptions this module exists to remove. Known
// accepted window: a marked no-op write emits no scroll event, so its target
// can linger and claim a later user scroll within the epsilon; the bound and
// splice-on-match keep that window narrow.
const MAX_PENDING_SCROLL_MARKS = 16

/**
 * Distinguishes self-initiated scrolls from user scrolls by explicit marks
 * instead of wall-clock input windows. The system always knows when it writes
 * scrollTop; it can never reliably know when the user scrolled — under
 * main-thread jank, input events dispatch late and time-window heuristics
 * misclassify exactly when it matters.
 */
export function createProgrammaticScrollMarks() {
  const pendingTargets = []
  const classifiedEvents = new WeakMap()

  const matchesTarget = (targetOffset, scrollOffset, maxScrollOffset) => {
    if (Math.abs(scrollOffset - targetOffset) <= SCROLL_MARK_MATCH_EPSILON) {
      return true
    }
    // Why: a write past the scrollable range lands at the clamped max, not at
    // its target; that landing is still our scroll, not the user's.
    return (
      targetOffset > maxScrollOffset + SCROLL_MARK_MATCH_EPSILON &&
      scrollOffset >= maxScrollOffset - SCROLL_MARK_MATCH_EPSILON
    )
  }

  return {
    mark: (targetOffset) => {
      pendingTargets.push(targetOffset)
      if (pendingTargets.length > MAX_PENDING_SCROLL_MARKS) {
        pendingTargets.shift()
      }
    },
    consume: (event, scrollOffset, maxScrollOffset) => {
      const cached = classifiedEvents.get(event)
      if (cached !== undefined) {
        return cached
      }
      const matchedIndex = pendingTargets.findIndex((targetOffset) =>
        matchesTarget(targetOffset, scrollOffset, maxScrollOffset),
      )
      if (matchedIndex !== -1) {
        // Why: scroll events arrive in write order; older marks whose events
        // were coalesced away must not linger to claim a later user scroll.
        pendingTargets.splice(0, matchedIndex + 1)
      }
      const isProgrammatic = matchedIndex !== -1
      classifiedEvents.set(event, isProgrammatic)
      return isProgrammatic
    },
  }
}
