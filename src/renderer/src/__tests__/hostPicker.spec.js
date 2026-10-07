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
import { hostAddress, shortRemotePath, homeRelative, hostListWidth } from '../remoteHostDisplay'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setMessages } from '../i18n'

const TARGETS = [
  { id: 'ssh-a', label: 'fivem-afterlife', host: '158.69.53.210', port: 22, username: 'fivem', defaultPath: '/home/fivem/FXServer/server-data/resources', identityFile: 'C:\\Users\\me\\.ssh\\id_secret' },
  { id: 'ssh-b', label: 'fivem-staging', host: '158.69.53.210', port: 2222, username: 'deploy', defaultPath: '/srv/staging' },
  { id: 'ssh-c', label: '192.99.0.20', host: '192.99.0.20', port: 22, username: '' }
]

let rect
let rowRect
let naturalHeight
const origRect = HTMLElement.prototype.getBoundingClientRect
const origScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')

beforeEach(() => {
  setMessages('en', {})
  rect = { top: 100, bottom: 128, left: 40, right: 240, width: 200, height: 28 }
  rowRect = null
  naturalHeight = 200
  window.innerWidth = 1000
  window.innerHeight = 700
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches && this.matches('[data-test="host-trigger"]')) return { ...rect, x: rect.left, y: rect.top }
    if (rowRect && this.matches && this.matches('.aph')) return { ...rowRect, x: rowRect.left, y: rowRect.top }
    return origRect.call(this)
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

describe('row layout: dot, text, one action', () => {
  const STATES = { 'ssh-b': { status: 'connected' } }
  async function openWith(hosts, props = {}) {
    const w = mountPicker({ hosts, ...props })
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    return w
  }

  it('every row is on one grid: dot slot, icon, text, action; no status column', async () => {
    const w = await openWith(buildHostOptions(TARGETS, STATES))
    const rows = Array.from(list().querySelectorAll('[data-host-item]'))
    // Add remote host, Local Windows, then the SSH hosts: the same four cells.
    expect(rows).toHaveLength(2 + TARGETS.length)
    for (const row of rows) {
      const cells = Array.from(row.children).map((c) => c.getAttribute('class') || '')
      expect(cells).toHaveLength(4)
      expect(cells[0]).toContain('aph-dot-slot')
      expect(cells[1]).toContain('aph-icon')
      expect(cells[2]).toContain('aph-item-body')
      expect(cells[3]).toContain('aph-action')
    }
    expect(list().querySelector('.aph-item-status')).toBeNull()
    expect(list().querySelector('.aph-item-head')).toBeNull()
    w.unmount()
  })

  it('disconnected: grey dot and a Connect button; connected: green dot and a Connected tag, no button', async () => {
    const w = await openWith(buildHostOptions(TARGETS, STATES))
    const dotA = q('[data-test="host-status-ssh-a"]')
    expect(dotA.classList.contains('aph-dot')).toBe(true)
    expect(dotA.dataset.tone).toBe('off')
    const actionA = q('[data-test="host-action-ssh-a"]')
    expect(actionA.querySelector('[data-test="host-connect-ssh-a"]').textContent.trim()).toBe('Connect')
    expect(actionA.querySelector('.aph-tag')).toBeNull()

    expect(q('[data-test="host-status-ssh-b"]').dataset.tone).toBe('ok')
    const actionB = q('[data-test="host-action-ssh-b"]')
    expect(actionB.querySelector('[data-test="host-connect-ssh-b"]')).toBeNull()
    expect(actionB.querySelector('[data-test="host-connected-ssh-b"]').textContent).toBe('Connected')
    // The status word only for screen readers (in the dot), the tooltip and the aria-label.
    expect(q('[data-test="host-status-ssh-a"] .aph-sr').textContent).toBe('Disconnected')
    expect(q('[data-test="host-ssh-a"]').getAttribute('aria-label')).toContain('Disconnected')
    expect(q('[data-test="host-ssh-a"]').getAttribute('aria-label')).toContain('fivem-afterlife')
    expect(q('[data-test="host-ssh-b"]').getAttribute('aria-label')).toContain('Connected')
    // Local Windows: no dot, This computer under it, a check when selected.
    expect(q('[data-test="host-status-local"]')).toBeNull()
    expect(q('[data-test="host-sub-local"]').textContent).toBe('This computer')
    expect(q('[data-test="host-action-local"] .aph-check')).not.toBeNull()
    w.unmount()
  })

  it('an error: red dot, the error on line 2 in red (instead of the address), the full text in the tooltip', async () => {
    const err = 'Could not connect to 158.69.53.210: Connection refused after a very long while, try again later'
    const w = await openWith(buildHostOptions(TARGETS, STATES, { errors: { 'ssh-a': err } }))
    expect(q('[data-test="host-status-ssh-a"]').dataset.tone).toBe('bad')
    expect(q('[data-test="host-status-ssh-a"]').classList.contains('tone-bad')).toBe(true)
    const line = q('[data-test="host-error-ssh-a"]')
    expect(line.textContent).toBe(err)
    expect(line.classList.contains('bad')).toBe(true)
    expect(q('[data-test="host-sub-ssh-a"]')).toBeNull()
    expect(q('[data-test="host-ssh-a"]').getAttribute('title')).toContain(err)
    expect(q('[data-test="host-connect-ssh-a"]').textContent.trim()).toBe('Retry')
    w.unmount()
  })

  it('connecting: yellow dot, the busy button', async () => {
    const w = await openWith(buildHostOptions(TARGETS, STATES, { connecting: { 'ssh-a': true } }))
    expect(q('[data-test="host-status-ssh-a"]').dataset.tone).toBe('busy')
    expect(q('[data-test="host-connect-ssh-a"]').classList.contains('busy')).toBe(true)
    w.unmount()
  })
})

describe('list width', () => {
  async function widthWith(row) {
    rowRect = row
    const w = mountPicker()
    await w.find('[data-test="host-trigger"]').trigger('click')
    await nextTick()
    const out = { width: list().style.width, left: list().style.left }
    w.unmount()
    return out
  }
  it('as wide as the picker row (the dialog content), 460 to 640 px', async () => {
    expect(await widthWith({ top: 100, bottom: 128, left: 24, right: 488, width: 464, height: 28 })).toEqual({ width: '464px', left: '24px' })
    expect((await widthWith({ top: 100, bottom: 128, left: 24, right: 324, width: 300, height: 28 })).width).toBe('460px')
    expect((await widthWith({ top: 100, bottom: 128, left: 24, right: 924, width: 900, height: 28 })).width).toBe('640px')
  })

  it('hostListWidth clamps to the window', () => {
    expect(hostListWidth(464, 1000)).toBe(464)
    expect(hostListWidth(200, 1000)).toBe(460)
    expect(hostListWidth(1200, 1000)).toBe(640)
    expect(hostListWidth(464, 400)).toBe(384)
    expect(hostListWidth(0, 0)).toBe(0)
  })
})

describe('layers: the sign-in prompt is above the dialog and its host list', () => {
  const src = (rel) => readFileSync(resolve(__dirname, rel), 'utf8')
  const zOf = (css, selector) => {
    const i = css.indexOf(selector + ' {')
    expect(i).toBeGreaterThanOrEqual(0)
    const block = css.slice(i, css.indexOf('}', i))
    return Number(/z-index:\s*(\d+)/.exec(block)[1])
  }
  it('prompt > host list > Add a project dialog, and above the other lists teleported to <body>', () => {
    const dialog = zOf(src('../components/project/AddProjectDialog.vue'), '.ap-backdrop')
    const hostList = zOf(src('../components/project/AddProjectHostSelector.vue'), '.aph-list')
    const prompt = zOf(src('../components/remote/remoteHosts.css'), '.ssh-cred-backdrop')
    const select = zOf(src('../components/ui/ThemedSelect.vue'), '.ts-select-popup')
    expect(hostList).toBeGreaterThan(dialog)
    expect(prompt).toBeGreaterThan(hostList)
    expect(prompt).toBeGreaterThan(select)
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
