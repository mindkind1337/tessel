import { describe, it, expect } from 'vitest'
import { osc7Path, createCwdTracker, paneLinkMode, linkTarget, localPath, wslToWindows, normalizePosix } from '../links/terminalLinkPaths'

describe('the shell current folder (OSC 633 / OSC 7)', () => {
  it('OSC 7 file URLs, percent-decoded', () => {
    expect(osc7Path('file://box/home/me/my%20app')).toBe('/home/me/my app')
    expect(osc7Path('file:///C:/Users/me')).toBe('/C:/Users/me')
    expect(osc7Path('file://box')).toBe(null)
    expect(osc7Path('http://x/y')).toBe(null)
    expect(osc7Path('file://box/a%0Ab')).toBe(null)
  })
  it('tracks the last folder reported by either sequence', () => {
    const t = createCwdTracker()
    expect(t.get()).toBe(null)
    t.feed633('P;Cwd=C:\\Users\\me\\proj')
    expect(t.get()).toBe('C:\\Users\\me\\proj')
    t.feed633('A')
    expect(t.get()).toBe('C:\\Users\\me\\proj')
    t.feed7('file://pc/C:/Users/me/other')
    expect(t.get()).toBe('/C:/Users/me/other')
    // 633 escapes ";" and "\" in values.
    t.feed633('P;Cwd=/home/me/a\\x3bb')
    expect(t.get()).toBe('/home/me/a;b')
    t.feed633('P;HasRichCommandDetection=True')
    expect(t.get()).toBe('/home/me/a;b')
  })
})

describe('where a terminal path points', () => {
  it('pane kinds', () => {
    expect(paneLinkMode({ remoteHostId: 'ssh-1', shellId: 'wsl' })).toBe('ssh')
    expect(paneLinkMode({ shellId: 'wsl' })).toBe('wsl')
    expect(paneLinkMode({ shellId: 'pwsh' })).toBe('local')
  })
  it('local: relative to the shell folder, else where the pane started', () => {
    expect(linkTarget('src/a.js', { mode: 'local', cwd: 'C:\\proj\\sub', startDir: 'C:\\proj' })).toEqual({ query: 'src/a.js', cwd: 'C:\\proj\\sub' })
    expect(linkTarget('src/a.js', { mode: 'local', cwd: null, startDir: 'C:\\proj' })).toEqual({ query: 'src/a.js', cwd: 'C:\\proj' })
    // OSC 7 on Windows, Git Bash's /c/… paths.
    expect(linkTarget('a.js', { mode: 'local', cwd: '/C:/Users/me' }).cwd).toBe('C:\\Users\\me')
    expect(linkTarget('/c/Users/me/a.js', { mode: 'local', gitbash: true, cwd: '/c/Users/me' })).toEqual({ query: 'C:\\Users\\me\\a.js', cwd: 'C:\\Users\\me' })
    expect(localPath('/c/x', { gitbash: false })).toBe('/c/x')
    // "~" is expanded by main (this PC's home).
    expect(linkTarget('~/notes.md', { mode: 'local', startDir: 'C:\\proj' }).query).toBe('~/notes.md')
  })
  it('WSL: /mnt/<drive> is the drive, other Linux paths the distro share', () => {
    expect(wslToWindows('/mnt/c/Users/me/a.txt', null)).toBe('C:\\Users\\me\\a.txt')
    expect(wslToWindows('/home/me/a.txt', null)).toBe(null)
    expect(wslToWindows('/home/me/a.txt', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\a.txt')
    const ctx = { mode: 'wsl', cwd: '/home/me/proj', distro: 'Ubuntu', startDir: 'C:\\proj' }
    expect(linkTarget('src/a.js', ctx)).toEqual({ query: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\src\\a.js', cwd: null })
    expect(linkTarget('../x/b.js', ctx).query).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\x\\b.js')
    expect(linkTarget('/mnt/d/data/c.csv', ctx).query).toBe('D:\\data\\c.csv')
    expect(linkTarget('~/notes.md', ctx).query).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.md')
    // Windows paths and the \\wsl$ share stay this PC's.
    expect(linkTarget('C:\\proj\\a.js', ctx)).toEqual({ query: 'C:\\proj\\a.js', cwd: null })
    expect(linkTarget('\\\\wsl$\\Ubuntu\\etc\\hosts', ctx).query).toBe('\\\\wsl.localhost\\Ubuntu\\etc\\hosts')
    // A shell in a Windows folder (/mnt/c/…).
    expect(linkTarget('a.js', { ...ctx, cwd: '/mnt/c/proj' }).query).toBe('C:\\proj\\a.js')
    // The shell folder unknown: from where the pane started.
    expect(linkTarget('a.js', { ...ctx, cwd: null })).toEqual({ query: 'a.js', cwd: 'C:\\proj' })
    // No distro known: only /mnt paths.
    expect(linkTarget('/etc/hosts', { ...ctx, distro: null })).toBe(null)
  })
  it('SSH: the host paths as ssh://, never this PC paths', () => {
    const ctx = { mode: 'ssh', hostId: 'ssh-box1', cwd: '/srv/app', remotePath: '/srv/app', home: '/home/me' }
    expect(linkTarget('src/a.js', ctx)).toEqual({ query: 'ssh://ssh-box1/srv/app/src/a.js', cwd: null })
    expect(linkTarget('../lib/b.js', ctx).query).toBe('ssh://ssh-box1/srv/lib/b.js')
    expect(linkTarget('/etc/hosts', ctx).query).toBe('ssh://ssh-box1/etc/hosts')
    expect(linkTarget('~/x.md', ctx).query).toBe('ssh://ssh-box1/home/me/x.md')
    expect(linkTarget('C:\\Users\\me\\a.js', ctx)).toBe(null)
    expect(linkTarget('src\\a.js', ctx)).toBe(null)
    // The shell folder unknown: the pane's folder on the host.
    expect(linkTarget('a.js', { ...ctx, cwd: null }).query).toBe('ssh://ssh-box1/srv/app/a.js')
    expect(linkTarget('a.js', { ...ctx, cwd: null, remotePath: null })).toBe(null)
    // A project saved as "~/app": its files are named from home.
    const homeCtx = { mode: 'ssh', hostId: 'ssh-box1', cwd: '/home/me/app', remotePath: '~/app', home: '/home/me' }
    expect(linkTarget('src/a.js', homeCtx).query).toBe('ssh://ssh-box1/~/app/src/a.js')
    expect(linkTarget('~/app/b.js', homeCtx).query).toBe('ssh://ssh-box1/~/app/b.js')
    // Home not known yet: "~" stays.
    expect(linkTarget('~/x.md', { ...ctx, home: null }).query).toBe('ssh://ssh-box1/~/x.md')
  })
  it('POSIX dots', () => {
    expect(normalizePosix('/a/./b/../c')).toBe('/a/c')
    expect(normalizePosix('/../x')).toBe('/x')
  })
})
