// files:viewImage's optional size cap (an image shown inline in a chat): an
// image over it is refused before it is read; without it, the viewer's cap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

vi.mock('../i18n', () => ({ t: (_k, s) => s }))
import { readImageForView } from '../fileView.js'

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-viewcap-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('readImageForView maxBytes', () => {
  it('refuses an image over the cap, reads one under it', () => {
    const file = join(dir, 'a.png')
    fs.writeFileSync(file, Buffer.alloc(2048, 1))
    const big = readImageForView(file, { maxBytes: 1024 })
    expect(big.ok).toBe(false)
    expect(big.tooLarge).toBe(true)
    const ok = readImageForView(file, { maxBytes: 4096 })
    expect(ok.ok).toBe(true)
    expect(ok.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(readImageForView(file).ok).toBe(true)
    expect(readImageForView(join(dir, 'gone.png'), { maxBytes: 4096 }).ok).toBe(false)
  })
})
