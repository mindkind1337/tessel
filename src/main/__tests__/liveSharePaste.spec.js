// @vitest-environment node
// Live Share: an image a guest pastes (or drops) into a host's pane
// (liveShare/sharePaste.js, liveShare.js). The guest's Tessel reads the image
// as a PNG and sends it in parts; the host checks the type right on that
// pane's project, takes only a real PNG within the caps (its size read from
// its header before anything is decoded), makes it a new PNG, saves it with
// a name of its own in its folder for pasted images, has its window paste
// the path, and lists it in "Recent guest actions". End to end over real
// WebSockets on 127.0.0.1 (only Cloudflare's tunnel is faked), and with a
// guest that sends what it likes (createShareGuest straight at the host).
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { registerLiveShare } from '../liveShare'
import { createShareGuest } from '../liveShare/shareGuest'
import { newSigningKey, decodeInvite } from '../liveShare/shareCrypto'
import { OP_AREAS } from '../liveShare/shareChannel'
import { SHARE_FEATURES } from '../liveShare/shareChat'
import { PASTE_LIMITS, PASTE_OPS, MAX_PARTS, pngSize, checkPng, splitParts, createPasteUploads, createPasteImages, newUploadId } from '../liveShare/sharePaste'
import { NO_RIGHTS } from '../../shared/liveShareRights'

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

vi.mock('../liveShare/shareTunnel.js', () => ({
  ensureCloudflared: vi.fn(async () => 'cloudflared.exe'),
  startTunnel: vi.fn(async ({ port }) => ({ url: `ws://127.0.0.1:${port}/`, stop: vi.fn(), pid: 4242 })),
  waitReachable: vi.fn(async () => true),
  waitRegistered: vi.fn(async () => true),
  tunnelLogTail: vi.fn(() => ''),
  endLeftoverTunnel: vi.fn(async () => false),
  tunnelState: vi.fn(async () => 'ours'),
  stopTunnelPid: vi.fn(async () => true),
  stopTunnelLater: vi.fn(),
  processState: vi.fn(async () => null)
}))

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('timed out')
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// A PNG as far as these specs go: the signature, its header (IHDR with the
// width and height), then its "pixels"; what comes after TRAILER is not part
// of the image (a decoder drops it), and BROKEN anywhere makes it undecodable.
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TRAILER = Buffer.from('TRAILER')
function makePng(w, h, pixels = Buffer.from('pixels')) {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'latin1')
  ihdr.writeUInt32BE(w, 8)
  ihdr.writeUInt32BE(h, 12)
  return Buffer.concat([SIG, ihdr, pixels])
}
// Electron's nativeImage, for those PNGs: toPNG makes the image again (the
// trailer gone).
const EMPTY = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }
function fakeNativeImage() {
  const ni = {
    createFromBuffer: vi.fn((buf) => {
      const size = pngSize(buf)
      if (!size || buf.includes('BROKEN')) return EMPTY
      const end = buf.indexOf(TRAILER)
      const pixels = Buffer.from(buf.subarray(33, end < 0 ? buf.length : end))
      return { isEmpty: () => false, getSize: () => ({ ...size }), toPNG: () => makePng(size.width, size.height, pixels) }
    }),
    createFromPath: vi.fn((p) => {
      try {
        return ni.createFromBuffer(fs.readFileSync(p))
      } catch {
        return EMPTY
      }
    })
  }
  return ni
}

