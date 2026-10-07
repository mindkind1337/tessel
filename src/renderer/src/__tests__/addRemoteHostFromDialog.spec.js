// "Add remote host" in Add a project (like VS Code's Connect to Host from a
// new window): the SSH host form opens over the dialog; once saved, the new
// host is signed in to (its Files session) and selected in the dialog, and
// the new project goes on there. Nothing opens in the current project (no
// pane: the pane opener is never called), and Cancel comes back unchanged.
// window.shellApi is a fake: nothing connects anywhere.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AddProjectDialog from '../components/project/AddProjectDialog.vue'
import { remoteHostsState, setRemoteHostHandlers } from '../remoteHosts'
import { setMessages } from '../i18n'

let saved
let addResult
let connectResult
let calls
let openPane

function fakeApi() {
  return {
    pickFolder: async () => null,
    addProject: { defaults: async () => ({ ok: true, parent: 'C:\\p', gitAvailable: true }) },
    remoteHosts: {
      add: async (target) => {
        calls.push(['add', target])
        if (!addResult.ok) return addResult
        const t = { id: 'ssh-new', source: 'manual', ...target }
        saved.push(t)
        return { ok: true, target: t }
      },
      list: async () => ({ ok: true, targets: saved.map((x) => ({ ...x })), states: {} })
    },
    remoteFs: {
      connect: async (id) => {
        calls.push(['connect', id])
        return connectResult
      },
      browse: async () => ({ ok: true, path: '/home/deploy', entries: [] }),
      cancel: async () => {}
    }
  }
}

beforeEach(() => {
  setMessages('en', {})
  saved = [{ id: 'ssh-box', label: 'box', host: '10.0.0.5', port: 22, username: 'root', configHost: '10.0.0.5', source: 'manual' }]
  addResult = { ok: true }
  connectResult = { ok: true }
  calls = []
  openPane = vi.fn(async () => true)
  setRemoteHostHandlers({ connect: openPane, openSettings: vi.fn() })
  remoteHostsState.targets = saved.map((x) => ({ ...x }))
  remoteHostsState.states = {}
  remoteHostsState.loaded = true
  window.shellApi = fakeApi()
})
afterEach(() => {
  remoteHostsState.targets = []
  remoteHostsState.states = {}
  setRemoteHostHandlers({ connect: null, openSettings: null })
  document.body.innerHTML = ''
})

const mountDialog = () => mount(AddProjectDialog, { attachTo: document.body })
const form = () => document.querySelector('.rh-dialog')

async function openForm(w) {
  await w.find('[data-test="host-trigger"]').trigger('click')
  document.querySelector('[data-test="host-add"]').click()
  await flushPromises()
}
async function fillAndSave(host, user = '') {
  const h = document.getElementById('ssh-target-host')
  h.value = host
  h.dispatchEvent(new Event('input'))
  if (user) {
    const u = document.getElementById('ssh-target-username')
    u.value = user
    u.dispatchEvent(new Event('input'))
  }
  form().querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }))
  await flushPromises()
  await flushPromises()
}

describe('Add remote host from Add a project', () => {
  it('opens the host form over the dialog, outside it; the list closes, the dialog stays', async () => {
    const w = mountDialog()
    await openForm(w)
    expect(form()).not.toBeNull()
    expect(w.find('[data-test="add-project"]').element.contains(form())).toBe(false)
    expect(document.querySelector('[data-test="host-list"]')).toBeNull()
    expect(w.find('[data-test="add-project"]').exists()).toBe(true)
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })

  it('Cancel / Esc: back to the dialog unchanged, nothing saved, nothing opened', async () => {
    const w = mountDialog()
    await openForm(w)
    const cancel = [...form().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel')
    cancel.click()
    await flushPromises()
    expect(form()).toBeNull()
    expect(w.find('[data-test="add-project"]').exists()).toBe(true)
    expect(w.vm.hostId).toBe('local')
    // Esc in the form closes the form only, not the dialog.
    await openForm(w)
    form().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(form()).toBeNull()
    expect(w.emitted('close')).toBeUndefined()
    expect(w.emitted('add')).toBeUndefined()
    expect(calls).toEqual([])
    expect(openPane).not.toHaveBeenCalled()
    w.unmount()
  })

  it('saved: signed in and selected in the dialog, ready for a new project there; no pane in the current project', async () => {
    const w = mountDialog()
    await openForm(w)
    // Same IP as an existing host, another login.
    await fillAndSave('10.0.0.5', 'deploy')
    expect(calls[0][0]).toBe('add')
    expect(calls[0][1]).toMatchObject({ host: '10.0.0.5', username: 'deploy', port: 22 })
    expect(calls[1]).toEqual(['connect', 'ssh-new'])
    expect(form()).toBeNull()
    expect(w.vm.hostId).toBe('ssh-new')
    expect(w.vm.step).toBe('add')
    expect(w.find('[data-test="host-trigger"]').text()).toContain('deploy@10.0.0.5')
    expect(w.find('[data-test="host-trigger-status"]').text()).toBe('Connected')
    expect(w.find('[data-test="ap-browse"]').text()).toContain('Open project on SSH host')
    // Nothing was added or opened in the current project.
    expect(openPane).not.toHaveBeenCalled()
    expect(w.emitted('add')).toBeUndefined()
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })

  it('then the folder picked on it becomes a NEW project on that host', async () => {
    const w = mountDialog()
    await openForm(w)
    await fillAndSave('10.0.0.5', 'deploy')
    await w.find('[data-test="ap-browse"]').trigger('click')
    await flushPromises()
    expect(w.vm.step).toBe('remote')
    const browser = w.findComponent({ name: 'RemoteFolderBrowser' })
    expect(browser.exists()).toBe(true)
    expect(browser.props('hostId')).toBe('ssh-new')
    browser.vm.$emit('select', '/home/deploy/app')
    await flushPromises()
    expect(w.emitted('add')[0][0]).toEqual({ projects: [{ name: 'app', remote: { hostId: 'ssh-new', path: '/home/deploy/app' } }], source: 'remote' })
    expect(openPane).not.toHaveBeenCalled()
    w.unmount()
  })

  it('a refused save keeps the form open with the error', async () => {
    addResult = { ok: false, error: 'host-invalid' }
    const w = mountDialog()
    await openForm(w)
    await fillAndSave('bad host')
    expect(form()).not.toBeNull()
    expect(form().querySelector('[role="alert"], .rh-form-error, .rh-error')).not.toBeNull()
    expect(w.vm.hostId).toBe('local')
    w.unmount()
  })

  it('saved but the sign-in fails: selected anyway, the error under the actions, still no pane', async () => {
    connectResult = { ok: false, error: 'Connection refused' }
    const w = mountDialog()
    await openForm(w)
    await fillAndSave('10.0.0.9', 'deploy')
    expect(w.vm.hostId).toBe('ssh-new')
    expect(w.find('.ap-error').text()).toContain('Connection refused')
    expect(openPane).not.toHaveBeenCalled()
    w.unmount()
  })
})
