// A file dragged out of the explorer to Windows: the one-file addresses on
// 127.0.0.1 (dragOut.js), asked over real HTTP.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createDragOut, dragName, TOKEN_MS, GRACE_MS } from '../dragOut'

function get(url, { host, method = 'GET' } = {}) {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method, agent: false, headers: { Host: host || u.host } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}
const settle = () => new Promise((r) => setTimeout(r, 20))

let base
let proj
let d
beforeEach(() => {
  base = fs.mkdtempSync(join(os.tmpdir(), 'tessel-dragout-'))
  proj = join(base, 'proj')
  fs.mkdirSync(join(proj, 'src'), { recursive: true })
  fs.writeFileSync(join(proj, 'src', 'a:b.bin'.replace(':', '_')), Buffer.from([0, 1, 2, 255]))
  fs.writeFileSync(join(proj, 'README.md'), '# hi')
})
afterEach(() => {
  d?.close()
  d = null
  fs.rmSync(base, { recursive: true, force: true })
})

describe('one-file addresses for a drag out to Windows', () => {
  it('a local file: served once, as an attachment, then gone; the server closes with its last address', async () => {
    d = createDragOut({ remote: null, guest: () => null, idleMs: 30 })
    const r = await d.prepare({ root: proj, file: join(proj, 'README.md') })
    expect(r).toMatchObject({ ok: true, name: 'README.md' })
    // The address names no file and no project.
    expect(r.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dl\/[0-9a-f]{64}$/)
    const res = await get(r.url)
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('# hi')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="README\.md"/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await settle()
    expect(d._tokens.size).toBe(0)
    // Not at once (the answer may still be on its way), but soon after.
    expect(d._port()).not.toBe(0)
    await new Promise((r) => setTimeout(r, 80))
    expect(d._port()).toBe(0)
  })
  it('only GET, only the exact Host, only a live token', async () => {
    d = createDragOut({ remote: null, guest: () => null })
    const r = await d.prepare({ root: proj, file: join(proj, 'README.md') })
    const port = new URL(r.url).port
    expect((await get(r.url, { method: 'POST' })).status).toBe(405)
    expect((await get(r.url, { host: `localhost:${port}` })).status).toBe(421)
    expect((await get(r.url, { host: 'evil.example' })).status).toBe(421)
    expect((await get(r.url.replace(/[0-9a-f]{64}$/, 'f'.repeat(64)))).status).toBe(404)
    expect((await get(r.url.replace(/\/dl\/.*/, '/README.md'))).status).toBe(404)
    // Still good after the refusals.
    expect((await get(r.url)).status).toBe(200)
  })
  it('an address expires after 2 minutes; given up, it goes after a short grace (Windows asks once the drag is over)', async () => {
    let t = 1000
    d = createDragOut({ remote: null, guest: () => null, now: () => t })
    const a = await d.prepare({ root: proj, file: join(proj, 'README.md') })
    t += TOKEN_MS + 1
    expect((await get(a.url)).status).toBe(404)
    // Given up, then asked within the grace: still served.
    const b = await d.prepare({ root: proj, file: join(proj, 'README.md') })
    d.revoke(b.url)
    t += GRACE_MS - 100
    expect((await get(b.url)).status).toBe(200)
    // Given up and never asked: gone after the grace.
    const c = await d.prepare({ root: proj, file: join(proj, 'README.md') })
    d.revoke(c.url)
    t += GRACE_MS + 1
    expect((await get(c.url)).status).toBe(404)
  })
  it('one answer at a time per token; a cut answer gives the token back', async () => {
    let release
    const readDownload = vi.fn(() => new Promise((r) => (release = r)))
    d = createDragOut({ remote: { readDownload }, guest: () => null })
    const r = await d.prepare({ root: 'ssh://box/srv/app', file: 'ssh://box/srv/app\\a.txt' })
    const first = get(r.url)
    await settle()
    expect((await get(r.url)).status).toBe(409)
    release({ ok: true, buf: Buffer.from('x') })
    expect((await first).status).toBe(200)
    expect(readDownload).toHaveBeenCalledTimes(1)
  })
  it('a Live Share host file only in the session it was made in; none without a session', async () => {
    // One guestFs for the app's life (liveShare.js), the session key changes with each join.
    const shared = { readDownload: vi.fn(async () => ({ ok: true, buf: Buffer.from('one') })) }
    let joined = 1
    d = createDragOut({ remote: null, guest: () => shared, session: () => joined })
    const r = await d.prepare({ root: 'lshare://p1', file: 'lshare://p1\\a.js' })
    joined = 2
    expect((await get(r.url)).status).toBe(404)
    expect(shared.readDownload).not.toHaveBeenCalled()
    joined = 0
    expect((await d.prepare({ root: 'lshare://p1', file: 'lshare://p1\\a.js' })).ok).toBe(false)
  })
  it('a name that would break the header (a cut emoji, a lone surrogate) is answered with clean headers', async () => {
    const long = 'é'.repeat(150) + '😀'.repeat(60) + '.txt'
    expect(Array.from(dragName(long)).length).toBe(200)
    expect(dragName(long).endsWith('.txt')).toBe(true)
    // An early dot is no extension: never repeated.
    const early = 'a.' + 'b'.repeat(300)
    expect(dragName(early)).toBe(Array.from(early).slice(0, 200).join(''))
    expect(() => encodeURIComponent(dragName('lshare://p1\\bad\ud800.txt'))).not.toThrow()
    const readDownload = vi.fn(async () => ({ ok: true, buf: Buffer.from('z') }))
    const s = { readDownload }
    d = createDragOut({ remote: null, guest: () => s, session: () => 1 })
    const r = await d.prepare({ root: 'lshare://p1', file: 'lshare://p1\\bad\ud800.txt' })
    const res = await get(r.url)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/^attachment; /)
  })
  it('refuses what is not one file of the project: outside, a folder, through a junction, mixed kinds', async () => {
    d = createDragOut({ remote: null, guest: () => null })
    fs.writeFileSync(join(base, 'secret.txt'), 's')
    const other = join(base, 'other')
    fs.mkdirSync(other)
    fs.writeFileSync(join(other, 'x.txt'), 'x')
    fs.symlinkSync(other, join(proj, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const file of [join(base, 'secret.txt'), join(proj, 'src'), join(proj, 'linked', 'x.txt'), join(proj, '..', 'secret.txt'), 'ssh://box/srv/app\\a', 'lshare://p1\\a']) {
      expect((await d.prepare({ root: proj, file })).ok).toBe(false)
    }
    expect((await d.prepare({ root: 'ssh://box/srv/app', file: 'ssh://box/srv/app2\\a' })).ok).toBe(false)
    expect((await d.prepare({ root: 'ssh://box/srv/app', file: join(proj, 'README.md') })).ok).toBe(false)
    expect((await d.prepare({ root: 'lshare://p1', file: 'ssh://box/srv/app\\a' })).ok).toBe(false)
    expect(d._tokens.size).toBe(0)
  })
  it('a remote file is read through the Files session: over the cap a clean 413, never a partial file', async () => {
    const readDownload = vi.fn(async (f) => (f.endsWith('big.iso') ? { ok: false, code: 'too-large' } : f.endsWith('gone') ? { ok: false } : { ok: true, buf: Buffer.from('remote bytes') }))
    d = createDragOut({ remote: { readDownload }, guest: () => null })
    const ROOT = 'ssh://box/srv/app'
    const ok = await d.prepare({ root: ROOT, file: `${ROOT}\\src\\a:b.txt` })
    expect(ok.name).toBe('a_b.txt')
    const res = await get(ok.url)
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('remote bytes')
    expect(readDownload).toHaveBeenCalledWith(`${ROOT}\\src\\a:b.txt`)
    const big = await d.prepare({ root: ROOT, file: `${ROOT}\\big.iso` })
    const r413 = await get(big.url)
    expect(r413.status).toBe(413)
    expect(r413.body.length).toBe(0)
    expect((await get((await d.prepare({ root: ROOT, file: `${ROOT}\\gone` })).url)).status).toBe(404)
  })
  it('a Live Share host file goes through the session (the host decides)', async () => {
    const readDownload = vi.fn(async () => ({ ok: true, buf: Buffer.from('shared') }))
    const shared = { readDownload }
    d = createDragOut({ remote: null, guest: () => shared, session: () => 7 })
    const r = await d.prepare({ root: 'lshare://p1', file: 'lshare://p1\\a.js' })
    expect((await get(r.url)).body.toString()).toBe('shared')
    expect(readDownload).toHaveBeenCalledWith('lshare://p1\\a.js')
  })
  it('names Windows can write, without a colon (the DownloadURL separator)', () => {
    expect(dragName('ssh://box/srv/app\\a:b?.txt')).toBe('a_b_.txt')
    expect(dragName('C:\\p\\CON.txt')).toBe('file-CON.txt')
    expect(dragName('C:\\p\\trail. ')).toBe('trail')
  })
})
