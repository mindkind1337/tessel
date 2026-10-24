// Rename and change folder for any project, local or SSH, in every grouping:
// the flat list's rename dialog, the card menu, the folder checks for a local
// folder, and the wiring in App.vue.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import RenameProjectDialog from '../components/sidebar/RenameProjectDialog.vue'
import { resetSettings, settings } from '../settings'
import { setUiLanguage, t } from '../i18n'
import { _resetFeedsForTest } from '../agentChildrenFeed'
import { checkLocalFolder } from '../projectFolder'
import { localRootRefusal, isBareLocalHome } from '../addProject'

const NOW = 1_000_000_000
const project = (extra = {}) => ({ id: 'ws1', name: 'api', cwd: 'C:\\code\\api', branch: '', panes: [], copies: [], worktrees: [], ...extra })
const src = readFileSync(resolve(__dirname, '../App.vue'), 'utf8')

describe('Rename in the flat list', () => {
  let mounted = []
  const labels = () => [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].map((b) => b.textContent.trim())
  const mountSidebar = (projects) => {
    const w = mount(WorkspaceSidebar, { props: { projects, currentId: 'ws1', ports: {}, now: NOW, teams: [] }, attachTo: document.body })
    mounted.push(w)
    return w
  }
  const choose = async (label) => {
    document.querySelectorAll('.orca-menu [data-orca-menu-item]').forEach((b) => b.textContent.trim() === label && b.click())
    await nextTick()
  }
  const cardMenu = (w) => w.findAll('.wtc-surface')[0].trigger('contextmenu', { clientX: 20, clientY: 30 })
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

  it('the project card menu has Rename and opens the dialog, prefilled', async () => {
    settings.sidebarGroupBy = 'none'
    const w = mountSidebar([project()])
    await cardMenu(w)
    expect(labels()).toEqual(expect.arrayContaining(['Rename', 'Change Project Folder…']))
    await choose('Rename')
    const input = document.querySelector('[data-test="rename-project-input"]')
    expect(input).toBeTruthy()
    expect(input.value).toBe('api')
    expect(document.querySelector('[data-test="rename-project-dialog"] h2').textContent).toBe('Rename project')
    expect(w.find('input.osb-rename').exists()).toBe(false)
  })

  it('Enter saves the cleaned name through the rename event; the dialog closes', async () => {
    settings.sidebarGroupBy = 'none'
    const w = mountSidebar([project()])
    await cardMenu(w)
    await choose('Rename')
    const input = document.querySelector('[data-test="rename-project-input"]')
    input.value = '  New\u202e name '
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(w.emitted('rename')).toEqual([['ws1', 'New name']])
    expect(document.querySelector('[data-test="rename-project-dialog"]')).toBeNull()
  })

  it('Escape and Cancel emit nothing', async () => {
    settings.sidebarGroupBy = 'none'
    const w = mountSidebar([project()])
    await cardMenu(w)
    await choose('Rename')
    document.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.querySelector('[data-test="rename-project-dialog"]')).toBeNull()
    await cardMenu(w)
    await choose('Rename')
    document.querySelector('[data-test="rename-project-cancel"]').click()
    await nextTick()
    expect(w.emitted('rename')).toBeUndefined()
  })

  it('a Live Share guest has no Rename in the flat list', async () => {
    settings.sidebarGroupBy = 'none'
    const w = mountSidebar([project({ live: 'guest' })])
    await cardMenu(w)
    expect(labels()).not.toContain('Rename')
    w.vm.openRenameDialog('ws1')
    await nextTick()
    expect(document.querySelector('[data-test="rename-project-dialog"]')).toBeNull()
  })

  it('grouped, Rename still edits in place', async () => {
    settings.sidebarGroupBy = 'repo'
    const w = mountSidebar([project()])
    await w.get('[aria-label="Project actions for api"]').trigger('click')
    await choose('Rename')
    expect(w.find('input.osb-rename').exists()).toBe(true)
    expect(document.querySelector('[data-test="rename-project-dialog"]')).toBeNull()
  })

  it('a new project in the flat list does not pop the dialog up by itself', async () => {
    settings.sidebarGroupBy = 'none'
    const w = mountSidebar([project()])
    w.vm.startRename('ws1')
    await nextTick()
    expect(document.querySelector('[data-test="rename-project-dialog"]')).toBeNull()
  })

  it('works for an SSH project too', async () => {
    settings.sidebarGroupBy = 'none'
    const w = mountSidebar([project({ cwd: null, remote: { host: 'dev', path: '/srv/api' } })])
    await cardMenu(w)
    expect(labels()).toContain('Rename')
  })
})

describe('the rename dialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })
  it('refuses an empty name with a hint, keeps 80 characters, allows duplicates', async () => {
    const w = mount(RenameProjectDialog, { props: { name: 'api' }, attachTo: document.body })
    const input = w.get('[data-test="rename-project-input"]')
    await input.setValue('   ')
    await w.get('[data-test="rename-project-save"]').trigger('click')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.get('[data-test="rename-project-hint"]').text()).toBe('Enter a name for this project.')
    await input.setValue('x'.repeat(200))
    expect(w.find('[data-test="rename-project-hint"]').exists()).toBe(false)
    await w.get('[data-test="rename-project-save"]').trigger('click')
    expect(w.emitted('save')[0][0]).toHaveLength(80)
    w.unmount()
  })
  it('is in French', async () => {
    await setUiLanguage('fr')
    expect(t('sidebar.renameDialog.title', 'Rename project')).toBe('Renommer le projet')
    expect(t('sidebar.renameDialog.save', 'Save')).not.toBe('Save')
    expect(t('app.cmd.renameProject', 'Rename project…')).not.toBe('Rename project…')
    await setUiLanguage('en')
  })
})

