// The chat image viewer's Save as and Open in a tab (chatImageActions.js):
// only real png/jpeg/gif/webp bytes, a clean offered name, one copy per image.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatImageActions, imageFromDataUrl, saveName } from '../chatImageActions.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-imgact-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('chat image actions', () => {
  it('takes only an image by its bytes, whatever the data: URL says', () => {
    expect(imageFromDataUrl(PNG).mime).toBe('image/png')
    // Declared PNG, bytes are text.
    expect(imageFromDataUrl('data:image/png;base64,' + Buffer.from('hello world, not an image').toString('base64'))).toBeNull()
    expect(imageFromDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(imageFromDataUrl('https://example.com/x.png')).toBeNull()
    expect(imageFromDataUrl(42)).toBeNull()
  })

  it('offers a clean name with the real extension', () => {
    expect(saveName('C:\\x\\shot.jpg', 'image/png')).toBe('shot.png')
    expect(saveName('a<b>:c?.webp', 'image/webp')).toBe('abc.webp')
    expect(saveName('', 'image/jpeg')).toBe('image.jpg')
    expect(saveName('..', 'image/gif')).toBe('image.gif')
  })

  it('Save as writes the bytes where the dialog says, nothing when cancelled', async () => {
    const target = join(dir, 'out.png')
    const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: target })) }
    const actions = createChatImageActions({ dialog, downloadsDir: () => dir, dir: join(dir, 'copies') })
    const res = await actions.saveAs({ dataUrl: PNG, name: 'shot.png' })
    expect(res).toEqual({ ok: true, path: target })
    expect(fs.readFileSync(target).subarray(1, 4).toString()).toBe('PNG')
    expect(dialog.showSaveDialog.mock.calls[0][0].defaultPath).toBe(join(dir, 'shot.png'))
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    expect(await actions.saveAs({ dataUrl: PNG })).toEqual({ ok: false, canceled: true })
    expect((await actions.saveAs({ dataUrl: 'data:image/png;base64,AAAA' })).ok).toBe(false)
    expect(dialog.showSaveDialog).toHaveBeenCalledTimes(2)
  })

  it('a copy to open in a tab: one file per image, in its own folder', () => {
    const copies = join(dir, 'copies')
    const actions = createChatImageActions({ dialog: {}, dir: copies })
    const a = actions.viewCopy({ dataUrl: PNG })
    const b = actions.viewCopy({ dataUrl: PNG })
    expect(a.ok).toBe(true)
    expect(a.path).toBe(b.path)
    expect(a.path.startsWith(copies)).toBe(true)
    expect(a.path.endsWith('.png')).toBe(true)
    expect(fs.readdirSync(copies)).toHaveLength(1)
    expect(actions.viewCopy({ dataUrl: 'nope' }).ok).toBe(false)
  })

  it('answers the main window only', async () => {
    const handlers = {}
    const win = { webContents: {}, isDestroyed: () => false }
    const actions = createChatImageActions({ dialog: {}, getWindow: () => win, dir: join(dir, 'c') })
    actions.register({ handle: (name, fn) => (handlers[name] = fn) })
    expect(await handlers['chatImages:viewCopy']({ sender: {} }, { dataUrl: PNG })).toEqual({ ok: false })
    expect((await handlers['chatImages:viewCopy']({ sender: win.webContents }, { dataUrl: PNG })).ok).toBe(true)
  })
})