const dirs = []
const newDir = () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-lsp-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('an image a guest sends, checked (sharePaste.js)', () => {
  it('reads a PNG\u2019s size from its header; anything else is no PNG', () => {
    expect(pngSize(makePng(640, 480))).toEqual({ width: 640, height: 480 })
    expect(pngSize(Buffer.from('GIF89a and some more bytes to be long enough'))).toBe(null)
    expect(pngSize(makePng(0, 10))).toBe(null)
    expect(pngSize('not a buffer')).toBe(null)
  })

  it('takes a real PNG within the caps and gives a new PNG of it; too big is refused before any decoding', () => {
    const ni = fakeNativeImage()
    const res = checkPng(Buffer.concat([makePng(10, 20, Buffer.from('dots')), TRAILER, Buffer.from('anything else')]), ni)
    expect(res).toEqual({ ok: true, png: makePng(10, 20, Buffer.from('dots')), width: 10, height: 20 })
    expect(res.png.includes('anything else')).toBe(false)
    // Not an image, an image that does not decode, one whose header lies.
    expect(checkPng(Buffer.from('#!/bin/sh\nrm -rf /\n'.repeat(4)), ni)).toEqual({ ok: false, code: 'not-image' })
    expect(checkPng(makePng(10, 10, Buffer.from('BROKEN')), ni)).toEqual({ ok: false, code: 'not-image' })
    const liar = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 99, height: 99 }), toPNG: () => makePng(99, 99) }) }
    expect(checkPng(makePng(10, 10), liar)).toEqual({ ok: false, code: 'not-image' })
    expect(checkPng(Buffer.alloc(0), ni)).toEqual({ ok: false, code: 'not-image' })
    // Over 8000 pixels a side, over 10 MB: refused, never decoded.
    ni.createFromBuffer.mockClear()
    expect(checkPng(makePng(8001, 10), ni)).toEqual({ ok: false, code: 'too-large' })
    expect(checkPng(makePng(10, 9000), ni)).toEqual({ ok: false, code: 'too-large' })
    expect(checkPng(makePng(10, 10, Buffer.alloc(PASTE_LIMITS.bytes)), ni)).toEqual({ ok: false, code: 'too-large' })
    expect(ni.createFromBuffer).not.toHaveBeenCalled()
    expect(checkPng(makePng(8000, 8000), ni).ok).toBe(true)
  })

  it('is sent in parts of 512 KB, each under the 1 MB a guest\u2019s message may be', () => {
    const png = makePng(10, 10, Buffer.alloc(PASTE_LIMITS.part * 2 + 5, 7))
    const parts = splitParts(png)
    expect(parts).toHaveLength(3)
    expect(Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')))).toEqual(png)
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThan(1000 * 1000 - 1000)
    expect(MAX_PARTS).toBe(20)
    expect(OP_AREAS.paste).toBe('paste')
    expect(SHARE_FEATURES).toContain('paste')
    expect(PASTE_OPS['paste.image']).toMatchObject({ right: 'type', kind: 'write' })
    expect(PASTE_OPS['paste.part']).toMatchObject({ right: 'type' })
  })
})

