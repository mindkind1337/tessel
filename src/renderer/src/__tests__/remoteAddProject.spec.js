// Add a project on an SSH host (AddProjectDialog + AddProjectHostSelector +
// RemoteFolderBrowser): connect from the host list (states, error, retry),
// the dialog going on once connected, browsing the host's folders (home,
// into, up, a typed path, files not choosable), the folder chosen as the
// project; clone and create on the host; the host states in French.
// window.shellApi.remoteFs is a fake: nothing connects anywhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AddProjectDialog from '../components/project/AddProjectDialog.vue'
import { remoteHostsState } from '../remoteHosts'
import { sshCredentialState, addSshCredentialRequest } from '../sshCredentials'
import { setMessages } from '../i18n'
import { joinRemote, parentRemote, remoteCrumbs, isPathInput, resolveTypedPath, filterRemoteEntries, enterAction, hostStatusText } from '../addProject'

// A fake host: its folders, by real path.
const TREE = {
  '/home/fivem': [
    { name: '.bashrc', dir: false },
    { name: 'server', dir: true },
    { name: 'txData', dir: true },
    { name: 'db.sql', dir: false },
    { name: 'config.json', dir: false }
  ],
  '/home/fivem/server': [{ name: 'resources', dir: true }],
  '/home': [{ name: 'fivem', dir: true }],
  '/': [{ name: 'home', dir: true }],
  '/srv': []
}

let calls
let connectResults
let releaseConnect = null
// Lets the pending sign-in finish, then the dialog react.
async function signedIn() {
  await flushPromises()
  if (releaseConnect) releaseConnect()
  releaseConnect = null
  await flushPromises()
}
let cloneResult
let createResult

function fakeRemoteFs() {
  return {
    connect: async (hostId) => {
      calls.push(['connect', hostId])
      const next = connectResults.length ? connectResults.shift() : { ok: true }
      // The sign-in (a password dialog) takes a while: held until released.
      await new Promise((r) => (releaseConnect = r))
      return next
    },
    browse: async (hostId, path) => {
      calls.push(['browse', hostId, path])
      let p = path === '~' ? '/home/fivem' : path.startsWith('~/') ? '/home/fivem' + path.slice(1) : path
      p = p.length > 1 ? p.replace(/\/+$/, '') : p
      if (!TREE[p]) return { ok: false, error: 'This folder does not exist on the host.' }
      return { ok: true, path: p, entries: TREE[p] }
    },
    clone: async (hostId, url, parent) => {
      calls.push(['clone', hostId, url, parent])
      return cloneResult
    },
    create: async (hostId, parent, name) => {
      calls.push(['create', hostId, parent, name])
      return createResult
    },
    cancel: async (hostId) => calls.push(['cancel', hostId])
  }
}

beforeEach(() => {
  setMessages('en', {})
  calls = []
  connectResults = []
  cloneResult = { ok: true, path: '/home/fivem/app', name: 'app' }
  createResult = { ok: true, path: '/home/fivem/new-one', name: 'new-one' }
  remoteHostsState.targets = [{ id: 'ssh-box', label: 'box', host: 'box.lan', port: 22, configHost: 'box', source: 'ssh-config' }]
  remoteHostsState.states = {}
  remoteHostsState.loaded = true
  window.shellApi = { pickFolder: async () => null, addProject: { defaults: async () => ({ ok: true, parent: 'C:\\p', gitAvailable: true }) }, remoteFs: fakeRemoteFs() }
})
afterEach(() => {
  remoteHostsState.targets = []
  remoteHostsState.states = {}
  sshCredentialState.queue = []
  document.body.innerHTML = ''
})

// The host list is teleported to <body>; stubbed in place here (hostPicker.spec.js covers the teleport).
const mountDialog = (props = {}) => mount(AddProjectDialog, { props, attachTo: document.body, global: { stubs: { teleport: true } } })
const browserNames = (w) => w.findAll('.rfb-row .rfb-name').map((n) => n.text())

