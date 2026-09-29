// After Orca's use-native-chat-structured-composer-send.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import { useNativeChatStructuredComposerSend } from '../use-native-chat-structured-composer-send.js'
function setup(extra = {}) {
  const draft = ref('hello'),
    scopeKey = ref('one'),
    onError = vi.fn()
  const setDraft = vi.fn((value) => {
      draft.value = value
    }),
    setHistory = vi.fn()
  const send = vi.fn().mockResolvedValue({ ok: true })
  const hook = renderHook(() =>
    useNativeChatStructuredComposerSend({
      draft,
      scopeKey,
      onError,
      setDraft,
      setHistory,
      send,
      ...extra,
    }),
  )
  return { ...hook, draft, scopeKey, onError, setDraft, setHistory, send }
}
describe('confirmed text sends', () => {
  it('routes typed option commands through setOption and waits for confirmation', async () => {
    const setOption = vi.fn().mockResolvedValue({ ok: true })
    const h = setup({ setOption })
    await h.result.current('/model new-model')
    expect(setOption).toHaveBeenCalledWith({ model: 'new-model' })
    expect(h.send).not.toHaveBeenCalled()
    expect(h.draft.value).toBe('')
  })
  it('refuses unsupported option commands without submitting them as model text', async () => {
    const h = setup()
    await h.result.current('/effort high')
    expect(h.send).not.toHaveBeenCalled()
    expect(h.draft.value).toBe('hello')
    expect(h.onError).toHaveBeenCalled()
  })
  it('applies permission caps to typed options too', async () => {
    const setOption = vi.fn(),
      h = setup({ setOption, agent: 'codex', chatLaunchYolo: false })
    await h.result.current('/permissionMode bypassPermissions')
    expect(setOption).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.draft.value).toBe('hello')
  })
  it.each([false, true, undefined, { accepted: true }, { ok: false, error: 'denied' }])(
    'keeps the draft for non-confirmation %o',
    async (response) => {
      const h = setup()
      h.send.mockResolvedValue(response)
      await h.result.current('hello')
      expect(h.draft.value).toBe('hello')
      expect(h.setHistory).not.toHaveBeenCalled()
      expect(h.onError).toHaveBeenCalled()
    },
  )
  it('sends only text and clears after ok:true', async () => {
    const h = setup()
    await h.result.current('hello')
    expect(h.send).toHaveBeenCalledWith('hello')
    expect(h.draft.value).toBe('')
    expect(h.setHistory).toHaveBeenCalledOnce()
  })
  it('preserves edits made while a normal message is in flight', async () => {
    let resolve
    const h = setup({
      send: () =>
        new Promise((r) => {
          resolve = r
        }),
    })
    const pending = h.result.current('hello')
    h.draft.value = 'new text'
    resolve({ ok: true })
    await pending
    expect(h.draft.value).toBe('new text')
    expect(h.setHistory).toHaveBeenCalledOnce()
  })
  it.each(['scope', 'scope-return', 'unmount'])(
    'ignores completion after %s changes',
    async (change) => {
      let resolve
      const h = setup({
        send: () =>
          new Promise((r) => {
            resolve = r
          }),
      })
      const pending = h.result.current('hello')
      if (change === 'scope') h.scopeKey.value = 'two'
      else if (change === 'scope-return') {
        h.scopeKey.value = 'two'
        h.scopeKey.value = 'one'
      } else h.unmount()
      resolve({ ok: true })
      await pending
      expect(h.setDraft).not.toHaveBeenCalled()
      expect(h.setHistory).not.toHaveBeenCalled()
    },
  )
  it('serializes duplicate submits and reports rejections', async () => {
    let reject
    const send = vi.fn(
        () =>
          new Promise((_, r) => {
            reject = r
          }),
      ),
      h = setup({ send })
    const pending = h.result.current('hello')
    await h.result.current('hello')
    expect(send).toHaveBeenCalledOnce()
    reject(new Error('failed'))
    await pending
    expect(h.draft.value).toBe('hello')
    expect(h.onError).toHaveBeenCalledWith('failed')
  })
  it.each(['hello', '/goal build it'])('refuses image attachments for %s', async (text) => {
    const h = setup()
    await h.result.current(text, [{ id: 'image', path: '/image.png' }])
    expect(h.send).not.toHaveBeenCalled()
    expect(h.onError).toHaveBeenCalled()
  })
  it.each([{ disabled: true }, { disabledReason: 'closed' }, { sendBlockedReason: 'starting' }])(
    'respects send guard %o',
    async (extra) => {
      const h = setup(extra)
      await h.result.current('hello')
      expect(h.send).not.toHaveBeenCalled()
    },
  )
})
