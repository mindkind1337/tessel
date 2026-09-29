import { describe, it, expect } from 'vitest'
import { isAbsolute } from 'path'
import { remoteRoot, parseRemotePath, relativeTo, childPath, remoteHostPath, isRemotePath } from '../../shared/remotePath'

describe('remote virtual paths', () => {
  it('a remote project root, absolute or from home', () => {
    expect(remoteRoot('ssh-1a', '/srv/app/')).toBe('ssh://ssh-1a/srv/app')
    expect(remoteRoot('ssh-1a', '~/app')).toBe('ssh://ssh-1a/~/app')
    expect(remoteRoot('ssh-1a', '~')).toBe('ssh://ssh-1a/~')
    expect(remoteRoot('../x', '/srv')).toBe(null)
    expect(remoteRoot('ssh-1a', 'rel')).toBe(null)
    expect(remoteRoot('ssh-1a', '/a/../b')).toBe(null)
  })
  it('files below it, joined with \\ or /', () => {
    const root = remoteRoot('ssh-1a', '~/app')
    const file = childPath(root, 'src/a b.js')
    expect(file).toBe('ssh://ssh-1a/~/app\\src\\a b.js')
    expect(parseRemotePath(file)).toEqual({ hostId: 'ssh-1a', path: '~/app/src/a b.js' })
    expect(parseRemotePath('ssh://ssh-1a/srv//app/x')).toEqual({ hostId: 'ssh-1a', path: '/srv/app/x' })
    expect(relativeTo('~/app', '~/app/src/a b.js')).toBe('src/a b.js')
    expect(relativeTo('/srv/app', '/srv/apple')).toBe(null)
    expect(remoteHostPath(file)).toBe('~/app/src/a b.js')
  })
  it('refuses .., control characters and odd host ids', () => {
    expect(parseRemotePath('ssh://ssh-1a/srv/app\\..\\etc')).toBe(null)
    expect(parseRemotePath('ssh://ssh-1a/srv/./x')).toBe(null)
    expect(parseRemotePath('ssh://ssh-1a/srv/a\nb')).toBe(null)
    expect(parseRemotePath('ssh://evil;rm/srv')).toBe(null)
    expect(parseRemotePath('C:\\srv')).toBe(null)
  })
  it('is never a local absolute path (local handlers refuse it)', () => {
    const v = 'ssh://ssh-1a/srv/app\\a.txt'
    expect(isRemotePath(v)).toBe(true)
    expect(isAbsolute(v)).toBe(false)
  })
})
