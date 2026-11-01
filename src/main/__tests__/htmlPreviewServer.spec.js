// @vitest-environment node
// The HTML preview as a real website (htmlPreviewServer.js): a project's
// folder served on the loopback, over real HTTP requests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPreviewServer, safeSegments, hasHidden } from '../htmlPreviewServer'

const BS2 = String.fromCharCode(92, 92)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-preview-'))
const site = path.join(dir, 'site')
const outside = path.join(dir, 'secret.txt')
let server
let remoteFiles
const remote = {
  previewRoot: (file) => (file.startsWith('ssh://ssh-h1/var/www') ? { root: 'ssh://ssh-h1/var/www', rel: file.slice('ssh://ssh-h1/var/www\\'.length).replace(/\\/g, '/') } : null),
  read: async (root, rel) => (remoteFiles[rel] ? { ok: true, buf: Buffer.from(remoteFiles[rel]) } : { ok: false })
}

beforeAll(() => {
  fs.mkdirSync(path.join(site, 'css'), { recursive: true })
  fs.mkdirSync(path.join(site, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(site, 'index.html'), '<link rel="stylesheet" href="css/style.css"><h1>Home</h1>')
  fs.writeFileSync(path.join(site, 'css', 'style.css'), 'h1{color:red}')
  fs.writeFileSync(path.join(site, 'docs', 'index.html'), '<p>docs</p>')
  fs.writeFileSync(path.join(site, 'clip.mp4'), Buffer.from('0123456789'))
  fs.writeFileSync(path.join(site, 'app.js'), 'console.log(1)')
  fs.writeFileSync(outside, 'TOP SECRET')
  remoteFiles = { 'index.html': '<h1>Remote</h1>', 'a/style.css': 'p{}' }
  server = createPreviewServer({ remote })
})
afterAll(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

// -> { status, headers, body }; host: the Host header to send
function get(url, { method = 'GET', headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    // The path as written (the client does not normalize ".." or %2e).
    const raw = url.replace(/^https?:\/\/[^/]+/, '')
    const req = http.request({ host: '127.0.0.1', port: u.port, path: raw, method, headers: { host: host || u.host, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}
const open = async (file, extra = {}) => {
  const r = await server.register({ file, root: site, scripts: true, ...extra })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return r.url
}
const at = (url, rel) => url.replace(/\/[^/]*$/, '') + '/' + rel

describe('a local project served like a website', () => {
  it('the page, its CSS and scripts load by their relative paths, with the right types', async () => {
    const url = await open(path.join(site, 'index.html'))
    expect(url).toMatch(/^http:\/\/[0-9a-f]{32}\.localhost:\d+\/index\.html$/)
    const page = await get(url)
    expect(page.status).toBe(200)
    expect(page.body).toContain('<h1>Home</h1>')
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    const css = await get(at(url, 'css/style.css'))
    expect(css.body).toBe('h1{color:red}')
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
    expect((await get(at(url, 'app.js'))).headers['content-type']).toBe('text/javascript; charset=utf-8')
  })
  it('a page of a subfolder: the project is the root, so "../css" and "/css" both reach the site', async () => {
    const url = await open(path.join(site, 'docs', 'index.html'))
    expect(url.endsWith('/docs/index.html')).toBe(true)
    const root = url.replace(/\/docs\/index\.html$/, '')
    expect((await get(`${root}/css/style.css`)).status).toBe(200)
    expect((await get(`${root}/docs/../css/style.css`.replace('/docs/..', ''))).status).toBe(200)
  })
  it('a folder answers with its index.html, never a listing', async () => {
    const url = await open(path.join(site, 'index.html'))
    const root = url.replace(/\/index\.html$/, '')
    expect((await get(`${root}/docs/`)).body).toBe('<p>docs</p>')
    expect((await get(`${root}/css`)).status).toBe(404)
    expect((await get(`${root}/`)).body).toContain('Home')
  })
  it('the text being edited (not saved) replaces its file, and only that one', async () => {
    const url = await open(path.join(site, 'index.html'), { text: '<h1>Unsaved</h1>' })
    expect((await get(url)).body).toBe('<h1>Unsaved</h1>')
    expect((await get(at(url, 'css/style.css'))).body).toBe('h1{color:red}')
    // Another file's unsaved text does not undo this one's; none for a file puts it back to the disk's.
    await open(path.join(site, 'docs', 'index.html'), { text: '<p>docs unsaved</p>' })
    expect((await get(url)).body).toBe('<h1>Unsaved</h1>')
    const again = await open(path.join(site, 'index.html'))
    expect(again).toBe(url)
    expect((await get(again)).body).toContain('Home')
    expect((await get(at(url, 'docs/index.html'))).body).toBe('<p>docs unsaved</p>')
  })
  it('a video seeks: byte ranges and HEAD', async () => {
    const url = at(await open(path.join(site, 'index.html')), 'clip.mp4')
    const part = await get(url, { headers: { Range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.body).toBe('2345')
    expect(part.headers['content-range']).toBe('bytes 2-5/10')
    expect((await get(url, { headers: { Range: 'bytes=-3' } })).body).toBe('789')
    expect((await get(url, { headers: { Range: 'bytes=20-30' } })).status).toBe(416)
    const head = await get(url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers['content-length']).toBe('10')
    expect(head.body).toBe('')
  })
})

describe('who can ask for what', () => {
  it('a wrong label, another Host, another method: nothing is served', async () => {
    const url = await open(path.join(site, 'index.html'))
    const u = new URL(url)
    expect((await get(url, { host: 'evil.example' })).status).toBe(403)
    expect((await get(url, { host: `localhost:${u.port}` })).status).toBe(403)
    expect((await get(url, { host: `127.0.0.1:${u.port}` })).status).toBe(403)
    // A short label, another port: not a preview's Host.
    expect((await get(url, { host: `${'0'.repeat(12)}.localhost:${u.port}` })).status).toBe(403)
    expect((await get(url, { host: `${u.hostname}:1` })).status).toBe(403)
    // The right shape, a label no preview has: nothing there.
    expect((await get(url, { host: `${'0'.repeat(32)}.localhost:${u.port}` })).status).toBe(404)
    const post = await get(url, { method: 'POST' })
    expect(post.status).toBe(405)
  })
  it('nothing outside the project: "..", encoded dots, backslashes, NUL', async () => {
    const url = await open(path.join(site, 'index.html'))
    const root = url.replace(/\/index\.html$/, '')
    for (const p of ['/%2e%2e/secret.txt', '/css/%2e%2e/%2e%2e/secret.txt', '/..%2Fsecret.txt', '/%5C..%5Csecret.txt', '/a%00b']) {
      const r = await get(root + p)
      expect([400, 404], p).toContain(r.status)
      expect(r.body).not.toContain('TOP SECRET')
    }
  })
  it('a link (symlink or junction) that leaves the project is refused', async () => {
    const link = path.join(site, 'out')
    try {
      fs.symlinkSync(dir, link, 'junction')
    } catch {
      return // no right to make links here
    }
    const url = await open(path.join(site, 'index.html'))
    const r = await get(url.replace(/\/index\.html$/, '') + '/out/secret.txt')
    expect(r.status).toBe(403)
    expect(r.body).not.toContain('TOP SECRET')
    fs.rmSync(link, { recursive: true, force: true })
  })
  it('the HTML answers carry a policy that keeps the page from other programs of this computer', async () => {
    const url = await open(path.join(site, 'index.html'))
    const csp = (await get(url)).headers['content-security-policy']
    expect(csp).toContain("connect-src 'self' https: wss:")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toContain('http:')
    expect((await get(at(url, 'css/style.css'))).headers['x-content-type-options']).toBe('nosniff')
    expect((await get(at(url, 'css/style.css'))).headers['cross-origin-resource-policy']).toBe('same-origin')
  })
  it("a page's root-relative paths (/css/style.css) reach the site's own root, from any page", async () => {
    const sub = await open(path.join(site, 'docs', 'index.html'))
    const origin = new URL(sub).origin
    expect((await get(`${origin}/css/style.css`)).body).toBe('h1{color:red}')
    expect((await get(`${origin}/`)).body).toContain('Home')
  })
  it('every answer carries the policy, an SVG or XML opened by itself too (it runs scripts)', async () => {
    fs.writeFileSync(path.join(site, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const url = await open(path.join(site, 'index.html'))
    for (const f of ['x.svg', 'css/style.css', 'app.js', 'clip.mp4']) {
      const r = await get(at(url, f))
      expect(r.headers['content-security-policy'], f).toContain("connect-src 'self' https: wss:")
      expect(r.headers['content-security-policy'], f).toContain("frame-src 'none'")
    }
  })
  it('a page inside a hidden folder is not previewed (it would only be refused)', async () => {
    fs.mkdirSync(path.join(site, '.next'), { recursive: true })
    fs.writeFileSync(path.join(site, '.next', 'index.html'), '<p>x</p>')
    const r = await server.register({ file: path.join(site, '.next', 'index.html'), root: site })
    expect(r).toMatchObject({ ok: false, code: 'hidden' })
  })
  it('scripts are off unless asked: the page loads CSS and images but nothing runs or connects', async () => {
    const off = await open(path.join(site, 'index.html'), { scripts: false })
    const on = await open(path.join(site, 'index.html'), { scripts: true })
    expect(off).not.toBe(on)
    const csp = (await get(off)).headers['content-security-policy']
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("style-src 'self'")
    expect((await get(at(off, 'css/style.css'))).status).toBe(200)
    expect((await get(on)).headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'")
  })
  it('hidden files and folders are never served (.git, .env, .ssh), by name or by real name', async () => {
    fs.mkdirSync(path.join(site, '.git'), { recursive: true })
    fs.writeFileSync(path.join(site, '.git', 'config'), '[remote] url=secret')
    fs.writeFileSync(path.join(site, '.env'), 'KEY=secret')
    const url = await open(path.join(site, 'index.html'))
    for (const p of ['.env', '.git/config', '%2Egit/config']) {
      const r = await get(at(url, p))
      expect(r.status, p).toBe(404)
      expect(r.body).not.toContain('secret')
    }
    // Not even as the page to preview.
    expect((await server.register({ file: path.join(site, '.env'), root: site })).ok).toBe(false)
  })
  it('a file that is not there: refused, with no path in the answer', async () => {
    expect((await server.register({ file: path.join(site, 'nope.html'), root: site })).ok).toBe(false)
    expect((await server.register({ file: 'relative.html' })).ok).toBe(false)
    expect((await server.register({ file: 'lshare://x/a.html' })).ok).toBe(false)
    // Only HTML, never a network path (it would be reached for the check alone).
    expect((await server.register({ file: path.join(site, 'app.js'), root: site })).ok).toBe(false)
    expect((await server.register({ file: BS2 + 'host' + BS2 + 'share' + BS2 + 'a.html' })).ok).toBe(false)
    expect((await server.register({ file: path.join(site, 'index.html'), root: BS2 + 'host' + BS2 + 'share' })).ok).toBe(false)
  })
})

describe('a project on an SSH host', () => {
  it('its files are read on the host through the open session', async () => {
    const r = await server.register({ file: 'ssh://ssh-h1/var/www\\index.html', root: 'C:\\ignored' })
    expect(r.ok).toBe(true)
    expect((await get(r.url)).body).toBe('<h1>Remote</h1>')
    expect((await get(at(r.url, 'a/style.css'))).body).toBe('p{}')
    expect((await get(at(r.url, 'missing.css'))).status).toBe(404)
    expect((await get(at(r.url, 'a/..%2F..%2Fetc/passwd'))).status).toBe(400)
  })
  it('a page with many files opens at most 4 reads of the host at a time', async () => {
    let now = 0
    let peak = 0
    const slow = createPreviewServer({
      remote: {
        previewRoot: (f) => ({ root: 'ssh://ssh-h1/var/www', rel: f.split(String.fromCharCode(92)).pop() }),
        read: async () => {
          now++
          peak = Math.max(peak, now)
          await new Promise((r) => setTimeout(r, 25))
          now--
          return { ok: true, buf: Buffer.from('x') }
        }
      }
    })
    const r = await slow.register({ file: 'ssh://ssh-h1/var/www' + String.fromCharCode(92) + 'a.html' })
    await Promise.all(Array.from({ length: 12 }, (_, i) => get(at(r.url, `f${i}.css`))))
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    slow.close()
  })
  it('a file of no open project: refused', async () => {
    expect((await server.register({ file: 'ssh://ssh-h1/etc/passwd' })).ok).toBe(false)
  })
})

describe('safeSegments', () => {
  it('decodes, and refuses anything that could leave the folder', () => {
    expect(safeSegments('/a/b%20c/d.css')).toEqual(['a', 'b c', 'd.css'])
    expect(safeSegments('/')).toEqual([])
    for (const bad of ['/..', '/a/./b', '/a%2Fb', '/a%5Cb', '/%00', '/%zz']) expect(safeSegments(bad), bad).toBeNull()
    expect(safeSegments('/C:', { windows: true })).toBeNull()
    expect(safeSegments('/C:', { windows: false })).toEqual(['C:'])
  })
})

describe('the preview addresses', () => {
  it('isPreviewUrl: any label of this server, nothing else', async () => {
    const url = await open(path.join(site, 'index.html'))
    const u = new URL(url)
    expect(server.isPreviewUrl(url)).toBe(true)
    expect(server.isPreviewUrl(`http://${'a'.repeat(32)}.localhost:${u.port}/x`)).toBe(true)
    for (const bad of [`http://127.0.0.1:${u.port}/x`, `http://abcdef012345.localhost:${u.port}/x`, `https://${'a'.repeat(32)}.localhost:${u.port}/`, `http://${'a'.repeat(32)}.localhost:1/`, `http://${'a'.repeat(32)}.localhost.evil.com:${u.port}/`, 'https://example.com/', '', null])
      expect(server.isPreviewUrl(bad), String(bad)).toBe(false)
  })
  it('hasHidden', () => {
    expect(hasHidden(['a', '.git', 'config'])).toBe(true)
    expect(hasHidden(['a', 'b.css'])).toBe(false)
  })
})
