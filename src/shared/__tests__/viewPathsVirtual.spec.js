// A link or image in a Live Share host's file (lshare://) or a remote one
// (ssh://): only a relative path inside the same virtual root, read from
// there; never an absolute path, a drive, a share (a host could make the
// guest's computer open SMB to any server) or a file: address.
import { describe, it, expect } from 'vitest'
import { resolveFrom, resolvePreviewImage } from '../viewPaths'

it('blocks passive network images but keeps local and virtual relative assets', () => {
  for (const href of ['\\\\host.invalid\\share\\x.png', '%5C%5Chost.invalid%5Cshare%5Cx.png', '\\\\?\\UNC\\host.invalid\\share\\x.png']) {
    expect(resolvePreviewImage('C:\\docs\\index.html', href)).toBe(null)
  }
  expect(resolvePreviewImage('\\\\host.invalid\\share\\index.html', 'x.png')).toBe('\\\\host.invalid\\share\\x.png')
  expect(resolvePreviewImage('\\\\host.invalid\\share\\index.html', '\\\\other.invalid\\share\\x.png')).toBe(null)
  expect(resolvePreviewImage('\\\\host.invalid\\share\\index.html', '\\\\host.invalid\\other\\x.png')).toBe(null)
  expect(resolvePreviewImage('C:\\docs\\index.html', 'x.png')).toBe('C:\\docs\\x.png')
  expect(resolvePreviewImage('ssh://host/srv/index.html', 'x.png')).toBe(resolveFrom('ssh://host/srv/index.html', 'x.png'))
  expect(resolvePreviewImage('lshare://p1\\index.html', 'x.png')).toBe(resolveFrom('lshare://p1\\index.html', 'x.png'))
})

const DOC = 'lshare://p1\\docs\\README.md'

describe('links and images in a shared or remote file', () => {
  it('resolves a relative path inside the same project', () => {
    expect(resolveFrom(DOC, 'img/x.png')).toBe('lshare://p1\\docs\\img\\x.png')
    expect(resolveFrom(DOC, './img/x.png#a')).toBe('lshare://p1\\docs\\img\\x.png')
    expect(resolveFrom(DOC, '../src/a.md?x=1')).toBe('lshare://p1\\src\\a.md')
    expect(resolveFrom(DOC, 'logo%20x.png')).toBe('lshare://p1\\docs\\logo x.png')
  })

  it('never an absolute path, a drive, a share, a scheme, or out of the project', () => {
    for (const href of ['\\\\host.invalid\\share\\x.png', '//host.invalid/share/x.png', 'C:\\Users\\x.png', 'C:/x.png', '/etc/passwd', '\\x.png', 'file:///C:/x.png', 'file://host/share/x.png', 'smb://host/x', '../../x.png', '../../../x.png'])
      expect(resolveFrom(DOC, href), href).toBe(null)
    // A name Windows reads otherwise: refused by the virtual path itself.
    expect(resolveFrom(DOC, 'img/nul.png')).toBe(null)
  })

  it('a remote file: relative paths on the same host', () => {
    expect(resolveFrom('ssh://ssh-1a/home/me/app\\docs\\README.md', 'img/x.png')).toBe('ssh://ssh-1a/home/me/app/docs/img/x.png')
    expect(resolveFrom('ssh://ssh-1a/~/app/README.md', '../x.png')).toBe('ssh://ssh-1a/~/x.png')
    expect(resolveFrom('ssh://ssh-1a/home/me/app/README.md', '\\\\host\\share\\x.png')).toBe(null)
    expect(resolveFrom('ssh://ssh-1a/home/me/app/README.md', 'C:\\x.png')).toBe(null)
  })

  it('a local file as before', () => {
    expect(resolveFrom('C:\\p\\docs\\README.md', '../src/a.md#part')).toBe('C:\\p\\src\\a.md')
  })
})
