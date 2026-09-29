// After Orca's use-native-chat-turn-status.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import { computed, shallowRef, toValue, watch } from 'vue'
import {
  reduceNativeChatTurnTiming,
  selectNativeChatTurnStatuses,
} from '../shared/native-chat-turn-status.js'

export function useNativeChatTurnStatus(options) {
  const read = (key) => toValue(toValue(options)[key])
  const activeTurnKey = computed(() => {
    const index = read('latestUserIndex')
    return (index !== -1 ? read('messages')[index]?.id : null) ?? '__unanchored__'
  })
  const timingByTurn = shallowRef({})
  watch(
    [
      activeTurnKey,
      () => read('messages'),
      () => read('isWorking'),
      () => read('workingStartedAt'),
    ],
    () => {
      timingByTurn.value = reduceNativeChatTurnTiming(timingByTurn.value, {
        activeTurnKey: activeTurnKey.value,
        validTurnKeys: new Set(
          read('messages')
            .filter((message) => message.role === 'user')
            .map((message) => message.id),
        ),
        isWorking: read('isWorking'),
        workingStartedAt: read('workingStartedAt'),
        now: Date.now(),
      })
    },
    { immediate: true, flush: 'pre' },
  )
  const statuses = computed(() =>
    selectNativeChatTurnStatuses(timingByTurn.value, {
      activeTurnKey: activeTurnKey.value,
      isWorking: read('isWorking'),
      workingStartedAt: read('workingStartedAt'),
      thinking: read('thinking') ?? false,
      settledByTurn: read('settledTurns') ?? undefined,
    }),
  )
  return {
    active: computed(() => statuses.value.active),
    completedByTurn: computed(() => statuses.value.completedByTurn),
  }
}
