// Add a project (components/project/AddProjectDialog.vue), like Orca's: the
// Host picker, Browse folder / Clone from URL / Create new project, Esc and ×,
// the clone and create steps, a folder on an SSH host, and the repositories
// found in a folder (import separately or as a group).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AddProjectDialog from '../components/project/AddProjectDialog.vue'
import SidePanel from '../components/SidePanel.vue'
import { remoteHostsState } from '../remoteHosts'
import { setMessages } from '../i18n'
import {
  buildHostOptions,
  startActions,
  planImport,
  remotePathError,
  remoteProjectName,
  savedRemote,
  savedGroup,
  joinPath,
  scanLimitText
} from '../addProject'
import { setTasks } from '../taskBoardStore'

let calls
let progressCb
let scanCb
let scanResult
let cloneResult
let createResult
let pickResult

const SCAN = {
  selectedPath: 'C:\\code',
  selectedPathKind: 'non_git_folder',
  repos: [
    { path: 'C:\\code\\api', displayName: 'api', depth: 1 },
    { path: 'C:\\code\\web', displayName: 'web', depth: 1 }
  ],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 10,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: 30000
}

beforeEach(() => {
  setMessages('en', {})
  calls = []
  progressCb = null
  scanCb = null
  scanResult = { ok: true, scan: SCAN }
  cloneResult = { ok: true, path: 'C:\\projects\\app', name: 'app' }
  createResult = { ok: true, path: 'C:\\projects\\my-project', name: 'my-project' }
  pickResult = 'C:\\code'
  remoteHostsState.targets = [{ id: 'ssh-box', label: 'box', host: 'box.lan', port: 22, configHost: 'box', source: 'ssh-config' }]
  remoteHostsState.states = {}
  remoteHostsState.loaded = true
  window.shellApi = {
    pickFolder: async (opts) => {
      calls.push(['pickFolder', opts])
      return pickResult
    },
    addProject: {
      defaults: async () => ({ ok: true, parent: 'C:\\Users\\me\\tessel\\projects', gitAvailable: true }),
      clone: async (url, dest) => {
        calls.push(['clone', url, dest])
        if (progressCb) progressCb({ phase: 'Receiving objects', percent: 40 })
        await new Promise((r) => setTimeout(r, 0))
        return cloneResult
      },
      cloneAbort: async () => calls.push(['cloneAbort']),
      onCloneProgress: (cb) => {
        progressCb = cb
        return () => (progressCb = null)
      },
      create: async (parent, name) => {
        calls.push(['create', parent, name])
        return createResult
      },
      scan: async (path, id) => {
        calls.push(['scan', path])
        if (scanCb) scanCb({ scanId: id, scan: { ...SCAN, repos: SCAN.repos.slice(0, 1) } })
        return scanResult
      },
      scanStop: async (id) => calls.push(['scanStop', id]),
      onScanProgress: (cb) => {
        scanCb = cb
        return () => (scanCb = null)
      }
    }
  }
})
afterEach(() => {
  remoteHostsState.targets = []
  document.body.innerHTML = ''
})

const mountDialog = (props = {}) => mount(AddProjectDialog, { props, attachTo: document.body })

