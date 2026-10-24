// Rename a project and change its folder, on an SSH host as for a local one:
// the sidebar's menus (hidden for a Live Share guest), the checks on the
// folder chosen, and the wiring in App.vue (every consumer follows ws.remote).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import RemoteFolderDialog from '../components/project/RemoteFolderDialog.vue'
import { resetSettings } from '../settings'
import { setUiLanguage, t } from '../i18n'
import { _resetFeedsForTest } from '../agentChildrenFeed'
import { cleanProjectName, canEditProject, checkRemoteFolder } from '../projectFolder'

const NOW = 1_000_000_000
const project = (extra = {}) => ({
  id: 'ws1',
  name: 'resources',
  cwd: null,
  branch: '',
  panes: [],
  copies: [],
  worktrees: [],
  remote: { host: 'dev.afterliferp.ca', path: '/srv/fx/resources' },
  ...extra
})
const src = readFileSync(resolve(__dirname, '../App.vue'), 'utf8')

describe('the sidebar menus of a remote project', () => {
  let mounted = []
  const items = () => [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].map((b) => b.textContent.trim())
  function mountSidebar(projects) {
    const w = mount(WorkspaceSidebar, { props: { projects, currentId: 'ws1', ports: {}, now: NOW, teams: [] }, attachTo: document.body })
    mounted.push(w)
    return w
  }
  beforeEach(() => {
    resetSettings()
    window.shellApi = {}
  })
  afterEach(async () => {
    for (const w of mounted) w.unmount()
    mounted = []
    document.body.innerHTML = ''
    _resetFeedsForTest()
    delete window.shellApi
    await setUiLanguage('en')
  })

  it('has Rename and Change Project Folder, which asks App for the folder', async () => {
    const w = mountSidebar([project()])
    await w.get('[aria-label="Project actions for resources"]').trigger('click')
    expect(items()).toEqual(expect.arrayContaining(['Rename', 'Change Project Folder…']))
    document.querySelectorAll('.orca-menu [data-orca-menu-item]').forEach((b) => b.textContent.trim() === 'Change Project Folder…' && b.click())
    await nextTick()
    expect(w.emitted('folder')).toEqual([['ws1']])
  })

  it('renames in place (double-click) and emits the new name', async () => {
    const w = mountSidebar([project()])
    await w.get('.osb-section-label').trigger('dblclick')
    const input = w.get('input.osb-rename')
    await input.setValue('  FX resources ')
    await input.trigger('keydown.enter')
    expect(w.emitted('rename')).toEqual([['ws1', 'FX resources']])
  })

  it('the main card menu has them too', async () => {
    const w = mountSidebar([project()])
    await w.findAll('.wtc-surface')[0].trigger('contextmenu', { clientX: 20, clientY: 30 })
    expect(items()).toEqual(expect.arrayContaining(['Rename', 'Change Project Folder…']))
  })

  it('a Live Share guest sees neither, and a double-click does not edit', async () => {
    const w = mountSidebar([project({ live: 'guest' })])
    await w.get('[aria-label="Project actions for resources"]').trigger('click')
    expect(items()).not.toContain('Rename')
    expect(items()).not.toContain('Change Project Folder…')
    await w.get('.osb-section-label').trigger('dblclick')
    expect(w.find('input.osb-rename').exists()).toBe(false)
  })
})

