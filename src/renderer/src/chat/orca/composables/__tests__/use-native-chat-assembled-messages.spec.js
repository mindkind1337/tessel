import { shallowRef } from 'vue'
import { describe, expect, it } from 'vitest'
import { renderHook } from './withSetup.js'
import { useNativeChatAssembledMessages } from '../use-native-chat-assembled-messages.js'

const message = (id, text = id) => ({
  id,
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript',
})

describe('Vue incremental transcript assembly', () => {
  it('applies suffixes, replaces revised rows, and resets after a session switch', () => {
    const first = message('one')
    const baseMessages = shallowRef([first])
    const appended = shallowRef([])
    const sessionId = shallowRef('a')
    const { result } = renderHook(() =>
      useNativeChatAssembledMessages({ agent: 'claude', sessionId, baseMessages, appended }),
    )
    expect(result.current.assembledMessages.map((item) => item.id)).toEqual(['one'])
    appended.value = [message('two')]
    expect(result.current.assembledMessages.map((item) => item.id)).toEqual(['one', 'two'])
    appended.value = [message('two', 'revised')]
    expect(result.current.assembledMessages[1].blocks[0].text).toBe('revised')
    sessionId.value = 'b'
    baseMessages.value = [message('new')]
    appended.value = []
    expect(result.current.assembledMessages.map((item) => item.id)).toEqual(['new'])
    expect(result.current.normalizedMessages.map((item) => item.id)).toEqual(['new'])
  })
})
