import { describe, expect, it } from 'vitest'
import { chatRemoteRoot, remoteLinkTarget } from '../chat/remoteChatLinks.js'

const ROOT = 'ssh://ssh-box1/home/me/app'

describe('file links of a chat on an SSH host', () => {
  it('knows a host folder from a local one', () => {
    expect(chatRemoteRoot('ssh://ssh-box1/home/me/app\\src')).toBe('ssh://ssh-box1/home/me/app/src')
    expect(chatRemoteRoot('C:\\code\\app')).toBe(null)
    expect(chatRemoteRoot(null)).toBe(null)
  })

  it('maps the host\'s paths to virtual ones, POSIX-wise', () => {
    expect(remoteLinkTarget(ROOT, '/home/me/app/src/a.js')).toEqual({ file: 'ssh://ssh-box1/home/me/app/src/a.js', path: '/home/me/app/src/a.js', inside: true })
    expect(remoteLinkTarget(ROOT, 'src/a.js').file).toBe('ssh://ssh-box1/home/me/app/src/a.js')
    expect(remoteLinkTarget(ROOT, './src/../b.md').file).toBe('ssh://ssh-box1/home/me/app/b.md')
    expect(remoteLinkTarget(ROOT, 'file:///home/me/app/c%20d.txt').path).toBe('/home/me/app/c d.txt')
  })

  it('outside the project is said so; this PC\'s paths and bad text are refused', () => {
    expect(remoteLinkTarget(ROOT, '/etc/passwd')).toMatchObject({ inside: false })
    expect(remoteLinkTarget(ROOT, '../../../etc/passwd')).toMatchObject({ path: '/etc/passwd', inside: false })
    expect(remoteLinkTarget(ROOT, 'C:\\Users\\me\\a.txt')).toBe(null)
    expect(remoteLinkTarget(ROOT, 'src\\a.js')).toBe(null)
    expect(remoteLinkTarget(ROOT, 'a\u0000b')).toBe(null)
    expect(remoteLinkTarget('C:\\local', 'a.js')).toBe(null)
  })

  it('a project from the home folder keeps its "~"', () => {
    expect(remoteLinkTarget('ssh://ssh-box1/~/app', 'src/a.js')).toMatchObject({ file: 'ssh://ssh-box1/~/app/src/a.js', inside: true })
    expect(remoteLinkTarget('ssh://ssh-box1/~/app', '~/../x')).toBe(null)
  })
})
