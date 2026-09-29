// After Orca's use-native-chat-file-link-click.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatFileLinkClick } from '../use-native-chat-file-link-click.js'
import { createNativeChatFileHref } from '../../shared/native-chat-href-routing.js'

const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })
describe('useNativeChatFileLinkClick', () => {
  it.each([
    ['docs/deck.md', '/repo/docs/deck.md', null, null],
    ['/repo/src/app.ts:12', '/repo/src/app.ts', 12, null],
    ['README.md:5:3', '/repo/README.md', 5, 3],
    ['../other/file.md', '/other/file.md', null, null],
    ['docs/plan.md#L7', '/repo/docs/plan.md', 7, null],
    ['docs/release%20notes.md', '/repo/docs/release notes.md', null, null],
    ['file:///repo/docs/release%20notes.md#L4', '/repo/docs/release notes.md', 4, null],
    [createNativeChatFileHref('My C# App/Program.cs'), '/repo/My C# App/Program.cs', null, null],
    ['C:\\repo\\app.js:6', 'C:/repo/app.js', 6, null],
  ])('resolves %s through the viewer', async (href, file, line, col) => {
    const openFile = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatFileLinkClick({ worktreePath: '/repo' }, { openFile }),
    )
    const click = event()
    await result.current(click, href)
    expect(openFile).toHaveBeenCalledWith({ file, line, col }, click)
    expect(click.preventDefault).toHaveBeenCalled()
    expect(click.stopPropagation).toHaveBeenCalled()
  })
  it('distinguishes unresolved paths from failed opens', async () => {
    const openFile = vi.fn().mockRejectedValue(new Error('unavailable'))
    const onOpenFailure = vi.fn()
    const { result } = renderHook(() =>
      useNativeChatFileLinkClick({ worktreePath: '/workspaces/repo' }, { openFile, onOpenFailure }),
    )
    await result.current(event(), '~/.claude/plans/plan.md')
    expect(openFile).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ verdict: 'unresolved' }),
    )
    await result.current(event(), 'docs/deck.md')
    expect(onOpenFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ verdict: 'unverifiable', path: '/workspaces/repo/docs/deck.md' }),
    )
  })
  it('reads the current pane context on every click and refuses remote contexts', async () => {
    const context = ref({ worktreePath: '/one' })
    const openFile = vi.fn()
    const { result } = renderHook(() => useNativeChatFileLinkClick(context, { openFile }))
    context.value = { worktreePath: '/two' }
    await result.current(event(), 'file.md')
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ file: '/two/file.md' }),
      expect.anything(),
    )
    context.value = { worktreePath: '/remote', runtimeEnvironmentId: 'ssh:server' }
    await result.current(event(), 'file.md')
    expect(openFile).toHaveBeenCalledTimes(1)
  })
  it.each(['run.exe', 'RUN.CMD', 'run.ps1', 'run.sh', 'file:///tmp/run.bat'])(
    'refuses executable %s',
    async (href) => {
      const openFile = vi.fn()
      const { result } = renderHook(() =>
        useNativeChatFileLinkClick({ worktreePath: '/repo' }, { openFile }),
      )
      await result.current(event(), href)
      expect(openFile).not.toHaveBeenCalled()
    },
  )
})