describe('connect from the host list', () => {
  it('the password prompt closes the host list (not the dialog); once signed in the host is selected', async () => {
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await w.find('[data-test="host-connect-ssh-box"]').trigger('click')
    expect(w.find('[data-test="host-list"]').exists()).toBe(true)
    // ssh asks for the password: the prompt opens over the dialog.
    addSshCredentialRequest({ paneId: 'remote-fs:ssh-box', promptId: 'p1', hostId: 'ssh-box', label: 'box', kind: 'password' })
    await flushPromises()
    expect(w.find('[data-test="host-list"]').exists()).toBe(false)
    expect(w.find('[data-test="add-project"]').exists()).toBe(true)
    expect(w.emitted('close')).toBeUndefined()
    // The password is accepted: the prompt goes, the host is connected and selected.
    sshCredentialState.queue = []
    await signedIn()
    expect(w.vm.hostId).toBe('ssh-box')
    expect(w.find('[data-test="host-trigger"]').text()).toContain('Connected')
    w.unmount()
  })

  it('disconnected -> connecting -> connected: the host is selected and the dialog goes on', async () => {
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    expect(w.find('[data-test="host-status-ssh-box"]').text()).toBe('Disconnected')
    const connect = w.find('[data-test="host-connect-ssh-box"]')
    expect(connect.text()).toBe('Connect')
    await connect.trigger('click')
    // Connecting: in the row, the list stays open.
    expect(w.find('[data-test="host-status-ssh-box"]').text()).toBe('Connecting…')
    expect(w.find('[data-test="host-connect-ssh-box"]').text()).toContain('Connecting')
    await signedIn()
    expect(calls).toEqual([['connect', 'ssh-box']])
    // Connected: selected, list closed, Open project on SSH host offered.
    expect(w.find('[data-test="host-list"]').exists()).toBe(false)
    expect(w.find('[data-test="host-trigger"]').text()).toContain('box')
    expect(w.find('[data-test="host-trigger"]').text()).toContain('Connected')
    expect(w.find('[data-test="ap-browse"]').text()).toContain('Open project on SSH host')
    w.unmount()
  })

  it('clicking the row of a disconnected host connects it too', async () => {
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await w.find('[data-test="host-ssh-box"]').trigger('click')
    await signedIn()
    expect(calls).toEqual([['connect', 'ssh-box']])
    expect(w.vm.hostId).toBe('ssh-box')
    w.unmount()
  })

  it('an error shows in the row with Retry; retry connects', async () => {
    connectResults = [{ ok: false, error: 'Could not connect to box: Connection refused' }, { ok: true }]
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await w.find('[data-test="host-connect-ssh-box"]').trigger('click')
    await signedIn()
    expect(w.find('[data-test="host-list"]').exists()).toBe(true)
    expect(w.vm.hostId).toBe('local')
    expect(w.find('[data-test="host-status-ssh-box"]').text()).toBe('Error')
    expect(w.find('[data-test="host-error-ssh-box"]').text()).toContain('Connection refused')
    expect(w.find('[data-test="host-connect-ssh-box"]').text()).toBe('Retry')
    await w.find('[data-test="host-connect-ssh-box"]').trigger('click')
    await signedIn()
    expect(calls.filter((c) => c[0] === 'connect')).toHaveLength(2)
    expect(w.vm.hostId).toBe('ssh-box')
    expect(w.find('[data-test="host-list"]').exists()).toBe(false)
    w.unmount()
  })

  it('a sign-in cancelled (password dialog) is not an error', async () => {
    connectResults = [{ ok: false, cancelled: true, error: 'Sign-in to box was cancelled.' }]
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await w.find('[data-test="host-connect-ssh-box"]').trigger('click')
    await signedIn()
    expect(w.find('[data-test="host-status-ssh-box"]').text()).toBe('Disconnected')
    expect(w.find('[data-test="host-connect-ssh-box"]').text()).toBe('Connect')
    w.unmount()
  })

  it('in French: the states, the kind and the verbs', async () => {
    setMessages('fr', {
      remote: { status: { disconnected: 'Déconnecté', connecting: 'Connexion…', error: 'Erreur', connected: 'Connecté' }, verb: { connect: 'Se connecter', retry: 'Réessayer' } },
      project: { host: { statusDetail: '{{status}} - {{detail}}', connecting: 'Connexion' } }
    })
    connectResults = [{ ok: false, error: 'refusé' }]
    const w = mountDialog()
    await w.find('[data-test="host-trigger"]').trigger('click')
    expect(w.find('[data-test="host-status-ssh-box"]').text()).toBe('Déconnecté')
    expect(w.find('[data-test="host-connect-ssh-box"]').text()).toBe('Se connecter')
    await w.find('[data-test="host-connect-ssh-box"]').trigger('click')
    expect(w.find('[data-test="host-status-ssh-box"]').text()).toBe('Connexion…')
    expect(w.find('[data-test="host-connect-ssh-box"]').text()).toContain('Connexion')
    await signedIn()
    expect(w.find('[data-test="host-status-ssh-box"]').text()).toBe('Erreur')
    expect(w.find('[data-test="host-connect-ssh-box"]').text()).toBe('Réessayer')
    w.unmount()
  })
})

