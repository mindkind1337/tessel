// After Orca's use-native-chat-composer-paste.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatComposerPaste } from '../use-native-chat-composer-paste.js'
describe('plain text composer paste', () => {
  it('inserts text/plain and never requests HTML', () => {
    const insertTypedText = vi.fn(),
      getData = vi.fn((type) => (type === 'text/plain' ? '<b>literal</b>' : '<b>html</b>'))
    const { result } = renderHook(() => useNativeChatComposerPaste({ insertTypedText }))
    const event = { preventDefault: vi.fn(), clipboardData: { getData } }
    result.current.handlePaste(event)
    expect(getData).toHaveBeenCalledExactlyOnceWith('text/plain')
    expect(insertTypedText).toHaveBeenCalledWith('<b>literal</b>')
    expect(event.preventDefault).toHaveBeenCalled()
  })
  it('deduplicates capture/bubble paste and refuses images without saving', () => {
    const insertTypedText = vi.fn(),
      setNotice = vi.fn()
    const { result } = renderHook(() => useNativeChatComposerPaste({ insertTypedText, setNotice }))
    result.current.handlePaste({ defaultPrevented: true })
    result.current.handlePaste({
      preventDefault() {},
      clipboardData: { getData: () => '', items: [{ type: 'image/png' }] },
    })
    expect(insertTypedText).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledOnce()
  })
  it('pastes menu text when still enabled', async () => {
    const insertTypedText = vi.fn(),
      readClipboardText = vi.fn(async () => 'plain')
    const { result } = renderHook(() =>
      useNativeChatComposerPaste({ insertTypedText, readClipboardText }),
    )
    await result.current.pasteFromClipboard()
    expect(insertTypedText).toHaveBeenCalledWith('plain')
  })
  it("menu paste attaches a clipboard image (saved by the main process) before any text", async () => {
    const insertTypedText = vi.fn(),
      attachImages = vi.fn(() => 1),
      readClipboardText = vi.fn(async () => 'plain')
    const prev = globalThis.window.shellApi
    globalThis.window.shellApi = { clipboardHasImage: vi.fn(async () => true), saveClipboardImage: vi.fn(async () => 'C:/t/image-1.png') }
    try {
      const { result } = renderHook(() =>
        useNativeChatComposerPaste({ insertTypedText, attachImages, readClipboardText, allowImages: true }),
      )
      expect(await result.current.pasteFromClipboard()).toBe(true)
      expect(attachImages).toHaveBeenCalledWith([{ path: 'C:/t/image-1.png' }])
      expect(insertTypedText).not.toHaveBeenCalled()
      // Images not allowed: the text as before.
      const other = renderHook(() => useNativeChatComposerPaste({ insertTypedText, attachImages, readClipboardText }))
      await other.result.current.pasteFromClipboard()
      expect(insertTypedText).toHaveBeenCalledWith('plain')
    } finally {
      globalThis.window.shellApi = prev
    }
  })
  it.each(['disabled', 'scope', 'unmount'])('drops an async paste after %s', async (change) => {
    let resolve
    const disabled = ref(false),
      scopeKey = ref('a'),
      insertTypedText = vi.fn()
    const { result, unmount } = renderHook(() =>
      useNativeChatComposerPaste({
        disabled,
        scopeKey,
        insertTypedText,
        readClipboardText: () =>
          new Promise((r) => {
            resolve = r
          }),
      }),
    )
    const pending = result.current.pasteFromClipboard()
    if (change === 'disabled') disabled.value = true
    if (change === 'scope') scopeKey.value = 'b'
    if (change === 'unmount') unmount()
    resolve('stale')
    await pending
    expect(insertTypedText).not.toHaveBeenCalled()
  })
})
