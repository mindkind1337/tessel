// The Host picker of Add a project (AddProjectHostSelector): its list is
// teleported to <body> with fixed coordinates, so it overflows the dialog
// instead of adding a scrollbar to it; it opens below or above the trigger
// and is capped to the window; keys, Esc and outside clicks. Each SSH row
// says user@host[:port] · its folder, so two hosts on one IP stay apart.
// Nothing connects anywhere.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import AddProjectHostSelector from '../components/project/AddProjectHostSelector.vue'
import { buildHostOptions, sshHostDetail } from '../addProject'
import { hostAddress, shortRemotePath, homeRelative } from '../remoteHostDisplay'
import { setMessages } from '../i18n'

const TARGETS = [
  { id: 'ssh-a', label: 'fivem-afterlife', host: '158.69.53.210', port: 22, username: 'fivem', defaultPath: '/home/fivem/FXServer/server-data/resources', identityFile: 'C:\\Users\\me\\.ssh\\id_secret' },
  { id: 'ssh-b', label: 'fivem-staging', host: '158.69.53.210', port: 2222, username: 'deploy', defaultPath: '/srv/staging' },
  { id: 'ssh-c', label: '192.99.0.20', host: '192.99.0.20', port: 22, username: '' }
]

let rect
let naturalHeight
const origRect = HTMLElement.prototype.getBoundingClientRect
const origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

beforeEach(() => {
  setMessages('en', {})
  rect = { top: 100, bottom: 128, left: 40, right: 240, width: 200, height: 28 }
  naturalHeight = 200
  window.innerWidth = 1000
  window.innerHeight = 700
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches && this.matches('[data-test="host-trigger"]') ? { ...rect, x: rect.left, y: rect.top } : origRect.call(this)
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return this.matches && this.matches('[data-test="host-list"]') ? naturalHeight : 0
    }
  })
})
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = origRect
  if (origScroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origScroll)
  else delete HTMLElement.prototype.scrollHeight
  document.body.innerHTML = ''
})

// The picker inside a clipping dialog, like Add a project.
function mountPicker(props = {}) {
  const host = document.createElement('div')
  host.className = 'fake-dialog'
  host.style.overflowY = 'auto'
  document.body.appendChild(host)
  return mount(AddProjectHostSelector, {
    props: { hosts: buildHostOptions(TARGETS, {}), selectedId: 'local', ...props },
    attachTo: host
  })
}
const list = () => document.querySelector('[data-test="host-list"]')
const q = (sel) => document.querySelector(sel)

describe('the host list escapes the dialog', () => {
  it('is teleported to <body>, outside the dialog, with fixed coordinates at the trigger', async () => {
    const w = mountPicker()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    const el = list()
    expect(el).not.toBeNull()
    expect(el.parentElement).toBe(document.body)
    expect(q('.fake-dialog').contains(el)).toBe(false)
    expect(el.classList.contains('aph-list')).toBe(true)
    // Below the trigger: top = bottom + 4, left at the trigger.
    expect(el.style.top).toBe('132px')
    expect(el.style.bottom).toBe('')
    expect(el.style.left).toBe('40px')
    expect(el.style.maxHeight).toBe(`${700 - 128 - 4 - 8}px`)
    w.unmount()
  })

  it('opens above the trigger when it does not fit below', async () => {
    rect = { top: 600, bottom: 628, left: 40, right: 240, width: 200, height: 28 }
    naturalHeight = 300
    const w = mountPicker()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    const el = list()
    expect(el.style.top).toBe('')
    expect(el.style.bottom).toBe(`${700 - 600 + 4}px`)
    expect(el.style.maxHeight).toBe(`${600 - 4 - 8}px`)
    w.unmount()
  })

  it('taller than the window: the roomier side, capped to the window (the list scrolls)', async () => {
    rect = { top: 300, bottom: 328, left: 900, right: 990, width: 90, height: 28 }
    naturalHeight = 5000
    const w = mountPicker()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    const el = list()
    expect(el.style.top).toBe('332px')
    expect(el.style.maxHeight).toBe(`${700 - 328 - 4 - 8}px`)
    // Kept inside the window on the right.
    expect(parseFloat(el.style.left) + parseFloat(el.style.width)).toBeLessThanOrEqual(1000 - 8)
    w.unmount()
  })

  it('Esc closes the list only; arrows move; an outside click closes it, a click in it does not', async () => {
    const w = mountPicker()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    const items = Array.from(list().querySelectorAll('[data-host-item]'))
    expect(document.activeElement).toBe(items[1])
    list().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[2])
    list().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(items[items.length - 1])
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    list().dispatchEvent(esc)
    await nextTick()
    expect(list()).toBeNull()
    expect(document.activeElement).toBe(w.find('[data-test="host-trigger"]').element)

    await w.find('[data-test="host-trigger"]').trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(list()).not.toBeNull()
    list().querySelector('[data-test="host-ssh-a"]').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(list()).not.toBeNull()
    q('.fake-dialog').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(list()).toBeNull()
    w.unmount()
  })

  it('picking a connected host selects it and closes the list', async () => {
    const w = mountPicker({ hosts: buildHostOptions(TARGETS, { 'ssh-b': { status: 'connected' } }) })
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    q('[data-test="host-ssh-b"]').click()
    await nextTick()
    expect(w.emitted('select')).toEqual([['ssh-b']])
    expect(list()).toBeNull()
    w.unmount()
  })
})

