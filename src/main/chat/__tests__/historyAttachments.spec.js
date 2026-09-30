// @vitest-environment node
// Images and files of earlier-history messages (historyAttachments.js), for
// each agent's format. Synthetic transcripts and bytes only.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  claudeHistoryEvents,
  codexHistoryEvents,
  opencodeHistoryEvents,
  readOlderHistory,
  readTranscriptHistory,
  resolveHistoryAttachments,
  ATTACHMENT_LIMITS,
  HISTORY_LIMITS
} from '../transcriptHistory'
import { PNG_1x1, TEXT, jpegOf, pngOf } from './fixtures/chatImageBytes'

const CLAUDE_ID = '11111111-2222-4333-8444-555555555555'
const CODEX_ID = '01946a2b-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const ts = (s) => `2026-09-01T10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`
const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const b64 = (buf) => buf.toString('base64')
const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${b64(buf)}`
const JPEG = jpegOf(3, 2)
const BIG = pngOf(4, 4, ATTACHMENT_LIMITS.imageBytes + 10) // over 2 MB decoded
const WITH = { ...HISTORY_LIMITS, attachments: ATTACHMENT_LIMITS }
const users = (events) => events.filter((e) => e.type === 'user')

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-history-att-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const write = (name, buf) => {
  const file = join(tmp, name)
  fs.writeFileSync(file, buf)
  return file
}
function claudeHome(content) {
  const home = join(tmp, 'claude')
  fs.mkdirSync(join(home, 'projects', 'C--proj'), { recursive: true })
  fs.writeFileSync(join(home, 'projects', 'C--proj', `${CLAUDE_ID}.jsonl`), content)
  return home
}
function codexHome(content) {
  const home = join(tmp, 'codex')
  const dir = join(home, 'sessions', '2025', '01', '15')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, `rollout-2025-01-15T10-00-00-${CODEX_ID}.jsonl`), content)
  return home
}
const claudeImage = (data, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } })
const claudeUser = (uuid, s, content) => ({ type: 'user', uuid, timestamp: ts(s), message: { role: 'user', content } })
const claudeReply = (s) => ({ type: 'assistant', uuid: `a${s}`, timestamp: ts(s), message: { id: `m${s}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })

