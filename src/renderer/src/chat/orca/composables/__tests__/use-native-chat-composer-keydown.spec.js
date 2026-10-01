// After Orca's use-native-chat-composer-keydown.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)

import { renderHook } from './withSetup.js'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPickerSuggestion,
  deriveComposerAutocomplete,
  EMPTY_HISTORY,
} from '../../native-chat-composer-state.js'
import { getNativeChatAgentProfile } from '../../shared/native-chat-agent-profiles.js'
import { useNativeChatComposerKeyDown } from '../use-native-chat-composer-keydown.js'

const COMMAND = {
  kind: 'command',
  id: 'command:clear',
  name: 'clear',
  token: '/clear',
  description: 'Clear history',
  skillCollision: false,
}

function picker(items = [COMMAND]) {
  return {
    mode: 'slash',
    query: '',
    items,
    triggerKey: '/:0',
    prefix: '/',
    dispatchable: true,
    grouped: false,
    commandsEnabled: true,
    skillsEnabled: false,
    skillStatus: 'ready',
  }
}

function setup(autocomplete = picker(), composing = false, draft = '/') {
  const callbacks = {
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker: vi.fn(),
    interrupt: vi.fn(),
    send: vi.fn(),
    setActiveSuggestion: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    setHistory: vi.fn(),
  }
  const hook = renderHook(() =>
    useNativeChatComposerKeyDown({
      autocomplete,
      activeSuggestion: 0,
      draft,
      history: EMPTY_HISTORY,
      isComposing: () => composing,
      ...callbacks,
    }),
  )
  return { handler: hook.result.current, callbacks }
}

function keyEvent(key, isComposing = false) {
  return {
    key,
    shiftKey: false,
    keyCode: isComposing ? 229 : 0,
    nativeEvent: { isComposing },
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  }
}

describe('useNativeChatComposerKeyDown', () => {
  it('dispatches command Enter but completes command Tab', () => {
    const enter = setup()
    enter.handler(keyEvent('Enter'))
    expect(enter.callbacks.dispatchPickerCommand).toHaveBeenCalledWith(COMMAND)
    expect(enter.callbacks.completePickerItem).not.toHaveBeenCalled()

    const tab = setup()
    tab.handler(keyEvent('Tab'))
    expect(tab.callbacks.completePickerItem).toHaveBeenCalledWith(COMMAND)
    expect(tab.callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
  })

  it('falls through to composer send when the open picker has no options', () => {
    const { handler, callbacks } = setup(picker([]))
    handler(keyEvent('Enter'))
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it.each(['claude', 'openclaude', 'codex', 'grok'])(
    'completes mid-prompt command Enter without dispatching or losing prose for %s',
    (agent) => {
      const draft = 'Explain /cle before continuing'
      const caret = 'Explain /cle'.length
      const autocomplete = deriveComposerAutocomplete(
        draft,
        caret,
        [COMMAND],
        [],
        getNativeChatAgentProfile(agent),
      )
      expect(autocomplete.mode).toBe('slash')
      const { handler, callbacks } = setup(autocomplete, false, draft)
      const event = keyEvent('Enter')
      handler(event)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
      expect(callbacks.send).not.toHaveBeenCalled()
      expect(callbacks.completePickerItem).toHaveBeenCalledOnce()
      const [item] = callbacks.completePickerItem.mock.calls[0]
      expect(applyPickerSuggestion(draft, caret, item)).toEqual({
        draft: 'Explain /clear  before continuing',
        caret: 'Explain /clear '.length,
        insertedToken: '/clear',
      })
    },
  )

  it('dismisses Escape without interrupting the agent', () => {
    const { handler, callbacks } = setup()
    handler(keyEvent('Escape'))
    expect(callbacks.dismissPicker).toHaveBeenCalledWith('/:0')
    expect(callbacks.interrupt).not.toHaveBeenCalled()
  })

  it('does not accept or submit while IME composition is active', () => {
    const { handler, callbacks } = setup(picker(), true)
    const event = keyEvent('Enter', true)
    handler(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
    expect(callbacks.send).not.toHaveBeenCalled()
  })
})

describe('the "@" file list (Tessel)', () => {
  it('Enter or Tab puts the active file in the draft; arrows move; no list: Enter sends', () => {
    const acceptMention = vi.fn()
    const mention = { mode: 'mention', query: 'app', items: ['src/App.vue', 'src/app.js'] }
    const hook = renderHook(() =>
      useNativeChatComposerKeyDown({
        autocomplete: mention,
        activeSuggestion: 1,
        draft: '@app',
        history: EMPTY_HISTORY,
        isComposing: () => false,
        acceptMention,
        send: vi.fn(),
        setActiveSuggestion: vi.fn(),
      }),
    )
    hook.result.current(keyEvent('Enter'))
    expect(acceptMention).toHaveBeenCalledWith('src/app.js')
    hook.result.current(keyEvent('Tab'))
    expect(acceptMention).toHaveBeenCalledTimes(2)
    const plain = setup({ mode: 'mention', query: 'x' }, false, '@x')
    plain.handler(keyEvent('Enter'))
    expect(plain.callbacks.send).toHaveBeenCalledOnce()
  })
})
