// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { imageInEntry, claudeImageFile, isPastedImage, isSavedPaste } from '../pastedImages'

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
    expect(f).toMatch(/claude-[0-9a-f]{16}-image-8-[0-9a-f]{16}\.png$/)
    expect(fs.readFileSync(f, 'utf8')).toBe('second image')
    // Asked again: the same copy.
    expect(await claudeImageFile({ sessionId: SID, n: 8 }, home, out)).toBe(f)
    expect(await claudeImageFile({ sessionId: SID, n: 9 }, home, out)).toBe(null)
    expect(await claudeImageFile({ sessionId: 'not-a-session', n: 7 }, home, out)).toBe(null)
  })

  it('never answers with a copy saved for another session or another image of that number', async () => {
    const other = '6da350a1-0000-4000-8000-000000000000' // the same first 8 characters
    const dir = join(home, '.claude', 'projects', 'C--x')
    fs.mkdirSync(dir, { recursive: true })
    const entry = (data) => JSON.stringify({ type: 'user', imagePasteIds: [3], message: { content: [{ type: 'text', text: '[Image #3]' }, img(data)] } })
    fs.writeFileSync(join(dir, `${SID}.jsonl`), entry(PNG_A) + '\n')
    fs.writeFileSync(join(dir, `${other}.jsonl`), entry(PNG_B) + '\n')
    const mine = await claudeImageFile({ sessionId: SID, n: 3 }, home, out)
    const theirs = await claudeImageFile({ sessionId: other, n: 3 }, home, out)
    expect(theirs).not.toBe(mine)
    expect(fs.readFileSync(mine, 'utf8')).toBe('first image')
    expect(fs.readFileSync(theirs, 'utf8')).toBe('second image')
    // The session resumed and #3 reused for another image: the newest one.
    fs.appendFileSync(join(dir, `${SID}.jsonl`), entry(PNG_B) + '\n')
    const again = await claudeImageFile({ sessionId: SID, n: 3 }, home, out)
    expect(again).not.toBe(mine)
    expect(fs.readFileSync(again, 'utf8')).toBe('second image')
  })

  it('the pasted file gone from %TEMP%: the transcript bytes are saved again', async () => {
    const dir = join(home, '.claude', 'projects', 'C--x')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', imagePasteIds: [1], message: { content: [img(PNG_A)] } }) + '\n')
    const f = await claudeImageFile({ sessionId: SID, n: 1 }, home, out)
    fs.rmSync(f)
    expect(await claudeImageFile({ sessionId: SID, n: 1 }, home, out)).toBe(f)
    expect(fs.readFileSync(f, 'utf8')).toBe('first image')
  })

  it('only files Tessel saved itself are opened directly', () => {
    expect(isPastedImage(join(out, 'image-1.png'), out)).toBe(true)
    expect(isPastedImage('C:\\Windows\\System32\\calc.exe', out)).toBe(false)
    expect(isPastedImage(join(out, '..', 'secret.png'), out)).toBe(false)
    expect(isPastedImage(join(out, 'image.exe'), out)).toBe(false)
    // A folder whose name only starts the same is not it; one inside it is (screenshots).
    expect(isPastedImage(`${out}-evil${join('/', 'x.png')}`, out)).toBe(false)
    expect(isPastedImage(join(out, 'agent-browser', 'browser-1.png'), out)).toBe(true)
    expect(isPastedImage(out, out)).toBe(false)
  })

  it('a saved paste sent on to an SSH host: right in the folder, by Tessel’s own name', () => {
    expect(isSavedPaste(join(out, 'image-1712345678901.png'), out)).toBe(true)
    expect(isSavedPaste(join(out, 'guest-image-1712345678901-ab12cd34.png'), out)).toBe(true)
    expect(isSavedPaste(join(out, 'agent-browser', 'image-1.png'), out)).toBe(false)
    expect(isSavedPaste(`${out}-evil${join('/', 'image-1.png')}`, out)).toBe(false)
    expect(isSavedPaste(join(out, 'browser-1.png'), out)).toBe(false)
    expect(isSavedPaste(join(out, 'image-1.jpg'), out)).toBe(false)
    expect(isSavedPaste(join(out, '..', 'image-1.png'), out)).toBe(false)
    expect(isSavedPaste(42, out)).toBe(false)
  })
})