describe('the checks', () => {
  const ws = { id: 'a', name: 'resources', remote: { hostId: 'ssh-box', path: '/srv/fx/resources' } }
  const other = { id: 'b', name: 'web', remote: { hostId: 'ssh-box', path: '/srv/web' } }
  const elsewhere = { id: 'c', name: 'c', remote: { hostId: 'ssh-other', path: '/srv/fx' } }
  beforeEach(() => setUiLanguage('en'))

  it('cleans a name: no control characters, trimmed, 80 characters', () => {
    expect(cleanProjectName('  a\u0000b\nc  ')).toBe('a b c')
    expect(cleanProjectName('x'.repeat(200))).toHaveLength(80)
    expect(cleanProjectName('   ')).toBe('')
    expect(cleanProjectName(null)).toBe('')
  })

  it('a guest cannot edit', () => {
    const isGuest = (w) => !!w.liveShare
    expect(canEditProject(ws, isGuest)).toBe(true)
    expect(canEditProject({ ...ws, liveShare: {} }, isGuest)).toBe(false)
    expect(canEditProject(null, isGuest)).toBe(false)
  })

  it('keeps the real path the host listed', () => {
    expect(checkRemoteFolder({ ws, picked: '~/fx', browsed: { ok: true, path: '/home/me/fx' }, workspaces: [ws, other, elsewhere] })).toEqual({ path: '/home/me/fx' })
    // another host with the same path is no conflict
    expect(checkRemoteFolder({ ws, picked: '/srv/fx', browsed: { ok: true, path: '/srv/fx' }, workspaces: [ws, elsewhere] })).toEqual({ path: '/srv/fx' })
  })

  it('refuses the host failures with the host words (missing, denied, not connected)', () => {
    for (const error of ['This folder does not exist on the host.', 'Permission denied: this folder cannot be read.', 'dev is not connected. Use Connect to sign in.']) {
      expect(checkRemoteFolder({ ws, picked: '/nope', browsed: { ok: false, error }, workspaces: [ws] })).toEqual({ error })
    }
    expect(checkRemoteFolder({ ws, picked: '/x', browsed: undefined, workspaces: [ws] }).error).toBeTruthy()
  })

  it('refuses bad typed paths, odd answers, the same folder and another project’s folder', () => {
    const bad = (picked, browsed) => checkRemoteFolder({ ws, picked, browsed: browsed || { ok: true, path: '/ok' }, workspaces: [ws, other] })
    expect(bad('relative/dir').error).toBeTruthy()
    expect(bad('/a\u0007b').error).toBeTruthy()
    expect(bad('C:\\dir').error).toBeTruthy()
    expect(bad('/a', { ok: true, path: 'C:\\Users' }).error).toBeTruthy()
    expect(bad('/a', { ok: true, path: '/a/../etc' }).error).toBeTruthy()
    expect(bad('/a', { ok: true, path: '/srv/fx/resources/' })).toMatchObject({ same: true })
    expect(bad('/a', { ok: true, path: '/srv/web' }).error).toContain('web')
  })

  it('its words are in French', async () => {
    await setUiLanguage('fr')
    for (const [key, en] of [
      ['project.remote.folder.title', 'Project folder on {{host}}'],
      ['project.remote.folder.checking', 'Checking the folder on the host…'],
      ['project.remote.folder.same', 'This project already uses this folder.'],
      ['project.remote.folder.guest', 'A Live Share project belongs to its host: only they can change it.'],
      ['project.remote.folder.hostGone', 'This remote host is no longer saved in Tessel.'],
      ['project.remoteBrowser.footerFolder', 'New panes start in this folder on this host · {{path}}']
    ]) {
      expect(t(key, en)).not.toBe(en)
    }
    const other2 = t('project.remote.folder.other', 'x {{name}}', { name: 'web' })
    expect(other2).toContain('web')
    expect(other2).not.toBe('x web')
  })
})

describe('the folder dialog', () => {
  it('shows the check in progress and its error, and closes on Escape', async () => {
    window.shellApi = { remoteFs: { browse: async () => ({ ok: true, path: '/home', entries: [] }) } }
    const w = mount(RemoteFolderDialog, { props: { hostId: 'ssh-box', hostLabel: 'dev', projectName: 'resources', error: 'Not found' }, attachTo: document.body })
    expect(w.get('[data-test="remote-folder-error"]').text()).toBe('Not found')
    await w.setProps({ busy: true })
    expect(w.find('[data-test="remote-folder-error"]').exists()).toBe(false)
    expect(w.find('[data-test="remote-folder-busy"]').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
    delete window.shellApi
  })
})

describe('App.vue', () => {
  it('moves a remote project to the folder the host listed, in place (same project, panes stay)', () => {
    expect(src).toMatch(/api\.browse\(hostId, picked\)/)
    expect(src).toMatch(/ws\.remote = \{ hostId: ws\.remote\.hostId, path \}/)
    // never the local folder picker for a remote project
    const at = src.indexOf('async function setWorkspaceFolder')
    const fn = src.slice(at, at + 1800)
    expect(fn.indexOf('remoteFolder.value = {')).toBeGreaterThan(0)
    expect(fn.indexOf('remoteFolder.value = {')).toBeLessThan(fn.indexOf('pickFolder'))
  })
  it('a guest can neither rename nor move a project', () => {
    expect(src).toMatch(/function renameWorkspace[\s\S]{0,300}canEditProject\(ws,/)
    expect(src).toMatch(/async function setWorkspaceFolder[\s\S]{0,400}canEditProject\(ws,/)
    expect(src).toMatch(/function applyRemoteFolder\(ws, path\) \{\s*if \(!ws\.remote \|\| liveShare\.isGuestWs\(ws\)\) return false/)
  })
  it('what follows a remote project reads ws.remote live (git, roots, new panes, saved layout)', () => {
    expect(src).toMatch(/const gitKeyOf = \(w\) => \(w\.remote \? remoteRoot\(w\.remote\.hostId, w\.remote\.path\)/)
    expect(src).toMatch(/return \{ \.\.\.opts, remoteHostId: ws\.remote\.hostId, remotePath: ws\.remote\.path \}/)
    expect(src).toMatch(/\.\.\.\(w\.remote \? \{ remote: \{ hostId: w\.remote\.hostId, path: w\.remote\.path \} \} : \{\}\)/)
    expect(src).toMatch(/filter\(\(w\) => w\.remote\)\s*\.map\(\(w\) => remoteRoot\(w\.remote\.hostId, w\.remote\.path\)\)[\s\S]{0,120}saveLayoutNow/)
  })
})
