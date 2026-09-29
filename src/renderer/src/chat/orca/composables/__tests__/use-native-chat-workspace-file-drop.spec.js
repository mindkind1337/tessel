// After Orca's use-native-chat-workspace-file-drop.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatWorkspaceFileDrop } from '../use-native-chat-workspace-file-drop.js'

function drag(path = '/repo/file.md', extra = {}) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      types: ['text/x-tessel-path'],
      getData: () => path,
      files: [],
      effectAllowed: 'copy',
      ...extra,
    },
  }
}
describe('useNativeChatWorkspaceFileDrop', () => {
  it('inserts explorer paths as text, quoting spaces', () => {
    const insertText = vi.fn()
    const { result } = renderHook(() => useNativeChatWorkspaceFileDrop({ insertText }))
    const e = drag('/repo/a file.md')
    result.current.onDropCapture(e)
    expect(insertText).toHaveBeenCalledWith('"/repo/a file.md" ')
    expect(e.preventDefault).toHaveBeenCalled()
    expect(e.stopPropagation).toHaveBeenCalled()
  })
  it('resolves OS Files with the preload callback', () => {
    const insertText = vi.fn(),
      pathForFile = vi.fn((file) => '/repo/' + file.name)
    const { result } = renderHook(() => useNativeChatWorkspaceFileDrop({ insertText, pathForFile }))
    result.current.onDropCapture(
      drag('', { types: ['Files'], files: [{ name: 'a.md' }, { name: 'b.md' }] }),
    )
    expect(insertText).toHaveBeenCalledWith('/repo/a.md /repo/b.md ')
  })
  it.each([{ disabled: true }, { remote: true }])(
    'claims but refuses guarded drops: %o',
    (options) => {
      const insertText = vi.fn()
      const { result } = renderHook(() =>
        useNativeChatWorkspaceFileDrop({ insertText, ...options }),
      )
      const e = drag()
      result.current.onDragOverCapture(e)
      result.current.onDropCapture(e)
      expect(e.dataTransfer.dropEffect).toBe('none')
      expect(e.stopPropagation).toHaveBeenCalled()
      expect(insertText).not.toHaveBeenCalled()
    },
  )
  it('does not claim ordinary text or promise a forbidden copy', () => {
    const insertText = vi.fn()
    const { result } = renderHook(() => useNativeChatWorkspaceFileDrop({ insertText }))
    const text = drag('', { types: ['text/plain'] })
    result.current.onDropCapture(text)
    expect(text.preventDefault).not.toHaveBeenCalled()
    const move = drag('/repo/a', { effectAllowed: 'move' })
    result.current.onDropCapture(move)
    expect(move.dataTransfer.dropEffect).toBe('none')
    expect(insertText).not.toHaveBeenCalled()
  })
  it('invalidates a queued insertion after changing panes or disabling the composer', () => {
    const paneKey = ref('a'),
      disabled = ref(false),
      attachResolvedPaths = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatWorkspaceFileDrop({ paneKey, disabled, attachResolvedPaths }),
    )
    result.current.onDropCapture(drag())
    const guard = attachResolvedPaths.mock.calls[0][2].targetOwnerIsCurrent
    expect(guard()).toBe(true)
    paneKey.value = 'b'
    expect(guard()).toBe(false)
    paneKey.value = 'a'
    disabled.value = true
    expect(guard()).toBe(false)
  })
  it.each(['relative.md', '/repo/file\nnext', '/repo/' + 'x'.repeat(262144)])(
    'rejects malformed or oversized paths',
    (path) => {
      const setNotice = vi.fn(),
        insertText = vi.fn()
      const { result } = renderHook(() => useNativeChatWorkspaceFileDrop({ insertText, setNotice }))
      result.current.onDropCapture(drag(path))
      expect(insertText).not.toHaveBeenCalled()
      expect(setNotice).toHaveBeenCalledTimes(1)
    },
  )
  it('bounds OS file count before resolving paths', () => {
    const setNotice = vi.fn(),
      pathForFile = vi.fn()
    const { result } = renderHook(() => useNativeChatWorkspaceFileDrop({ pathForFile, setNotice }))
    result.current.onDropCapture(drag('', { types: ['Files'], files: Array(257).fill({}) }))
    expect(pathForFile).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalled()
  })
})
