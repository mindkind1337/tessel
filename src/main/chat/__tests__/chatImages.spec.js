// @vitest-environment node
// Images attached to chat messages: validation (type by magic bytes, size,
// count, real files only), the per-agent payloads, the journal (names only)
// and the cleanup (turn end, removed chip, closed pane, old leftovers).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { cleanImageName, createChatImages, imageSize, IMAGE_ID, sniffImage } from '../chatImages'
import { claudeUserContent } from '../claudeChat'
import { codexUserInput } from '../codexChat'
import { opencodeParts } from '../opencodeChat'
import { createChatSessions } from '../sessions'
import { claudeHistoryEvents, codexHistoryEvents, opencodeHistoryEvents } from '../transcriptHistory'
import { BMP, PNG_1x1, SVG, TEXT, gifOf, jpegOf, pngOf, webpOf } from './fixtures/chatImageBytes'

const flush = () => new Promise((r) => setImmediate(r))
let tmp, dir, store
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chat-images-'))
  dir = join(tmp, 'store')
  store = createChatImages({ dir })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})
const write = (name, buf) => {
  const file = join(tmp, name)
  fs.writeFileSync(file, buf)
  return file
}
const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])

describe('what an image is', () => {
  it('knows png, jpeg, gif and webp by their bytes, with their pixel size', () => {
    expect(sniffImage(PNG_1x1)).toBe('image/png')
    expect(imageSize(PNG_1x1, 'image/png')).toEqual({ width: 1, height: 1 })
    for (const [buf, mime] of [
      [pngOf(688, 478), 'image/png'],
      [jpegOf(688, 478), 'image/jpeg'],
      [gifOf(688, 478), 'image/gif'],
      [webpOf(688, 478), 'image/webp']
    ]) {
      expect(sniffImage(buf)).toBe(mime)
      expect(imageSize(buf, mime)).toEqual({ width: 688, height: 478 })
    }
  })
  it('refuses anything else, whatever its name', () => {
    for (const buf of [BMP, SVG, TEXT, Buffer.alloc(0), Buffer.from('GIF8')]) expect(sniffImage(buf)).toBeNull()
  })
  it('keeps a shown name to one line, without its folder', () => {
    expect(cleanImageName('C:\\Users\\me\\shot.png', 'image/png')).toBe('shot.png')
    expect(cleanImageName('a\u0000b\nc.png', 'image/png')).toBe('abc.png')
    expect(cleanImageName('', 'image/jpeg')).toBe('image.jpg')
    expect(cleanImageName(`${'x'.repeat(300)}.png`, 'image/png')).toHaveLength(120)
  })
})

