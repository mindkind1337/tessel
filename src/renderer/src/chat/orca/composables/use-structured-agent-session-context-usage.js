// After Orca's use-structured-agent-session-context-usage.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// journalItems and support accept values, refs/computed or getters.
// Returns computed usage, combining loaded journal facts with host facts.
// Unknown usage remains null; loaded facts take precedence.
import { computed, toValue } from 'vue'
import { selectStructuredAgentContextUsage } from '../shared/structured-agent-session-context-usage.js'
export function useStructuredAgentSessionContextUsage(journalItems, support) {
  return computed(() =>
    selectStructuredAgentContextUsage(
      toValue(journalItems) || [],
      toValue(toValue(support)?.current),
    ),
  )
}
