// After Orca's use-native-chat-composer-attachments.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { renderHook } from './withSetup.js'
import {
  useNativeChatComposerAttachments,
  readNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests,
} from '../use-native-chat-composer-attachments.js'
afterEach(() => {
  clearNativeChatAttachmentCacheForTests()
  vi.unstubAllGlobals()
})
describe('local attachment state and text-only paths', () => {
  function setup(extra = {}) {
    const draft = ref(''),
      caret = ref(0),
      composing = ref(false),
      disabled = ref(false)
    const setNotice = vi.fn()
    const hook = renderHook(() =>
      useNativeChatComposerAttachments({
        attachmentScopeKey: 'a',
        caret,
        disabled,
        isComposing: () => composing.value,
        setNotice,
        setDraft: (update) => {
          draft.value = typeof update === 'function' ? update(draft.value) : update
        },
        setCaret: (value) => {
          caret.value = value
        },
        ...extra,
      }),
    )
    return { ...hook, draft, caret, composing, disabled, setNotice }
  }
  it('defaults to text paths, not image chips', () => {
    const h = setup()
    h.result.current.attachResolvedPaths(['/shot.png'])
    expect(h.draft.value).toBe('/shot.png ')
    expect(h.result.current.imageAttachments).toEqual([])
    expect(h.result.current.beginPendingImageAttachment('blob:x')).toBeNull()
  })
  it('restores opt-in settled chips on remount but not pending previews', () => {
    const h = setup({ allowImages: true })
    h.result.current.attachResolvedPaths(['/shot.png'])
    h.result.current.beginPendingImageAttachment('data:image/png,example')
    h.unmount()
    const next = setup({ allowImages: true })
    expect(next.result.current.imageAttachments).toHaveLength(1)
    expect(next.result.current.imageAttachments[0].path).toBe('/shot.png')
    expect(next.result.current.imageAttachments[0].previewUrl).toBeUndefined()
  })
  it('settles a pending chip in place and removes only the targeted chip', () => {
    const h = setup({ allowImages: true })
    const id = h.result.current.beginPendingImageAttachment(),
      other = h.result.current.beginPendingImageAttachment()
    h.result.current.resolvePendingImageAttachment(id, '/shot.png')
    expect(h.result.current.imageAttachments[0]).toMatchObject({ id, path: '/shot.png' })
    expect(readNativeChatAttachmentCache('a')).toHaveLength(1)
    h.result.current.dropPendingImageAttachment(other)
    expect(h.result.current.imageAttachments).toHaveLength(1)
    h.result.current.removeImageAttachment(id)
    expect(h.result.current.imageAttachments).toEqual([])
  })
  it('revokes blob previews but not data previews', () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { revokeObjectURL })
    const h = setup({ allowImages: true })
    h.result.current.beginPendingImageAttachment('blob:one')
    h.result.current.beginPendingImageAttachment('data:image/png,test')
    h.result.current.clearImageAttachments()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:one')
  })
  it('holds IME paths, preserves order and drains once', () => {
    const h = setup()
    h.composing.value = true
    h.result.current.attachResolvedPaths(['/one'])
    h.result.current.attachResolvedPaths(['/two', '/one'])
    expect(h.draft.value).toBe('')
    h.composing.value = false
    h.result.current.flushPendingAttachments()
    h.result.current.flushPendingAttachments()
    expect(h.draft.value).toBe('/one /two /one ')
  })
  it('rejects queued paths whose ownership changes', () => {
    const h = setup()
    h.composing.value = true
    let current = true
    h.result.current.attachResolvedPaths(['/one'], undefined, {
      targetOwnerIsCurrent: () => current,
    })
    current = false
    h.composing.value = false
    h.result.current.flushPendingAttachments()
    expect(h.draft.value).toBe('')
  })
  it('drops queued paths after any disabled transition', () => {
    const h = setup()
    h.composing.value = true
    h.result.current.attachResolvedPaths(['/one'])
    h.disabled.value = true
    h.disabled.value = false
    h.composing.value = false
    h.result.current.flushPendingAttachments()
    expect(h.draft.value).toBe('')
  })
  it('bounds the entire IME queue and preserves overflow notice', () => {
    const h = setup()
    h.composing.value = true
    expect(h.result.current.attachResolvedPaths(Array(256).fill('/one'))).toBe(true)
    expect(h.result.current.attachResolvedPaths(['/overflow'])).toBe(false)
    expect(h.setNotice).toHaveBeenCalledOnce()
    h.composing.value = false
    h.result.current.flushPendingAttachments()
    expect(h.draft.value).not.toContain('overflow')
    expect(h.setNotice).toHaveBeenCalledOnce()
  })
  it('refuses remote connection paths', () => {
    const h = setup()
    expect(h.result.current.attachResolvedPaths(['/one'], 'ssh-host')).toBe(false)
    expect(h.draft.value).toBe('')
  })
})
