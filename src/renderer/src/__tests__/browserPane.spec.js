// Tessel's built-in browser pane (BrowserPane.vue) and its pure logic
// (browser/browserPage.js): the address bar, the page's events, the failure
// overlay, the blank page, the ports popover and what the main process says
// about this pane's page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import {
  clampZoom,
  nextZoom,
  zoomPercent,
  isShownLoadFailure,
  loadFailureView,
  httpsRecoveryUrl,
  pageTitleFor,
  permissionNotice,
  downloadNotice,
  shortcutAction,
  portAddress
} from '../browser/browserPage'

const design = vi.hoisted(() => ({ toggle: null, screenshot: null }))
vi.mock('../components/DesignModePanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'DesignModePanel',
      props: { guestId: { type: Number, default: null }, pageUrl: String, pageTitle: String, paneId: String },
      emits: ['active'],
      setup(props, { expose }) {
        expose({ toggle: () => design.toggle(), stop() {}, screenshot: () => design.screenshot(), isActive: () => false })
        return () => h('div', { class: 'dm-stub', 'data-guest': props.guestId, 'data-url': props.pageUrl })
      }
    })
  }
})
import BrowserPane from '../components/BrowserPane.vue'
import SideBrowser from '../components/SideBrowser.vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { acquirePassthrough } from '../browser/webviewPassthrough'