describe('Claude history images and documents', () => {
  it('shows valid PNG/JPEG images as data: URLs; wrong bytes, oversized ones stay "[image]"', () => {
    const home = claudeHome(
      lines([
        claudeUser('u1', 1, [
          { type: 'text', text: 'look' },
          claudeImage(b64(PNG_1x1)),
          // Declared png, the bytes are a JPEG: shown as what the bytes are.
          claudeImage(b64(JPEG), 'image/png'),
          // Declared png, the bytes are text: refused.
          claudeImage(b64(TEXT), 'image/png'),
          claudeImage(b64(BIG)),
          // A declared type Tessel does not show, whatever the bytes.
          claudeImage(b64(PNG_1x1), 'image/svg+xml'),
          { type: 'image', source: { type: 'url', url: 'https://example.invalid/x.png' } }
        ]),
        claudeReply(2)
      ])
    )
    const res = readTranscriptHistory({ agent: 'claude', sessionId: CLAUDE_ID, home })
    expect(res.ok).toBe(true)
    const [u] = users(res.events)
    expect(u.images).toEqual([
      { name: 'image.png', mediaType: 'image/png', dataUrl: dataUrl(PNG_1x1) },
      { name: 'image.jpg', mediaType: 'image/jpeg', dataUrl: dataUrl(JPEG, 'image/jpeg') }
    ])
    expect(u.text).toBe('look\n[image] [image] [image] [image]')
    expect(u.files).toBeUndefined()
  })

  it('at most 4 images per message; a "[Image #1]" prompt adds no placeholder', () => {
    const six = Array.from({ length: 6 }, () => claudeImage(b64(PNG_1x1)))
    const events = claudeHistoryEvents(
      [JSON.stringify(claudeUser('u1', 1, [{ type: 'text', text: 'six' }, ...six])), JSON.stringify(claudeUser('u2', 2, [{ type: 'text', text: '[Image #1] see' }, claudeImage(b64(TEXT))]))],
      WITH
    )
    resolveHistoryAttachments(events)
    const [six4, marked] = users(events)
    expect(six4.images.map((i) => i.name)).toEqual(['image.png', 'image-2.png', 'image-3.png', 'image-4.png'])
    expect(six4.text).toBe('six\n[image] [image]')
    expect(marked.images).toBeUndefined()
    expect(marked.text).toBe('[Image #1] see')
  })

  it('a page holds at most ~12 MB of images, the newest messages first', () => {
    // 2 MB images, 4 per message, 2 messages = 16 MB > 12 MB.
    const img = pngOf(2, 2, ATTACHMENT_LIMITS.imageBytes - 200)
    const four = Array.from({ length: 4 }, () => claudeImage(b64(img)))
    const events = claudeHistoryEvents([JSON.stringify(claudeUser('old', 1, four)), JSON.stringify(claudeUser('new', 2, four))], WITH)
    resolveHistoryAttachments(events)
    const [older, newer] = users(events)
    expect(newer.images).toHaveLength(4)
    expect(older.images).toHaveLength(2)
    expect(older.text).toBe('[image] [image]')
    const total = [...older.images, ...newer.images].reduce((n, i) => n + Buffer.from(i.dataUrl.split(',')[1], 'base64').length, 0)
    expect(total).toBeLessThanOrEqual(ATTACHMENT_LIMITS.pageBytes)
  })

  it('a document block is a file chip (name, type, size), never its data', () => {
    const pdf = Buffer.from('%PDF-1.4 fake pdf bytes')
    const events = claudeHistoryEvents(
      [
        JSON.stringify(
          claudeUser('u1', 1, [
            { type: 'text', text: 'read these' },
            { type: 'document', title: 'report.pdf', source: { type: 'base64', media_type: 'application/pdf', data: b64(pdf) } },
            { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hello' } }
          ])
        ),
        JSON.stringify(claudeUser('u2', 2, [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(pdf) } }]))
      ],
      WITH
    )
    resolveHistoryAttachments(events)
    const [a, b] = users(events)
    expect(a.files).toEqual([
      { name: 'report.pdf', mediaType: 'application/pdf', size: pdf.length },
      { name: 'document.txt', mediaType: 'text/plain', size: 5 }
    ])
    expect(a.text).toBe('read these')
    // A document alone is a message too.
    expect(b.files).toEqual([{ name: 'document.pdf', mediaType: 'application/pdf', size: pdf.length }])
    expect(JSON.stringify(events)).not.toContain(b64(pdf))
  })

  it('without attachment caps (the search index): "[image]" text only, nothing decoded', () => {
    const events = claudeHistoryEvents([JSON.stringify(claudeUser('u1', 1, [{ type: 'text', text: 'look' }, claudeImage(b64(PNG_1x1))]))])
    expect(users(events)[0]).toMatchObject({ text: 'look\n[image]' })
    expect(users(events)[0].images).toBeUndefined()
  })

  it('older pages get their images too', () => {
    const recs = []
    for (let i = 0; i < 40; i++) {
      recs.push(claudeUser(`u${i}`, i * 2, [{ type: 'text', text: `p${i} ${'x'.repeat(200)}` }, claudeImage(b64(PNG_1x1))]))
      recs.push(claudeReply(i * 2 + 1))
    }
    const home = claudeHome(lines(recs))
    const small = { bytes: 4096, probe: 1024, maxLine: 1024 * 1024, text: HISTORY_LIMITS.text }
    const page = readOlderHistory({ agent: 'claude', sessionId: CLAUDE_ID, home, beforeAt: Date.parse(ts(60)), limits: small })
    expect(page.ok).toBe(true)
    const us = users(page.events)
    expect(us.length).toBeGreaterThan(0)
    for (const u of us) {
      expect(u.images).toEqual([{ name: 'image.png', mediaType: 'image/png', dataUrl: dataUrl(PNG_1x1) }])
      expect(u.text).not.toContain('[image]')
    }
  })
})

