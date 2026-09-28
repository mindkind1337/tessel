// Remote hosts in the interface: the form logic ported from Orca's
// ssh-target-draft / save payload, the status words, the Settings page
// (components/remote/RemoteHostsSettings.vue) and the status bar item
// (RemoteHostsStatus.vue). window.shellApi.remoteHosts is a fake here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setMessages } from '../i18n'
import {
  parseSshHostInput,
  applyParsedSshHostInput,
  buildSavePayload,
  emptyForm,
  formFromTarget,
  overallStatus,
  connectVerb,
  statusLabel,
  connectedHostCountLabel,
  remoteHostsState,
  setRemoteHostHandlers,
  remoteErrorText
} from '../remoteHosts'
import RemoteHostsSettings from '../components/remote/RemoteHostsSettings.vue'
import RemoteHostsStatus from '../components/remote/RemoteHostsStatus.vue'
import frRemote from '../i18n/locales/fr/remote.json'

const PROD = { id: 'ssh-1', label: 'prod', configHost: 'prod', host: 'prod.example.com', port: 22, username: 'deploy', source: 'ssh-config' }
const BOX = { id: 'ssh-2', label: 'box', configHost: 'box', host: 'box', port: 2222, username: '', identityFile: 'C:\\k\\id', source: 'manual' }

function fakeApi(over = {}) {
  const state = { targets: [PROD, BOX], states: {} }
  return {
    state,
    list: vi.fn(async () => ({ ok: true, targets: state.targets, states: state.states })),
    importConfig: vi.fn(async () => ({ ok: true, targets: [], all: state.targets })),
    add: vi.fn(async (target) => ({ ok: true, target: { id: 'ssh-3', ...target } })),
    update: vi.fn(async (id, updates) => ({ ok: true, target: { id, ...updates } })),
    remove: vi.fn(async () => ({ ok: true })),
    test: vi.fn(async () => ({ success: true })),
    disconnect: vi.fn(async () => ({ ok: true, closed: 1 })),
    onState: vi.fn(() => () => {}),
    ...over
  }
}

describe('host input and the save payload (Orca ssh-target-draft)', () => {
  it('parses server, user@server:port, ssh:// URLs and IPv6', () => {
    expect(parseSshHostInput('server')).toMatchObject({ host: 'server', configHost: 'server' })
    expect(parseSshHostInput('deploy@server:2222')).toMatchObject({ host: 'server', username: 'deploy', port: 2222 })
    expect(parseSshHostInput('ssh://me@[::1]:2200')).toMatchObject({ host: '::1', username: 'me', port: 2200 })
    expect(parseSshHostInput('server:99999')).toMatchObject({ invalidPort: true })
    expect(parseSshHostInput('  ')).toBe(null)
  })

  it('fills username and port from the Host field on blur', () => {
    const draft = applyParsedSshHostInput({ ...emptyForm(), host: 'deploy@server:2222' })
    expect(draft).toMatchObject({ host: 'server', username: 'deploy', port: '2222', configHost: 'server' })
  })

  it('builds the target, or says what is wrong', () => {
    expect(buildSavePayload({ ...emptyForm(), host: '' })).toEqual({ ok: false, error: 'Host or SSH config alias is required' })
    expect(buildSavePayload({ ...emptyForm(), host: 'srv', port: 'abc' }).ok).toBe(false)
    expect(buildSavePayload({ ...emptyForm(), host: 'srv', port: '70000' }).ok).toBe(false)
    const ok = buildSavePayload({ ...emptyForm(), host: 'deploy@srv:2200', identityFile: ' ~/.ssh/k ' })
    expect(ok).toEqual({
      ok: true,
      target: { label: 'deploy@srv', configHost: 'srv', host: 'srv', port: 2200, username: 'deploy', identityFile: '~/.ssh/k', proxyCommand: '', jumpHost: '' }
    })
  })

  it('an edited hand-made host clears its implicit alias', () => {
    expect(formFromTarget(BOX).configHost).toBe('')
    expect(formFromTarget(PROD).configHost).toBe('prod')
  })

  it('status words, verbs and the overall status like Orca', () => {
    expect(overallStatus([])).toBe('disconnected')
    expect(overallStatus(['connected', 'connected'])).toBe('connected')
    expect(overallStatus(['connected', 'disconnected'])).toBe('partial')
    expect(overallStatus(['connecting', 'connected'])).toBe('connecting')
    expect(connectVerb('error')).toBe('Retry')
    expect(connectVerb('auth-failed')).toBe('Reconnect')
    expect(connectVerb('disconnected')).toBe('Connect')
    expect(statusLabel('connected')).toBe('Connected')
    expect(connectedHostCountLabel(1)).toBe('1 host')
    expect(connectedHostCountLabel(3)).toBe('3 hosts')
    expect(remoteErrorText('host-invalid', 'x')).toMatch(/characters/)
  })

  it('speaks French with the remote catalog', () => {
    setMessages('fr', frRemote)
    try {
      expect(statusLabel('disconnected')).toBe('Déconnecté')
      expect(connectedHostCountLabel(2)).toBe('2 hôtes')
      expect(connectedHostCountLabel(1)).toBe('1 hôte')
    } finally {
      setMessages('en', {})
    }
  })
})