describe('the host\u2019s uploads (createPasteUploads)', () => {
  const part = (upload, index, count, bytes, pane = 'pane-1') => ({ pane, upload, index, count, data: Buffer.from(bytes).toString('base64') })
  it('takes the parts in order, one upload per guest, and gives them back whole once', () => {
    const u = createPasteUploads()
    const id = newUploadId()
    expect(u.part('g1', 'ws-1', part(id, 0, 2, 'ab'))).toEqual({ ok: true })
    // Out of order, another pane, another project: refused.
    expect(u.part('g1', 'ws-1', part(id, 0 + 2, 2, 'x'))).toMatchObject({ ok: false })
    expect(u.part('g1', 'ws-1', part(id, 1, 2, 'x', 'pane-2'))).toEqual({ ok: false, code: 'bad-args' })
    expect(u.part('g1', 'ws-2', part(id, 1, 2, 'x'))).toEqual({ ok: false, code: 'bad-args' })
    // Not all in yet.
    expect(u.take('g1', 'ws-1', { pane: 'pane-1', upload: id })).toEqual({ ok: false, code: 'bad-args' })
    expect(u.part('g1', 'ws-1', part(id, 1, 2, 'cd'))).toEqual({ ok: true })
    // Another guest can't take it.
    expect(u.take('g2', 'ws-1', { pane: 'pane-1', upload: id })).toEqual({ ok: false, code: 'bad-args' })
    expect(u.take('g1', 'ws-1', { pane: 'pane-1', upload: id })).toEqual({ ok: true, bytes: Buffer.from('abcd') })
    expect(u.take('g1', 'ws-1', { pane: 'pane-1', upload: id })).toEqual({ ok: false, code: 'bad-args' })
    // A new upload replaces the one a guest had.
    const a = newUploadId()
    const b = newUploadId()
    u.part('g1', 'ws-1', part(a, 0, 2, 'a'))
    u.part('g1', 'ws-1', part(b, 0, 1, 'b'))
    expect(u.size()).toBe(1)
    expect(u.part('g1', 'ws-1', part(a, 1, 2, 'a'))).toEqual({ ok: false, code: 'bad-args' })
    expect(u.take('g1', 'ws-1', { pane: 'pane-1', upload: b })).toEqual({ ok: true, bytes: Buffer.from('b') })
  })

  it('keeps to the caps: parts, bytes, uploads at once, images a minute, a minute without a part', () => {
    let now = 1000
    const u = createPasteUploads({ now: () => now })
    expect(u.part('g1', 'ws-1', part(newUploadId(), 0, MAX_PARTS + 1, 'a'))).toEqual({ ok: false, code: 'too-large' })
    expect(u.part('g1', 'ws-1', { ...part(newUploadId(), 0, 1, 'a'), data: 'not base64!' })).toEqual({ ok: false, code: 'bad-args' })
    expect(u.part('g1', 'ws-1', { ...part(newUploadId(), 0, 1, 'a'), data: 'A'.repeat(800000) })).toEqual({ ok: false, code: 'bad-args' })
    expect(u.part('g1', 'ws-1', { ...part('../../x', 0, 1, 'a') })).toEqual({ ok: false, code: 'bad-args' })
    expect(u.part('g1', 'ws-1', part(newUploadId(), 0, 1, 'a', 'C:\\x'))).toEqual({ ok: false, code: 'bad-args' })
    // Bytes over 10 MB in all: refused, the upload dropped.
    const small = createPasteUploads({ limits: { ...PASTE_LIMITS, bytes: 8, part: 4 } })
    const id = newUploadId()
    expect(small.part('g1', 'ws-1', part(id, 0, 2, 'abcd'))).toEqual({ ok: true })
    expect(small.part('g1', 'ws-1', part(id, 1, 2, 'abcde'))).toEqual({ ok: false, code: 'too-large' })
    expect(small.size()).toBe(0)
    // Three uploads at once, all guests together.
    for (const g of ['g1', 'g2', 'g3']) expect(u.part(g, 'ws-1', part(newUploadId(), 0, 2, 'a'))).toEqual({ ok: true })
    expect(u.part('g4', 'ws-1', part(newUploadId(), 0, 2, 'a'))).toEqual({ ok: false, code: 'busy' })
    // A minute without a part: dropped (room again).
    now += PASTE_LIMITS.uploadMs
    expect(u.part('g4', 'ws-1', part(newUploadId(), 0, 2, 'a'))).toEqual({ ok: true })
    expect(u.size()).toBe(1)
    // Guests gone: their uploads go.
    u.keep([])
    expect(u.size()).toBe(0)
    // Six images a minute per guest.
    for (let i = 0; i < 7; i++) {
      const x = newUploadId()
      u.part('g1', 'ws-1', part(x, 0, 1, 'a'))
      expect(u.take('g1', 'ws-1', { pane: 'pane-1', upload: x }).ok).toBe(i < 6)
    }
    now += 60000
    const y = newUploadId()
    u.part('g1', 'ws-1', part(y, 0, 1, 'a'))
    expect(u.take('g1', 'ws-1', { pane: 'pane-1', upload: y }).ok).toBe(true)
  })

  it('saves with a name of the host\u2019s, in its own folder; reads a guest\u2019s clipboard or dropped file as a checked PNG', () => {
    const dir = newDir()
    const ni = fakeNativeImage()
    let clip = EMPTY
    const images = createPasteImages({ nativeImage: ni, clipboard: { readImage: () => clip }, dir })
    const file = images.save(makePng(2, 2))
    expect(file.startsWith(dir)).toBe(true)
    expect(file).toMatch(/guest-image-\d+-[0-9a-f]{8}\.png$/)
    expect(fs.readFileSync(file)).toEqual(makePng(2, 2))
    expect(images.fromClipboard()).toEqual({ ok: false, code: 'no-image' })
    clip = ni.createFromBuffer(makePng(9000, 4))
    expect(images.fromClipboard()).toEqual({ ok: false, code: 'too-large' })
    clip = ni.createFromBuffer(makePng(4, 4))
    expect(images.fromClipboard()).toMatchObject({ ok: true, width: 4, height: 4 })
    const pic = join(dir, 'drop.png')
    fs.writeFileSync(pic, makePng(3, 3))
    expect(images.fromFile(pic)).toMatchObject({ ok: true, width: 3 })
    const text = join(dir, 'notes.txt')
    fs.writeFileSync(text, 'hello')
    expect(images.fromFile(text)).toEqual({ ok: false, code: 'not-image' })
    const fake = join(dir, 'fake.png')
    fs.writeFileSync(fake, 'not really')
    expect(images.fromFile(fake)).toEqual({ ok: false, code: 'not-image' })
    expect(images.fromFile(join(dir, 'gone.png'))).toEqual({ ok: false, code: 'not-image' })
  })
})