describe('start step', () => {
  it('shows Orca\'s title, host, one big action and the other ways', () => {
    const w = mountDialog()
    expect(w.find('#ap-heading').text()).toBe('Add a project')
    expect(w.find('[data-test="host-trigger"]').text()).toContain('Local Windows')
    const browse = w.find('[data-test="ap-browse"]')
    expect(browse.text()).toContain('Browse folder')
    expect(browse.text()).toContain('Local project, Git repo, or folder with many repos')
    expect(w.text()).toContain('Other ways to add')
    expect(w.find('[data-test="ap-clone"]').text()).toContain('Clone from URL')
    expect(w.find('[data-test="ap-clone"]').text()).toContain('Clone a remote Git repository')
    expect(w.find('[data-test="ap-create"]').text()).toContain('Create new project')
    expect(w.find('[data-test="ap-create"]').text()).toContain('Start from an empty folder')
    w.unmount()
  })

  it('French strings come from the catalog', async () => {
    setMessages('fr', {
      project: {
        start: { title: 'Ajouter un projet', browseTitle: 'Parcourir le dossier', otherWays: "Autres moyens d'ajout" },
        host: { label: 'Hôte', localWindows: 'Local Windows' }
      }
    })
    const w = mountDialog()
    expect(w.find('#ap-heading').text()).toBe('Ajouter un projet')
    expect(w.text()).toContain('Hôte')
    expect(w.text()).toContain('Parcourir le dossier')
    w.unmount()
  })

  it('the host list: this computer, the saved SSH hosts, Add remote host', async () => {
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    const list = w.find('[data-test="host-list"]')
    expect(list.exists()).toBe(true)
    expect(list.text()).toContain('Local Windows')
    expect(list.text()).toContain('box')
    expect(list.text()).toContain('Add remote host')
    await w.find('[data-test="host-ssh-box"]').trigger('click')
    expect(w.find('[data-test="host-list"]').exists()).toBe(false)
    expect(w.find('[data-test="host-trigger"]').text()).toContain('box')
    // On an SSH host: open a folder there; clone and create not yet.
    expect(w.find('[data-test="ap-browse"]').text()).toContain('Open project on SSH host')
    expect(w.find('[data-test="ap-clone"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="ap-create"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="ap-clone"]').text()).toContain('Not available for SSH hosts yet')
    w.unmount()
  })

  it('Add remote host asks for Settings > SSH Hosts', async () => {
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await w.find('[data-test="host-add"]').trigger('click')
    expect(w.emitted('manage-hosts')).toHaveLength(1)
    w.unmount()
  })

  it('Esc and × close it; Esc in the host list only closes the list', async () => {
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await w.find('[data-test="host-list"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="host-list"]').exists()).toBe(false)
    expect(w.emitted('close')).toBeUndefined()
    await w.find('[data-test="add-project"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('[data-test="ap-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })

  it('↑/↓ move between the actions; the ⏎ chip follows the focus', async () => {
    const w = mountDialog()
    await flushPromises()
    const browse = w.find('[data-test="ap-browse"]')
    browse.element.focus()
    await browse.trigger('focus')
    expect(browse.find('.ap-enter').exists()).toBe(true)
    await w.find('.ap-start').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(w.find('[data-test="ap-clone"]').element)
    w.unmount()
  })
})

describe('browse folder', () => {
  it('a plain folder or repository is added as it is', async () => {
    scanResult = { ok: true, scan: { ...SCAN, selectedPathKind: 'git_repo', repos: [] } }
    const w = mountDialog()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c[0] === 'scan')).toEqual(['scan', 'C:\\code'])
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'code', cwd: 'C:\\code' }], source: 'browse' })
    w.unmount()
  })

  it('a folder of repositories opens the import step: all selected, group named after the folder', async () => {
    const w = mountDialog()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    expect(w.find('#ap-heading').text()).toBe('Import repositories from folder')
    expect(w.find('[data-test="nested-desc"]').text()).toBe('Found 2 repositories in C:\\code.')
    expect(w.findAll('[data-test="nested-repo"]').length).toBe(2)
    expect(w.text()).toContain('2 of 2 selected')
    expect(w.text()).toContain('Deselect all')
    expect(w.find('[data-test="nested-group-name"]').element.value).toBe('code')
    await w.find('[data-test="nested-group"]').trigger('click')
    expect(w.emitted('add')[0][0]).toEqual({
      projects: [
        {
          name: 'code',
          cwd: 'C:\\code',
          group: { repos: [{ path: 'C:\\code\\api', name: 'api' }, { path: 'C:\\code\\web', name: 'web' }] }
        }
      ],
      source: 'group'
    })
    w.unmount()
  })

  it('import separately: one project per selected repository', async () => {
    const w = mountDialog()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    await w.findAll('[data-test="nested-repo"]')[0].setValue(false)
    expect(w.text()).toContain('1 of 2 selected')
    await w.find('[data-test="nested-separate"]').trigger('click')
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'web', cwd: 'C:\\code\\web' }], source: 'separate' })
    w.unmount()
  })

  it('none selected: Open as Folder', async () => {
    const w = mountDialog()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="nested-all"]').setValue(false)
    expect(w.find('[data-test="nested-group"]').attributes('disabled')).toBeDefined()
    await w.find('[data-test="nested-folder"]').trigger('click')
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'code', cwd: 'C:\\code' }], source: 'folder' })
    w.unmount()
  })

  it('a partial scan says so', async () => {
    scanResult = { ok: true, scan: { ...SCAN, truncated: true } }
    const w = mountDialog()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="nested-limits"]').text()).toContain('Showing partial scan results.')
    w.unmount()
  })

  it('while the scan runs: the repositories found so far, a stop button', async () => {
    let finish
    window.shellApi.addProject.scan = (path, id) => {
      scanCb({ scanId: id, scan: { ...SCAN, repos: SCAN.repos.slice(0, 1) } })
      return new Promise((r) => (finish = r))
    }
    const w = mountDialog()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="nested-desc"]').text()).toBe('Scanning... Found 1 repository in C:\\code.')
    expect(w.find('[data-test="nested-group"]').attributes('disabled')).toBeDefined()
    await w.find('[data-test="nested-stop"]').trigger('click')
    expect(calls.some((c) => c[0] === 'scanStop')).toBe(true)
    finish({ ok: true, scan: { ...SCAN, repos: SCAN.repos.slice(0, 1), stopped: true } })
    await flushPromises()
    expect(w.find('[data-test="nested-desc"]').text()).toBe('Found 1 repository in C:\\code.')
    expect(w.find('[data-test="nested-limits"]').text()).toContain('Scan stopped early.')
    expect(w.find('[data-test="nested-group"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('cancelling the folder picker changes nothing', async () => {
    pickResult = null
    const w = mountDialog()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c[0] === 'scan')).toBe(false)
    expect(w.emitted('add')).toBeUndefined()
    expect(w.find('[data-test="ap-browse"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})

describe('clone from URL', () => {
  it('URL + parent folder (the default), progress, then the project', async () => {
    const w = mountDialog()
    await w.find('[data-test="ap-clone"]').trigger('click')
    await flushPromises()
    expect(w.find('#ap-heading').text()).toBe('Clone from URL')
    expect(w.find('[data-test="clone-dest"]').element.value).toBe('C:\\Users\\me\\tessel\\projects')
    expect(w.find('[data-test="clone-go"]').attributes('disabled')).toBeDefined()
    await w.find('[data-test="clone-url"]').setValue('https://github.com/user/app.git')
    await w.find('[data-test="clone-go"]').trigger('click')
    await w.vm.$nextTick()
    expect(w.find('[data-test="clone-progress"]').text()).toContain('Receiving objects')
    expect(w.find('[data-test="clone-progress"]').text()).toContain('40%')
    await flushPromises()
    expect(calls.find((c) => c[0] === 'clone')).toEqual(['clone', 'https://github.com/user/app.git', 'C:\\Users\\me\\tessel\\projects'])
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'app', cwd: 'C:\\projects\\app' }], source: 'clone' })
    w.unmount()
  })

  it('shows the error; Back while cloning cancels it', async () => {
    cloneResult = { ok: false, error: 'Clone failed: fatal: repository not found' }
    const w = mountDialog()
    await w.find('[data-test="ap-clone"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="clone-url"]').setValue('https://github.com/user/none.git')
    await w.find('[data-test="clone-go"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="clone-error"]').text()).toBe('Clone failed: fatal: repository not found')
    // A slow clone, then Back.
    window.shellApi.addProject.clone = () => new Promise(() => {})
    await w.find('[data-test="clone-go"]').trigger('click')
    await w.find('[data-test="ap-back"]').trigger('click')
    expect(calls.some((c) => c[0] === 'cloneAbort')).toBe(true)
    expect(w.find('#ap-heading').text()).toBe('Add a project')
    w.unmount()
  })

  it('the folder button picks the parent folder', async () => {
    pickResult = 'D:\\src'
    const w = mountDialog()
    await w.find('[data-test="ap-clone"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="clone-pick"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="clone-dest"]').element.value).toBe('D:\\src')
    w.unmount()
  })
})