describe('browse the host and choose a folder', () => {
  it('connect -> browse (home) -> into a folder -> choose -> the project on that host', async () => {
    const w = mountDialog({ initialHostId: 'ssh-box' })
    // Selected but not signed in: the action connects first, then goes on.
    await w.find('[data-test="ap-browse"]').trigger('click')
    expect(w.find('[data-test="ap-busy"]').text()).toContain('Connecting to box...')
    await signedIn()
    expect(calls[0]).toEqual(['connect', 'ssh-box'])
    expect(w.find('#ap-heading').text()).toBe('Browse remote file system')
    expect(w.text()).toContain('Navigate to a folder and click Select to choose it.')
    expect(calls[1]).toEqual(['browse', 'ssh-box', '~'])
    // Folders first, hidden files included, files shown.
    expect(browserNames(w)).toEqual(['.bashrc', 'server', 'txData', 'db.sql', 'config.json'])
    expect(w.find('[data-test="rfb-footer"]').text()).toBe('Opens as a project on this host · /home/fivem')
    // Breadcrumb: / > home > fivem (the current one bold).
    const crumbs = w.findAll('.rfb-crumb')
    expect(crumbs.map((c) => c.text())).toEqual(['/', 'home', 'fivem'])
    expect(crumbs[2].classes()).toContain('current')
    // Into "server" (a single click, after the double-click delay).
    await w.find('[data-test="rfb-dir-server"]').trigger('click')
    await new Promise((r) => setTimeout(r, 260))
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['browse', 'ssh-box', '/home/fivem/server'])
    expect(browserNames(w)).toEqual(['resources'])
    await w.find('[data-test="rfb-select"]').trigger('click')
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'server', remote: { hostId: 'ssh-box', path: '/home/fivem/server' } }], source: 'remote' })
    w.unmount()
  })

  it('up, home, a typed path, the filter; files are not choosable', async () => {
    remoteHostsState.states = { 'ssh-box': { status: 'connected' } }
    const w = mountDialog({ initialHostId: 'ssh-box' })
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c[0] === 'connect')).toBe(false)
    // Up.
    await w.find('[data-test="rfb-up"]').trigger('click')
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['browse', 'ssh-box', '/home'])
    // Home.
    await w.find('[data-test="rfb-home"]').trigger('click')
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['browse', 'ssh-box', '~'])
    // Filter.
    const input = w.find('[data-test="rfb-filter"]')
    await input.setValue('tx')
    expect(browserNames(w)).toEqual(['txData'])
    // Enter with one folder matching: into it.
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['browse', 'ssh-box', '/home/fivem/txData'])
    // A typed path.
    await input.setValue('/srv')
    expect(w.find('[data-test="rfb-path-hint"]').text()).toContain('/srv')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['browse', 'ssh-box', '/srv'])
    expect(w.text()).toContain('Empty folder')
    // A path that is not there: the error, with Retry.
    await input.setValue('/nope')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(w.find('[data-test="rfb-error"]').text()).toContain('does not exist')
    expect(w.find('[data-test="rfb-select"]').attributes('disabled')).toBeDefined()
    await w.find('[data-test="rfb-retry"]').trigger('click')
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['browse', 'ssh-box', '/nope'])
    // Back home: a file clicked says it cannot be opened; nothing is added.
    await w.find('[data-test="rfb-home"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="rfb-file-db.sql"]').trigger('click')
    await new Promise((r) => setTimeout(r, 260))
    expect(w.find('[data-test="rfb-footer"]').text()).toBe('Files cannot be opened as a project')
    await w.find('[data-test="rfb-file-db.sql"]').trigger('dblclick')
    expect(w.emitted('add')).toBeUndefined()
    // A double-click on a folder chooses it.
    await w.find('[data-test="rfb-dir-txData"]').trigger('dblclick')
    expect(w.emitted('add')[0][0].projects[0]).toEqual({ name: 'txData', remote: { hostId: 'ssh-box', path: '/home/fivem/txData' } })
    w.unmount()
  })

  it('Esc clears the filter, then Cancel goes back to the start', async () => {
    remoteHostsState.states = { 'ssh-box': { status: 'connected' } }
    const w = mountDialog({ initialHostId: 'ssh-box' })
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    const input = w.find('[data-test="rfb-filter"]')
    await input.setValue('x')
    await input.trigger('keydown', { key: 'Escape' })
    expect(input.element.value).toBe('')
    expect(w.emitted('close')).toBeUndefined()
    await input.trigger('keydown', { key: 'Escape' })
    expect(w.vm.step).toBe('add')
    expect(w.emitted('close')).toBeUndefined()
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="rfb-cancel"]').trigger('click')
    expect(w.vm.step).toBe('add')
    w.unmount()
  })
})

