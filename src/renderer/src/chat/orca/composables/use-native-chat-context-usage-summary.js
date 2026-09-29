// After Orca's use-native-chat-context-usage-summary.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// structuredTransport accepts a value/ref/getter; nested contextUsage may be a ref.
// Returns a computed summary or null for unknown usage, never a fabricated zero.
// Uses the reference pure summary unchanged.
import { computed, toValue } from 'vue'
import { summarizeContextUsage } from '../native-chat-context-usage-summary.js'
export function useNativeChatContextUsageSummary(structuredTransport) {
  return computed(() => {
    const usage = toValue(toValue(structuredTransport)?.contextUsage)
    return usage ? summarizeContextUsage(usage) : null
  })
}
