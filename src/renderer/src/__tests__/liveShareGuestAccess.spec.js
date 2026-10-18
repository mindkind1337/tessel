// A Live Share host's project as a guest's panels see it: its lshare:// paths
// (src/shared/liveSharePath.js), what the host lets the guest do in it
// (liveShareAccess.js), and the Open Editors' folder of such a file.
import { describe, it, expect, beforeEach } from 'vitest'
import { LSHARE_PREFIX, isLsharePath, isVirtualPath, parseLsharePath, lsharePath } from '../../../shared/liveSharePath'
import { lshareAccess, setLshareAccess, endLshareSession, forgetLshareAccess, accessOf, stateOfAnswer, accessStateText, accessStateKind } from '../liveShareGuestAccess'
import { folderLabel } from '../explorer/openEditors'

beforeEach(() => forgetLshareAccess())

describe('lshare:// paths', () => {
  it('tells them from local and SSH paths', () => {
    expect(LSHARE_PREFIX).toBe('lshare://')
    expect(isLsharePath('lshare://p1/src/a.js')).toBe(true)
    expect(isLsharePath('C:\\p\\a.js')).toBe(false)
    expect(isLsharePath(null)).toBe(false)
    expect(isVirtualPath('lshare://p1')).toBe(true)
    expect(isVirtualPath('ssh://ssh-1a2b/srv/app')).toBe(true)
    expect(isVirtualPath('C:\\p')).toBe(false)
    expect(isVirtualPath(undefined)).toBe(false)
  })

  it('parses the project and the path in it, with either separator', () => {
    expect(parseLsharePath('lshare://p1')).toEqual({ project: 'p1', rel: '' })
    expect(parseLsharePath('lshare://p1/')).toEqual({ project: 'p1', rel: '' })
    expect(parseLsharePath('lshare://ws-9_a/src/app.js')).toEqual({ project: 'ws-9_a', rel: 'src/app.js' })
    expect(parseLsharePath('lshare://p1\\src\\ui\\a.vue')).toEqual({ project: 'p1', rel: 'src/ui/a.vue' })
  })

  it('refuses what is not one: dot segments, control characters, a bad project, too long', () => {
    expect(parseLsharePath('lshare://p1/../x')).toBeNull()
    expect(parseLsharePath('lshare://p1/a/./b')).toBeNull()
    expect(parseLsharePath('lshare://p1/a\u0000b')).toBeNull()
    expect(parseLsharePath('lshare://p 1/a')).toBeNull()
    expect(parseLsharePath('lshare:///a')).toBeNull()
    expect(parseLsharePath('lshare://' + 'a'.repeat(81))).toBeNull()
    expect(parseLsharePath('lshare://p1/' + 'a'.repeat(5000))).toBeNull()
    expect(parseLsharePath('ssh://ssh-1/a')).toBeNull()
  })

  it('builds them back, joined the way the interface joins paths', () => {
    expect(lsharePath('p1')).toBe('lshare://p1')
    expect(lsharePath('p1', 'src/a.js')).toBe('lshare://p1\\src\\a.js')
    expect(lsharePath('p 1', 'a')).toBeNull()
    expect(lsharePath('p1', '../a')).toBeNull()
    expect(lsharePath('p1', 'a\nb')).toBeNull()
    expect(parseLsharePath(lsharePath('p1', 'a/b.txt'))).toEqual({ project: 'p1', rel: 'a/b.txt' })
  })
})

describe("what the host lets the guest do", () => {
  it('nothing until the window says so; local and SSH paths are never limited', () => {
    expect(accessOf('C:\\p\\a.js')).toBeNull()
    expect(accessOf('ssh://ssh-1a2b/srv/a.js')).toBeNull()
    expect(accessOf('lshare://p1/a.js')).toMatchObject({ project: 'p1', edit: false, git: false, tasks: false, state: 'ok' })
    // A path that does not parse: no access at all.
    expect(accessOf('lshare://p1/../a')).toMatchObject({ edit: false, state: 'no-access' })
  })

  it('takes the rights given, live, and only known states', () => {
    setLshareAccess('p1', { edit: true })
    expect(accessOf('lshare://p1/a.js')).toMatchObject({ edit: true, git: false })
    setLshareAccess('p1', { git: true, state: 'bogus', edit: 'yes' })
    expect(lshareAccess.p1).toEqual({ edit: true, git: true, tasks: false, state: 'ok' })
    setLshareAccess('p1', { state: 'no-access' })
    expect(accessOf('lshare://p1').state).toBe('no-access')
    expect(accessOf('lshare://p2').state).toBe('ok')
  })

  it('the session ending takes every right away and disconnects every project', () => {
    setLshareAccess('p1', { edit: true, git: true, tasks: true })
    setLshareAccess('p2', { edit: true })
    endLshareSession()
    expect(lshareAccess.p1).toEqual({ edit: false, git: false, tasks: false, state: 'ended' })
    expect(lshareAccess.p2.state).toBe('ended')
    forgetLshareAccess('p1')
    expect(lshareAccess.p1).toBeUndefined()
    expect(lshareAccess.p2).toBeDefined()
  })

  it("reads a host's refusal codes, and says each state in words", () => {
    expect(stateOfAnswer({ ok: false, code: 'no-access' })).toBe('no-access')
    expect(stateOfAnswer({ ok: false, code: 'outdated-host' })).toBe('outdated-host')
    // guestFs.js's own codes for the same.
    expect(stateOfAnswer({ ok: false, code: 'no-project' })).toBe('no-access')
    expect(stateOfAnswer({ ok: false, code: 'bad-op' })).toBe('outdated-host')
    // A project whose folder is on the host's SSH server: nothing was taken away.
    expect(stateOfAnswer({ ok: false, code: 'remote-project' })).toBe('remote')
    expect(accessStateText('remote')).toMatch(/SSH server/)
    expect(accessStateText('remote')).not.toMatch(/no longer/)
    expect(accessStateKind('remote')).toBe('info')
    expect(accessStateKind('no-access')).toBe('error')
    expect(stateOfAnswer({ ok: false, code: 'forbidden' })).toBeNull()
    expect(stateOfAnswer({ ok: false, code: 'constructor' })).toBeNull()
    expect(stateOfAnswer(null)).toBeNull()
    expect(accessStateText('no-access')).toBe('You no longer have access to this project.')
    expect(accessStateText('outdated-host')).toMatch(/too old/)
    expect(accessStateText('ok')).toBe('')
  })
})

describe('Open Editors', () => {
  it("a Live Share host's file shows its folder in the project, never a host path", () => {
    expect(folderLabel('lshare://p1\\src\\ui\\a.vue', 'lshare://p1')).toBe('src/ui')
    expect(folderLabel('lshare://p1/readme.md', 'lshare://p1')).toBe('')
    // Local files as before.
    expect(folderLabel('C:\\p\\src\\a.ts', 'C:\\p')).toBe('src')
  })
})
