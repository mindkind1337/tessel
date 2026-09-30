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
  })
})

// A fake main process: imageSave (clipboard bytes) / imageImport (a dropped
// file) answer with an opaque id, as src/main/chat/chatImages.js does.
function fakeImageApi({ refuse = null } = {}) {
  let n = 0
  const image = (name) => ({ id: `img_${String(++n).padStart(24, '0')}`, name, width: 688, height: 478 })
  return {
    imageSave: vi.fn(async ({ name }) => (refuse ? { ok: false, error: refuse } : { ok: true, image: image(name) })),
    imageImport: vi.fn(async ({ path }) =>
      refuse ? { ok: false, error: refuse } : { ok: true, image: image(path.split(/[\\/]/).pop()) },
    ),
    imageDiscard: vi.fn(async () => ({ ok: true })),
  }
}
const png = (size = 10, type = 'image/png') => ({ type, size, arrayBuffer: async () => new ArrayBuffer(size) })

describe('image chips (allowImages)', () => {
  function setup(extra = {}) {
    const draft = ref('')
    const setNotice = vi.fn()
    const imageApi = extra.imageApi || fakeImageApi()
    const hook = renderHook(() =>
      useNativeChatComposerAttachments({
        attachmentScopeKey: 'pane-1',
        allowImages: true,
        imageApi,
        setNotice,
        isComposing: () => false,
        caret: 0,
        setDraft: (update) => {
          draft.value = typeof update === 'function' ? update(draft.value) : update
        },
        setCaret: () => {},
        ...extra,
      }),
    )
    return { ...hook, draft, setNotice, imageApi }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('saves pasted images through the main process and names them image.png, image-2.png', async () => {
    const h = setup()
    expect(h.result.current.attachImages([{ file: png() }])).toBe(1)
    expect(h.result.current.imageAttachments[0]).toMatchObject({ pending: true, name: 'image.png' })
    await settle()
    h.result.current.attachImages([{ file: png() }])
    await settle()
    expect(h.imageApi.imageSave).toHaveBeenCalledTimes(2)
    expect(h.imageApi.imageSave.mock.calls[0][0]).toMatchObject({ paneId: 'pane-1', name: 'image.png' })
    expect(h.imageApi.imageSave.mock.calls[0][0].bytes).toBeInstanceOf(Uint8Array)
    expect(h.imageApi.imageSave.mock.calls[1][0].name).toBe('image-2.png')
    const chips = h.result.current.imageAttachments
    expect(chips.map((c) => [c.name, c.width, c.height, !!c.pending])).toEqual([
      ['image.png', 688, 478, false],
      ['image-2.png', 688, 478, false],
    ])
    expect(h.result.current.imageIdsForSend()).toEqual([chips[0].imageId, chips[1].imageId])
  })

  it('refuses other types, images over 10 MB and more than 10 per message, before any save', async () => {
    const h = setup()
    h.result.current.attachImages([{ file: png(10, 'image/bmp') }])
    expect(h.setNotice).toHaveBeenLastCalledWith('Only PNG, JPEG, GIF and WebP images can be attached.')
    h.result.current.attachImages([{ file: png(10 * 1024 * 1024 + 1) }])
    expect(h.setNotice).toHaveBeenLastCalledWith('This image is larger than 10 MB.')
    expect(h.imageApi.imageSave).not.toHaveBeenCalled()
    expect(h.result.current.attachImages(Array.from({ length: 12 }, () => ({ file: png() })))).toBe(10)
    expect(h.setNotice).toHaveBeenLastCalledWith('At most 10 images per message.')
    await settle()
    expect(h.result.current.attachImages([{ file: png() }])).toBe(0)
    expect(h.result.current.imageAttachments).toHaveLength(10)
  })

  it('drops a chip the main process refused, with its reason', async () => {
    const h = setup({ imageApi: fakeImageApi({ refuse: 'Links cannot be attached: drop the image itself.' }) })
    h.result.current.attachResolvedPaths(['C:\\shots\\link.png'])
    await settle()
    expect(h.result.current.imageAttachments).toEqual([])
    expect(h.setNotice).toHaveBeenLastCalledWith('Links cannot be attached: drop the image itself.')
  })

  it('imports dropped image files by path (the main process copies them) and inserts other paths as text', async () => {
    const h = setup()
    const file = png()
    h.result.current.attachResolvedPaths(['C:\\shots\\a.png', 'C:\\notes.txt'], undefined, {
      files: [file, png(3, 'text/plain')],
    })
    await settle()
    expect(h.imageApi.imageImport).toHaveBeenCalledExactlyOnceWith({ paneId: 'pane-1', path: 'C:\\shots\\a.png' })
    expect(h.draft.value).toBe('C:\\notes.txt ')
    expect(h.result.current.imageAttachments[0]).toMatchObject({ name: 'a.png', width: 688 })
    // Dragged from Tessel's explorer (no File): the main process adds a thumbnail.
    h.result.current.attachResolvedPaths(['C:\\shots\\b.webp'])
    await settle()
    expect(h.imageApi.imageImport).toHaveBeenLastCalledWith({ paneId: 'pane-1', path: 'C:\\shots\\b.webp', thumb: true })
  })

  it('discards a removed chip in the main process; a sent one is only cleared', async () => {
    const h = setup()
    h.result.current.attachImages([{ file: png() }, { file: png() }])
    await settle()
    const [first] = h.result.current.imageAttachments
    h.result.current.removeImageAttachment(first.id)
    expect(h.imageApi.imageDiscard).toHaveBeenCalledExactlyOnceWith({ paneId: 'pane-1', id: first.imageId })
    h.result.current.clearImageAttachments()
    expect(h.result.current.imageAttachments).toEqual([])
    expect(h.imageApi.imageDiscard).toHaveBeenCalledOnce()
  })

  it('restores settled chips on remount (not pending ones)', async () => {
    const h = setup()
    h.result.current.attachImages([{ file: png() }])
    await settle()
    h.result.current.attachImages([{ file: png() }]) // still saving
    h.unmount()
    expect(readNativeChatAttachmentCache('pane-1')).toHaveLength(1)
    const next = setup()
    expect(next.result.current.imageAttachments).toHaveLength(1)
    expect(next.result.current.imageAttachments[0].name).toBe('image.png')
  })
})

describe('text paths while composing', () => {
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