// --- End to end ------------------------------------------------------------
function fakeMain({ images = null } = {}) {
  const m = {
    handle: {},
    on: {},
    sent: [],
    ipcMain: { handle: (name, fn) => (m.handle[name] = fn), on: (name, fn) => (m.on[name] = fn) },
    send: (channel, payload) => m.sent.push([channel, payload]),
    host: {
      request: vi.fn(async (op, body, _timeout, onReply) => {
        const msg = op === 'attach' ? { ok: true, buffer: `screen of ${body.id}` } : { ok: false }
        onReply?.(msg)
        return msg
      }),
      send: vi.fn()
    },
    events: (channel) => m.sent.filter(([c]) => c === channel).map(([, p]) => p),
    last: (channel) => m.events(channel).at(-1)
  }
  m.api = registerLiveShare({
    ipcMain: m.ipcMain,
    send: m.send,
    host: m.host,
    dataDir: newDir(),
    queueData: () => {},
    sendExit: () => {},
    log: { info: () => {}, warn: () => {} },
    kill: vi.fn(),
    pidRunning: () => true,
    resume: false,
    images
  })
  return m
}
const leaf = (id, extra = {}) => ({ type: 'leaf', id, view: 'terminal', title: id, kind: 'shell', ...extra })
const TYPE = { ...NO_RIGHTS, type: true }

