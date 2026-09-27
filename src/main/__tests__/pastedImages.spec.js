// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { imageInEntry, claudeImageFile, isPastedImage } from '../pastedImages'

const SID = '6da350a1-326a-4f43-b9cc-9fae8081edcc'
const PNG_A = Buffer.from('first image').toString('base64')
const PNG_B = Buffer.from('second image').toString('base64')
const img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

let home
let out
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-img-'))
  out = join(home, 'paste')
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('[Image #N] in a Claude Code conversation', () => {
  it('finds the image by its number, in a message or a message sent mid-turn', () => {
    const msg = { type: 'user', imagePasteIds: [39, 40], message: { content: [{ type: 'text', text: '[Image #39] and [Image #40]' }, img(PNG_A), img(PNG_B)] } }
    expect(imageInEntry(msg, 40).data).toBe(PNG_B)
    expect(imageInEntry(msg, 39).data).toBe(PNG_A)
    expect(imageInEntry(msg, 41)).toBe(null)
    const queued = { type: 'attachment', attachment: { type: 'queued_command', imagePasteIds: [42], prompt: [{ type: 'text', text: '[Image #42] x' }, img(PNG_A)] } }
    expect(imageInEntry(queued, 42).mediaType).toBe('image/png')
    expect(imageInEntry({ type: 'user', message: { content: [img(PNG_A)] } }, 1)).toBe(null)
  })

  it('saves it once as a file, read from the transcript line by line', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'attachment', attachment: { imagePasteIds: [7], prompt: [{ type: 'text', text: '[Image #7]' }, img(PNG_A)] } }),
      '{"broken',
      JSON.stringify({ type: 'user', imagePasteIds: [8], message: { content: [{ type: 'text', text: '[Image #8]' }, img(PNG_B)] } })
    ]
    const dir = join(home, '.claude', 'projects', 'C--x')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, `${SID}.jsonl`), lines.join('\n') + '\n')
    const f = await claudeImageFile({ sessionId: SID, n: 8 }, home, out)
    expect(f).toMatch(/claude-6da350a1-image-8\.png$/)
    expect(fs.readFileSync(f, 'utf8')).toBe('second image')
    expect(await claudeImageFile({ sessionId: SID, n: 9 }, home, out)).toBe(null)
    expect(await claudeImageFile({ sessionId: 'not-a-session', n: 7 }, home, out)).toBe(null)
  })

  it('only files Tessel saved itself are opened directly', () => {
    expect(isPastedImage(join(out, 'image-1.png'), out)).toBe(true)
    expect(isPastedImage('C:\\Windows\\System32\\calc.exe', out)).toBe(false)
    expect(isPastedImage(join(out, '..', 'secret.png'), out)).toBe(false)
    expect(isPastedImage(join(out, 'image.exe'), out)).toBe(false)
  })
})
