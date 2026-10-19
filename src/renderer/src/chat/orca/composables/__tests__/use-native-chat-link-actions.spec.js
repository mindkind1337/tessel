// After Orca's use-native-chat-link-actions.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, provide, ref } from 'vue'
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
  // Tessel: the window's link router (panelCtx.openTarget, links/openTarget.js).
  function withPanel(panel, setup) {
    let api
    const app = createApp({
      setup() {
        provide('panelCtx', panel)
        return () => h(defineComponent({ setup: () => ((api = setup()), () => null) }))
      },
    })
    app.mount(document.createElement('div'))
    return { api, unmount: () => app.unmount() }
  }
  it('sends web pages and mail addresses to the link router when no openWeb is given', async () => {
    const openTarget = vi.fn(async () => true)
    const { api, unmount } = withPanel({ openTarget }, () => useNativeChatLinkActions(null, null, {}, {}))
    const click = { ...event(), ctrlKey: true }
    await api.onLinkClick.value(click, 'https://example.com/x')
    expect(openTarget).toHaveBeenCalledWith('https://example.com/x', { event: click })
    await api.onLinkClick.value(event(), 'mailto:ada@example.com')
    expect(openTarget).toHaveBeenLastCalledWith('mailto:ada@example.com', expect.anything())
    await api.onLinkClick.value(event(), 'javascript:alert(1)')
    expect(openTarget).toHaveBeenCalledTimes(2)
    unmount()
  })
  it('an explicit openWeb still wins for web pages; mail goes to the router', async () => {
    const openTarget = vi.fn(async () => true),
      openWeb = vi.fn()
    const { api, unmount } = withPanel({ openTarget }, () => useNativeChatLinkActions(null, null, {}, { openWeb }))
    await api.onLinkClick.value(event(), 'https://example.com/')
    expect(openWeb).toHaveBeenCalled()
    expect(openTarget).not.toHaveBeenCalled()
    await api.onLinkClick.value(event(), 'mailto:a@b.c')
    expect(openTarget).toHaveBeenCalledWith('mailto:a@b.c', expect.anything())
    unmount()
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
