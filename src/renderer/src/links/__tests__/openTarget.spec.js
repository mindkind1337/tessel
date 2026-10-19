import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyTarget, createLinkRouter, openTarget, setLinkRouter, getLinkRouter } from '../openTarget.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('classifyTarget', () => {
  it('web pages and mail addresses', () => {
    expect(classifyTarget('https://example.com/a?b=1')).toMatchObject({ kind: 'url', url: 'https://example.com/a?b=1', path: null })
    expect(classifyTarget('  http://localhost:3000/ ')).toMatchObject({ kind: 'url', url: 'http://localhost:3000/' })
    expect(classifyTarget({ url: 'https://x.dev' })).toMatchObject({ kind: 'url', url: 'https://x.dev/' })
    expect(classifyTarget('mailto:ada@example.com')).toMatchObject({ kind: 'mailto', url: 'mailto:ada@example.com' })
  })

  it('never anything Tessel does not open', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'chrome://settings', 'ms-settings:', '', '   ', null, undefined, 'https://', 'C:\\a\u0007b.js', '\\\\server\\share\\x.js', '//server/share/x.png', 'file://server/share/x.js'])
      expect(classifyTarget(bad)).toBeNull()
    expect(classifyTarget({ kind: 'url' })).toBeNull()
    expect(classifyTarget({ src: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBeNull()
  })

  it("WSL's own share is this PC's (terminal links of a WSL pane)", () => {
    expect(classifyTarget('\\\\wsl.localhost\\Ubuntu\\home\\me\\a.js')).toMatchObject({ kind: 'file', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\a.js' })
    expect(classifyTarget({ path: '\\\\wsl$\\Ubuntu\\home\\me', kind: 'dir' })).toMatchObject({ kind: 'dir' })
    expect(classifyTarget('\\\\wsl.evil.com\\share\\a.js')).toBeNull()
    expect(classifyTarget('\\\\wslx\\share\\a.js')).toBeNull()
  })

  it('files, images, PDFs and folders by their path', () => {
    expect(classifyTarget('C:\\p\\src\\a.js')).toMatchObject({ kind: 'file', path: 'C:\\p\\src\\a.js', remote: null, lshare: false })
    expect(classifyTarget({ path: 'C:/p/shot.PNG' })).toMatchObject({ kind: 'image', path: 'C:/p/shot.PNG' })
    expect(classifyTarget({ file: 'C:\\p\\spec.pdf' })).toMatchObject({ kind: 'pdf' })
    expect(classifyTarget('C:\\p\\src\\')).toMatchObject({ kind: 'dir' })
    expect(classifyTarget({ path: 'C:\\p\\src', kind: 'dir' })).toMatchObject({ kind: 'dir', path: 'C:\\p\\src' })
    expect(classifyTarget({ path: 'src/a.js', line: 12, col: 3 })).toMatchObject({ kind: 'file', line: 12, col: 3 })
    expect(classifyTarget({ path: 'a.js', line: 0, col: -1 })).toMatchObject({ line: null, col: null })
  })

  it('file: URIs become paths, with their #L line', () => {
    expect(classifyTarget('file:///C:/p/a.js#L7')).toMatchObject({ kind: 'file', path: 'C:/p/a.js', line: 7 })
  })

  it('SSH and Live Share paths keep their host', () => {
    expect(classifyTarget('ssh://ssh-1a2b/home/me/app\\src\\a.js')).toMatchObject({ kind: 'file', remote: 'ssh-1a2b', lshare: false })
    expect(classifyTarget('ssh://not a host/x')).toBeNull()
    expect(classifyTarget({ path: 'lshare://p-abc/docs/x.md', line: 2 })).toMatchObject({ kind: 'file', lshare: true, remote: null, line: 2 })
  })

  it('an image given by its data', () => {
    expect(classifyTarget(PNG)).toMatchObject({ kind: 'image', src: PNG, path: null })
    expect(classifyTarget({ src: PNG, path: 'C:\\t\\a.png' })).toMatchObject({ kind: 'image', src: PNG, path: 'C:\\t\\a.png' })
  })

  it('is idempotent on its own output', () => {
    for (const x of ['https://e.com/', 'mailto:a@b.c', 'C:\\p\\a.js', 'C:\\p\\d\\', PNG]) {
      const once = classifyTarget(x)
      expect(classifyTarget(once)).toEqual(once)
    }
  })
})

function fakes(over = {}) {
  return {
    openInEditor: vi.fn(() => ({ id: 'ed' })),
    viewFile: vi.fn(),
    openPdf: vi.fn(),
    readImage: vi.fn(async () => ({ ok: true, dataUrl: PNG })),
    showImage: vi.fn(),
    revealInFiles: vi.fn(async () => true),
    openFolder: vi.fn(async () => ({ ok: true })),
    urlMode: vi.fn(() => 'builtin'),
    openUrlBuiltin: vi.fn(() => ({ id: 'web' })),
    openUrlSystem: vi.fn(async () => true),
    openMail: vi.fn(async () => true),
    notOpened: vi.fn(),
    ...over
  }
}

describe('createLinkRouter', () => {
  it('a file: the editor at its line and column', async () => {
    const d = fakes()
    expect(await createLinkRouter(d).open({ path: 'C:\\p\\a.js', line: 4, col: 2 })).toBe(true)
    expect(d.openInEditor).toHaveBeenCalledWith({ file: 'C:\\p\\a.js', line: 4, col: 2, preview: true })
  })

  it('a file with no editor to hold it: the modal viewer', async () => {
    const d = fakes({ openInEditor: vi.fn(() => null) })
    await createLinkRouter(d).open({ path: 'C:\\p\\a.md', line: 3 }, { label: 'a.md' })
    expect(d.viewFile).toHaveBeenCalledWith({ file: 'C:\\p\\a.md', label: 'a.md', line: 3 })
  })

  it('a PDF: its PDF window', async () => {
    const d = fakes()
    await createLinkRouter(d).open('C:\\p\\spec.pdf')
    expect(d.openPdf).toHaveBeenCalledWith({ file: 'C:\\p\\spec.pdf', label: 'spec.pdf' })
    expect(d.openInEditor).not.toHaveBeenCalled()
  })

  it('an image: an editor tab (as in VS Code); the lightbox when asked, or when no tab opens', async () => {
    const d = fakes()
    const r = createLinkRouter(d)
    await r.open('C:\\p\\shot.png')
    expect(d.openInEditor).toHaveBeenCalledWith(expect.objectContaining({ file: 'C:\\p\\shot.png' }))
    expect(d.showImage).not.toHaveBeenCalled()
    await r.open('C:\\p\\shot.png', { image: 'lightbox' })
    expect(d.readImage).toHaveBeenCalledWith('C:\\p\\shot.png')
    expect(d.showImage).toHaveBeenCalledWith({ src: PNG, title: 'shot.png', file: null })
    const noTab = fakes({ openInEditor: vi.fn(async () => false) })
    await createLinkRouter(noTab).open('C:\\p\\shot.png')
    expect(noTab.showImage).toHaveBeenCalledWith({ src: PNG, title: 'shot.png', file: null })
  })

  it('an image by its data: a copy Tessel writes, in an editor tab; else the lightbox', async () => {
    const d = fakes({ imageCopy: vi.fn(async () => ({ ok: true, path: 'C:\\tmp\\img_1.png' })) })
    await createLinkRouter(d).open({ src: PNG, path: 'C:\\gone\\pasted.png' }, { label: 'Image #1' })
    expect(d.imageCopy).toHaveBeenCalledWith(PNG)
    expect(d.openInEditor).toHaveBeenCalledWith(expect.objectContaining({ file: 'C:\\tmp\\img_1.png' }))
    expect(d.showImage).not.toHaveBeenCalled()
    const plain = fakes()
    await createLinkRouter(plain).open(PNG, { label: 'Image #1' })
    expect(plain.readImage).not.toHaveBeenCalled()
    expect(plain.showImage).toHaveBeenCalledWith({ src: PNG, title: 'Image #1', file: null })
    await createLinkRouter(d).open(PNG, { image: 'lightbox', label: 'Image #2' })
    expect(d.showImage).toHaveBeenCalledWith({ src: PNG, title: 'Image #2', file: null })
  })

  it('a folder: the Files tab; outside it, the file manager (local folders only)', async () => {
    const d = fakes()
    await createLinkRouter(d).open({ path: 'C:\\p\\src', kind: 'dir' })
    expect(d.revealInFiles).toHaveBeenCalledWith('C:\\p\\src')
    expect(d.openFolder).not.toHaveBeenCalled()
    const out = fakes({ revealInFiles: vi.fn(async () => false) })
    await createLinkRouter(out).open('D:\\other\\')
    expect(out.openFolder).toHaveBeenCalledWith('D:\\other\\')
    const remote = fakes({ revealInFiles: vi.fn(async () => false) })
    expect(await createLinkRouter(remote).open({ path: 'ssh://ssh-1a2b/srv/x', kind: 'dir' })).toBe(false)
    expect(remote.openFolder).not.toHaveBeenCalled()
    expect(remote.notOpened).toHaveBeenCalledWith(expect.objectContaining({ reason: 'outside' }))
  })

  it('a web page: the built-in browser by default, Ctrl or Cmd+click the system one', async () => {
    const d = fakes()
    const r = createLinkRouter(d)
    await r.open('https://example.com')
    expect(d.openUrlBuiltin).toHaveBeenCalledWith('https://example.com/')
    expect(d.openUrlSystem).not.toHaveBeenCalled()
    await r.open('https://example.com', { event: { ctrlKey: true } })
    expect(d.openUrlSystem).toHaveBeenCalledWith('https://example.com/')
    d.openUrlSystem.mockClear()
    await r.open('https://example.com', { event: { metaKey: true } })
    expect(d.openUrlSystem).toHaveBeenCalledTimes(1)
  })

  it('the setting on the system browser: Ctrl+click opens the built-in one', async () => {
    const d = fakes({ urlMode: () => 'system' })
    const r = createLinkRouter(d)
    await r.open('https://example.com')
    expect(d.openUrlSystem).toHaveBeenCalled()
    expect(d.openUrlBuiltin).not.toHaveBeenCalled()
    await r.open('https://example.com', { event: { ctrlKey: true } })
    expect(d.openUrlBuiltin).toHaveBeenCalled()
  })

  it('no built-in browser to open it in (no project): the system one', async () => {
    const d = fakes({ openUrlBuiltin: vi.fn(() => null), urlMode: () => 'nonsense' })
    expect(await createLinkRouter(d).open('https://example.com')).toBe(true)
    expect(d.openUrlSystem).toHaveBeenCalledWith('https://example.com/')
  })

  it('a mail address: the mail program, never the built-in browser', async () => {
    const d = fakes()
    await createLinkRouter(d).open('mailto:ada@example.com')
    expect(d.openMail).toHaveBeenCalledWith('mailto:ada@example.com')
    expect(d.openUrlBuiltin).not.toHaveBeenCalled()
  })

  it('refused or failed targets report false and tell the user', async () => {
    const d = fakes({ openUrlSystem: vi.fn(async () => false), urlMode: () => 'system' })
    const r = createLinkRouter(d)
    expect(await r.open('javascript:alert(1)')).toBe(false)
    expect(d.notOpened).not.toHaveBeenCalled()
    expect(await r.open('https://example.com')).toBe(false)
    expect(d.notOpened).toHaveBeenCalledWith(expect.objectContaining({ reason: 'failed' }))
    const throws = fakes({ openInEditor: vi.fn(() => { throw new Error('x') }) })
    expect(await createLinkRouter(throws).open('C:\\p\\a.js')).toBe(false)
  })
})

describe('openTarget (the window router)', () => {
  afterEach(() => {
    setLinkRouter(null)
    delete window.shellApi
  })

  it('goes through the registered router', async () => {
    const d = fakes()
    setLinkRouter(createLinkRouter(d))
    expect(getLinkRouter()).not.toBeNull()
    await openTarget({ path: 'C:\\p\\a.js', line: 2 })
    expect(d.openInEditor).toHaveBeenCalled()
  })

  it('without one: web pages and mail addresses in the system browser, nothing else', async () => {
    window.shellApi = { openExternal: vi.fn(async () => true) }
    expect(await openTarget('https://example.com')).toBe(true)
    expect(await openTarget('mailto:a@b.c')).toBe(true)
    expect(await openTarget('C:\\p\\a.js')).toBe(false)
    expect(window.shellApi.openExternal.mock.calls).toEqual([['https://example.com/'], ['mailto:a@b.c']])
  })
})