describe('saving and importing', () => {
  it('saves clipboard bytes under an opaque id, in its own folder', () => {
    const r = store.saveBytes({ paneId: 'p1', bytes: new Uint8Array(pngOf(688, 478)), name: 'image.png' })
    expect(r).toMatchObject({ ok: true, image: { name: 'image.png', mime: 'image/png', width: 688, height: 478 } })
    expect(IMAGE_ID.test(r.image.id)).toBe(true)
    expect(r.image).not.toHaveProperty('file')
    expect(files()).toEqual([`${r.image.id}.png`])
  })
  it('refuses bytes that are not an allowed image, or over 10 MB', () => {
    for (const bytes of [BMP, SVG, TEXT]) expect(store.saveBytes({ paneId: 'p1', bytes }).ok).toBe(false)
    const big = pngOf(10, 10, 10 * 1024 * 1024)
    expect(store.saveBytes({ paneId: 'p1', bytes: big })).toMatchObject({ ok: false, error: 'This image is larger than 10 MB.' })
    expect(store.saveBytes({ paneId: 'p1', bytes: 'not bytes' }).ok).toBe(false)
    expect(files()).toEqual([])
  })
  it('copies a dropped image file (by its bytes, not its name)', () => {
    const r = store.importFile({ paneId: 'p1', path: write('photo.jpeg', jpegOf(640, 480)) })
    expect(r).toMatchObject({ ok: true, image: { name: 'photo.jpeg', mime: 'image/jpeg', width: 640, height: 480 } })
    expect(files()).toEqual([`${r.image.id}.jpg`])
    // A text file named .png, an SVG, a BMP: refused.
    for (const [name, buf] of [['fake.png', TEXT], ['logo.svg', SVG], ['old.bmp', BMP]]) {
      expect(store.importFile({ paneId: 'p1', path: write(name, buf) })).toMatchObject({ ok: false, error: 'Only PNG, JPEG, GIF and WebP images can be attached.' })
    }
  })
  it('refuses a folder, a missing file, a relative path and a file over 10 MB', () => {
    fs.mkdirSync(join(tmp, 'folder.png'))
    expect(store.importFile({ paneId: 'p1', path: join(tmp, 'folder.png') }).ok).toBe(false)
    expect(store.importFile({ paneId: 'p1', path: join(tmp, 'missing.png') })).toMatchObject({ ok: false, error: 'This file could not be read.' })
    expect(store.importFile({ paneId: 'p1', path: 'relative.png' }).ok).toBe(false)
    expect(store.importFile({ paneId: 'p1', path: `${join(tmp, 'a.png')}\0` }).ok).toBe(false)
    const big = write('big.png', pngOf(10, 10, 10 * 1024 * 1024))
    expect(store.importFile({ paneId: 'p1', path: big })).toMatchObject({ ok: false, error: 'This image is larger than 10 MB.' })
    expect(files()).toEqual([])
  })
  it('refuses a link to an image', () => {
    const target = write('real.png', pngOf(5, 5))
    const link = join(tmp, 'link.png')
    let made = true
    try {
      fs.symlinkSync(target, link, 'file')
    } catch {
      made = false // no symlink right on this machine: the check is simulated
    }
    if (!made) {
      const real = fs.lstatSync
      vi.spyOn(fs, 'lstatSync').mockImplementation((p, ...rest) =>
        p === link ? { ...real(target), isSymbolicLink: () => true, isFile: () => false } : real(p, ...rest)
      )
    }
    expect(store.importFile({ paneId: 'p1', path: link })).toMatchObject({ ok: false, error: 'Links cannot be attached: drop the image itself.' })
    expect(files()).toEqual([])
  })
  it('caps the images a pane can hold', () => {
    const small = createChatImages({ dir, limits: { maxBytes: 1024, perMessage: 10, perPane: 2, total: 200, name: 120 } })
    expect(small.saveBytes({ paneId: 'p1', bytes: PNG_1x1 }).ok).toBe(true)
    expect(small.saveBytes({ paneId: 'p1', bytes: PNG_1x1 }).ok).toBe(true)
    expect(small.saveBytes({ paneId: 'p1', bytes: PNG_1x1 }).ok).toBe(false)
    expect(small.saveBytes({ paneId: 'p2', bytes: PNG_1x1 }).ok).toBe(true)
  })
})

describe('taking images for a message', () => {
  const save = (paneId = 'p1') => store.saveBytes({ paneId, bytes: PNG_1x1, name: 'image.png' }).image.id
  it('takes only its own pane’s ids, at most 10, once', () => {
    const a = save()
    const other = save('p2')
    expect(store.take('p1', [other]).ok).toBe(false)
    expect(store.take('p1', ['C:\\Windows\\win.ini']).ok).toBe(false)
    expect(store.take('p1', [a, a]).ok).toBe(false)
    const eleven = Array.from({ length: 11 }, () => save())
    expect(store.take('p1', eleven)).toMatchObject({ ok: false, error: 'At most 10 images per message.' })
    const r = store.take('p1', [a])
    expect(r.ok).toBe(true)
    expect(r.images[0].file.startsWith(dir)).toBe(true)
    // Sent once: not again, and no longer discardable as a chip.
    expect(store.take('p1', [a]).ok).toBe(false)
    expect(store.discard({ paneId: 'p1', id: a }).ok).toBe(false)
  })
  it('discards a removed chip and everything a closed pane still holds', () => {
    const a = save()
    save()
    save('p2')
    expect(store.discard({ paneId: 'p2', id: a }).ok).toBe(false)
    expect(store.discard({ paneId: 'p1', id: a }).ok).toBe(true)
    expect(files()).toHaveLength(2)
    store.releasePane('p1')
    expect(files()).toHaveLength(1)
  })
  it('sweeps leftovers of an earlier run after a day', () => {
    fs.mkdirSync(dir, { recursive: true })
    const old = join(dir, 'img_old.png')
    fs.writeFileSync(old, PNG_1x1)
    const day = Date.now() / 1000 - 2 * 86400
    fs.utimesSync(old, day, day)
    const fresh = save()
    store.sweep()
    expect(files()).toEqual([`${fresh}.png`])
  })
})