describe('browserPage.js', () => {
  it('zoom levels: -3..+5 by 0.5, as a percent', () => {
    expect(nextZoom(0, 1)).toBe(0.5)
    expect(nextZoom(0.5, -1)).toBe(0)
    expect(nextZoom(3, 0)).toBe(0)
    expect(nextZoom(5, 1)).toBe(5)
    expect(nextZoom(-3, -1)).toBe(-3)
    expect(clampZoom('x')).toBe(0)
    expect(clampZoom(0.3)).toBe(0.5)
    expect(zoomPercent(0)).toBe(100)
    expect(zoomPercent(1)).toBe(120)
    expect(zoomPercent(-1)).toBe(83)
  })

  it('an aborted load or a frame inside the page is not a failure to show', () => {
    expect(isShownLoadFailure({ errorCode: -3, isMainFrame: true })).toBe(false)
    expect(isShownLoadFailure({ errorCode: -102, isMainFrame: false })).toBe(false)
    expect(isShownLoadFailure({ errorCode: -102, isMainFrame: true })).toBe(true)
    expect(isShownLoadFailure(null)).toBe(false)
  })

  it('failure texts: a local server, another page, a certificate, a crash', () => {
    const local = loadFailureView({ kind: 'load', code: -102, url: 'http://localhost:5173/' })
    expect(local.title).toBe("Can't reach localhost:5173")
    expect(local.description).toBe("We couldn't connect to your local server.")
    expect(local.hints[0]).toMatch(/make sure the server is running/)
    expect(local.httpsUrl).toBe('https://localhost:5173/')

    const remote = loadFailureView({ kind: 'load', code: -105, url: 'https://example.com/x' })
    expect(remote.title).toBe("Can't reach example.com")
    expect(remote.description).toBe("We couldn't connect to this page.")
    expect(remote.hints).toEqual([])
    expect(remote.httpsUrl).toBe(null)

    expect(loadFailureView({ kind: 'load', code: -105, url: 'about:blank' }).title).toBe("Can't load this page")
    const cert = loadFailureView({ kind: 'load', code: -202, url: 'https://localhost:8443/' })
    expect(cert.title).toBe("Connection isn't secure")
    expect(cert.description).toMatch(/^Tessel doesn't trust/)
    expect(loadFailureView({ kind: 'crash' }).title).toBe('Browser page stopped')
    expect(httpsRecoveryUrl('http://example.com/')).toBe(null)
  })

  it('the title: the page title, else its host; none for the blank page', () => {
    expect(pageTitleFor('My app', 'http://localhost:3000/')).toBe('My app')
    expect(pageTitleFor('', 'http://localhost:3000/')).toBe('localhost:3000')
    expect(pageTitleFor('http://localhost:3000/', 'http://localhost:3000/')).toBe('localhost:3000')
    expect(pageTitleFor('localhost:3000/', 'http://localhost:3000/')).toBe('localhost:3000')
    expect(pageTitleFor('x', 'about:blank')).toBe('')
  })

  it('notices for a denied permission and a blocked download', () => {
    expect(permissionNotice({ permission: 'media', origin: 'https://a.test' })).toBe(
      'https://a.test asked for camera or microphone access; Tessel denied it.'
    )
    expect(permissionNotice({ permission: 'geolocation', origin: 'unknown' })).toBe('This page asked for your location; Tessel denied it.')
    expect(permissionNotice({ permission: 'hid', origin: 'https://a.test' })).toBe('https://a.test asked for hid; Tessel denied it.')
    expect(downloadNotice({ name: 'a.zip' })).toBe('Tessel does not download files. Open a.zip in your default browser?')
  })

  it('keys: address, reload, history, devtools, zoom', () => {
    const k = (key, mods = {}) => shortcutAction({ key, ...mods })
    expect(k('l', { ctrlKey: true })).toBe('focusAddress')
    expect(k('f', { ctrlKey: true })).toBe('find')
    expect(k('F', { ctrlKey: true, shiftKey: true })).toBe(null)
    expect(k('r', { ctrlKey: true })).toBe('reload')
    expect(k('R', { ctrlKey: true, shiftKey: true })).toBe('hardReload')
    expect(k('F5')).toBe('reload')
    expect(k('ArrowLeft', { altKey: true })).toBe('back')
    expect(k('ArrowRight', { altKey: true })).toBe('forward')
    expect(k('F12')).toBe('devTools')
    expect(k('=', { ctrlKey: true })).toBe('zoomIn')
    expect(k('+', { ctrlKey: true, shiftKey: true })).toBe('zoomIn')
    expect(k('-', { ctrlKey: true })).toBe('zoomOut')
    expect(k('0', { ctrlKey: true })).toBe('zoomReset')
    expect(k('a')).toBe(null)
    expect(k('l', { ctrlKey: true, altKey: true })).toBe(null)
  })

  it('a port row shows its address without the scheme', () => {
    expect(portAddress({ url: 'http://localhost:5173/', port: 5173 })).toBe('localhost:5173')
    expect(portAddress({ port: 3000 })).toBe('localhost:3000')
  })
})

describe('BrowserPane.vue', () => {
  let wrapper, ctx, api, node, handlers, offs, ports, prevApi, askConfirm

  function fakeWebview(el) {
    el.loadURL = vi.fn(() => Promise.resolve())
    el.goBack = vi.fn()
    el.goForward = vi.fn()
    el.reload = vi.fn()
    el.reloadIgnoringCache = vi.fn()
    el.stop = vi.fn()
    el.canGoBack = vi.fn(() => false)
    el.canGoForward = vi.fn(() => false)
    el.getURL = vi.fn(() => 'about:blank')
    el.getTitle = vi.fn(() => '')
    el.getWebContentsId = vi.fn(() => 42)
    el.setZoomLevel = vi.fn()
    el.isLoading = vi.fn(() => false)
    el.focus = vi.fn()
    el.findInPage = vi.fn()
    el.stopFindInPage = vi.fn()
    el.executeJavaScript = vi.fn(async () => [0, 640])
    return el
  }
  function fire(name, props = {}) {
    const ev = new Event(name)
    Object.assign(ev, props)
    webview().dispatchEvent(ev)
  }
  const webview = () => wrapper.find('webview').element

  async function mountPane(url = 'about:blank', extra = {}) {
    node = reactive({ type: 'leaf', kind: 'browser', id: 'b1', num: 2, title: '', url, zoom: 0, focusAddress: 0, ...extra })
    wrapper = mount(BrowserPane, {
      props: { node },
      attachTo: document.body,
      global: { provide: { panelCtx: ctx, askConfirm: (q) => askConfirm(q) } }
    })
    fakeWebview(webview())
    await nextTick()
  }
  async function ready() {
    fire('dom-ready')
    await nextTick()
  }
  async function typeAddress(text) {
    const input = wrapper.find('.bp-address-input')
    await input.setValue(text)
    await wrapper.find('form.bp-address').trigger('submit')
    await flushPromises()
  }

  beforeEach(() => {
    handlers = {}
    offs = []
    ports = []
    const sub = (name) =>
      vi.fn((cb) => {
        handlers[name] = cb
        const off = vi.fn()
        offs.push(off)
        return off
      })
    api = {
      onPopup: sub('popup'),
      onShortcut: sub('shortcut'),
      onPermissionDenied: sub('permission'),
      onDownloadBlocked: sub('download'),
      openDevTools: vi.fn(() => Promise.resolve({ ok: true }))
    }
    prevApi = window.shellApi
    window.shellApi = { browser: api, writeClipboard: vi.fn(), openExternal: vi.fn() }
    ctx = {
      activeId: ref('b1'),
      maximizedId: ref(null),
      highlightId: ref(null),
      setActive: vi.fn(),
      closeLeaf: vi.fn(),
      toggleMaximize: vi.fn(),
      beginPaneDrag: vi.fn(),
      toast: vi.fn(),
      copied: vi.fn(),
      browserPorts: () => ports,
      openExternal: vi.fn()
    }
    design.toggle = vi.fn()
    design.screenshot = vi.fn()
    askConfirm = vi.fn(async () => true)
  })

  afterEach(() => {
    if (wrapper) wrapper.unmount()
    wrapper = null
    window.shellApi = prevApi
  })

  it('renders the pane header, the toolbar and the webview (hardened attributes, first address as src)', async () => {
    await mountPane('http://localhost:3000/')
    const root = wrapper.find('.pane.browser-pane')
    expect(root.attributes('data-pane-kind')).toBe('browser')
    expect(root.attributes('data-pane-id')).toBe('b1')
    expect(root.classes()).toContain('active')
    expect(wrapper.find('.pane-nav .pane-num').exists()).toBe(false)
    expect(wrapper.find('[data-test="browser-title"]').text()).toBe('localhost:3000')
    const wv = wrapper.find('webview')
    expect(wv.attributes('partition')).toBe('persist:tessel-browser')
    expect(wv.attributes('src')).toBe('http://localhost:3000/')
    expect(wv.attributes('webpreferences')).toContain('contextIsolation=yes')
    expect(wrapper.find('.bp-address-input').element.value).toBe('http://localhost:3000/')
    expect(wrapper.find('[data-test="browser-back"]').attributes('disabled')).toBeDefined()
  })

  it('Clear browsing data: asks first, clears the session, says so', async () => {
    api.clearData = vi.fn(async () => ({ ok: true }))
    await mountPane('http://localhost:3000/')
    await ready()
    const btn = wrapper.find('[data-test="browser-clear-data"]')
    expect(btn.attributes('aria-label')).toBe('Clear browsing data')

    askConfirm.mockResolvedValueOnce(false)
    await btn.trigger('click')
    await flushPromises()
    expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clear browsing data?', confirmLabel: 'Clear', danger: true }))
    expect(api.clearData).not.toHaveBeenCalled()

    await btn.trigger('click')
    await flushPromises()
    expect(api.clearData).toHaveBeenCalledTimes(1)
    expect(ctx.toast).toHaveBeenLastCalledWith('Browsing data cleared', { timeout: 3000 })

    api.clearData = vi.fn(async () => ({ ok: false }))
    await btn.trigger('click')
    await flushPromises()
    expect(ctx.toast).toHaveBeenLastCalledWith('Could not clear the browsing data.', { kind: 'error' })

    api.clearData = vi.fn(async () => { throw new Error('gone') })
    ctx.toast.mockClear()
    await btn.trigger('click')
    await flushPromises()
    expect(ctx.toast).toHaveBeenLastCalledWith('Could not clear the browsing data.', { kind: 'error' })
  })

  it('a blank page shows the New Tab state, with the active ports to open', async () => {
    ports = [{ id: 'p1', url: 'http://localhost:5173/', port: 5173, processName: 'node', label: 'web' }]
    await mountPane()
    await ready()
    const empty = wrapper.find('[data-test="browser-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('New Tab')
    expect(empty.text()).toContain('Type a URL above to start browsing.')
    expect(wrapper.find('[data-test="browser-title"]').text()).toBe('Browser')
    expect(wrapper.find('[data-test="browser-external"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="browser-design"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="browser-empty-port"]').trigger('click')
    expect(webview().loadURL).toHaveBeenCalledWith('http://localhost:5173/')
  })

  it('Enter normalizes the address: localhost:5173 -> http://localhost:5173/', async () => {
    await mountPane()
    await ready()
    await typeAddress('localhost:5173')
    expect(webview().loadURL).toHaveBeenCalledWith('http://localhost:5173/')
    expect(wrapper.find('[data-test="browser-address-error"]').exists()).toBe(false)
  })

  it('an address typed before the page is ready loads once it is', async () => {
    await mountPane()
    await typeAddress('example.com')
    expect(webview().loadURL).not.toHaveBeenCalled()
    await ready()
    expect(webview().loadURL).toHaveBeenCalledWith('https://example.com/')
    expect(webview().setZoomLevel).toHaveBeenCalledWith(0)
  })

  it('an address the browser refuses shows an inline error; Escape puts the current address back', async () => {
    await mountPane('http://localhost:3000/')
    await ready()
    await typeAddress('javascript:alert(1)')
    expect(webview().loadURL).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="browser-address-error"]').text()).toBe('Enter a valid http(s) or localhost URL.')
    await wrapper.find('.bp-address-input').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.bp-address-input').element.value).toBe('http://localhost:3000/')
    expect(wrapper.find('[data-test="browser-address-error"]').exists()).toBe(false)
  })

  it('navigation and titles are written to the node; history enables Back', async () => {
    await mountPane()
    await ready()
    webview().canGoBack.mockReturnValue(true)
    fire('did-start-loading')
    await nextTick()
    expect(wrapper.find('[data-test="browser-reload"]').attributes('aria-label')).toBe('Stop')
    fire('did-navigate', { url: 'http://localhost:5173/' })
    await nextTick()
    expect(node.url).toBe('http://localhost:5173/')
    expect(node.title).toBe('localhost:5173')
    fire('page-title-updated', { title: 'Vite App' })
    fire('did-stop-loading')
    await nextTick()
    expect(node.title).toBe('Vite App')
    expect(wrapper.find('[data-test="browser-title"]').text()).toBe('Vite App')
    expect(wrapper.find('.bp-address-input').element.value).toBe('http://localhost:5173/')
    expect(wrapper.find('[data-test="browser-empty"]').exists()).toBe(false)
    const back = wrapper.find('[data-test="browser-back"]')
    expect(back.attributes('disabled')).toBeUndefined()
    await back.trigger('click')
    expect(webview().goBack).toHaveBeenCalled()
    fire('did-navigate-in-page', { url: 'http://localhost:5173/#/about', isMainFrame: true })
    await nextTick()
    expect(node.url).toBe('http://localhost:5173/#/about')
  })

  it('a failed load shows the failure overlay (aborts and frames ignored); Retry, Copy, Try HTTPS', async () => {
    await mountPane()
    await ready()
    fire('did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED', validatedURL: 'http://localhost:5173/', isMainFrame: true })
    fire('did-fail-load', { errorCode: -102, errorDescription: 'x', validatedURL: 'http://localhost:5173/', isMainFrame: false })
    await nextTick()
    expect(wrapper.find('[data-test="browser-failure"]').exists()).toBe(false)

    fire('did-fail-load', { errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: 'http://localhost:5173/', isMainFrame: true })
    await nextTick()
    const overlay = wrapper.find('[data-test="browser-failure"]')
    expect(overlay.exists()).toBe(true)
    expect(wrapper.find('[data-test="browser-failure-title"]').text()).toBe("Can't reach localhost:5173")
    expect(overlay.text()).toContain("We couldn't connect to your local server.")
    expect(overlay.text()).toContain('make sure the server is running')
    expect(wrapper.find('[data-test="browser-empty"]').exists()).toBe(false)
    expect(node.url).toBe('http://localhost:5173/')

    await wrapper.find('[data-test="browser-retry"]').trigger('click')
    expect(webview().loadURL).toHaveBeenLastCalledWith('http://localhost:5173/')
    await wrapper.find('[data-test="browser-copy"]').trigger('click')
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('http://localhost:5173/')
    expect(ctx.toast).toHaveBeenCalledWith('Copied the current page address.', expect.any(Object))
    await wrapper.find('[data-test="browser-open-external"]').trigger('click')
    expect(ctx.openExternal).toHaveBeenCalledWith('http://localhost:5173/')
    await wrapper.find('[data-test="browser-try-https"]').trigger('click')
    expect(webview().loadURL).toHaveBeenLastCalledWith('https://localhost:5173/')

    fire('did-navigate', { url: 'https://localhost:5173/' })
    await nextTick()
    expect(wrapper.find('[data-test="browser-failure"]').exists()).toBe(false)
  })

  it('a crashed page shows "Browser page stopped"; Retry reloads it', async () => {
    await mountPane('https://example.com/')
    await ready()
    fire('render-process-gone', { details: { reason: 'crashed' } })
    await nextTick()
    expect(wrapper.find('[data-test="browser-failure-title"]').text()).toBe('Browser page stopped')
    expect(wrapper.text()).toContain('The browser page stopped unexpectedly. Retry to restore it.')
    expect(wrapper.find('[data-test="browser-copy"]').exists()).toBe(false)
    await wrapper.find('[data-test="browser-retry"]').trigger('click')
    expect(webview().reload).toHaveBeenCalled()
  })

  it('the ports popover lists the ports; a click opens one in this pane', async () => {
    ports = [
      { id: 'p1', url: 'http://localhost:5173/', port: 5173, processName: 'node.exe', label: 'web' },
      { id: 'p2', url: 'http://localhost:8080/', port: 8080, processName: null, label: '' }
    ]
    await mountPane('https://example.com/')
    await ready()
    const btn = wrapper.find('[data-test="browser-ports"]')
    expect(btn.find('.bp-badge').text()).toBe('2')
    await btn.trigger('click')
    const rows = wrapper.findAll('[data-test="browser-port-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.bp-port-num').text()).toBe('5173')
    expect(rows[0].text()).toContain('node.exe')
    expect(rows[0].text()).toContain('localhost:5173')
    expect(rows[1].text()).toContain('Unknown process')
    await rows[1].trigger('click')
    expect(webview().loadURL).toHaveBeenCalledWith('http://localhost:8080/')
    expect(wrapper.find('[data-test="browser-ports-popover"]').exists()).toBe(false)
  })

  it('the ports popover says when there are none', async () => {
    await mountPane()
    await wrapper.find('[data-test="browser-ports"]').trigger('click')
    expect(wrapper.find('[data-test="browser-ports-popover"]').text()).toContain('No workspace ports detected')
  })

  it('events from the main process count only for this pane\'s page', async () => {
    await mountPane('https://example.com/')
    await ready()
    handlers.popup({ webContentsId: 7, url: 'https://other.test/' })
    handlers.permission({ webContentsId: 7, permission: 'media', origin: 'https://x.test' })
    expect(webview().loadURL).not.toHaveBeenCalled()
    expect(ctx.toast).not.toHaveBeenCalled()

    handlers.popup({ webContentsId: 42, url: 'https://popup.test/' })
    expect(webview().loadURL).toHaveBeenCalledWith('https://popup.test/')
    handlers.permission({ webContentsId: 42, permission: 'media', origin: 'https://x.test' })
    expect(ctx.toast).toHaveBeenLastCalledWith('https://x.test asked for camera or microphone access; Tessel denied it.', expect.any(Object))
    handlers.download({ webContentsId: 42, url: 'https://x.test/a.zip', name: 'a.zip' })
    const [text, opts] = ctx.toast.mock.calls.at(-1)
    expect(text).toBe('Tessel does not download files. Open a.zip in your default browser?')
    expect(opts.action.label).toBe('Open in default browser')
    opts.action.run()
    expect(ctx.openExternal).toHaveBeenCalledWith('https://x.test/a.zip')
    handlers.shortcut({ webContentsId: 42, action: 'devTools' })
    expect(api.openDevTools).toHaveBeenCalledWith(42)
    handlers.shortcut({ webContentsId: 42, action: 'zoomIn' })
    expect(node.zoom).toBe(0.5)
    expect(webview().setZoomLevel).toHaveBeenLastCalledWith(0.5)

    wrapper.unmount()
    wrapper = null
    expect(offs).toHaveLength(4)
    for (const off of offs) expect(off).toHaveBeenCalled()
  })

  it('keys in the pane: zoom with its badge, reload, focus the address', async () => {
    await mountPane('https://example.com/', { zoom: 1 })
    await ready()
    expect(webview().setZoomLevel).toHaveBeenCalledWith(1)
    const root = wrapper.find('.browser-pane')
    await root.trigger('keydown', { key: '=', ctrlKey: true })
    expect(node.zoom).toBe(1.5)
    expect(wrapper.find('[data-test="browser-zoom"]').classes()).toContain('shown')
    expect(wrapper.find('[data-test="browser-zoom"]').text()).toBe('131%')
    await root.trigger('keydown', { key: '0', ctrlKey: true })
    expect(node.zoom).toBe(0)
    await root.trigger('keydown', { key: 'r', ctrlKey: true })
    expect(webview().reload).toHaveBeenCalled()
    await root.trigger('keydown', { key: 'R', ctrlKey: true, shiftKey: true })
    expect(webview().reloadIgnoringCache).toHaveBeenCalled()
    await root.trigger('keydown', { key: 'l', ctrlKey: true })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('.bp-address-input').element)
  })

  it('the app can ask for the address bar or another page', async () => {
    await mountPane('https://example.com/')
    await ready()
    node.focusAddress++
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('.bp-address-input').element)
    node.url = 'http://localhost:4000/'
    await nextTick()
    expect(webview().loadURL).toHaveBeenCalledWith('http://localhost:4000/')
    node.url = 'file:///C:/secret.txt'
    await nextTick()
    expect(webview().loadURL).toHaveBeenCalledTimes(1)
  })

  it('Design Mode and the screenshot go to the Design Mode panel', async () => {
    await mountPane('https://example.com/')
    await ready()
    const panel = wrapper.find('.dm-stub')
    expect(panel.attributes('data-guest')).toBe('42')
    expect(panel.attributes('data-url')).toBe('https://example.com/')
    await wrapper.find('[data-test="browser-design"]').trigger('click')
    expect(design.toggle).toHaveBeenCalled()
    await wrapper.find('[data-test="browser-screenshot"]').trigger('click')
    expect(design.screenshot).toHaveBeenCalled()
    wrapper.findComponent({ name: 'DesignModePanel' }).vm.$emit('active', true)
    await nextTick()
    expect(wrapper.find('[data-test="browser-design"]').classes()).toContain('on')
  })

  it('the header maximizes, closes and moves the pane', async () => {
    await mountPane()
    const buttons = wrapper.findAll('.pane-nav-actions .pane-nav-btn')
    await buttons[0].trigger('click')
    expect(ctx.toggleMaximize).toHaveBeenCalledWith('b1')
    await buttons[1].trigger('click')
    expect(ctx.closeLeaf).toHaveBeenCalledWith('b1')
    const down = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(down, 'button', { value: 0 })
    wrapper.find('.pane-title').element.dispatchEvent(down)
    expect(ctx.beginPaneDrag).toHaveBeenCalled()
  })
})