describe('create new project', () => {
  it('name + parent (the default), target preview, then the project', async () => {
    const w = mountDialog()
    await w.find('[data-test="ap-create"]').trigger('click')
    await flushPromises()
    expect(w.find('#ap-heading').text()).toBe('Create a new project')
    expect(w.find('[data-test="create-summary"]').text()).toContain('Git repository in C:\\Users\\me\\tessel\\projects')
    expect(w.find('[data-test="create-summary"]').text()).toContain('C:\\Users\\me\\tessel\\projects\\project-name')
    expect(w.find('[data-test="create-go"]').attributes('disabled')).toBeDefined()
    await w.find('[data-test="create-name"]').setValue('my-project')
    await w.find('[data-test="create-go"]').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c[0] === 'create')).toEqual(['create', 'C:\\Users\\me\\tessel\\projects', 'my-project'])
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'my-project', cwd: 'C:\\projects\\my-project' }], source: 'create' })
    w.unmount()
  })

  it('no Git: says so and cannot create; errors are shown', async () => {
    window.shellApi.addProject.defaults = async () => ({ ok: true, parent: 'C:\\p', gitAvailable: false })
    const w = mountDialog()
    await w.find('[data-test="ap-create"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="create-no-git"]').text()).toBe('Git is required to create a project.')
    await w.find('[data-test="create-name"]').setValue('x')
    expect(w.find('[data-test="create-go"]').attributes('disabled')).toBeDefined()
    w.unmount()

    window.shellApi.addProject.defaults = async () => ({ ok: true, parent: 'C:\\p', gitAvailable: true })
    createResult = { ok: false, error: '"x" already exists at this location and is not empty.' }
    const w2 = mountDialog()
    await w2.find('[data-test="ap-create"]').trigger('click')
    await flushPromises()
    await w2.find('[data-test="create-name"]').setValue('x')
    await w2.find('[data-test="create-go"]').trigger('click')
    await flushPromises()
    expect(w2.find('[data-test="create-error"]').text()).toContain('already exists')
    w2.unmount()
  })
})

