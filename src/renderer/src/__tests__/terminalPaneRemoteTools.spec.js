// An agent on an SSH host without Tessel's tools (App.vue noteRemoteToolsMissing):
// its pane says why, with Retry (a restart of the pane) and Close.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { remoteHostsState } from '../remoteHosts'

const fixture = vi.hoisted(() => ({ terminals: [] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 80
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = {
        active: {
          baseY: 0,
          viewportY: 0,
          cursorY: 0,
          cursorX: 0,
          length: 24,
          getLine: () => ({ isWrapped: false, translateToString: () => '', getCell: () => ({ getChars: () => '', isDim: () => false }) })
        }
      }
      this.written = []
      fixture.terminals.push(this)
    }
    write(data, callback) {
      this.written.push(data)
      callback?.()
    }
    open(host) {
      this.textarea = document.createElement('textarea')
      host.append(this.textarea)
    }
    loadAddon() {}
    registerLinkProvider() {}
    onScroll() {}
    onWriteParsed() {}
    onData(cb) {
      this.typed = cb
    }
    onResize() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    focus() {}
    dispose() {}
    scrollToBottom() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 }
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    onDidChangeResults() {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

describe('a pane whose agent on an SSH host has no Tessel tools', () => {
  let wrapper, ctx, previousApi
  function mountPane(extra = {}) {
    wrapper = mount(TerminalPane, {
      props: { node: reactive({ id: 'pane-t1', type: 'leaf', kind: 'agent', agentId: 'claude', agentCommand: 'claude', title: 'Claude Code', remoteHostId: 'ssh-box', ...extra }) },
      global: { provide: { panelCtx: ctx } }
    })
    return wrapper
  }
  beforeEach(() => {
    previousApi = window.shellApi
    fixture.terminals.length = 0
    resetSettings()
    settings.gpuAcceleration = 'off'
    remoteHostsState.targets = [{ id: 'ssh-box', label: 'Box', host: 'box.example' }]
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    window.shellApi = { resizePty: vi.fn(), onData: () => () => {}, onExit: () => () => {} }
    ctx = {
      activeId: ref('elsewhere'), broadcast: ref(false), maximizedId: ref(null), highlightId: ref(null),
      voiceName: ref('English'), voiceLabel: ref(''), voiceLanguages: ref([]),
      teamById: () => null, trackOf: () => null, setActive: vi.fn(), routeInput: vi.fn(), restartLeaf: vi.fn()
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    resetSettings()
    remoteHostsState.targets = []
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  it('shows the reason, and Retry restarts the pane', async () => {
    mountPane({ remoteToolsNote: 'Tessel tools are not connected on Box: Node.js was not found.' })
    expect(wrapper.get('[data-test="remote-tools-note"]').text()).toContain('Tessel tools are not connected on Box: Node.js was not found.')
    await wrapper.get('[data-test="remote-tools-retry"]').trigger('click')
    expect(ctx.restartLeaf).toHaveBeenCalledWith('pane-t1')
    expect(wrapper.find('[data-test="remote-tools-note"]').exists()).toBe(false)
  })

  it('Close hides it without restarting', async () => {
    mountPane({ remoteToolsNote: 'Tessel tools are not connected on Box: x.' })
    await wrapper.get('[data-test="remote-tools-close"]').trigger('click')
    expect(ctx.restartLeaf).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="remote-tools-note"]').exists()).toBe(false)
  })

  it('none without a note', () => {
    mountPane()
    expect(wrapper.find('[data-test="remote-tools-note"]').exists()).toBe(false)
  })
})
