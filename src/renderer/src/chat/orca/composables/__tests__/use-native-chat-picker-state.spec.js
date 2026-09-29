// After Orca's picker/catalog hooks (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatPickerState } from '../use-native-chat-picker-state.js'
import { useNativeChatComposerCatalog } from '../use-native-chat-composer-catalog.js'
import { useNativeChatPickerCommandDispatch } from '../use-native-chat-picker-command-dispatch.js'
describe('picker state and catalog', () => {
  it('completes commands, dismisses a trigger and resets on scope changes', () => {
    const draft = ref('/cle'),
      caret = ref(4),
      scope = ref('a')
    const h = renderHook(() =>
      useNativeChatPickerState({
        agent: 'claude',
        draftScopeKey: scope,
        draft,
        caret,
        agentCommands: [{ name: 'clear', description: 'Clear' }],
        sessionSkillNames: [],
        setDraft: (value) => {
          draft.value = value
        },
        setCaret: (value) => {
          caret.value = value
        },
      }),
    )
    expect(h.result.current.autocomplete.mode).toBe('slash')
    const item = h.result.current.autocomplete.items[0]
    h.result.current.dismiss('/:0')
    expect(h.result.current.autocomplete.mode).toBe('none')
    scope.value = 'b'
    expect(h.result.current.autocomplete.mode).toBe('slash')
    h.result.current.completeItem(item)
    expect(draft.value).toBe('/clear ')
    expect(h.result.current.classifySend('/clear')).toBe('command')
  })
  it('respects empty reported catalogs without reviving skills', () => {
    const transport = ref({ sessionCommands: [] }),
      h = renderHook(() => useNativeChatComposerCatalog('codex', transport))
    expect(h.result.current.agentCommands).toEqual([])
    expect(h.result.current.sessionSkillNames).toEqual([])
    transport.value = { conversationCommands: ['clear'], setOption() {} }
    expect(h.result.current.agentCommands.map((item) => item.name)).toContain('clear')
    expect(h.result.current.agentCommands.map((item) => item.name)).toContain('model')
    expect(h.result.current.sessionSkillNames).toBeUndefined()
  })
  it('offers only supported host actions without a reported catalog', () => {
    const h = renderHook(() => useNativeChatComposerCatalog('claude', {}))
    expect(h.result.current.agentCommands.some((item) => item.name === 'model')).toBe(false)
    expect(h.result.current.agentCommands.some((item) => item.name === 'clear')).toBe(false)
  })
  it('opens option pickers rather than sending bare option commands', async () => {
    const sendStructured = vi.fn(),
      onOptionCommand = vi.fn()
    const h = renderHook(() =>
      useNativeChatPickerCommandDispatch({ sendStructured, onOptionCommand }),
    )
    await h.result.current({ name: 'model' })
    expect(onOptionCommand).toHaveBeenCalledWith('model')
    expect(sendStructured).not.toHaveBeenCalled()
  })
  it('dispatches through confirmed structured sending and keeps errors visible', async () => {
    const sendStructured = vi.fn().mockResolvedValue({ ok: false }),
      setNotice = vi.fn(),
      onSlashCommand = vi.fn()
    const h = renderHook(() =>
      useNativeChatPickerCommandDispatch({ sendStructured, setNotice, onSlashCommand }),
    )
    await h.result.current({ name: 'clear' })
    expect(sendStructured).toHaveBeenCalledWith('/clear', [])
    expect(setNotice).not.toHaveBeenCalled()
    sendStructured.mockResolvedValue({ ok: true })
    await h.result.current({ name: 'clear' })
    expect(onSlashCommand).toHaveBeenCalledWith('/clear')
  })
})
