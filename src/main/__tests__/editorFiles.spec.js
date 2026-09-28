import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import {
  readForEdit,
  writeForEdit,
  statForEdit,
  headContent,
  createFileWatcher,
  BINARY_ERROR,
  MAX_EDIT_BYTES
} from '../editorFiles'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

describe('editor files: read and write', () => {
  let root
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-editor-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('reads text, strips a UTF-8 BOM and remembers it', () => {
    const f = join(root, 'a.txt')
    fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\r\n')]))
    const r = readForEdit(f)
    expect(r.ok).toBe(true)
    expect(r.bom).toBe(true)
    expect(r.text).toBe('héllo\r\n')
    expect(r.sig).toBe(statForEdit(f).sig)
    fs.writeFileSync(f, 'plain')
    expect(readForEdit(f)).toMatchObject({ ok: true, bom: false, text: 'plain' })
  })

  it('refuses binary files, folders, missing files and relative paths', () => {
    const bin = join(root, 'b.bin')
    fs.writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]))
    expect(readForEdit(bin)).toMatchObject({ ok: false, code: 'binary', error: BINARY_ERROR })
    expect(readForEdit(root)).toMatchObject({ ok: false, code: 'not-file' })
    expect(readForEdit(join(root, 'nope.txt'))).toMatchObject({ ok: false, code: 'missing' })
    expect(readForEdit('rel.txt').ok).toBe(false)
  })

  it('refuses text that is not UTF-8', () => {
    const f = join(root, 'latin1.txt')
    fs.writeFileSync(f, Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    expect(readForEdit(f)).toMatchObject({ ok: false, code: 'encoding' })
  })

  it('refuses files over 50 MB', () => {
    const f = join(root, 'big.txt')
    const fd = fs.openSync(f, 'w')
    fs.ftruncateSync(fd, MAX_EDIT_BYTES + 1)
    fs.closeSync(fd)
    expect(readForEdit(f)).toMatchObject({ ok: false, code: 'too-large' })
  })

  it('writes atomically, keeping CRLF exactly and the BOM when it had one', async () => {
    const f = join(root, 'c.js')
    fs.writeFileSync(f, 'old\r\n')
    const res = await writeForEdit({ file: f, text: 'one\r\ntwo\r\n', bom: true })
    expect(res.ok).toBe(true)
    const buf = fs.readFileSync(f)
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(buf.subarray(3).toString('utf8')).toBe('one\r\ntwo\r\n')
    expect(res.sig).toBe(statForEdit(f).sig)
    await writeForEdit({ file: f, text: 'lf\nonly\n', bom: false })
    expect(fs.readFileSync(f, 'utf8')).toBe('lf\nonly\n')
    // No temporary file left behind.
    expect(fs.readdirSync(root)).toEqual(['c.js'])
  })

  it('creates a missing file, and never writes over a folder', async () => {
    const f = join(root, 'new.txt')
    expect((await writeForEdit({ file: f, text: 'x' })).ok).toBe(true)
    expect(fs.readFileSync(f, 'utf8')).toBe('x')
    expect((await writeForEdit({ file: root, text: 'x' })).ok).toBe(false)
    expect((await writeForEdit({ file: 'rel.txt', text: 'x' })).ok).toBe(false)
    expect((await writeForEdit({ file: f, text: null })).ok).toBe(false)
  })

  it('keeps the original file intact when the write fails', async () => {
    const f = join(root, 'keep.txt')
    fs.writeFileSync(f, 'safe')
    const res = await writeForEdit({ file: join(root, 'missing-dir', 'x.txt'), text: 'x' })
    expect(res.ok).toBe(false)
    expect(fs.readFileSync(f, 'utf8')).toBe('safe')
  })
})

describe('editor files: the committed version (HEAD)', () => {
  let root
  const g = (...args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true })
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-editor-git-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('says when the file is not in a repository', async () => {
    const f = join(root, 'a.txt')
    fs.writeFileSync(f, 'x')
    const r = await headContent(f)
    expect(r).toMatchObject({ ok: true, repo: false, isNew: true, text: '' })
  })

  it('reads the committed text, and an empty side for a new file or no commit', async () => {
    g('init', '-q')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'T')
    g('config', 'core.autocrlf', 'false')
    fs.mkdirSync(join(root, 'sub dir'))
    const f = join(root, 'sub dir', 'a.txt')
    fs.writeFileSync(f, 'committed\r\n')
    let r = await headContent(f)
    expect(r).toMatchObject({ ok: true, repo: true, isNew: true, text: '' })
    expect(r.note).toMatch(/No commit yet/)
    g('add', '.')
    g('commit', '-q', '-m', 'first')
    fs.writeFileSync(f, 'changed\r\n')
    r = await headContent(f)
    expect(r).toMatchObject({ ok: true, repo: true, isNew: false, text: 'committed\r\n' })
    const n = join(root, 'new.txt')
    fs.writeFileSync(n, 'n')
    r = await headContent(n)
    expect(r).toMatchObject({ ok: true, repo: true, isNew: true, text: '' })
    expect(r.note).toMatch(/new file/)
  })
})

describe('editor files: watching', () => {
  let root
  beforeEach(() => {
    root = fs.mkdtempSync(join(os.tmpdir(), 'tessel-editor-watch-'))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('reports a change, a deletion and a return, but not our own write', async () => {
    const f = join(root, 'w.txt')
    fs.writeFileSync(f, 'a')
    const seen = []
    const w = createFileWatcher((e) => seen.push(e), { pollMs: 100, debounceMs: 20 })
    try {
      w.set([f])
      const own = await writeForEdit({ file: f, text: 'ours' })
      w.noteWritten(f, own.sig)
      await wait(300)
      expect(seen).toEqual([])
      fs.writeFileSync(f, 'theirs, longer')
      await wait(400)
      expect(seen.at(-1)).toMatchObject({ path: f, exists: true })
      fs.unlinkSync(f)
      await wait(400)
      expect(seen.at(-1)).toMatchObject({ path: f, exists: false })
      fs.writeFileSync(f, 'back')
      await wait(400)
      expect(seen.at(-1)).toMatchObject({ path: f, exists: true })
      expect(w.set([])).toBe(0)
    } finally {
      w.close()
    }
  })
})
