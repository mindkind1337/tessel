// Live Share: an image a guest pasted into one of the host's panes, on the
// host's window (liveSharePaste.js): pasted into that pane only while the
// guest still may type there, main told how it went; the notice in "Recent
// guest actions"; the guest's toast for each refusal, in French too.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { pasteForGuest, pasteFailText } from '../liveSharePaste'
import { actionText } from '../liveShareWindow'
import { registerPane, unregisterPane } from '../paneRegistry'
import { setUiLanguage } from '../i18n'

describe('a guest\u2019s image pasted on the host\u2019s side', () => {
  const api = { pasteImageFile: vi.fn(async () => ({ ok: true })) }
  afterEach(() => {
    unregisterPane('pane-1', api)
    api.pasteImageFile.mockClear()
  })
  const req = { request: 'p1', id: 'pane-1', project: 'ws-1', file: 'C:\\Temp\\tessel-paste\\guest-image-1-ab12cd34.png', guest: { id: 'g1', name: 'Alex' } }

  it('pastes the saved file into the pane while the request stands, and says how it went', async () => {
    registerPane('pane-1', api)
    const answer = vi.fn()
    await pasteForGuest(req, { stands: () => true, answer })
    expect(api.pasteImageFile).toHaveBeenCalledWith(req.file, expect.any(Function))
    expect(answer).toHaveBeenCalledWith(true)
    // The pane asks again right before it pastes: the window's view and main's word.
    const still = api.pasteImageFile.mock.calls[0][1]
    await expect(still()).resolves.toBe(true)
    let mainSays = false
    await pasteForGuest(req, { stands: () => true, check: async () => mainSays, answer: vi.fn() })
    await expect(api.pasteImageFile.mock.calls[1][1]()).resolves.toBe(false)
    mainSays = true
    await expect(api.pasteImageFile.mock.calls[1][1]()).resolves.toBe(true)
    api.pasteImageFile.mockClear()
    // The guest lost the right (or the project): nothing pasted.
    const no = vi.fn()
    await pasteForGuest(req, { stands: () => false, answer: no })
    expect(no).toHaveBeenCalledWith(false, 'revoked')
    expect(api.pasteImageFile).not.toHaveBeenCalled()
    // The pane could not take it.
    api.pasteImageFile.mockResolvedValueOnce({ ok: false, code: 'unavailable' })
    const failed = vi.fn()
    await pasteForGuest(req, { stands: () => true, answer: failed })
    expect(failed).toHaveBeenCalledWith(false, 'unavailable')
  })

  it('a pane that is not there, or no file: not found / revoked', async () => {
    const answer = vi.fn()
    await pasteForGuest(req, { stands: () => true, answer })
    expect(answer).toHaveBeenCalledWith(false, 'not-found')
    await pasteForGuest({ ...req, file: null }, { stands: () => true, answer })
    expect(answer).toHaveBeenLastCalledWith(false, 'revoked')
  })

  it('lists it in Recent guest actions, and says each refusal to the guest', async () => {
    expect(actionText({ kind: 'pasteImage', name: 'Alex', detail: 'Claude' })).toBe('Alex pasted an image in Claude')
    expect(actionText({ kind: 'pasteImage', name: 'Alex', detail: '' })).toBe('Alex pasted an image in a pane')
    expect(pasteFailText('forbidden', 'Cedric')).toBe('Cedric has not let you type in this pane: the image was not pasted.')
    expect(pasteFailText('not-image', 'Cedric')).toBe('That is not an image Tessel can read.')
    expect(pasteFailText('outdated', 'Cedric')).toContain('Cedric')
    expect(pasteFailText('whatever', 'Cedric')).toBe('The image could not be pasted on Cedric’s side.')
    await setUiLanguage('fr')
    try {
      expect(actionText({ kind: 'pasteImage', name: 'Alex', detail: 'Claude' })).toBe('Alex a collé une image dans Claude')
      expect(pasteFailText('too-large', 'Cedric')).toBe("L'image est trop grande pour être envoyée (10 Mo, 8000 pixels de côté et 25 mégapixels au maximum).")
    } finally {
      await setUiLanguage('en')
    }
  })
})