describe('a folder on this computer', () => {
  it('refuses drive roots, system folders and the folder of all homes', () => {
    for (const p of ['C:\\', 'C:/', 'D:/', 'C:\\Windows', 'c:\\windows\\system32', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Users', 'C:\\ProgramData', '\\\\server', '/', '/etc', '/etc/ssh', '/usr', '/usr/lib', '/home', '/Users', '/bin', '/ETC', '/users', '/Library', '\\\\?\\C:\\Windows', '\\\\.\\C:\\', '//?/C:/Windows']) {
      expect(localRootRefusal(p), p).toBeTruthy()
    }
    for (const p of ['C:\\code\\api', '\\\\server\\share', '/home/me/api', '/srv/app', '/opt/app', 'C:\\Program Files\\App', 'C:\\Users\\me\\code']) {
      expect(localRootRefusal(p), p).toBe('')
    }
  })
  it('a user’s own home folder asks first', () => {
    expect(isBareLocalHome('C:\\Users\\me')).toBe(true)
    expect(isBareLocalHome('/home/me/')).toBe(true)
    expect(isBareLocalHome('/Users/me')).toBe(true)
    expect(isBareLocalHome('E:\\Profiles\\me', 'E:\\profiles\\me\\')).toBe(true)
    expect(isBareLocalHome('C:\\Users\\me\\code')).toBe(false)
  })

  it('a link to the home folder asks first, like the home folder itself', () => {
    const checked = { ok: true, path: 'D:\\x', real: 'C:\\Users\\me' }
    expect(checkLocalFolder({ ws: { id: 'a', name: 'api', cwd: 'C:\\code\\api' }, checked, workspaces: [], home: '' })).toEqual({ path: 'D:\\x', confirmHome: true })
  })

  const ws = { id: 'a', name: 'api', cwd: 'C:\\code\\api' }
  const other = { id: 'b', name: 'web', cwd: 'C:\\code\\web' }
  const ssh = { id: 'c', name: 'box', cwd: null, remote: { hostId: 'ssh-x', path: '/srv/new' } }
  const guest = { id: 'd', name: 'g', cwd: 'C:\\code\\guest', liveShare: {} }
  const ok = (path, real) => ({ ok: true, path, real: real || path })
  const check = (checked, home = 'C:\\Users\\me') => checkLocalFolder({ ws, checked, workspaces: [ws, other, ssh, guest], home })
  beforeEach(() => setUiLanguage('en'))

  it('keeps a folder that exists, or says why not', () => {
    expect(check(ok('C:\\code\\new'))).toEqual({ path: 'C:\\code\\new' })
    expect(check({ ok: false, error: 'The project folder does not exist.' })).toEqual({ error: 'The project folder does not exist.' })
    expect(check(undefined).error).toBeTruthy()
  })
  it('refuses the same folder (any case, trailing slash, real path) and another project’s', () => {
    expect(check(ok('c:\\CODE\\api\\'))).toMatchObject({ same: true })
    expect(check(ok('D:\\link', 'C:\\code\\api'))).toMatchObject({ same: true })
    expect(check(ok('C:\\code\\web')).error).toContain('web')
    expect(check(ok('D:\\link', 'C:\\code\\web')).error).toContain('web')
  })
  it('an SSH project or a guest’s folder is no conflict', () => {
    expect(check(ok('/srv/new'))).toEqual({ path: '/srv/new' })
    expect(check(ok('C:\\code\\guest'))).toEqual({ path: 'C:\\code\\guest' })
  })
  it('refuses roots and system folders, even through a link; the bare home asks', () => {
    expect(check(ok('C:\\')).error).toBeTruthy()
    expect(check(ok('C:\\Windows')).error).toBeTruthy()
    expect(check(ok('D:\\link', 'C:\\Windows')).error).toBeTruthy()
    expect(check(ok('C:\\Users\\me'))).toEqual({ path: 'C:\\Users\\me', confirmHome: true })
  })
})

describe('App.vue: change folder on this computer', () => {
  const fn = () => src.slice(src.indexOf('async function setWorkspaceFolder'), src.indexOf('// The folder dialog of a remote project'))
  it('checks the folder in main, blocks on unsaved files, asks for a home folder, keeps the project', () => {
    const f = fn()
    expect(f).toContain('api.checkFolder(picked)')
    expect(f).toContain('checkLocalFolder({ ws, checked, workspaces: workspaces.value, home })')
    expect(f.indexOf('projectHasDirtyEditor(ws)')).toBeLessThan(f.indexOf('await window.shellApi.pickFolder'))
    expect(f).toContain('if (verdict.confirmHome) {')
    expect(f).toMatch(/liveShare\.isGuestWs\(ws\)\) return false/)
    expect(f).toContain('ws.cwd = verdict.path')
    expect(f).not.toMatch(/ws\.(id|tree|team|activeId) =/)
    expect(f).toContain('delete wsWorktrees[old]')
  })
  it('the command palette renames and moves the project on screen, never a guest’s', () => {
    expect(src).toMatch(/canEditProject\(currentWs\.value, \(w\) => liveShare\.isGuestWs\(w\)\)[\s\S]{0,500}openRenameDialog\(wsId\)[\s\S]{0,200}setWorkspaceFolder\(wsId\)/)
  })
  it('main answers checkFolder and the preload exposes it', () => {
    expect(readFileSync(resolve(__dirname, '../../../main/addProject.js'), 'utf8')).toContain("'addProject:checkFolder'")
    expect(readFileSync(resolve(__dirname, '../../../preload/index.js'), 'utf8')).toContain("'addProject:checkFolder'")
  })
})