describe('registerLiveShare: a guest pastes an image into a host\u2019s pane', () => {
  const mains = []
  const clients = []
  afterEach(() => {
    for (const c of clients.splice(0)) c.leave()
    for (const m of mains.splice(0)) m.api.stopAll()
  })

  async function setUp({ rights = TYPE } = {}) {
    const hostDir = newDir()
    const hostNi = fakeNativeImage()
    const guestNi = fakeNativeImage()
    const clip = { image: EMPTY }
    const host = fakeMain({ images: createPasteImages({ nativeImage: hostNi, clipboard: { readImage: () => EMPTY }, dir: hostDir }) })
    const guest = fakeMain({ images: createPasteImages({ nativeImage: guestNi, clipboard: { readImage: () => clip.image }, dir: newDir() }) })
    mains.push(host, guest)
    const started = await host.handle['liveShare:start'](null, { name: 'Cedric', projects: ['ws-1'] })
    host.on['liveShare:layouts'](null, [{ id: 'ws-1', layout: { project: 'site', tree: { type: 'split', children: [leaf('pane-1', { kind: 'agent', agentId: 'claude', title: 'Claude' }), leaf('pane-2', { view: 'editor' })] }, activeId: 'pane-1' } }])
    const invite = started.invites[0].code
    await guest.handle['liveShare:join'](null, { invite, name: 'Alex' })
    const ask = await until(() => host.last('liveShare:ask'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], rights })
    const joined = await until(() => guest.events('liveShare:guest').find((s) => s.state === 'joined' && s.panes.length))
    if (rights.type) await until(() => guest.last('liveShare:guest').rights?.type)
    return { host, guest, hostDir, hostNi, guestNi, clip, invite, guestId: ask.guestId, localId: joined.panes[0].id }
  }
  // The host's window pastes it (or does not): its answer to main.
  async function windowAnswers(host, ok = true, code) {
    const req = await until(() => host.events('liveShare:hostRequest').find((r) => r.action === 'pasteImage' && !r.answered))
    req.answered = true
    host.on['liveShare:pasteDone'](null, { request: req.request, ok, code })
    return req
  }

  it('Ctrl+V: sent in parts, saved by the host as a new PNG with its own name, pasted by its window, listed in Recent guest actions', async () => {
    const { host, guest, hostDir, clip, localId } = await setUp()
    // Over 1 MB: three parts.
    const pixels = Buffer.alloc(PASTE_LIMITS.part * 2 + 100, 3)
    clip.image = fakeNativeImage().createFromBuffer(Buffer.concat([makePng(1200, 900, pixels), TRAILER, Buffer.from('C:\\Users\\alex\\secret.txt')]))
    const pasting = guest.handle['liveShare:pasteImage'](null, localId, {})
    const req = await windowAnswers(host)
    await expect(pasting).resolves.toEqual({ ok: true })
    expect(req).toMatchObject({ action: 'pasteImage', id: 'pane-1', project: 'ws-1', guest: expect.objectContaining({ name: 'Alex' }) })
    // The host's folder, the host's name for it, the image made again.
    expect(req.file.startsWith(hostDir)).toBe(true)
    expect(req.file).toMatch(/guest-image-\d+-[0-9a-f]{8}\.png$/)
    expect(fs.readFileSync(req.file)).toEqual(makePng(1200, 900, pixels))
    expect(fs.readFileSync(req.file).includes('alex')).toBe(false)
    // The notice.
    const action = await until(() => host.last('liveShare:guestAction'))
    expect(action).toMatchObject({ kind: 'pasteImage', name: 'Alex', project: 'ws-1', detail: 'Claude' })
    expect(host.last('liveShare:host').actions[0]).toMatchObject({ kind: 'pasteImage', detail: 'Claude' })

    // The window could not paste it (the pane gone): said to the guest, no notice.
    const before = host.events('liveShare:guestAction').length
    const again = guest.handle['liveShare:pasteImage'](null, localId, {})
    await windowAnswers(host, false, 'not-found')
    await expect(again).resolves.toEqual({ ok: false, code: 'not-found' })
    expect(host.events('liveShare:guestAction')).toHaveLength(before)
  })

  it('a dropped image file goes the same way; another file, an image too large, no image: refused on the guest\u2019s side, nothing sent', async () => {
    const { host, guest, clip, localId } = await setUp()
    const dir = newDir()
    const pic = join(dir, 'shot.png')
    fs.writeFileSync(pic, makePng(50, 40))
    const dropping = guest.handle['liveShare:pasteImage'](null, localId, { file: pic })
    const req = await windowAnswers(host)
    await expect(dropping).resolves.toEqual({ ok: true })
    expect(req.file).not.toContain(dir)
    expect(fs.readFileSync(req.file)).toEqual(makePng(50, 40))
    const asked = host.events('liveShare:hostRequest').length
    const text = join(dir, 'notes.txt')
    fs.writeFileSync(text, 'hi')
    await expect(guest.handle['liveShare:pasteImage'](null, localId, { file: text })).resolves.toEqual({ ok: false, code: 'not-image' })
    await expect(guest.handle['liveShare:pasteImage'](null, localId, {})).resolves.toEqual({ ok: false, code: 'no-image' })
    clip.image = fakeNativeImage().createFromBuffer(makePng(9000, 9000))
    await expect(guest.handle['liveShare:pasteImage'](null, localId, {})).resolves.toEqual({ ok: false, code: 'too-large' })
    clip.image = fakeNativeImage().createFromBuffer(makePng(10, 10, Buffer.alloc(PASTE_LIMITS.bytes + 1)))
    await expect(guest.handle['liveShare:pasteImage'](null, localId, {})).resolves.toEqual({ ok: false, code: 'too-large' })
    await expect(guest.handle['liveShare:pasteImage'](null, 'pane-not-a-guest-pane', {})).resolves.toEqual({ ok: false, code: 'not-found' })
    await wait(50)
    expect(host.events('liveShare:hostRequest')).toHaveLength(asked)
  })

  it('without the type right: refused with a code the guest\u2019s pane says, nothing reaches the host', async () => {
    const { host, guest, clip, localId } = await setUp({ rights: NO_RIGHTS })
    clip.image = fakeNativeImage().createFromBuffer(makePng(4, 4))
    await expect(guest.handle['liveShare:pasteImage'](null, localId, {})).resolves.toEqual({ ok: false, code: 'forbidden' })
    await wait(50)
    expect(host.events('liveShare:hostRequest').filter((r) => r.action === 'pasteImage')).toEqual([])
  })

  it('a guest that sends what it likes: the host checks the right, the pane, the parts and the bytes, and chooses the path', async () => {
    const { host, hostDir, invite } = await setUp()
    const { url, secret } = decodeInvite(invite)
    const raw = { states: [], projects: null, rights: [] }
    const client = createShareGuest({ url, secret, name: 'Raw', signingKey: newSigningKey(), callbacks: { onState: (s) => raw.states.push(s), onProjects: (p) => (raw.projects = p), onRights: (r) => raw.rights.push(r) } })
    clients.push(client)
    client.connect()
    const ask = await until(() => host.events('liveShare:ask').find((x) => x.name === 'Raw'))
    await host.handle['liveShare:approve'](null, { guestId: ask.guestId, yes: true, projects: ['ws-1'], rights: NO_RIGHTS })
    await until(() => raw.states.includes('joined') && raw.projects)
    expect(client.speaks('paste')).toBe(true)
    const send = async (bytes, extra = {}) => {
      const upload = newUploadId()
      const parts = splitParts(bytes)
      for (let index = 0; index < parts.length; index++) {
        const r = await client.request('paste.part', 'ws-1', { pane: 'pane-1', upload, index, count: parts.length, data: parts[index], ...extra })
        if (!r.ok) return r
      }
      return client.request('paste.image', 'ws-1', { pane: 'pane-1', upload, ...extra })
    }
    // Without the right: the host's own no.
    await expect(send(makePng(4, 4))).resolves.toEqual({ ok: false, code: 'forbidden' })
    await host.handle['liveShare:access'](null, { subject: ask.guestId, right: 'type', on: true })
    await until(() => raw.rights.some((r) => r && r.type))
    // Not an image, an image that does not decode, too big for its header.
    await expect(send(Buffer.from('MZ\x90\x00 this is an exe, not an image'.repeat(10)))).resolves.toEqual({ ok: false, code: 'not-image' })
    await expect(send(makePng(5, 5, Buffer.from('BROKEN')))).resolves.toEqual({ ok: false, code: 'not-image' })
    await expect(send(makePng(20000, 5))).resolves.toEqual({ ok: false, code: 'too-large' })
    // A pane of no shared project's terminals (an editor, one of nobody's).
    const upload = newUploadId()
    const data = makePng(4, 4).toString('base64')
    await expect(client.request('paste.part', 'ws-1', { pane: 'pane-2', upload, index: 0, count: 1, data })).resolves.toEqual({ ok: false, code: 'not-found' })
    await expect(client.request('paste.part', 'ws-1', { pane: 'pane-9', upload, index: 0, count: 1, data })).resolves.toEqual({ ok: false, code: 'not-found' })
    // Parts out of order, too many, a paste with nothing sent.
    await expect(client.request('paste.part', 'ws-1', { pane: 'pane-1', upload, index: 1, count: 2, data })).resolves.toEqual({ ok: false, code: 'bad-args' })
    await expect(client.request('paste.part', 'ws-1', { pane: 'pane-1', upload, index: 0, count: MAX_PARTS + 1, data })).resolves.toEqual({ ok: false, code: 'too-large' })
    await expect(client.request('paste.image', 'ws-1', { pane: 'pane-1', upload: newUploadId() })).resolves.toEqual({ ok: false, code: 'bad-args' })
    expect(host.events('liveShare:hostRequest').filter((r) => r.action === 'pasteImage')).toEqual([])
    expect(fs.existsSync(hostDir) ? fs.readdirSync(hostDir) : []).toEqual([])
    // A path of its own choosing: ignored, the host names the file.
    const pasting = send(makePng(6, 6), { file: 'C:\\Windows\\System32\\evil.png', name: '..\\..\\evil.png' })
    const req = await windowAnswers(host)
    await expect(pasting).resolves.toEqual({ ok: true, data: {} })
    expect(req.file.startsWith(hostDir)).toBe(true)
    expect(req.file).not.toContain('evil')
  })
})
