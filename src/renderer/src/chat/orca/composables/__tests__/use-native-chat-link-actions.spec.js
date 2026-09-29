// After Orca's use-native-chat-link-actions.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatLinkActions } from '../use-native-chat-link-actions.js'

const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })
describe('useNativeChatLinkActions', () => {
  it.each(['https://example.com/path', 'http://localhost:3000/'])(
    'opens %s in the injected destination',
    async (href) => {
      const openWeb = vi.fn()
      const { result } = renderHook(() => useNativeChatLinkActions(null, null, {}, { openWeb }))
      const click = event()
      await result.current.onLinkClick(click, href)
      expect(openWeb).toHaveBeenCalledWith(href, click)
      expect(click.preventDefault).toHaveBeenCalled()
      expect(result.current.linkActionRequest).toBeNull()
    },
  )
  it.each([
    'javascript:alert(1)',
    'data:text/html,foo',
    'mailto:test@example.com',
    'ssh://host/path',
    'https://',
    'file:///repo/foo.md',
  ])('does not pass %s to the browser', async (href) => {
    const openWeb = vi.fn()
    const { result } = renderHook(() => useNativeChatLinkActions(null, null, {}, { openWeb }))
    const click = event()
    await result.current.onLinkClick(click, href)
    expect(openWeb).not.toHaveBeenCalled()
    expect(click.preventDefault).toHaveBeenCalled()
  })
  it('keeps file links on the viewer, including Shift clicks', async () => {
    const openWeb = vi.fn(),
      openFile = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatLinkActions({ worktreePath: '/repo' }, null, {}, { openWeb, openFile }),
    )
    await result.current.onLinkClick({ ...event(), shiftKey: true }, 'readme.md:5')
    expect(openWeb).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenCalledWith(
      { file: '/repo/readme.md', line: 5, col: null },
      expect.anything(),
    )
  })
  it('restores focus to the root and respects visibility', async () => {
    const root = { focus: vi.fn() },
      visible = ref(true),
      openWeb = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatLinkActions(null, ref(root), { isVisible: visible }, { openWeb }),
    )
    result.current.closeLinkActions(true)
    expect(root.focus).toHaveBeenCalledWith({ preventScroll: true })
    visible.value = false
    await result.current.onLinkClick(event(), 'https://example.com')
    expect(openWeb).not.toHaveBeenCalled()
  })
})