describe('a folder on an SSH host', () => {
  it('path checked, then the project on that host', async () => {
    const w = mountDialog({ initialHostId: 'ssh-box' })
    await w.find('[data-test="ap-browse"]').trigger('click')
    expect(w.find('#ap-heading').text()).toBe('Open project on SSH host')
    await w.find('[data-test="remote-path"]').setValue('srv/app')
    await w.find('[data-test="remote-go"]').trigger('click')
    expect(w.find('[data-test="remote-error"]').text()).toContain('absolute path')
    expect(w.emitted('add')).toBeUndefined()
    await w.find('[data-test="remote-path"]').setValue('/srv/my app')
    await w.find('[data-test="remote-go"]').trigger('click')
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'my app', remote: { hostId: 'ssh-box', path: '/srv/my app' } }], source: 'remote' })
    w.unmount()
  })
})

describe('add-project logic', () => {
  it('host options and actions', () => {
    const hosts = buildHostOptions([{ id: 'ssh-1', label: 'one' }], { 'ssh-1': { status: 'connected' } })
    expect(hosts.map((h) => [h.id, h.kind, h.status])).toEqual([
      ['local', 'local', 'local'],
      ['ssh-1', 'ssh', 'connected']
    ])
    expect(startActions('local').secondary.every((a) => !a.disabled)).toBe(true)
    expect(startActions('ssh').secondary.every((a) => a.disabled)).toBe(true)
  })

  it('only scanned repositories can be imported', () => {
    const plan = planImport({ scan: SCAN, selectedPaths: ['C:\\code\\api', 'C:\\Windows', 'C:\\code\\api'], mode: 'separate' })
    expect(plan).toEqual([{ name: 'api', cwd: 'C:\\code\\api' }])
    expect(planImport({ scan: SCAN, selectedPaths: [], mode: 'group' })).toEqual([])
    expect(planImport({ scan: SCAN, selectedPaths: ['C:\\code\\web'], mode: 'group', groupName: '  ' })[0].name).toBe('code')
  })

  it('remote paths, names and saved layouts', () => {
    expect(remotePathError('/srv')).toBe('')
    expect(remotePathError('~')).toBe('')
    expect(remotePathError('C:\\x')).not.toBe('')
    expect(remotePathError('/a\nb')).not.toBe('')
    expect(remoteProjectName('~', 'box')).toBe('box')
    expect(remoteProjectName('/srv/app/', 'box')).toBe('app')
    expect(savedRemote({ hostId: 'ssh-x', path: '/srv' })).toEqual({ hostId: 'ssh-x', path: '/srv' })
    expect(savedRemote({ hostId: '../x', path: '/srv' })).toBe(null)
    expect(savedRemote({ hostId: 'ssh-x', path: 'rel' })).toBe(null)
    expect(savedGroup({ repos: [{ path: 'C:\\a' }, { nope: 1 }] })).toEqual({ repos: [{ path: 'C:\\a', name: 'a' }] })
    expect(savedGroup({ repos: [] })).toBe(null)
    expect(joinPath('C:\\p\\', 'x')).toBe('C:\\p\\x')
    expect(scanLimitText(SCAN)).toBe(
      'Scan stops after 3 folder levels or 100 repositories or 30 seconds. You can stop scanning early and import repositories found so far.'
    )
  })
})

describe('side panel of a remote project', () => {
  beforeEach(() => {
    setTasks([])
    window.shellApi = {}
  })
  it('Files and Changes say they are not available yet', async () => {
    const w = mount(SidePanel, { props: { tab: 'files', root: null, remote: { host: 'box', path: '/srv/app' } } })
    expect(w.find('[data-test="remote-unavailable"]').text()).toContain('Not available for a remote project yet')
    expect(w.find('[data-test="remote-unavailable"]').text()).toContain('box:/srv/app')
    expect(w.findComponent({ name: 'ExplorerPanel' }).exists()).toBe(false)
    await w.setProps({ tab: 'changes' })
    expect(w.find('[data-test="remote-unavailable"]').exists()).toBe(true)
    expect(w.findComponent({ name: 'ChangesPanel' }).exists()).toBe(false)
    await w.setProps({ tab: 'tasks' })
    expect(w.find('[data-test="remote-unavailable"]').exists()).toBe(false)
    w.unmount()
  })
  it('in French', () => {
    setMessages('fr', { project: { remote: { unavailable: "Non disponible pour un projet distant pour l'instant" } } })
    const w = mount(SidePanel, { props: { tab: 'files', root: null, remote: { host: 'box', path: '/srv' } } })
    expect(w.text()).toContain("Non disponible pour un projet distant pour l'instant")
    w.unmount()
  })
})
