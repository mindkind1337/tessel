import { describe, expect, it, vi } from 'vitest'
import { statChatPaths, openChatPath, revealChatPath, MAX_STAT_PATHS } from '../chatFileOpen'
import { chatPathProblem, isSystemOpenFile } from '../../shared/chatFileLinks'

const win = process.platform === 'win32'
const abs = (p) => (win ? `C:/data/${p}` : `/data/${p}`)

// A fake disk: path -> 'file' | 'dir'. Nothing real is read or opened.
function fakeFs(entries) {
  return {
    stat: vi.fn(async (p) => {
      const kind = entries[p]
      if (!kind) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isDirectory: () => kind === 'dir', isFile: () => kind === 'file' }
    })
  }
}

describe('chatPathProblem', () => {
  it.each([
    ['\\\\server\\share\\a.png', 'network'],
    ['//server/share/a.png', 'network'],
    ['\\\\?\\C:\\a.png', 'network'],
    ['\\\\.\\PhysicalDrive0', 'network'],
    ['C:\\x\\nul.txt', 'network'],
    ['C:\\x\\COM1', 'network'],
    ['C:\\x\\a\u0000.png', 'control'],
    ['C:\\x\\a\n.png', 'control'],
    ['relative\\a.png', 'invalid'],
    ['C:\\x\\a.txt:stream', 'invalid'],
    ['C:\\x\\run.exe.', 'invalid'],
    ['C:\\x\\run.exe ', 'invalid'],
    ['C:\\x\\run.EXE', 'executable'],
    ['C:\\x\\go.lnk', 'executable'],
    ['C:\\x\\a.scr', 'executable'],
    ['C:\\x\\a.ps1', 'executable'],
    ['C:\\x\\a.bat', 'executable'],
    ['C:\\x\\a.vbs', 'executable'],
    ['C:\\x\\a.docm', 'executable'],
    ['C:\\x\\clip.mp4', null],
    ['C:\\x\\video\\', null],
    ['/home/me/a.pdf', null]
  ])('%s -> %s', (p, want) => {
    expect(chatPathProblem(p)).toBe(want)
  })
  it('knows media and documents', () => {
    for (const f of ['a.mp4', 'a.webm', 'a.MOV', 'a.gif', 'a.png', 'a.jpg', 'a.webp', 'a.svg', 'a.pdf', 'a.mp3', 'a.wav', 'a.docx', 'a.xlsx', 'a.zip'])
      expect(isSystemOpenFile(f)).toBe(true)
    for (const f of ['a.js', 'a.md', 'a.txt', 'a.exe', 'a.html', 'a']) expect(isSystemOpenFile(f)).toBe(false)
  })
})

describe('statChatPaths', () => {
  it('says what exists, and never looks at a refused path', async () => {
    const fsp = fakeFs({ [abs('a.mp4')]: 'file', [abs('video')]: 'dir' })
    const res = await statChatPaths(
      { paths: [abs('a.mp4'), abs('video'), abs('gone.gif'), '\\\\server\\share\\x.png', 'rel/a.png', abs('run.exe'), 42] },
      { fsp }
    )
    expect(res).toEqual({
      [abs('a.mp4')]: 'file',
      [abs('video')]: 'dir',
      [abs('gone.gif')]: null,
      '\\\\server\\share\\x.png': null,
      'rel/a.png': null,
      [abs('run.exe')]: null
    })
    expect(fsp.stat).toHaveBeenCalledTimes(3)
    expect(fsp.stat.mock.calls.map((c) => c[0])).not.toContain('\\\\server\\share\\x.png')
  })
  it('is bounded', async () => {
    const fsp = fakeFs({})
    const paths = Array.from({ length: 200 }, (_, i) => abs(`f${i}.png`))
    const res = await statChatPaths({ paths }, { fsp })
    expect(Object.keys(res)).toHaveLength(MAX_STAT_PATHS)
    expect(fsp.stat).toHaveBeenCalledTimes(MAX_STAT_PATHS)
    expect(await statChatPaths(null, { fsp })).toEqual({})
  })
})