describe('row detail', () => {
  it('two hosts on one IP: name, user@host[:port] · folder, status', async () => {
    const w = mountPicker({ hosts: buildHostOptions(TARGETS, { 'ssh-b': { status: 'connected' } }) })
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    expect(q('[data-test="host-title-ssh-a"]').textContent).toBe('fivem-afterlife')
    expect(q('[data-test="host-sub-ssh-a"]').textContent).toBe('fivem@158.69.53.210 · ~/FXServer/…/resources')
    expect(q('[data-test="host-status-ssh-a"]').textContent).toBe('Disconnected')
    expect(q('[data-test="host-title-ssh-b"]').textContent).toBe('fivem-staging')
    expect(q('[data-test="host-sub-ssh-b"]').textContent).toBe('deploy@158.69.53.210:2222 · /srv/staging')
    expect(q('[data-test="host-status-ssh-b"]').textContent).toBe('Connected')
    expect(q('[data-test="host-sub-ssh-a"]').textContent).not.toBe(q('[data-test="host-sub-ssh-b"]').textContent)
    // The full tooltip: the port and the whole folder.
    const tip = q('[data-test="host-ssh-a"]').getAttribute('title')
    expect(tip).toContain('fivem-afterlife')
    expect(tip).toContain('fivem@158.69.53.210:22 · /home/fivem/FXServer/server-data/resources')
    expect(tip).toContain('Disconnected')
    // Never a key path.
    expect(list().innerHTML).not.toContain('id_secret')
    expect(tip).not.toContain('id_secret')
    // A name that is the address already: no repeated line.
    expect(q('[data-test="host-sub-ssh-c"]')).toBeNull()
    w.unmount()
  })

  it('the trigger shows the same detail for the selected SSH host', () => {
    const w = mountPicker({ selectedId: 'ssh-b', hosts: buildHostOptions(TARGETS, { 'ssh-b': { status: 'connected' } }) })
    const trig = w.find('[data-test="host-trigger"]')
    expect(trig.text()).toContain('fivem-staging')
    expect(w.find('[data-test="host-trigger-sub"]').text()).toBe('deploy@158.69.53.210:2222 · /srv/staging')
    expect(w.find('[data-test="host-trigger-status"]').text()).toBe('Connected')
    expect(trig.attributes('title')).toContain('deploy@158.69.53.210:2222 · /srv/staging')
    w.unmount()
  })

  it('in French', async () => {
    setMessages('fr', { remote: { status: { disconnected: 'Déconnecté', connected: 'Connecté' } }, project: { host: { label: 'Hôte', localWindows: 'Local Windows' } } })
    const w = mountPicker({ hosts: buildHostOptions(TARGETS, { 'ssh-b': { status: 'connected' } }) })
    expect(w.text()).toContain('Hôte')
    expect(w.text()).toContain('Local Windows')
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    expect(q('[data-test="host-status-ssh-a"]').textContent).toBe('Déconnecté')
    expect(q('[data-test="host-status-ssh-b"]').textContent).toBe('Connecté')
    w.unmount()
  })
})

describe('display helpers', () => {
  it('user@host[:port]', () => {
    expect(hostAddress({ host: '1.2.3.4', port: 22, username: 'me' })).toBe('me@1.2.3.4')
    expect(hostAddress({ host: '1.2.3.4', port: 2200, username: 'me' })).toBe('me@1.2.3.4:2200')
    expect(hostAddress({ host: '1.2.3.4', port: 22 }, { port: true })).toBe('1.2.3.4:22')
    expect(hostAddress({ host: '::1', port: 2200 })).toBe('[::1]:2200')
    expect(hostAddress(null)).toBe('')
  })

  it('a short folder: first and last folder', () => {
    expect(shortRemotePath('/home/fivem/FXServer/server-data/resources', 'fivem')).toBe('~/FXServer/…/resources')
    expect(shortRemotePath('/home/fivem/app', 'fivem')).toBe('~/app')
    expect(shortRemotePath('/srv/a/b/c/')).toBe('/srv/…/c')
    expect(shortRemotePath('~/x/y/z')).toBe('~/x/…/z')
    expect(shortRemotePath('/')).toBe('/')
    expect(homeRelative('/root/x', 'root')).toBe('~/x')
    expect(homeRelative('/home/other/x', 'me')).toBe('/home/other/x')
  })

  it('sshHostDetail: only saved fields, no ssh -G', () => {
    expect(sshHostDetail({ label: 'box', host: 'box', configHost: 'box', port: 22, username: '' })).toEqual({ address: 'box', folder: '', subtitle: '', full: 'box:22' })
  })
})