describe('what each agent gets', () => {
  const pic = (mime = 'image/png', name = 'image.png') => ({ mime, name, path: 'C:\\Temp\\tessel-paste\\chat\\img_x.png', base64: () => 'QUJD' })
  it('Claude: base64 image blocks, then the text', () => {
    expect(claudeUserContent('look', [pic(), pic('image/webp')])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'QUJD' } },
      { type: 'text', text: 'look' }
    ])
    expect(claudeUserContent('', [pic()])).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }])
    expect(claudeUserContent('only text')).toEqual([{ type: 'text', text: 'only text' }])
  })
  it('Claude: a large png/jpeg is shrunk under its 5 MB limit', () => {
    const big = pngOf(4000, 3000, 6 * 1024 * 1024)
    const file = write('big.png', big)
    const pic2 = {
      getSize: () => ({ width: 4000, height: 3000 }),
      resize: vi.fn(() => pic2),
      toJPEG: vi.fn(() => Buffer.alloc(1000))
    }
    const nativeImage = { createFromBuffer: vi.fn(() => pic2) }
    const shrinking = createChatImages({ dir, nativeImage })
    const r = shrinking.importFile({ paneId: 'p1', path: file })
    const [img] = shrinking.take('p1', [r.image.id]).images
    const out = shrinking.forAgent(img).claudeImage()
    expect(out.mime).toBe('image/jpeg')
    expect(Buffer.from(out.data, 'base64')).toHaveLength(1000)
    expect(pic2.resize).toHaveBeenCalledWith({ width: 2048, quality: 'good' })
  })
  it('Codex: turn/start input with localImage items (Tessel’s copy)', () => {
    expect(codexUserInput('look', [pic()])).toEqual([
      { type: 'text', text: 'look', text_elements: [] },
      { type: 'localImage', path: 'C:\\Temp\\tessel-paste\\chat\\img_x.png' }
    ])
    expect(codexUserInput('', [pic()])).toEqual([{ type: 'localImage', path: 'C:\\Temp\\tessel-paste\\chat\\img_x.png' }])
  })
  it('OpenCode: prompt parts with file parts (data: URL), as its FilePartInput', () => {
    expect(opencodeParts('look', [pic('image/jpeg', 'photo.jpg')])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', mime: 'image/jpeg', filename: 'photo.jpg', url: 'data:image/jpeg;base64,QUJD' }
    ])
    expect(opencodeParts('', [pic()])).toHaveLength(1)
  })
})

class FakeAdapter extends EventEmitter {
  constructor() {
    super()
    this.start = vi.fn(async () => ({ ok: true, pid: 1, info: {} }))
    this.send = vi.fn(async () => ({ ok: true }))
    this.close = vi.fn(async () => this.emit('exit', { code: 0, signal: null, stderrTail: '', crashed: false }))
  }
}

