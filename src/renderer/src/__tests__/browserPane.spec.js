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
    expect(wrapper.find('.pane-nav .pane-num').text()).toBe('2')
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
