// After Orca's composer hooks (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, shallowRef } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatDraft } from '../use-native-chat-draft.js'
import { clearNativeChatDraftCacheForTests } from '../../native-chat-draft-cache.js'
import { useNativeChatCanSend } from '../use-native-chat-can-send.js'
import { useNativeChatComposerKeyDown } from '../use-native-chat-composer-keydown.js'
import { useNativeChatComposerInterrupt } from '../use-native-chat-composer-interrupt.js'
import { useNativeChatTypedInsertion } from '../use-native-chat-typed-insertion.js'
import { useNativeChatComposerRevealFocus } from '../use-native-chat-composer-reveal-focus.js'
afterEach(() => {
  clearNativeChatDraftCacheForTests()
  document.body.innerHTML = ''
})
const key = (name, extra = {}) => ({
  key: name,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...extra,
})
describe('Tessel composer protections', () => {
  it('waits for Vue template refs to mount before claiming focus', async () => {
    const rootRef = shallowRef(null),
      composerRef = shallowRef(null),
      frames = [],
      focus = vi.fn()
    renderHook(() => {
      useNativeChatComposerRevealFocus({
        rootRef,
        composerRef,
        isVisible: true,
        isFocusedGroup: true,
        composerReady: true,
        scheduleFrame: (callback) => frames.push(callback),
      })
      return {}
    })
    expect(frames).toHaveLength(0)
    rootRef.value = document.createElement('div')
    composerRef.value = { focus }
    await nextTick()
    expect(frames).toHaveLength(1)
    frames.shift()()
    expect(focus).toHaveBeenCalledOnce()
  })
  it('restores draft caches on pane switches and remounts', () => {
    const scope = ref('a'),
      h = renderHook(() => useNativeChatDraft(scope))
    h.result.current.setDraft('first')
    scope.value = 'b'
    expect(h.result.current.draft).toBe('')
    h.result.current.setDraft((old) => old + 'second')
    scope.value = 'a'
    expect(h.result.current.draft).toBe('first')
    h.unmount()
    const next = renderHook(() => useNativeChatDraft('b'))
    expect(next.result.current.draft).toBe('second')
  })
  it('distinguishes blocked sending from disabled input', () => {
    const blocked = ref('starting'),
      draft = ref('hello')
    const h = renderHook(() => useNativeChatCanSend({ draft, sendBlockedReason: blocked }))
    expect(h.result.current).toBe(false)
    blocked.value = ''
    expect(h.result.current).toBe(true)
    draft.value = ' '
    expect(h.result.current).toBe(false)
  })
  it.each([
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
    { keyCode: 229 },
  ])('does not submit modified or composing Enter: %o', (extra) => {
    const send = vi.fn(),
      h = renderHook(() => useNativeChatComposerKeyDown({ send }))
    const event = key('Enter', extra)
    h.result.current(event)
    expect(send).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
  it('sends Enter and spends Escape on menus before interrupting', () => {
    const menuOpen = ref(true),
      isWorking = ref(true),
      interrupt = vi.fn(),
      closeMenu = vi.fn(),
      send = vi.fn()
    const h = renderHook(() =>
      useNativeChatComposerKeyDown({ menuOpen, isWorking, closeMenu, interrupt, send }),
    )
    h.result.current(key('Escape'))
    expect(closeMenu).toHaveBeenCalledOnce()
    expect(interrupt).not.toHaveBeenCalled()
    menuOpen.value = false
    h.result.current(key('Escape'))
    expect(interrupt).toHaveBeenCalledOnce()
    isWorking.value = false
    h.result.current(key('Escape'))
    expect(interrupt).toHaveBeenCalledOnce()
    h.result.current(key('Enter'))
    expect(send).toHaveBeenCalledOnce()
  })
  it('leaves queued messages alone when interrupting a working agent', () => {
    const isWorking = ref(false),
      onStop = vi.fn(),
      cancelPendingSends = vi.fn()
    const h = renderHook(() =>
      useNativeChatComposerInterrupt({ isWorking, onStop, cancelPendingSends }),
    )
    h.result.current()
    expect(onStop).not.toHaveBeenCalled()
    isWorking.value = true
    h.result.current()
    expect(onStop).toHaveBeenCalledOnce()
    expect(cancelPendingSends).not.toHaveBeenCalled()
  })
  it('inserts plain text over the current selection and restores the caret', async () => {
    const input = document.createElement('textarea'),
      draft = ref('hello world'),
      caret = ref(5)
    input.value = draft.value
    input.setSelectionRange(0, 5)
    const h = renderHook(() =>
      useNativeChatTypedInsertion({
        textareaRef: shallowRef(input),
        draft,
        caret,
        setDraft: (value) => {
          draft.value = value
          input.value = value
        },
        setCaret: (value) => {
          caret.value = value
        },
      }),
    )
    expect(h.result.current.insertTypedText('<b>literal</b>')).toBe(true)
    await nextTick()
    expect(draft.value).toBe('<b>literal</b> world')
    expect(input.selectionStart).toBe(14)
    input.disabled = true
    expect(h.result.current.insertTypedText('ignored')).toBe(false)
  })
  it.each(['pointer', 'tab', 'editable', 'unmount'])(
    'does not steal focus after %s',
    async (kind) => {
      const frames = [],
        focus = vi.fn(),
        root = document.createElement('div')
      document.body.appendChild(root)
      const h = renderHook(() => {
        useNativeChatComposerRevealFocus({
          rootRef: shallowRef(root),
          composerRef: { focus },
          isVisible: true,
          isFocusedGroup: true,
          composerReady: true,
          scheduleFrame: (callback) => frames.push(callback),
        })
        return {}
      })
      if (kind === 'pointer') document.dispatchEvent(new Event('pointerdown'))
      if (kind === 'tab') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
      if (kind === 'editable') {
        const other = document.createElement('input')
        document.body.appendChild(other)
        other.focus()
      }
      if (kind === 'unmount') h.unmount()
      frames.shift()()
      expect(focus).not.toHaveBeenCalled()
    },
  )
})