describe('Codex history images and files', () => {
  it('data: URLs and local image paths; a folder, a missing file, bad bytes stay "[image]"', () => {
    const png = write('shot.png', PNG_1x1)
    const fake = write('fake.png', TEXT)
    const big = write('big.png', BIG)
    const folder = join(tmp, 'folder.png')
    fs.mkdirSync(folder)
    const home = codexHome(
      lines([
        { timestamp: ts(0), type: 'session_meta', payload: { id: CODEX_ID } },
        { timestamp: ts(1), type: 'event_msg', payload: { type: 'user_message', message: 'look', images: [dataUrl(PNG_1x1), 'data:image/png;base64,' + b64(TEXT)], local_images: [png, folder] } },
        { timestamp: ts(2), type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } },
        { timestamp: ts(3), type: 'event_msg', payload: { type: 'user_message', message: 'more', local_images: [fake, big, join(tmp, 'missing.png'), 'relative.png'] } },
        { timestamp: ts(4), type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } }
      ])
    )
    const res = readTranscriptHistory({ agent: 'codex', sessionId: CODEX_ID, home })
    expect(res.ok).toBe(true)
    const [a, b] = users(res.events)
    expect(a.images).toEqual([
      { name: 'image.png', mediaType: 'image/png', dataUrl: dataUrl(PNG_1x1) },
      { name: 'shot.png', mediaType: 'image/png', dataUrl: dataUrl(PNG_1x1) }
    ])
    expect(a.text).toBe('look\n[image] [image]')
    expect(b.images).toBeUndefined()
    expect(b.text).toBe('more\n[image] [image] [image] [image]')
  })

  it('a link, or a file reached through a junction, is never read', () => {
    const real = write('real.png', PNG_1x1)
    const inner = join(tmp, 'inner')
    fs.mkdirSync(inner)
    fs.writeFileSync(join(inner, 'in.png'), PNG_1x1)
    const via = join(tmp, 'via')
    fs.symlinkSync(inner, via, 'junction')
    const candidates = [join(via, 'in.png')]
    let link = null
    try {
      link = join(tmp, 'link.png')
      fs.symlinkSync(real, link, 'file')
      candidates.push(link)
    } catch {
      link = null // no right to make file links here: the junction case still runs
    }
    const events = codexHistoryEvents(
      [
        JSON.stringify({ timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }, ...candidates.map((path) => ({ type: 'localImage', path }))] } })
      ],
      CODEX_ID,
      WITH
    )
    resolveHistoryAttachments(events)
    const [u] = users(events)
    expect(u.images).toBeUndefined()
    expect(u.text).toBe(`x\n${candidates.map(() => '[image]').join(' ')}`)
  })

  it('response items: input_image with a data: URL, input_file as a chip (local file openable)', () => {
    const doc = write('notes.txt', Buffer.from('some notes'))
    const events = codexHistoryEvents(
      [
        JSON.stringify({
          timestamp: ts(1),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'see' },
              { type: 'input_image', image_url: dataUrl(JPEG, 'image/jpeg') },
              { type: 'input_file', filename: 'spec.pdf', file_data: 'data:application/pdf;base64,' + b64(Buffer.from('%PDF-1.4')) },
              { type: 'input_file', file_url: pathToFileURL(doc).href }
            ]
          }
        })
      ],
      CODEX_ID,
      WITH
    )
    resolveHistoryAttachments(events)
    const [u] = users(events)
    expect(u.images).toEqual([{ name: 'image.jpg', mediaType: 'image/jpeg', dataUrl: dataUrl(JPEG, 'image/jpeg') }])
    expect(u.files).toEqual([
      { name: 'spec.pdf', mediaType: 'application/pdf', size: 8 },
      { name: 'notes.txt', mediaType: '', size: 10, path: doc }
    ])
    expect(u.text).toBe('see')
  })
})

describe('OpenCode history images and files', () => {
  it('file parts: images by bytes, other files as chips, placeholders for the rest', () => {
    const doc = write('data.csv', Buffer.from('a,b\n1,2\n'))
    const png = write('pic.png', PNG_1x1)
    const messages = [
      {
        info: { id: 'msg_1', role: 'user', time: { created: 1 } },
        parts: [
          { type: 'text', text: 'look' },
          { type: 'file', mime: 'image/png', filename: 'a.png', url: dataUrl(PNG_1x1) },
          { type: 'file', mime: 'image/png', filename: 'fake.png', url: 'data:image/png;base64,' + b64(TEXT) },
          { type: 'file', mime: 'image/png', filename: 'pic.png', url: pathToFileURL(png).href },
          { type: 'file', mime: 'text/csv', filename: 'data.csv', url: pathToFileURL(doc).href },
          { type: 'file', mime: 'application/pdf', filename: 'gone.pdf', url: pathToFileURL(join(tmp, 'gone.pdf')).href }
        ]
      },
      { info: { id: 'msg_2', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'ok' }] }
    ]
    const events = opencodeHistoryEvents(messages, WITH)
    resolveHistoryAttachments(events)
    const [u] = users(events)
    expect(u.images).toEqual([
      { name: 'a.png', mediaType: 'image/png', dataUrl: dataUrl(PNG_1x1) },
      { name: 'pic.png', mediaType: 'image/png', dataUrl: dataUrl(PNG_1x1) }
    ])
    expect(u.files).toEqual([
      { name: 'data.csv', mediaType: 'text/csv', size: 8, path: doc },
      // No longer there: shown, not openable.
      { name: 'gone.pdf', mediaType: 'application/pdf' }
    ])
    expect(u.text).toBe('look\n[image]')
  })

  it('more files than a message shows: "[file]" for the rest', () => {
    const parts = Array.from({ length: ATTACHMENT_LIMITS.files + 2 }, (_, i) => ({ type: 'file', mime: 'text/plain', filename: `f${i}.txt`, url: 'data:text/plain;base64,aGk=' }))
    const events = opencodeHistoryEvents([{ info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts }], WITH)
    resolveHistoryAttachments(events)
    const [u] = users(events)
    expect(u.files).toHaveLength(ATTACHMENT_LIMITS.files)
    expect(u.files[0]).toEqual({ name: 'f0.txt', mediaType: 'text/plain', size: 2 })
    expect(u.text).toBe('[file] [file]')
  })
})

describe('network and device paths', () => {
  it('are never touched', async () => {
    const { localPath, plainFile } = await import('../historyAttachments.js')
    for (const p of ['\\attacker\share\x.png', '//attacker/share/x.png', '\\?\C:\x.png', '\\.\pipe\x', 'file://attacker/share/x.png']) {
      expect(localPath(p), p).toBe(null)
      expect(plainFile(p), p).toBe(null)
    }
  })
})
