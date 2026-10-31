// @vitest-environment node
import { it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

it('automatically saves agent-controlled downloads but leaves manual downloads with Save As', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-auto-download-'))
  try {
    const manager = createBrowserDownloads({ directory: () => dir, send: vi.fn() })
    const item = Object.assign(new EventEmitter(), {
      getFilename: () => 'original.pdf', getTotalBytes: () => 3, getReceivedBytes: () => 3,
      getSavePath: () => '', setSavePath: vi.fn(), setSaveDialogOptions: vi.fn()
    })
    manager.accept(item, 7, { unattended: true })
    expect(item.setSaveDialogOptions).not.toHaveBeenCalled()
    const staging = item.setSavePath.mock.calls[0][0]
    fs.writeFileSync(staging, 'PDF')
    item.emit('done', {}, 'completed')
    expect(manager.list(7)[0].path).toBe(path.join(dir, 'Tessel', 'original.pdf'))
    item.setSavePath.mockClear()
    manager.accept(item, 8)
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(item.setSaveDialogOptions).toHaveBeenCalled()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

it('saves once without a dialog, scopes the destination and never overwrites a racing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-agent-download-'))
  try {
    const manager = createBrowserDownloads({ directory: () => dir, send: vi.fn() })
    const target = path.join(dir, 'chosen.pdf')
    expect(manager.prepare(7, target, 'agent-a').ok).toBe(true)
    expect(manager.prepare(7, target, 'agent-b')).toMatchObject({ ok: false, error: 'destination-in-use' })
    const item = Object.assign(new EventEmitter(), {
      getFilename: () => 'random.pdf', getTotalBytes: () => 3, getReceivedBytes: () => 3,
      getSavePath: () => '', setSavePath: vi.fn(), setSaveDialogOptions: vi.fn()
    })
    manager.accept(item, 8)
    expect(item.setSavePath).not.toHaveBeenCalled()
    manager.accept(item, 7)
    const staging = item.setSavePath.mock.calls[0][0]
    fs.writeFileSync(staging, 'PDF')
    fs.writeFileSync(target, 'keep-existing')
    item.emit('done', {}, 'completed')
    expect(fs.readFileSync(target, 'utf8')).toBe('keep-existing')
    expect(manager.list(7)[0].path).toBe(path.join(dir, 'chosen (1).pdf'))
    expect(fs.readFileSync(manager.list(7)[0].path, 'utf8')).toBe('PDF')
    expect(fs.existsSync(staging)).toBe(false)
    item.setSavePath.mockClear()
    manager.accept(item, 7)
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(manager.prepare(7, 'relative.pdf', 'agent-a').ok).toBe(false)
    expect(manager.prepare(7, path.join(dir, 'NUL.pdf'), 'agent-a').ok).toBe(false)
    manager.prepare(7, target, 'agent-a', () => false)
    expect(() => manager.accept(item, 7)).toThrow('revoked')
    manager.prepare(7, target, 'agent-a')
    manager.accept(item, 7)
    const cancelledFile = item.setSavePath.mock.calls.at(-1)[0]
    item.emit('done', {}, 'cancelled')
    expect(fs.existsSync(cancelledFile)).toBe(false)
    manager.prepare(7, target, 'agent-a')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000)
    try { expect(() => manager.accept(item, 7)).toThrow('expired') } finally { clock.mockRestore() }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
