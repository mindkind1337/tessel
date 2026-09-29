// After Orca's use-native-chat-file-link-context.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { renderHook } from './withSetup.js'
import { useNativeChatFileLinkContext } from '../use-native-chat-file-link-context.js'
import { useNativeChatFileLinkClick } from '../use-native-chat-file-link-click.js'

describe('useNativeChatFileLinkContext', () => {
  it('tracks pane changes and accepts a resolver', () => {
    const pane = ref({ id: 'a', cwd: '/one' })
    const { result } = renderHook(() => useNativeChatFileLinkContext(pane))
    expect(result.current.worktreePath).toBe('/one')
    pane.value = { id: 'b', projectDir: '/two' }
    expect(result.current.worktreeId).toBe('b')
    expect(result.current.worktreePath).toBe('/two')
    pane.value.remote = { hostId: 'server' }
    expect(result.current).toBeNull()
    const resolved = renderHook(() =>
      useNativeChatFileLinkContext(null, {
        resolveContext: () => ({ worktreePath: '/custom', worktreeId: 'c' }),
      }),
    )
    expect(resolved.result.current.worktreePath).toBe('/custom')
  })
  it('uses Tessel paneFolder and viewFile instead of an external opener', async () => {
    const viewFile = vi.fn(),
      paneFolder = vi.fn(() => '/workspace')
    let click
    const wrapper = mount(
      defineComponent({
        setup() {
          const context = useNativeChatFileLinkContext({ id: 'a', cwd: '/stale' })
          click = useNativeChatFileLinkClick(context)
          return () => null
        },
      }),
      { global: { provide: { panelCtx: { paneFolder, viewFile } } } },
    )
    try {
      await click.value({ preventDefault() {}, stopPropagation() {}, shiftKey: true }, 'file.md:8')
      expect(viewFile).toHaveBeenCalledWith(
        { file: '/workspace/file.md', line: 8, col: null },
        expect.anything(),
      )
    } finally {
      wrapper.unmount()
    }
  })
})
