// After Orca's use-native-chat-session-option-command.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatSessionOptionCommand } from '../use-native-chat-session-option-command.js'
describe('session option confirmation and caps', () => {
  function setup(options = {}) {
    const setOption = vi.fn().mockResolvedValue({ ok: true }),
      setNotice = vi.fn()
    const hook = renderHook(() =>
      useNativeChatSessionOptionCommand({
        setOption,
        setNotice,
        permissionMode: 'default',
        ...options,
      }),
    )
    return { ...hook, setOption, setNotice }
  }
  it.each([
    ['claude', false, undefined, false, 'bypassPermissions'],
    ['claude', true, 'manual', false, 'bypassPermissions'],
    ['claude', true, 'manual', false, 'auto'],
    ['codex', true, undefined, true, 'bypassPermissions'],
    ['codex', true, undefined, false, 'auto'],
    ['codex', true, undefined, false, 'plan'],
    ['codex', true, undefined, false, 'acceptEdits'],
  ])(
    'blocks %s launchYolo=%s cap=%s busy=%s mode=%s',
    async (agent, chatLaunchYolo, maxPermissions, isWorking, value) => {
      const h = setup({ agent, chatLaunchYolo, maxPermissions, isWorking })
      expect((await h.result.current.dispatch({ optionId: 'permissionMode', value })).ok).toBe(
        false,
      )
      expect(h.setOption).not.toHaveBeenCalled()
      expect(h.setNotice).toHaveBeenCalled()
      expect(h.result.current.confirmedValues.permissionMode).toBe('default')
    },
  )
  it.each(['claude', 'codex'])('allows authorized idle Yolo for %s', async (agent) => {
    const h = setup({ agent, chatLaunchYolo: true })
    await h.result.current.dispatch({ optionId: 'permissionMode', value: 'bypassPermissions' })
    expect(h.setOption).toHaveBeenCalledWith({ permissionMode: 'bypassPermissions' })
    expect(h.result.current.confirmedValues.permissionMode).toBe('bypassPermissions')
  })
  it('does not display a requested value until confirmed and serializes requests', async () => {
    let resolve
    const setOption = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const h = setup({ setOption, values: { model: 'old' } })
    const pending = h.result.current.dispatch('/model new')
    expect(h.result.current.confirmedValues.model).toBe('old')
    await h.result.current.dispatch('/model another')
    expect(setOption).toHaveBeenCalledOnce()
    resolve({ ok: true })
    await pending
    expect(h.result.current.confirmedValues.model).toBe('new')
  })
  it.each([false, true, undefined, { ok: false }])(
    'keeps the old option for %o',
    async (response) => {
      const h = setup({ values: { effort: 'low' } })
      h.setOption.mockResolvedValue(response)
      await h.result.current.dispatch('/effort high')
      expect(h.result.current.confirmedValues.effort).toBe('low')
      expect(h.setNotice).toHaveBeenCalled()
    },
  )
  it('ignores a reply for a previous session', async () => {
    let resolve
    const sessionId = ref('a'),
      h = setup({
        sessionId,
        setOption: () =>
          new Promise((r) => {
            resolve = r
          }),
      })
    const pending = h.result.current.dispatch('/model new')
    sessionId.value = 'b'
    resolve({ ok: true })
    await pending
    expect(h.result.current.confirmedValues.model).toBeUndefined()
  })
})