describe('a chat message with images', () => {
  let sent, adapters, handlers, chat
  const paneId = 'pane-1'
  beforeEach(async () => {
    sent = []
    adapters = []
    handlers = {}
    chat = createChatSessions({
      dir: tmp,
      images: store,
      send: (channel, payload) => sent.push({ channel, ...payload }),
      createAdapter: () => {
        const a = new FakeAdapter()
        adapters.push(a)
        return a
      },
      resolveClaude: async () => ({ exe: 'C:\\bin\\claude.exe', exeArgs: [] }),
      env: { forPane: () => ({ Path: 'C:\\Windows' }) },
      trust: { isTrusted: () => true, ask: async () => true, trust: () => true },
      team: { newSecret: () => 'f'.repeat(64), setSecret: () => {}, revokeSecret: () => {} }
    })
    chat.register({ handle: (name, fn) => (handlers[name] = (q) => fn({}, q)) })
    const r = await chat.open({ paneId, cwd: tmp, permissions: 'manual' })
    expect(r.ok).toBe(true)
    await flush()
  })
  afterEach(() => chat.closeAll())
  const userEvents = () => sent.filter((e) => e.event?.type === 'user').map((e) => e.event)

  it('gives the adapter Tessel’s copies, journals names only, and removes the copies when the turn ends', async () => {
    const a = (await handlers['chat:imageSave']({ paneId, bytes: new Uint8Array(pngOf(688, 478)), name: 'image.png' })).image
    const b = (await handlers['chat:imageImport']({ paneId, path: write('shot.webp', webpOf(20, 10)) })).image
    const r = await handlers['chat:send']({ paneId, text: '', images: [a.id, b.id] })
    expect(r.ok).toBe(true)
    await flush()
    const call = adapters[0].send.mock.calls[0][0]
    expect(call.text).toBe('')
    expect(call.images.map((i) => [i.name, i.mime, i.path.startsWith(dir)])).toEqual([
      ['image.png', 'image/png', true],
      ['shot.webp', 'image/webp', true]
    ])
    expect(call.images[0].base64()).toBe(pngOf(688, 478).toString('base64'))
    expect(userEvents()[0].images).toEqual([
      { id: a.id, name: 'image.png', width: 688, height: 478 },
      { id: b.id, name: 'shot.webp', width: 20, height: 10 }
    ])
    const journal = fs.readdirSync(tmp, { recursive: true }).filter((f) => String(f).endsWith('.jsonl'))
    const text = journal.map((f) => fs.readFileSync(join(tmp, f), 'utf8')).join('')
    expect(text).toContain('image.png')
    expect(text).not.toContain(pngOf(688, 478).toString('base64'))
    expect(files()).toHaveLength(2)
    adapters[0].emit('turnEnd', { status: 'completed' })
    await flush()
    expect(files()).toEqual([])
  })

  it('keeps a queued message’s images until its own turn has ended', async () => {
    const first = (await handlers['chat:imageSave']({ paneId, bytes: PNG_1x1 })).image
    const second = (await handlers['chat:imageSave']({ paneId, bytes: PNG_1x1 })).image
    await handlers['chat:send']({ paneId, text: 'one', images: [first.id] })
    const r = await handlers['chat:send']({ paneId, text: 'two', images: [second.id] })
    expect(r.queued).toBe(true)
    adapters[0].emit('turnEnd', { status: 'completed' })
    await flush()
    expect(files()).toEqual([`${second.id}.png`])
    expect(adapters[0].send.mock.calls[1][0].images[0].id).toBe(second.id)
    adapters[0].emit('turnEnd', { status: 'completed' })
    await flush()
    expect(files()).toEqual([])
  })

  it('refuses ids that are not this pane’s, paths, and more than 10', async () => {
    const other = store.saveBytes({ paneId: 'pane-2', bytes: PNG_1x1 }).image
    expect(await handlers['chat:send']({ paneId, text: 'x', images: [other.id] })).toMatchObject({ ok: false, code: 'image' })
    expect(await handlers['chat:send']({ paneId, text: 'x', images: [join(tmp, 'a.png')] })).toMatchObject({ ok: false })
    expect(await handlers['chat:send']({ paneId, text: 'x', images: 'img' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await handlers['chat:send']({ paneId, text: '', images: [] })).toMatchObject({ ok: false, code: 'invalid' })
    const many = []
    for (let i = 0; i < 11; i++) many.push(store.saveBytes({ paneId, bytes: PNG_1x1 }).image.id)
    expect(await handlers['chat:send']({ paneId, text: 'x', images: many })).toMatchObject({ ok: false, error: 'At most 10 images per message.' })
    expect(adapters[0].send).not.toHaveBeenCalled()
  })

  it('removes a pane’s images when it is closed for good', async () => {
    await handlers['chat:imageSave']({ paneId, bytes: PNG_1x1 })
    await handlers['chat:imageImport']({ paneId, path: write('b.gif', gifOf(3, 3)) })
    expect(files()).toHaveLength(2)
    await handlers['chat:close']({ paneId, forget: true })
    expect(files()).toEqual([])
  })
})

describe('an earlier conversation shows [image] where images were', () => {
  it('Claude', () => {
    const line = JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }, { type: 'text', text: 'look' }] } })
    const only = JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] } })
    const texts = claudeHistoryEvents([line, only]).filter((e) => e.type === 'user').map((e) => e.text)
    expect(texts).toEqual(['look\n[image]', '[image]'])
    expect(JSON.stringify(claudeHistoryEvents([line]))).not.toContain('QUJD')
  })
  it('Codex', () => {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'look', images: ['data:image/png;base64,QUJD'] } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'ok' } })
    ]
    const texts = codexHistoryEvents(lines, 't1').filter((e) => e.type === 'user').map((e) => e.text)
    expect(texts).toEqual(['look\n[image]'])
  })
  it('OpenCode', () => {
    const messages = [{ info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'look' }, { type: 'file', mime: 'image/png', url: 'data:image/png;base64,QUJD' }] }]
    const texts = opencodeHistoryEvents(messages).filter((e) => e.type === 'user').map((e) => e.text)
    expect(texts).toEqual(['look\n[image]'])
  })
})
