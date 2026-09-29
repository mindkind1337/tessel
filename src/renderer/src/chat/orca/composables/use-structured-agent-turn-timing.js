// After Orca's use-structured-agent-turn-timing.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import { computed, shallowRef, toValue, watch } from 'vue'
import {
  selectStructuredAgentRunningTurnTiming,
  selectStructuredAgentSettledTurns,
} from '../shared/structured-agent-session-turn-timing.js'
import { stepStructuredAgentTurnClock } from '../shared/structured-agent-turn-clock-anchor.js'

export function useStructuredAgentTurnTiming(options, turnId) {
  const read = (key) => toValue(toValue(options)[key])
  const settledTurns = computed(() =>
    selectStructuredAgentSettledTurns(read('items'), read('submissions')),
  )
  const runningTiming = computed(() =>
    toValue(turnId) === null
      ? null
      : selectStructuredAgentRunningTurnTiming(read('items'), toValue(turnId)),
  )
  let latch = null
  const workingStartedAt = shallowRef(null)
  watch(
    [runningTiming, () => toValue(turnId), () => read('hostClock')],
    () => {
      const step = stepStructuredAgentTurnClock({
        timing: runningTiming.value,
        turnId: toValue(turnId),
        now: Date.now,
        hostClock: read('hostClock'),
        latch,
      })
      latch = step.latch
      workingStartedAt.value = step.workingStartedAt
    },
    { immediate: true, flush: 'sync' },
  )
  return { settledTurns, workingStartedAt }
}