describe('openChatPath', () => {
  const setup = (entries) => {
    const shell = { openPath: vi.fn(async () => '') }
    return { shell, fsp: fakeFs(entries) }
  }
  it('opens a folder and a media file with the system', async () => {
    const deps = setup({ [abs('video')]: 'dir', [abs('video/logo.mp4')]: 'file', [abs('doc.pdf')]: 'file' })
    expect(await openChatPath({ path: abs('video') }, deps)).toEqual({ ok: true, with: 'folder' })
    expect(await openChatPath({ path: abs('video/logo.mp4') }, deps)).toEqual({ ok: true, with: 'default' })
    expect(await openChatPath({ path: abs('doc.pdf') }, deps)).toEqual({ ok: true, with: 'default' })
    expect(deps.shell.openPath).toHaveBeenCalledTimes(3)
  })
  it.each([
    ['\\\\server\\share\\a.mp4', 'network'],
    ['//server/share', 'network'],
    ['\\\\?\\C:\\a.mp4', 'network'],
    ['relative/a.mp4', 'invalid'],
    ['C:\\x\\a\u0001.mp4', 'invalid']
  ])('refuses %s (%s) without looking', async (p, reason) => {
    const deps = setup({ [p]: 'file' })
    const res = await openChatPath({ path: p }, deps)
    expect(res).toMatchObject({ ok: false, reason })
    expect(deps.fsp.stat).not.toHaveBeenCalled()
    expect(deps.shell.openPath).not.toHaveBeenCalled()
  })
  it('refuses programs and scripts, even when they exist', async () => {
    for (const name of ['run.exe', 'run.bat', 'run.cmd', 'x.ps1', 'x.vbs', 'x.lnk', 'x.msi', 'x.scr', 'x.com']) {
      const deps = setup({ [abs(name)]: 'file' })
      expect(await openChatPath({ path: abs(name) }, deps)).toMatchObject({ ok: false, reason: 'executable' })
      expect(deps.shell.openPath).not.toHaveBeenCalled()
    }
  })
  it('refuses files that are not media or documents (text, scripts, unknown)', async () => {
    for (const name of ['x.js', 'x.py', 'x.html', 'x.txt', 'x.bin', 'noext']) {
      const deps = setup({ [abs(name)]: 'file' })
      expect(await openChatPath({ path: abs(name) }, deps)).toMatchObject({ ok: false, reason: 'type' })
      expect(deps.shell.openPath).not.toHaveBeenCalled()
    }
  })
  it('refuses a path that does not exist', async () => {
    const deps = setup({})
    expect(await openChatPath({ path: abs('gone.mp4') }, deps)).toMatchObject({ ok: false, reason: 'missing' })
    expect(await openChatPath({}, deps)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(deps.shell.openPath).not.toHaveBeenCalled()
  })
  it("passes the system's error on", async () => {
    const deps = setup({ [abs('a.mp4')]: 'file' })
    deps.shell.openPath.mockResolvedValue('No app')
    expect(await openChatPath({ path: abs('a.mp4') }, deps)).toEqual({ ok: false, reason: 'failed', error: 'No app' })
  })
})

describe('revealChatPath (Show in Folder)', () => {
  const setup = (entries) => ({ shell: { showItemInFolder: vi.fn() }, fsp: fakeFs(entries) })
  it('shows any existing file or folder in its folder, a script included (nothing is run)', async () => {
    const deps = setup({ [abs('a.png')]: 'file', [abs('dir')]: 'dir', [abs('run.ps1')]: 'file' })
    for (const p of [abs('a.png'), abs('dir'), abs('run.ps1')]) expect(await revealChatPath({ path: p }, deps)).toEqual({ ok: true })
    expect(deps.shell.showItemInFolder).toHaveBeenCalledTimes(3)
  })
  it.each([
    ['\\\\server\\share\\a.png', 'network'],
    ['relative/a.png', 'invalid'],
    ['C:\\x\\a\u0001.png', 'invalid']
  ])('refuses %s (%s)', async (p, reason) => {
    const deps = setup({ [p]: 'file' })
    expect(await revealChatPath({ path: p }, deps)).toMatchObject({ ok: false, reason })
    expect(deps.shell.showItemInFolder).not.toHaveBeenCalled()
  })
  // The chat resolves links with forward slashes (C:/data/a.png): the file
  // manager gets the system's own form, so the file is selected in its folder.
  it("the file manager gets the system's own path form", async () => {
    const deps = setup({ [abs('a.png')]: 'file' })
    await revealChatPath({ path: abs('a.png') }, deps)
    expect(deps.shell.showItemInFolder).toHaveBeenCalledWith(win ? 'C:\\data\\a.png' : '/data/a.png')
  })
  it('a missing path is refused', async () => {
    const deps = setup({})
    expect(await revealChatPath({ path: abs('gone.png') }, deps)).toMatchObject({ ok: false, reason: 'missing' })
    expect(deps.shell.showItemInFolder).not.toHaveBeenCalled()
  })
})