describe('clone and create on the host', () => {
  it('clone: parent picked on the host, then the project on that host', async () => {
    remoteHostsState.states = { 'ssh-box': { status: 'connected' } }
    const w = mountDialog({ initialHostId: 'ssh-box' })
    await w.find('[data-test="ap-clone"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('choose where to clone it on box')
    expect(w.find('[data-test="clone-dest"]').element.value).toBe('~')
    await w.find('[data-test="clone-pick"]').trigger('click')
    await flushPromises()
    expect(w.vm.browseFor).toBe('clone')
    expect(w.find('[data-test="rfb-footer"]').text()).toBe('Clones into this folder on this host · /home/fivem')
    await w.find('[data-test="rfb-select"]').trigger('click')
    expect(w.find('[data-test="clone-dest"]').element.value).toBe('/home/fivem')
    await w.find('[data-test="clone-url"]').setValue('https://github.com/me/app.git')
    await w.find('[data-test="clone-go"]').trigger('click')
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['clone', 'ssh-box', 'https://github.com/me/app.git', '/home/fivem'])
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'app', remote: { hostId: 'ssh-box', path: '/home/fivem/app' } }], source: 'clone' })
    w.unmount()
  })

  it('clone: the host\'s error is shown', async () => {
    remoteHostsState.states = { 'ssh-box': { status: 'connected' } }
    cloneResult = { ok: false, error: 'fatal: repository not found' }
    const w = mountDialog({ initialHostId: 'ssh-box' })
    await w.find('[data-test="ap-clone"]').trigger('click')
    await w.find('[data-test="clone-url"]').setValue('https://github.com/me/nope.git')
    await w.find('[data-test="clone-go"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="clone-error"]').text()).toContain('repository not found')
    expect(w.emitted('add')).toBeUndefined()
    w.unmount()
  })

  it('create: name + parent on the host, then the project there', async () => {
    remoteHostsState.states = { 'ssh-box': { status: 'connected' } }
    const w = mountDialog({ initialHostId: 'ssh-box' })
    await w.find('[data-test="ap-create"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('create a Git project on box')
    await w.find('[data-test="create-name"]').setValue('new-one')
    await w.find('[data-test="create-summary"]').trigger('click')
    await w.find('[data-test="create-pick"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="rfb-footer"]').text()).toContain('Creates the project in this folder on this host')
    await w.find('[data-test="rfb-select"]').trigger('click')
    expect(w.find('[data-test="create-parent"]').element.value).toBe('/home/fivem')
    expect(w.text()).toContain('/home/fivem/new-one')
    await w.find('[data-test="create-go"]').trigger('click')
    await flushPromises()
    expect(calls[calls.length - 1]).toEqual(['create', 'ssh-box', '/home/fivem', 'new-one'])
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'new-one', remote: { hostId: 'ssh-box', path: '/home/fivem/new-one' } }], source: 'create' })
    w.unmount()
  })
})

describe('folder picker logic', () => {
  it('paths', () => {
    expect(joinRemote('/', 'a')).toBe('/a')
    expect(joinRemote('/a/', 'b')).toBe('/a/b')
    expect(parentRemote('/a/b')).toBe('/a')
    expect(parentRemote('/a')).toBe('/')
    expect(parentRemote('/')).toBe('/')
    expect(remoteCrumbs('/home/fivem')).toEqual([
      { name: 'home', path: '/home' },
      { name: 'fivem', path: '/home/fivem' }
    ])
    expect(isPathInput('tx')).toBe(false)
    expect(isPathInput('a/b')).toBe(true)
    expect(isPathInput('~')).toBe(true)
    expect(resolveTypedPath('~/x', '/srv')).toBe('~/x')
    expect(resolveTypedPath('sub/dir', '/srv')).toBe('/srv/sub/dir')
    expect(resolveTypedPath('..', '/srv/a')).toBe('/srv')
    expect(resolveTypedPath('/a\nb', '/')).toBe('')
    expect(resolveTypedPath('C:\\x', '/')).toBe('')
  })

  it('filter and Enter', () => {
    const list = [
      { name: 'Server', dir: true },
      { name: 'server.cfg', dir: false },
      { name: 'db.sql', dir: false }
    ]
    expect(filterRemoteEntries(list, 'SERV').map((e) => e.name)).toEqual(['Server', 'server.cfg'])
    expect(enterAction(filterRemoteEntries(list, 'serv'))).toEqual({ type: 'navigate', name: 'Server' })
    expect(enterAction(filterRemoteEntries(list, 'sql'))).toEqual({ type: 'fileHint' })
    expect(enterAction([])).toEqual({ type: 'noop' })
  })

  it('host status text is translated as a whole', () => {
    setMessages('fr', { remote: { status: { disconnected: 'Déconnecté' } }, project: { host: { statusDetail: '{{status}} ({{detail}})' } } })
    expect(hostStatusText({ status: 'disconnected', detail: 'SSH' })).toBe('Déconnecté (SSH)')
  })
})