describe('BrowserPane.vue: layout, input and browser behaviour', () => {
  let wrapper, ctx, api, node, handlers, prevApi

  function fakeWebview(el) {
    Object.assign(el, {
      loadURL: vi.fn(() => Promise.resolve()),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      stop: vi.fn(),
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true),
      getTitle: vi.fn(() => ''),
      getWebContentsId: vi.fn(() => 42),
      setZoomLevel: vi.fn(),
      focus: vi.fn(),
      findInPage: vi.fn(),
      stopFindInPage: vi.fn(),
      executeJavaScript: vi.fn(async () => [0, 640])
    })
    return el
  }
  const webview = () => wrapper.find('webview').element
  function fire(name, props = {}) {
    const ev = new Event(name)
    Object.assign(ev, props)
    webview().dispatchEvent(ev)
  }
  async function mountPane(url = 'https://example.com/', extra = {}) {
    node = reactive({ type: 'leaf', kind: 'browser', id: 'b1', num: 2, title: '', url, zoom: 0, focusAddress: 0, ...extra })
    wrapper = mount(BrowserPane, { props: { node }, attachTo: document.body, global: { provide: { panelCtx: ctx } } })
    fakeWebview(webview())
    fire('dom-ready')
    await nextTick()
  }
  const key = (target, k, mods = {}) => target.trigger('keydown', { key: k, ...mods })

  beforeEach(() => {
    handlers = {}
    const sub = (name) =>
      vi.fn((cb) => {
        handlers[name] = cb
        return vi.fn()
      })
    api = {
      onPopup: sub('popup'),
      onShortcut: sub('shortcut'),
      onPermissionDenied: sub('permission'),
      onDownloadBlocked: sub('download'),
      onAppCommand: sub('appCommand'),
      openDevTools: vi.fn()
    }
    prevApi = window.shellApi
    window.shellApi = { browser: api }
    ctx = {
      activeId: ref('b1'),
      maximizedId: ref(null),
      highlightId: ref(null),
      setActive: vi.fn(),
      closeLeaf: vi.fn(),
      toggleMaximize: vi.fn(),
      beginPaneDrag: vi.fn(),
      toast: vi.fn(),
      browserPorts: () => [],
      openBrowserPane: vi.fn()
    }
  })
  afterEach(() => {
    if (wrapper) wrapper.unmount()
    wrapper = null
    window.shellApi = prevApi
  })

  it('the page fills its area at any size: a flex item allowed to shrink, inline', async () => {
    await mountPane()
    const style = webview().style
    expect(style.display).toBe('flex')
    expect(style.flex).toBe('1 1 auto')
    expect(style.width).toBe('100%')
    expect(style.height).toBe('100%')
    expect(style.minWidth).toBe('0px')
    expect(style.minHeight).toBe('0px')
    expect(style.pointerEvents).toBe('')
    expect(webview().parentElement.classList.contains('bp-page')).toBe(true)
  })

  it("the pane's stylesheet: a flex column down to the page, nothing that scales it or takes its pointer", () => {
    const file = resolve(process.cwd(), 'src/renderer/src/components/BrowserPane.vue')
    const css = parseSfc(readFileSync(file, 'utf8')).descriptor.styles
      .map((b) => b.content)
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (sel) => {
      const m = css.match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))
      return m ? m[2] : ''
    }
    expect(rule('.bp-body')).toMatch(/display:\s*flex/)
    expect(rule('.bp-body')).toMatch(/flex-direction:\s*column/)
    expect(rule('.bp-body')).toMatch(/min-height:\s*0/)
    expect(rule('.bp-page')).toMatch(/display:\s*flex/)
    expect(rule('.bp-page')).toMatch(/flex:\s*1 1 auto/)
    expect(rule('.bp-page')).toMatch(/min-height:\s*0/)
    expect(rule('.bp-page')).toMatch(/min-width:\s*0/)
    expect(rule('.bp-webview')).toMatch(/flex:\s*1 1 auto/)
    // `:global(x) .bp-webview` compiles to a bare `x` (the whole window then
    // ignores the pointer): plain descendant selectors only.
    expect(css).not.toMatch(/:global\(/)
    expect(css).not.toMatch(/(^|[^-])zoom:|transform:\s*scale/)
  })

  // A narrow pane (found in a real window: a third of 1600 px): the badge
  // shrank to 12 px and its Stop sat over the Ports button. Only the agent's
  // name may shrink; the badge never gets narrower than its icon and Stop.
  it("the Agent badge keeps its Stop button in a narrow pane: only the name shrinks", () => {
    const file = resolve(process.cwd(), 'src/renderer/src/components/BrowserPane.vue')
    const css = parseSfc(readFileSync(file, 'utf8')).descriptor.styles
      .map((b) => b.content)
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = (sel) => {
      const m = css.match(new RegExp(`(^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))
      return m ? m[2] : ''
    }
    expect(rule('.bp-agent')).toMatch(/display:\s*grid/)
    expect(rule('.bp-agent')).toMatch(/grid-template-columns:\s*auto minmax\(0,\s*max-content\) auto/)
    expect(rule('.bp-agent')).toMatch(/min-width:\s*min-content/)
    expect(rule('.bp-agent-stop')).not.toMatch(/position:\s*absolute/)
  })

  // A <webview> is transparent: a page that sets no background (most simple
  // pages, forms, docs) showed black text on Tessel's dark pane. A browser
  // paints such a page on white.
  it('a page without its own background is painted on white, as in a browser', () => {
    const file = resolve(process.cwd(), 'src/renderer/src/components/BrowserPane.vue')
    const css = parseSfc(readFileSync(file, 'utf8')).descriptor.styles
      .map((b) => b.content)
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const m = css.match(/(^|\n)\.bp-webview\s*\{([^}]*)\}/)
    expect(m && m[2]).toMatch(/background:\s*#fff\b/)
  })

  it("Tessel's drags let the pointer through the page, and give it back when they end", async () => {
    await mountPane()
    const release = acquirePassthrough()
    expect(webview().style.pointerEvents).toBe('none')
    release()
    expect(webview().style.pointerEvents).toBe('')
    // Unmounted mid-drag: the next pane is not held.
    const r2 = acquirePassthrough()
    const el = webview()
    wrapper.unmount()
    wrapper = null
    expect(el.style.pointerEvents).toBe('')
    r2()
  })

  it('Ctrl+F opens find: typing searches, Enter/Shift+Enter go through the matches, Escape closes', async () => {
    vi.useFakeTimers()
    try {
      await mountPane()
      await key(wrapper.find('.browser-pane'), 'f', { ctrlKey: true })
      const bar = wrapper.find('[data-test="browser-find"]')
      expect(bar.exists()).toBe(true)
      const input = wrapper.find('[data-test="browser-find-input"]')
      expect(document.activeElement).toBe(input.element)
      await input.setValue('tessel')
      vi.advanceTimersByTime(250)
      expect(webview().findInPage).toHaveBeenLastCalledWith('tessel', { forward: true, findNext: true })
      fire('found-in-page', { result: { activeMatchOrdinal: 1, matches: 5 } })
      await nextTick()
      expect(wrapper.find('[data-test="browser-find-count"]').text()).toBe('1 of 5')
      await key(input, 'Enter')
      expect(webview().findInPage).toHaveBeenLastCalledWith('tessel', { forward: true, findNext: false })
      await key(input, 'Enter', { shiftKey: true })
      expect(webview().findInPage).toHaveBeenLastCalledWith('tessel', { forward: false, findNext: false })
      await key(input, 'Escape')
      expect(wrapper.find('[data-test="browser-find"]').exists()).toBe(false)
      expect(webview().stopFindInPage).toHaveBeenCalledWith('clearSelection')
      expect(webview().focus).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('find from the page (the main process) and a count with no match; a new page closes it', async () => {
    await mountPane()
    handlers.shortcut({ webContentsId: 42, action: 'find' })
    await nextTick()
    const input = wrapper.find('[data-test="browser-find-input"]')
    await input.setValue('zz')
    await key(input, 'Enter')
    fire('found-in-page', { result: { activeMatchOrdinal: 0, matches: 0 } })
    await nextTick()
    expect(wrapper.find('[data-test="browser-find-count"]').text()).toBe('No matches')
    fire('did-navigate', { url: 'https://example.com/next' })
    await nextTick()
    expect(wrapper.find('[data-test="browser-find"]').exists()).toBe(false)
  })

  it('no find on the blank page', async () => {
    await mountPane('about:blank')
    await key(wrapper.find('.browser-pane'), 'f', { ctrlKey: true })
    expect(wrapper.find('[data-test="browser-find"]').exists()).toBe(false)
  })

  it('Escape stops a page still loading, and is not the app\'s Escape then', async () => {
    await mountPane()
    fire('did-start-loading')
    await nextTick()
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const seen = vi.fn()
    document.body.addEventListener('keydown', seen)
    wrapper.find('.browser-pane').element.dispatchEvent(e)
    document.body.removeEventListener('keydown', seen)
    expect(webview().stop).toHaveBeenCalled()
    expect(seen).not.toHaveBeenCalled()
    // Loaded: Escape is the app's again.
    fire('did-stop-loading')
    await nextTick()
    webview().stop.mockClear()
    await key(wrapper.find('.browser-pane'), 'Escape')
    expect(webview().stop).not.toHaveBeenCalled()
  })

  it('reload, history and zoom keys act on the page, never on Tessel', async () => {
    await mountPane()
    const pane = wrapper.find('.browser-pane')
    for (const [k, mods, method] of [
      ['F5', {}, 'reload'],
      ['r', { ctrlKey: true }, 'reload'],
      ['ArrowLeft', { altKey: true }, 'goBack'],
      ['ArrowRight', { altKey: true }, 'goForward']
    ]) {
      const e = new KeyboardEvent('keydown', { key: k, ...mods, bubbles: true, cancelable: true })
      pane.element.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
      expect(webview()[method]).toHaveBeenCalled()
    }
    handlers.shortcut({ webContentsId: 42, action: 'zoomIn' })
    expect(node.zoom).toBe(0.5)
    expect(webview().setZoomLevel).toHaveBeenLastCalledWith(0.5)
  })

  it("the mouse's back/forward buttons go to the active browser pane only", async () => {
    await mountPane()
    handlers.appCommand({ action: 'back' })
    expect(webview().goBack).toHaveBeenCalledTimes(1)
    handlers.appCommand({ action: 'forward' })
    expect(webview().goForward).toHaveBeenCalledTimes(1)
    ctx.activeId.value = 'other'
    handlers.appCommand({ action: 'back' })
    handlers.appCommand({ action: 'reload' })
    expect(webview().goBack).toHaveBeenCalledTimes(1)
    expect(webview().reload).not.toHaveBeenCalled()
  })

  it('routes back and forward to only the last focused grid or side browser', async () => {
    const commands = new Set()
    api.onAppCommand = (cb) => { commands.add(cb); return () => commands.delete(cb) }
    const command = (action) => { for (const cb of commands) cb({ action }) }
    await mountPane()
    const grid = webview()
    const side = mount(SideBrowser, {
      props: { node: reactive({ id: 'web-test', url: 'https://example.com/' }), active: true },
      attachTo: document.body,
      global: { provide: { panelCtx: ctx } }
    })
    try {
      const page = fakeWebview(side.find('webview').element)
      page.dispatchEvent(new Event('dom-ready'))
      await side.find('.browser-pane').trigger('mousedown')
      command('back')
      expect(page.goBack).toHaveBeenCalledTimes(1)
      expect(grid.goBack).not.toHaveBeenCalled()

      // The grid's id never changed while the side browser was used.
      expect(ctx.activeId.value).toBe('b1')
      await wrapper.find('.browser-pane').trigger('mousedown')
      command('forward')
      expect(grid.goForward).toHaveBeenCalledTimes(1)
      expect(page.goForward).not.toHaveBeenCalled()

      page.dispatchEvent(new Event('focus'))
      command('forward')
      expect(page.goForward).toHaveBeenCalledTimes(1)
      expect(grid.goForward).toHaveBeenCalledTimes(1)

      await wrapper.find('.bp-address-input').trigger('focusin')
      command('back')
      expect(grid.goBack).toHaveBeenCalledTimes(1)
      expect(page.goBack).toHaveBeenCalledTimes(1)

      page.dispatchEvent(new Event('focus'))
      await side.setProps({ active: false })
      command('back')
      expect(grid.goBack).toHaveBeenCalledTimes(2)
      expect(page.goBack).toHaveBeenCalledTimes(1)

      await side.setProps({ active: true })
      side.unmount()
      command('forward')
      expect(grid.goForward).toHaveBeenCalledTimes(2)
      expect(page.goForward).toHaveBeenCalledTimes(1)
    } finally {
      side.unmount()
    }
  })

  it('a middle-click or Ctrl+click link opens a new pane next to this one (its scroll noted first); others stay here', async () => {
    await mountPane()
    handlers.popup({ webContentsId: 42, url: 'https://example.com/other', newPane: true })
    await flushPromises()
    expect(webview().executeJavaScript).toHaveBeenCalledWith('[window.scrollX, window.scrollY]', false)
    expect(node.scroll).toEqual({ url: 'https://example.com/', x: 0, y: 640 })
    expect(ctx.openBrowserPane).toHaveBeenCalledWith('https://example.com/other', { fromId: 'b1', activate: false })
    expect(webview().loadURL).not.toHaveBeenCalled()

    handlers.popup({ webContentsId: 42, url: 'javascript:alert(1)', newPane: true })
    await flushPromises()
    expect(ctx.openBrowserPane).toHaveBeenCalledTimes(1)

    handlers.popup({ webContentsId: 42, url: 'https://example.com/same' })
    await flushPromises()
    expect(webview().loadURL).toHaveBeenCalledWith('https://example.com/same')
    expect(ctx.openBrowserPane).toHaveBeenCalledTimes(1)
  })

  it('rebuilt (a split, a move): the same page comes back where it was scrolled', async () => {
    await mountPane('https://example.com/', { scroll: { url: 'https://example.com/', x: 0, y: 1200 } })
    fire('did-finish-load')
    await flushPromises()
    expect(webview().executeJavaScript).toHaveBeenCalledWith('window.scrollTo(0, 1200)', false)
    expect(node.scroll).toBe(null)
    // Once only.
    webview().executeJavaScript.mockClear()
    fire('did-finish-load')
    expect(webview().executeJavaScript).not.toHaveBeenCalled()
  })

  it('a scroll noted for another page, or odd numbers from the page, are not used as they are', async () => {
    await mountPane('https://example.com/', { scroll: { url: 'https://other.test/', x: 0, y: 1200 } })
    fire('did-finish-load')
    await flushPromises()
    expect(webview().executeJavaScript).not.toHaveBeenCalled()
    webview().executeJavaScript.mockResolvedValueOnce(['1e99', 'NaN'])
    fire('blur')
    await flushPromises()
    expect(node.scroll).toEqual({ url: 'https://example.com/', x: 10000000, y: 0 })
  })

  it('the keyboard or the pointer leaving the page notes its scroll', async () => {
    await mountPane()
    await wrapper.find('.bp-page').trigger('pointerleave')
    await flushPromises()
    expect(node.scroll).toEqual({ url: 'https://example.com/', x: 0, y: 640 })
  })
})

// A page in a tab of the side panel (SideBrowser.vue): the same pane, without
// its header; the grid's pane context is not touched.
describe('SideBrowser.vue', () => {
  let prevApi, popup
  beforeEach(() => {
    prevApi = window.shellApi
    popup = null
    window.shellApi = {
      browser: {
        onPopup: (cb) => {
          popup = cb
          return () => {}
        }
      }
    }
  })
  afterEach(() => {
    window.shellApi = prevApi
  })

  it('no pane header; its address bar has the keyboard; a link for a new pane opens a new side tab', async () => {
    const parent = { activeId: ref('p1'), setActive: vi.fn(), toggleMaximize: vi.fn(), closeLeaf: vi.fn(), openBrowserPane: vi.fn(), toast: vi.fn() }
    const node = reactive({ id: 'web-a1', url: '', title: '' })
    const w = mount(SideBrowser, { props: { node, active: true }, attachTo: document.body, global: { provide: { panelCtx: parent } } })
    const el = w.find('webview').element
    el.getWebContentsId = () => 7
    el.loadURL = vi.fn(() => Promise.resolve())
    el.canGoBack = () => false
    el.canGoForward = () => false
    el.setZoomLevel = () => {}
    await flushPromises()
    expect(w.find('[data-test="pane-header"]').exists()).toBe(false)
    expect(w.find('.browser-pane').classes()).toContain('in-side')
    expect(w.find('[data-test="browser-toolbar"]').exists()).toBe(true)
    expect(document.activeElement).toBe(w.find('.bp-address-input').element)
    el.dispatchEvent(new Event('dom-ready'))
    await nextTick()
    popup({ webContentsId: 7, url: 'https://example.com/x', newPane: true })
    await flushPromises()
    expect(w.emitted('open-tab')).toEqual([['https://example.com/x']])
    expect(parent.openBrowserPane).not.toHaveBeenCalled()
    await w.find('.browser-pane').trigger('mousedown')
    expect(parent.setActive).not.toHaveBeenCalled()
    w.unmount()
  })
})
