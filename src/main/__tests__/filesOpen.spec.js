import { describe, expect, it, vi } from 'vitest'
import { openFileOutside, codeLaunch, parseCodeCmd, codeCmdFor } from '../filesOpen'

const win = process.platform === 'win32'
const abs = (p) => (win ? `C:/data/${p}` : `/data/${p}`)

// A fake disk: path -> 'file' | 'dir' | { link: target }. Nothing real is read or opened.
function fakeFs(entries) {
  const target = (p) => (entries[p] && typeof entries[p] === 'object' ? entries[p].link : p)
  return {
    stat: vi.fn(async (p) => {
      const kind = entries[target(p)]
      if (!kind) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isDirectory: () => kind === 'dir', isFile: () => kind === 'file' }
    }),
    realpath: vi.fn(async (p) => target(p))
  }
}
const fakeShell = () => ({ openPath: vi.fn(async () => '') })

describe('files:open (openFileOutside)', () => {
  it.each(['tool.exe', 'go.lnk', 'site.url', 'setup.msi', 'tweak.reg', 'app.hta', 'saver.scr', 'lib.jar', 'run.bat', 'run.ps1', 'run.cmd', 'macro.docm', 'disk.iso'])(
    'never hands %s to the system',
    async (name) => {
      const shell = fakeShell()
      const res = await openFileOutside({ file: abs(name) }, { shell, fsp: fakeFs({ [abs(name)]: 'file' }) })
      expect(res.ok).toBe(false)
      expect(shell.openPath).not.toHaveBeenCalled()
    }
  )

  it('refuses binary programs even when VS Code is installed', async () => {
    const openInCode = vi.fn(async () => true)
    const res = await openFileOutside({ file: abs('tool.exe') }, { shell: fakeShell(), openInCode, fsp: fakeFs({ [abs('tool.exe')]: 'file' }) })
    expect(res).toMatchObject({ ok: false, reason: 'executable' })
    expect(openInCode).not.toHaveBeenCalled()
  })

  it('lets VS Code show a plain-text script (it never runs it)', async () => {
    const openInCode = vi.fn(async () => true)
    const res = await openFileOutside({ file: abs('build.ps1'), line: 3 }, { shell: fakeShell(), openInCode, fsp: fakeFs({ [abs('build.ps1')]: 'file' }) })
    expect(res).toEqual({ ok: true, with: 'code' })
    expect(openInCode).toHaveBeenCalledWith(abs('build.ps1'), 3, null)
  })

  it('without VS Code, a script goes to Tessel\'s editor, not the system', async () => {
    const shell = fakeShell()
    const res = await openFileOutside({ file: abs('build.ps1') }, { shell, fsp: fakeFs({ [abs('build.ps1')]: 'file' }) })
    expect(res).toMatchObject({ ok: false, reason: 'editor' })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('refuses folders', async () => {
    const shell = fakeShell()
    const res = await openFileOutside({ file: abs('src') }, { shell, openInCode: async () => true, fsp: fakeFs({ [abs('src')]: 'dir' }) })
    expect(res).toMatchObject({ ok: false, reason: 'folder' })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('refuses network, device and missing paths without opening anything', async () => {
    const shell = fakeShell()
    const fsp = fakeFs({})
    expect((await openFileOutside({ file: '\\\\server\\share\\a.pdf' }, { shell, fsp })).reason).toBe('network')
    expect(fsp.stat).not.toHaveBeenCalled()
    expect((await openFileOutside({ file: abs('gone.pdf') }, { shell, fsp })).reason).toBe('missing')
    expect((await openFileOutside({ file: '' }, { shell, fsp })).reason).toBe('invalid')
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('opens media and documents with the system when VS Code is missing', async () => {
    const shell = fakeShell()
    const res = await openFileOutside({ file: abs('report.pdf') }, { shell, fsp: fakeFs({ [abs('report.pdf')]: 'file' }) })
    expect(res).toEqual({ ok: true, with: 'default' })
    expect(shell.openPath).toHaveBeenCalledWith(abs('report.pdf'))
  })

  it('code and unknown types open in Tessel\'s editor when VS Code is missing', async () => {
    const shell = fakeShell()
    for (const name of ['main.js', 'notes.txt', 'data.bin']) {
      const res = await openFileOutside({ file: abs(name) }, { shell, fsp: fakeFs({ [abs(name)]: 'file' }) })
      expect(res.reason).toBe('editor')
    }
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('judges a link by what it points at', async () => {
    const shell = fakeShell()
    const fsp = fakeFs({ [abs('fake.pdf')]: { link: abs('evil.exe') }, [abs('evil.exe')]: 'file' })
    const res = await openFileOutside({ file: abs('fake.pdf') }, { shell, fsp })
    expect(res).toMatchObject({ ok: false, reason: 'executable' })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('a document whose path cmd would misread still opens (no shell involved)', async () => {
    const shell = fakeShell()
    const file = abs('a&b %x% "q".pdf')
    const res = await openFileOutside({ file }, { shell, fsp: fakeFs({ [file]: 'file' }) })
    expect(res.ok).toBe(true)
    expect(shell.openPath).toHaveBeenCalledWith(file)
  })
})

describe('VS Code launcher', () => {
  const cmdText =
    '@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\6d62b1d5da\\resources\\app\\out\\cli.js" %*\r\nendlocal\r\n'
  const codeCmd = win ? 'C:\\VS Code\\bin\\code.cmd' : '/vscode/bin/code.cmd'

  it('reads Code.exe and its CLI script from code.cmd', () => {
    const parsed = parseCodeCmd(cmdText, codeCmd)
    expect(parsed.exe).toMatch(/Code\.exe$/)
    expect(parsed.cli).toMatch(/6d62b1d5da[\\/]resources[\\/]app[\\/]out[\\/]cli\.js$/)
    expect(parseCodeCmd('@echo off', codeCmd)).toBeNull()
  })

  it('a plain path goes through code.cmd as before', () => {
    const l = codeLaunch('C:\\p\\a.js:3', { codeCmd, env: {} })
    expect(l).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'code', '-g', 'C:\\p\\a.js:3'], env: {} })
  })

  it.each(['C:\\a&b\\x.js', 'C:\\a|b.js', 'C:\\100%\\x.js', 'C:\\a^b.js', 'C:\\a"b.js', 'C:\\<x>.js'])('%s starts Code.exe without cmd', (p) => {
    const l = codeLaunch(p, { codeCmd, readFile: () => cmdText, env: { A: '1' } })
    expect(l.file).toMatch(/Code\.exe$/)
    expect(l.file).not.toMatch(/cmd/i)
    expect(l.args[0]).toMatch(/cli\.js$/)
    expect(l.args.slice(1)).toEqual(['-g', p])
    expect(l.env).toMatchObject({ A: '1', ELECTRON_RUN_AS_NODE: '1' })
  })

  it('no launcher it can read: no VS Code for such a path', () => {
    expect(codeLaunch('C:\\a&b.js', { codeCmd, readFile: () => 'garbage' })).toBeNull()
    expect(codeLaunch('C:\\a&b.js', { codeCmd: null })).toBeNull()
  })

  it('finds code.cmd next to what where.exe lists', () => {
    expect(codeCmdFor('C:\\VS\\bin\\code')).toMatch(/bin[\\/]code\.cmd$/)
    expect(codeCmdFor('C:\\VS\\bin\\code.cmd')).toBe('C:\\VS\\bin\\code.cmd')
    expect(codeCmdFor('')).toBeNull()
  })
})