describe('Settings > SSH Hosts', () => {
  let api
  beforeEach(() => {
    api = fakeApi()
    window.shellApi = { remoteHosts: api }
    remoteHostsState.targets = []
    remoteHostsState.states = {}
  })
  afterEach(() => {
    delete window.shellApi
    document.body.innerHTML = ''
  })

  it('syncs ~/.ssh/config when it opens and lists the hosts like Orca', async () => {
    const w = mount(RemoteHostsSettings, { attachTo: document.body })
    await flushPromises()
    expect(api.importConfig).toHaveBeenCalledWith(false)
    const cards = w.findAll('[data-ssh-target-card]')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('prod')
    expect(cards[0].text()).toContain('deploy@prod.example.com:22')
    expect(cards[0].text()).toContain('Disconnected')
    expect(cards[1].text()).toContain('box:2222 • C:\\k\\id')
    expect(w.text()).toContain('SSH hosts')
    w.unmount()
  })

  it('shows the empty state', async () => {
    api.state.targets = []
    const w = mount(RemoteHostsSettings)
    await flushPromises()
    expect(w.text()).toContain('No SSH targets configured.')
    w.unmount()
  })

  it('Import re-adopts removed hosts and reports the count', async () => {
    api.importConfig = vi.fn(async (reAdopt) => ({ ok: true, targets: reAdopt ? [PROD, BOX] : [] }))
    const w = mount(RemoteHostsSettings)
    await flushPromises()
    await w.find('[data-test="remote-import"]').trigger('click')
    await flushPromises()
    expect(api.importConfig).toHaveBeenLastCalledWith(true)
    expect(w.text()).toContain('Synced 2 servers')
    w.unmount()
  })

  it('adds a host through the form', async () => {
    const w = mount(RemoteHostsSettings, { attachTo: document.body })
    await flushPromises()
    await w.find('[data-test="remote-add"]').trigger('click')
    expect(w.text()).toContain('Add SSH host')
    await w.find('#ssh-target-host').setValue('me@new.example.com:2200')
    await w.find('#ssh-target-host').trigger('blur')
    expect(w.find('#ssh-target-username').element.value).toBe('me')
    expect(w.find('#ssh-target-port').element.value).toBe('2200')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ host: 'new.example.com', username: 'me', port: 2200 }))
    expect(w.text()).toContain('Target added')
    expect(w.find('.rh-dialog').exists()).toBe(false)
    w.unmount()
  })

  it('shows the error the main process gives, and keeps the form open', async () => {
    api.add = vi.fn(async () => ({ ok: false, error: 'host-invalid' }))
    const w = mount(RemoteHostsSettings, { attachTo: document.body })
    await flushPromises()
    await w.find('[data-test="remote-add"]').trigger('click')
    await w.find('#ssh-target-host').setValue('weird')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('.rh-form-error').text()).toMatch(/characters ssh cannot take/)
    expect(w.find('.rh-dialog').exists()).toBe(true)
    w.unmount()
  })

  it('edits a host (Advanced opens when it has a jump host)', async () => {
    api.state.targets = [{ ...BOX, jumpHost: 'bastion' }]
    const w = mount(RemoteHostsSettings, { attachTo: document.body })
    await flushPromises()
    await w.find('[aria-label="Edit target"]').trigger('click')
    expect(w.text()).toContain('Edit SSH host')
    expect(w.find('#add-ssh-jump-host').element.value).toBe('bastion')
    await w.find('#ssh-target-label').setValue('Box 2')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(api.update).toHaveBeenCalledWith('ssh-2', expect.objectContaining({ label: 'Box 2', jumpHost: 'bastion' }))
    w.unmount()
  })

  it('tests a connection and shows the result', async () => {
    api.test = vi.fn(async () => ({ success: false, error: 'Permission denied (publickey).' }))
    const w = mount(RemoteHostsSettings)
    await flushPromises()
    await w.findAll('[data-test="remote-test"]')[0].trigger('click')
    await flushPromises()
    expect(api.test).toHaveBeenCalledWith('ssh-1')
    expect(w.text()).toContain('Permission denied (publickey).')
    w.unmount()
  })

  it('Connect goes through App\'s handler; a connected host offers Disconnect', async () => {
    const connect = vi.fn(async () => true)
    setRemoteHostHandlers({ connect })
    const w = mount(RemoteHostsSettings)
    await flushPromises()
    await w.findAll('[data-test="remote-connect"]')[0].trigger('click')
    await flushPromises()
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-1' }))
    remoteHostsState.states = { 'ssh-1': { status: 'connected' } }
    await nextTick()
    const card = w.findAll('[data-ssh-target-card]')[0]
    expect(card.text()).toContain('Connected')
    const disc = card.findAll('button').find((b) => b.text() === 'Disconnect')
    await disc.trigger('click')
    await flushPromises()
    expect(api.disconnect).toHaveBeenCalledWith('ssh-1')
    w.unmount()
  })

  it('Remove asks first', async () => {
    const w = mount(RemoteHostsSettings, { attachTo: document.body })
    await flushPromises()
    await w.findAll('[aria-label="Remove target"]')[0].trigger('click')
    expect(w.text()).toContain('Remove SSH Target')
    const confirm = w.findAll('.confirm-btn').find((b) => b.text() === 'Remove')
    await confirm.trigger('click')
    await flushPromises()
    expect(api.remove).toHaveBeenCalledWith('ssh-1')
    expect(w.text()).toContain('Target removed')
    w.unmount()
  })
})

