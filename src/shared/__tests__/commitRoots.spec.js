// The folders a commit link may ask git about (shared/commitRoots.js): the
// window's open folders and what is inside them; never a network share
// (WSL's own excepted), never a ".." way out.
import { describe, expect, it } from 'vitest'
import { cleanCommitRoots, commitRootAllowed, insideFolder, isForeignShare, validCommitRoot } from '../commitRoots.js'

describe('commitRoots', () => {
  it("network shares are refused, WSL's own is this PC's", () => {
    for (const p of ['\\\\evil\\share', '//evil/share', '\\\\?\\C:\\x', '\\\\wsl.evil.com\\x']) {
      expect(isForeignShare(p), p).toBe(true)
      expect(validCommitRoot(p), p).toBe(false)
    }
    expect(validCommitRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\app')).toBe(true)
    expect(validCommitRoot('\\\\wsl$\\Ubuntu\\home')).toBe(true)
    expect(validCommitRoot('C:\\p\\..\\x')).toBe(false)
    expect(validCommitRoot('C:\\a\u0007b')).toBe(false)
  })

  it('a folder inside an open one (any case, any separator on this PC; exact on a host)', () => {
    const roots = cleanCommitRoots(['C:\\Proj', 'C:\\proj\\', 'ssh://ssh-h1/srv/app', 'lshare://ws-1', '\\\\evil\\share', 7])
    expect(roots).toEqual(['C:\\Proj', 'ssh://ssh-h1/srv/app', 'lshare://ws-1'])
    expect(commitRootAllowed('c:/proj/src', roots)).toBe(true)
    expect(commitRootAllowed('C:\\Proj', roots)).toBe(true)
    expect(commitRootAllowed('C:\\Project', roots)).toBe(false)
    expect(commitRootAllowed('C:\\Proj\\..\\other', roots)).toBe(false)
    expect(commitRootAllowed('ssh://ssh-h1/srv/app/sub', roots)).toBe(true)
    expect(commitRootAllowed('ssh://ssh-h1/srv/other', roots)).toBe(false)
    expect(commitRootAllowed('ssh://ssh-h1/srv/app/../../etc', roots)).toBe(false)
    expect(commitRootAllowed('lshare://ws-1/sub', roots)).toBe(true)
    expect(commitRootAllowed('\\\\evil\\share', ['\\\\evil\\share'])).toBe(false)
    expect(commitRootAllowed('C:\\Proj', [])).toBe(false)
    expect(insideFolder('/srv/app/x', '/srv/app')).toBe(true)
    expect(insideFolder('/etc', '/srv/app')).toBe(false)
  })
})
