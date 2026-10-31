import { describe, it, expect, vi } from 'vitest'
import { createFileDownload, downloadName } from '../fileDownload'

function setup(result = { ok: true, buf: Buffer.from([0, 255, 4, 0]) }) {
  const read = vi.fn(async () => result)
  const writeFile = vi.fn(async () => {})
  const dialog = { showSaveDialog: vi.fn(async () => ({ filePath: 'C:/Downloads/image.png' })) }
  const download = createFileDownload({ dialog, getWindow: () => null, downloadsDir: () => 'C:/Downloads', remote: { readDownload: read }, guest: () => ({ readDownload: read }), writeFile })
  return { read, writeFile, dialog, download }
}
describe('remote file downloads', () => {
  it.each(['ssh://ssh-box/srv/image.png', 'lshare://p1/image.png'])('saves exact binary bytes for %s only to the chosen path', async (file) => {
    const h = setup()
    expect(await h.download(file)).toMatchObject({ ok: true })
    expect(h.read).toHaveBeenCalledWith(file)
    expect(h.writeFile).toHaveBeenCalledWith('C:/Downloads/image.png', Buffer.from([0, 255, 4, 0]))
  })
  it('cancels before fetching and never writes', async () => {
    const h = setup()
    h.dialog.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await h.download('lshare://p1/a.png')).toMatchObject({ canceled: true })
    expect(h.read).not.toHaveBeenCalled()
    expect(h.writeFile).not.toHaveBeenCalled()
  })
  it('does not write on revoked access or excessive data', async () => {
    for (const result of [{ ok: false, code: 'revoked', error: 'Access revoked' }, { ok: false, code: 'too-large' }, { ok: true, buf: Buffer.alloc(8 * 1024 * 1024 + 1) }]) {
      const h = setup(result)
      expect((await h.download('lshare://p1/file.bin')).ok).toBe(false)
      expect(h.writeFile).not.toHaveBeenCalled()
    }
  })
  it('refuses local sources and host-supplied path segments in the suggested name', async () => {
    const h = setup()
    expect((await h.download('C:/secret')).ok).toBe(false)
    expect(h.dialog.showSaveDialog).not.toHaveBeenCalled()
    expect(downloadName('ssh://ssh-box/srv/folder/file.png')).toBe('file.png')
    expect(downloadName('ssh://ssh-box/srv/CON.txt')).toBe('download-CON.txt')
  })
  it('reports save failures and allows a later attempt', async () => {
    const h = setup()
    h.writeFile.mockRejectedValueOnce(new Error('disk full'))
    expect((await h.download('lshare://p1/file')).ok).toBe(false)
    expect((await h.download('lshare://p1/file')).ok).toBe(true)
  })
})
