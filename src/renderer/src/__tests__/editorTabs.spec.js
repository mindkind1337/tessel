import { describe, it, expect } from 'vitest'
import {
  openTab,
  closeTab,
  pinTab,
  samePath,
  pathKey,
  autoSaveDelay,
  validSavedFiles,
  minimalEdit,
  mainEol
} from '../editor/editorTabs'
import { createSaveQueue } from '../editor/saveQueue'

const A = 'C:\\p\\a.js'
const B = 'C:\\p\\b.js'
const C = 'C:\\p\\c.js'

describe('editor tabs', () => {
  it('compares Windows paths whatever the case and slashes', () => {
    expect(samePath('C:\\P\\A.js', 'c:/p/a.js')).toBe(true)
    expect(pathKey('C:/x/')).toBe('c:\\x')
    expect(samePath(A, B)).toBe(false)
  })

  it('opens a preview tab, replaced by the next preview', () => {
    let r = openTab([], null, A, { preview: true })
    expect(r.files).toEqual([{ path: A, preview: true }])
    expect(r.activePath).toBe(A)
    r = openTab(r.files, r.activePath, B, { preview: true })
    expect(r.files).toEqual([{ path: B, preview: true }])
    expect(r.replaced).toBe(A)
  })

  it('never replaces a preview tab with unsaved edits, nor a kept tab', () => {
    let r = openTab([{ path: A, preview: true }], A, B, { preview: true, isDirty: (p) => p === A })
    expect(r.files.map((f) => f.path)).toEqual([A, B])
    r = openTab([{ path: A, preview: false }], A, B, { preview: true })
    expect(r.files).toEqual([
      { path: A, preview: false },
      { path: B, preview: true }
    ])
  })

  it('opens after the active tab; a kept open pins an existing preview', () => {
    const files = [
      { path: A, preview: false },
      { path: B, preview: false }
    ]
    let r = openTab(files, A, C, { preview: false })
    expect(r.files.map((f) => f.path)).toEqual([A, C, B])
    r = openTab([{ path: A, preview: true }], A, 'c:/P/A.JS', { preview: false })
    expect(r.files).toEqual([{ path: A, preview: false }])
    expect(r.activePath).toBe(A)
  })

  it('opens kept tabs when preview tabs are off', () => {
    const r = openTab([], null, A, { preview: true, previewTabs: false })
    expect(r.files).toEqual([{ path: A, preview: false }])
  })

  it('closes a tab, activating its right neighbour, else the left one', () => {
    const files = [A, B, C].map((path) => ({ path, preview: false }))
    expect(closeTab(files, B, B)).toEqual({ files: [files[0], files[2]], activePath: C })
    expect(closeTab(files, C, C).activePath).toBe(B)
    expect(closeTab(files, A, C).activePath).toBe(A)
    expect(closeTab([files[0]], A, A)).toEqual({ files: [], activePath: null })
  })

  it('pins a preview tab', () => {
    expect(pinTab([{ path: A, preview: true }], A)).toEqual([{ path: A, preview: false }])
  })

  it('keeps the auto-save delay between 250 ms and 10 s', () => {
    expect(autoSaveDelay(1000)).toBe(1000)
    expect(autoSaveDelay(10)).toBe(250)
    expect(autoSaveDelay(99999)).toBe(10000)
    expect(autoSaveDelay('2000')).toBe(2000)
    expect(autoSaveDelay('x')).toBe(1000)
    expect(autoSaveDelay(undefined)).toBe(1000)
  })

  it('restores only well-formed saved tabs', () => {
    expect(
      validSavedFiles([{ path: A, preview: true }, { path: 'relative.js' }, { path: 'c:/p/a.js' }, null, { path: B }, { path: 5 }])
    ).toEqual([
      { path: A, preview: true },
      { path: B, preview: false }
    ])
    expect(validSavedFiles(undefined)).toEqual([])
  })
})

describe('editor settings', () => {
  it('have Orca-like defaults and ignore malformed saved values', async () => {
    const { settings, loadSettings, resetSettings, DEFAULT_SETTINGS } = await import('../settings')
    expect(DEFAULT_SETTINGS).toMatchObject({
      editorAutoSave: false,
      editorAutoSaveDelayMs: 1000,
      editorMinimap: false,
      editorWordWrap: true,
      editorPreviewTabs: true,
      diffSideBySide: false
    })
    loadSettings({ editorAutoSave: true, editorAutoSaveDelayMs: 50, editorWordWrap: 'yes', diffSideBySide: true })
    expect(settings.editorAutoSave).toBe(true)
    expect(settings.editorAutoSaveDelayMs).toBe(1000)
    expect(settings.editorWordWrap).toBe(true)
    expect(settings.diffSideBySide).toBe(true)
    loadSettings({ editorAutoSaveDelayMs: 2500 })
    expect(settings.editorAutoSaveDelayMs).toBe(2500)
    resetSettings()
  })
})

describe('external changes applied as the smallest edit', () => {
  const apply = (a, e) => a.slice(0, e.start) + e.text + a.slice(e.endBefore)
  it('finds the changed middle', () => {
    const e = minimalEdit('one\ntwo\nthree\n', 'one\n2\nthree\n')
    expect(e).toEqual({ start: 4, endBefore: 7, text: '2' })
    expect(minimalEdit('same', 'same')).toBe(null)
  })
  it('handles appends, deletions and CRLF pairs', () => {
    for (const [a, b] of [
      ['abc', 'abcdef'],
      ['abcdef', 'abc'],
      ['x\r\ny', 'x\r\n\r\ny'],
      ['a\r\nb', 'a\nb'],
      ['', 'new'],
      ['old', ''],
      ['😀a', '😁a']
    ]) {
      const e = minimalEdit(a, b)
      expect(apply(a, e)).toBe(b)
    }
    const e = minimalEdit('x\r\ny', 'x\r\n\r\ny')
    expect(e.text.startsWith('\n')).toBe(false)
  })
  it('knows the main line ending', () => {
    expect(mainEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(mainEol('a\nb')).toBe('\n')
    expect(mainEol('one line')).toBe(null)
  })
})

describe('save queue', () => {
  it('runs saves of one file one after the other, in order', async () => {
    const q = createSaveQueue()
    const log = []
    let release
    const first = q.run('a', () => new Promise((r) => (release = r)).then(() => log.push('first')))
    const second = q.run('a', async () => log.push('second'))
    expect(q.busy('a')).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(log).toEqual([])
    release()
    await Promise.all([first, second])
    expect(log).toEqual(['first', 'second'])
    await q.idle('a')
    expect(q.busy('a')).toBe(false)
  })

  it('goes on after a failed save, and keeps files apart', async () => {
    const q = createSaveQueue()
    const failed = q.run('a', async () => {
      throw new Error('disk full')
    })
    await expect(failed).rejects.toThrow('disk full')
    await expect(q.run('a', async () => 'ok')).resolves.toBe('ok')
    let releaseB
    const b = q.run('b', () => new Promise((r) => (releaseB = r)))
    await expect(q.run('c', async () => 'c done')).resolves.toBe('c done')
    await new Promise((r) => setTimeout(r, 0))
    releaseB('b done')
    await expect(b).resolves.toBe('b done')
  })
})
