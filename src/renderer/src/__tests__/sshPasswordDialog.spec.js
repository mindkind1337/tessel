// The SSH password dialog (components/remote/SshPasswordDialog.vue, Orca's
// SshPassphraseDialog) and its queue (sshCredentials.js), and the "Update
// Available" card (components/UpdateCard.vue, Orca's UpdateCard).
// window.shellApi is a fake: the prompt comes from a fake main process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setMessages } from '../i18n'
import SshPasswordDialog from '../components/remote/SshPasswordDialog.vue'
import UpdateCard from '../components/UpdateCard.vue'
import { sshCredentialState } from '../sshCredentials'
import frRemote from '../i18n/locales/fr/remote.json'
import frApp from '../i18n/locales/fr/app.json'

let requestCb
let resolvedCb
function fakeApi(submitImpl) {
  return {
    sshCredentials: {
      submit: vi.fn(submitImpl || (async () => ({ ok: true }))),
      onRequest: vi.fn((cb) => {
        requestCb = cb
        return () => (requestCb = null)
      }),
      onResolved: vi.fn((cb) => {
        resolvedCb = cb
        return () => (resolvedCb = null)
      })
    }
  }
}
const PASSWORD = { paneId: 'pane-1', promptId: 'p-1', hostId: 'ssh-1', label: '148.113.224.19', kind: 'password', detail: 'ubuntu@148.113.224.19', retry: false }

async function open(req = PASSWORD, api = fakeApi()) {
  window.shellApi = api
  const w = mount(SshPasswordDialog, { attachTo: document.body })
  requestCb(req)
  await nextTick()
  await new Promise((r) => requestAnimationFrame(r))
  return { w, api }
}
const $ = (sel) => document.querySelector(sel)

