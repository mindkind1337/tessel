// @vitest-environment node
import { it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createBrowserDownloads } from '../browserDownloads'

it('tracks native completion, cancellation and errors, scoped to the originating page', () => {
  const send = vi.fn()
  const reveal = vi.fn()
  const manager = createBrowserDownloads({ directory: () => process.cwd(), send, reveal })
  const make = () => Object.assign(new EventEmitter(), {
    getFilename: () => 'original.pdf', getTotalBytes: () => 50, getReceivedBytes: () => 50,
    getSavePath: () => 'chosen.pdf', setSaveDialogOptions: vi.fn(), cancel: vi.fn()
  })
  const a = make(), b = make()
  manager.accept(a, 7)
  manager.accept(b, 8)
  expect(a.setSaveDialogOptions.mock.calls[0][0].defaultPath).not.toBe(b.setSaveDialogOptions.mock.calls[0][0].defaultPath)
  const id = manager.list(7)[0].id
  expect(manager.cancel(8, id)).toBe(false)
  a.emit('updated', {}, 'progressing')
  expect(manager.list(7)[0].receivedBytes).toBe(50)
  a.emit('done', {}, 'completed')
  expect(manager.list(7)[0].path).toBe('chosen.pdf')
  expect(manager.show(8, id)).toBe(false)
  expect(manager.show(7, id)).toBe(true)
  const other = manager.list(8)[0].id
  expect(manager.cancel(8, other)).toBe(true)
  expect(b.cancel).toHaveBeenCalled()
  b.emit('done', {}, 'cancelled')
  expect(manager.list(8)[0]).toMatchObject({ state: 'cancelled', path: null })
  const c = make()
  manager.accept(c, 7)
  c.emit('done', {}, 'interrupted')
  expect(manager.list(7)[1]).toMatchObject({ error: 'transfer-failed', path: null })
  expect(JSON.stringify(send.mock.calls)).not.toContain('https:')
})
