// @vitest-environment node
// Files the editor shows in a view of its own are read whole (files:viewImage):
// a PDF's bytes for its tab (pdf.js), a workbook, a document, audio; text never.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readImageForView, readForView } from '../fileView'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-viewbytes-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const put = (name, data) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, data)
  return p
}

describe('readImageForView: the bytes of a file shown in its own view', () => {
  it('a PDF: its bytes as a data URL (the file viewer still only gets its size)', () => {
    const p = put('a.pdf', Buffer.from('%PDF-1.4\n%%EOF\n'))
    const r = readImageForView(p)
    expect(r).toMatchObject({ ok: true, kind: 'pdf' })
    expect(r.dataUrl).toBe(`data:application/pdf;base64,${Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64')}`)
    expect(readForView(p)).toEqual({ ok: true, kind: 'pdf', size: 15 })
  })
  it('a workbook, a document, audio: their bytes with their type', () => {
    for (const [name, mime] of [
      ['b.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['c.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['d.mp3', 'audio/mpeg']
    ]) {
      const r = readImageForView(put(name, Buffer.from([1, 2, 3])))
      expect(r.ok, name).toBe(true)
      expect(r.dataUrl.startsWith(`data:${mime};base64,`), name).toBe(true)
    }
  })
  it('text or code: refused', () => {
    expect(readImageForView(put('e.js', 'x')).ok).toBe(false)
  })
})