describe('status bar: remote hosts', () => {
  beforeEach(() => {
    remoteHostsState.targets = [PROD, BOX]
    remoteHostsState.states = { 'ssh-2': { status: 'connected' } }
    window.shellApi = { remoteHosts: fakeApi() }
  })
  afterEach(() => {
    delete window.shellApi
    document.body.innerHTML = ''
  })

  it('shows the connected count and lists connected hosts first', async () => {
    const openSettings = vi.fn()
    const connect = vi.fn(async () => true)
    setRemoteHostHandlers({ openSettings, connect })
    const w = mount(RemoteHostsStatus, { attachTo: document.body })
    expect(w.text()).toContain('1 host')
    await w.find('[data-test="remote-hosts-status"]').trigger('click')
    const rows = [...document.querySelectorAll('[data-test="remote-host-row"]')]
    expect(rows.map((r) => r.querySelector('.rh-status-label').textContent)).toEqual(['box', 'prod'])
    expect(rows[0].textContent).toContain('SSH Host')
    expect(rows[0].textContent).toContain('Disconnect')
    const connectBtn = [...rows[1].querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect')
    connectBtn.click()
    await flushPromises()
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ssh-1' }))
    await w.find('[data-test="remote-hosts-status"]').trigger('click')
    const manage = [...document.querySelectorAll('.orca-menu-item')].find((b) => b.textContent.includes('Manage Remote Hosts'))
    manage.click()
    expect(openSettings).toHaveBeenCalled()
    w.unmount()
  })

  it('each state like Orca: Connecting… with a spinner, Error with Retry, Disconnected with Connect, Connected with Disconnect; French words', async () => {
    remoteHostsState.targets = [PROD, BOX, { ...BOX, id: 'ssh-4', label: 'err' }, { ...BOX, id: 'ssh-5', label: 'off' }]
    remoteHostsState.states = {
      'ssh-1': { status: 'connecting' },
      'ssh-2': { status: 'connected' },
      'ssh-4': { status: 'error', error: 'x' }
    }
    const w = mount(RemoteHostsStatus, { attachTo: document.body })
    expect(w.text()).toContain('Connecting…')
    await w.find('[data-test="remote-hosts-status"]').trigger('click')
    const row = (label) => [...document.querySelectorAll('[data-test="remote-host-row"]')].find((r) => r.querySelector('.rh-status-label').textContent === label)
    expect(row('prod').textContent).toContain('Connecting…')
    expect(row('prod').querySelector('[data-test="remote-host-connecting"]')).not.toBe(null)
    expect(row('prod').querySelector('button')).toBe(null)
    expect(row('prod').querySelector('.rh-dot-busy')).not.toBe(null)
    expect(row('err').textContent).toContain('Error')
    expect(row('err').querySelector('.rh-dot-bad')).not.toBe(null)
    expect(row('err').querySelector('button').textContent.trim()).toBe('Retry')
    expect(row('off').textContent).toContain('Disconnected')
    expect(row('off').querySelector('button').textContent.trim()).toBe('Connect')
    expect(row('box').querySelector('.rh-dot-ok')).not.toBe(null)
    expect(row('box').querySelector('button').textContent.trim()).toBe('Disconnect')
    w.unmount()

    setMessages('fr', frRemote)
    const fr = mount(RemoteHostsStatus, { attachTo: document.body })
    await fr.find('[data-test="remote-hosts-status"]').trigger('click')
    expect(row('prod').textContent).toContain('Connexion…')
    expect(row('err').textContent).toContain('Erreur')
    expect(row('err').querySelector('button').textContent.trim()).toBe('Réessayer')
    expect(row('off').textContent).toContain('Déconnecté')
    expect(row('off').querySelector('button').textContent.trim()).toBe('Se connecter')
    expect(row('box').textContent).toContain('Connecté')
    expect(row('box').querySelector('button').textContent.trim()).toBe('Se déconnecter')
    fr.unmount()
    setMessages('en', {})
  })

  it('0 hosts when nothing is connected', () => {
    remoteHostsState.states = {}
    const w = mount(RemoteHostsStatus)
    expect(w.text()).toContain('0 hosts')
    w.unmount()
  })
})
