// After Orca's use-structured-agent-session-context-usage.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useStructuredAgentSessionContextUsage } from '../use-structured-agent-session-context-usage.js'
import { useNativeChatContextUsageSummary } from '../use-native-chat-context-usage-summary.js'
describe('reactive context usage', () => {
  it('keeps unknown usage null, then merges whole-journal context with loaded turns', () => {
    const items = ref([]),
      support = ref(undefined)
    const h = renderHook(() => {
      const contextUsage = useStructuredAgentSessionContextUsage(items, support)
      return useNativeChatContextUsageSummary({ contextUsage })
    })
    expect(h.result.current).toBeNull()
    support.value = { current: { window: { tokens: 1000, capturedAt: 1 } } }
    items.value = [
      {
        sequence: 1,
        body: {
          kind: 'turn',
          turnId: 'a',
          state: 'completed',
          contextUsage: {
            used: {
              kind: 'estimate',
              usage: {
                inputTokens: 200,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                outputTokens: 1,
              },
              capturedAt: 2,
            },
          },
        },
      },
    ]
    expect(h.result.current).toMatchObject({
      usedTokens: 200,
      windowTokens: 1000,
      estimated: true,
      rows: [],
    })
    support.value = { current: { window: { tokens: 2000, capturedAt: 3 } } }
    expect(h.result.current.windowTokens).toBe(2000)
  })
})