describe('SSH password dialog', () => {
  beforeEach(() => {
    sshCredentialState.queue = []
  })
  afterEach(() => {
    setMessages('en', {})
    delete window.shellApi
    document.body.innerHTML = ''
  })

  it('shows Orca\'s password dialog, focused, Connect disabled while empty', async () => {
    const { w } = await open()
    const dlg = $('[data-test="ssh-credential-dialog"]')
    expect(dlg.textContent).toContain('SSH Password')
    expect(dlg.textContent).toContain('Enter the password for 148.113.224.19')
    expect(dlg.textContent).toContain('Password for ubuntu@148.113.224.19')
    const input = $('[data-test="ssh-credential-input"]')
    expect(input.type).toBe('password')
    expect(input.getAttribute('autocomplete')).toBe('off')
    expect(input.placeholder).toBe('Enter password')
    expect(document.activeElement).toBe(input)
    expect($('[data-test="ssh-credential-submit"]').disabled).toBe(true)
    expect($('[data-test="ssh-credential-submit"]').textContent.trim()).toBe('Connect')
    w.unmount()
  })

  it('in French, with Orca\'s words', async () => {
    setMessages('fr', frRemote)
    const { w } = await open()
    const dlg = $('[data-test="ssh-credential-dialog"]')
    expect(dlg.querySelector('#ssh-cred-title').textContent).toBe('Mot de passe SSH')
    expect(dlg.textContent).toContain('Saisissez le mot de passe pour 148.113.224.19')
    expect(dlg.textContent).toContain('Mot de passe pour ubuntu@148.113.224.19')
    expect($('[data-test="ssh-credential-input"]').placeholder).toBe('Saisissez le mot de passe')
    expect($('[data-test="ssh-credential-cancel"]').textContent.trim()).toBe('Annuler')
    expect($('[data-test="ssh-credential-submit"]').textContent.trim()).toBe('Se connecter')
    w.unmount()
  })

  it('Enter submits once through the one call, bound to the pane and prompt; the field is emptied', async () => {
    const { w, api } = await open()
    const input = $('[data-test="ssh-credential-input"]')
    input.value = 'hunter2'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect($('[data-test="ssh-credential-submit"]').disabled).toBe(false)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(api.sshCredentials.submit).toHaveBeenCalledTimes(1)
    expect(api.sshCredentials.submit).toHaveBeenCalledWith('pane-1', 'p-1', 'hunter2')
    expect(sshCredentialState.queue).toEqual([])
    expect($('[data-test="ssh-credential-dialog"]')).toBe(null)
    // The queue never holds the secret.
    expect(JSON.stringify(sshCredentialState)).not.toContain('hunter2')
    w.unmount()
  })

  it('Enter with an empty password does nothing', async () => {
    const { w, api } = await open()
    $('[data-test="ssh-credential-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(api.sshCredentials.submit).not.toHaveBeenCalled()
    w.unmount()
  })

  it('Esc cancels (value null)', async () => {
    const { w, api } = await open()
    $('[data-test="ssh-credential-dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(api.sshCredentials.submit).toHaveBeenCalledWith('pane-1', 'p-1', null)
    expect($('[data-test="ssh-credential-dialog"]')).toBe(null)
    w.unmount()
  })

  it('a wrong password comes back with the retry line; a passphrase and a challenge have their own words', async () => {
    const { w } = await open({ ...PASSWORD, promptId: 'p-2', retry: true })
    expect($('[data-test="ssh-credential-retry"]').textContent).toBe('Permission denied, please try again.')
    requestCb({ paneId: 'pane-1', promptId: 'p-3', label: 'srv', kind: 'passphrase', detail: 'C:\\k\\id', retry: false })
    await nextTick()
    const dlg = $('[data-test="ssh-credential-dialog"]')
    expect(dlg.textContent).toContain('SSH Key Passphrase')
    expect(dlg.textContent).toContain('Passphrase for C:\\k\\id')
    expect($('[data-test="ssh-credential-submit"]').textContent.trim()).toBe('Unlock')
    expect($('[data-test="ssh-credential-retry"]')).toBe(null)
    requestCb({ paneId: 'pane-1', promptId: 'p-4', label: 'srv', kind: 'keyboard-interactive', detail: 'Verification code', retry: false })
    await nextTick()
    expect($('[data-test="ssh-credential-dialog"]').textContent).toContain('SSH Verification')
    // A challenge may be answered empty.
    expect($('[data-test="ssh-credential-submit"]').disabled).toBe(false)
    expect($('[data-test="ssh-credential-submit"]').textContent.trim()).toBe('Continue')
    w.unmount()
  })

  it('closes when main withdraws the prompt, and a stale answer just closes it', async () => {
    const { w } = await open(PASSWORD, fakeApi(async () => ({ ok: false, error: 'stale' })))
    resolvedCb({ paneId: 'pane-1', promptId: 'p-1' })
    await nextTick()
    expect($('[data-test="ssh-credential-dialog"]')).toBe(null)
    requestCb({ ...PASSWORD, promptId: 'p-9' })
    await nextTick()
    const input = $('[data-test="ssh-credential-input"]')
    input.value = 'x'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    $('[data-test="ssh-credential-submit"]').click()
    await flushPromises()
    expect($('[data-test="ssh-credential-dialog"]')).toBe(null)
    w.unmount()
  })

  it('ignores malformed requests', async () => {
    const { w } = await open({ paneId: 'p', promptId: 'x', kind: 'root-shell' })
    expect($('[data-test="ssh-credential-dialog"]')).toBe(null)
    w.unmount()
  })

  const HOSTKEY = {
    paneId: 'pane-1',
    promptId: 'hk-1',
    hostId: 'ssh-1',
    label: 'srv',
    kind: 'hostkey',
    detail: [
      "The authenticity of host 'srv (10.0.0.5)' can't be established.",
      'ED25519 key fingerprint is SHA256:AbCd+Ef//012.',
      'Are you sure you want to continue connecting (yes/no/[fingerprint])?'
    ].join('\n'),
    retry: false
  }

  it("a host key question shows ssh's text and fingerprint with Yes / No, no password field; No has the focus", async () => {
    const { w, api } = await open(HOSTKEY)
    const dlg = $('[data-test="ssh-credential-dialog"]')
    expect(dlg.querySelector('#ssh-cred-title').textContent).toBe('Unknown SSH Host Key')
    expect($('[data-test="ssh-credential-question"]').textContent).toContain('SHA256:AbCd+Ef//012')
    expect($('[data-test="ssh-credential-input"]')).toBe(null)
    expect(document.activeElement).toBe($('[data-test="ssh-credential-no"]'))
    expect($('[data-test="ssh-credential-yes"]').textContent.trim()).toBe('Yes, connect')
    $('[data-test="ssh-credential-yes"]').click()
    await flushPromises()
    expect(api.sshCredentials.submit).toHaveBeenCalledWith('pane-1', 'hk-1', 'yes')
    expect($('[data-test="ssh-credential-dialog"]')).toBe(null)
    w.unmount()
  })

  it('host key: No and Esc answer no; in French', async () => {
    setMessages('fr', frRemote)
    const { w, api } = await open(HOSTKEY)
    expect($('#ssh-cred-title').textContent).toBe("Clé d'hôte SSH inconnue")
    expect($('[data-test="ssh-credential-yes"]').textContent.trim()).toBe('Oui, se connecter')
    expect($('[data-test="ssh-credential-no"]').textContent.trim()).toBe('Non')
    $('[data-test="ssh-credential-dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(api.sshCredentials.submit).toHaveBeenCalledWith('pane-1', 'hk-1', 'no')
    requestCb({ ...HOSTKEY, promptId: 'hk-2' })
    await nextTick()
    $('[data-test="ssh-credential-no"]').click()
    await flushPromises()
    expect(api.sshCredentials.submit).toHaveBeenLastCalledWith('pane-1', 'hk-2', 'no')
    expect(api.sshCredentials.submit).toHaveBeenCalledTimes(2)
    w.unmount()
  })
})

describe('Update Available card', () => {
  const READY = { state: 'ready', version: '1.4.216', current: '1.4.200' }
  beforeEach(() => {
    try {
      window.localStorage.clear()
    } catch {
      /* none */
    }
    window.shellApi = { openExternal: vi.fn(async () => true) }
    window.matchMedia = () => ({ matches: true })
  })
  afterEach(() => {
    setMessages('en', {})
    delete window.shellApi
  })

  it('only when an update is ready', () => {
    expect(mount(UpdateCard, { props: { status: { state: 'downloading', version: '2' } } }).find('[data-test="update-card"]').exists()).toBe(false)
    expect(mount(UpdateCard, { props: { status: READY } }).find('[data-test="update-card"]').exists()).toBe(true)
  })

  it('Orca\'s card: title, version, release notes, Update; × dismisses this version', async () => {
    const w = mount(UpdateCard, { props: { status: READY, releaseUrl: 'https://github.com/x/y/releases/tag/v1.4.216' } })
    expect(w.text()).toContain('Update Available')
    expect(w.text()).toContain('Tessel v1.4.216 is ready.')
    await w.find('[data-test="update-card-notes"]').trigger('click')
    expect(window.shellApi.openExternal).toHaveBeenCalledWith('https://github.com/x/y/releases/tag/v1.4.216')
    await w.find('[data-test="update-card-update"]').trigger('click')
    expect(w.emitted('update')).toHaveLength(1)
    await w.find('[data-test="update-card-dismiss"]').trigger('click')
    expect(w.find('[data-test="update-card"]').exists()).toBe(false)
    // Dismissed for this version; a newer one shows again.
    const again = mount(UpdateCard, { props: { status: READY } })
    expect(again.find('[data-test="update-card"]').exists()).toBe(false)
    await again.setProps({ status: { ...READY, version: '1.4.217' } })
    expect(again.find('[data-test="update-card"]').exists()).toBe(true)
  })

  it('the reassurance notice until dismissed; French', async () => {
    setMessages('fr', frApp)
    const w = mount(UpdateCard, { props: { status: READY, releaseUrl: 'https://x' } })
    expect(w.text()).toContain('Mise à jour disponible')
    expect(w.text()).toContain('Tessel v1.4.216 est prête.')
    expect(w.text()).toContain('Notes de version')
    expect(w.find('[data-test="update-card-update"]').text()).toBe('Mettre à jour')
    expect(w.text()).toContain('Vos panneaux se rouvriront')
    await w.find('[data-test="update-card-dismiss-tip"]').trigger('click')
    expect(w.text()).not.toContain('Claude et Codex reprendront')
    expect(w.find('[data-test="update-card"]').exists()).toBe(true)
  })

  it('Esc dismisses', async () => {
    const w = mount(UpdateCard, { props: { status: READY } })
    await w.find('[role="complementary"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="update-card"]').exists()).toBe(false)
  })
})
