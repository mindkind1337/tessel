// A restored pane on an SSH host waiting for Connect (App.vue createLeaf):
// the pane says "<host> — not connected" with a Connect button; Enter in the
// pane connects too; nothing typed goes anywhere before that.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
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
    attachCustomWheelEventHandler() {}
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

describe('a remote pane waiting for Connect', () => {
  let wrapper, ctx, previousApi
  beforeEach(() => {
    previousApi = window.shellApi
    fixture.terminals.length = 0
    resetSettings()
    settings.gpuAcceleration = 'off'
    remoteHostsState.targets = [{ id: 'ssh-box', label: 'Box', host: 'box.example' }]
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    window.shellApi = { resizePty: vi.fn(), onData: () => () => {}, onExit: () => () => {} }
    ctx = {
      activeId: ref('elsewhere'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref(''),
      voiceLanguages: ref([]),
      teamById: () => null,
      trackOf: () => null,
      setActive: vi.fn(),
      routeInput: vi.fn(),
      connectLeaf: vi.fn()
    }
    wrapper = mount(TerminalPane, {
      props: {
        node: {
          id: 'pane-r1',
          type: 'leaf',
          kind: 'shell',
          title: 'Box',
          remoteHostId: 'ssh-box',
          restoredText: 'last output',
          notConnected: { cwd: null, resume: true }
        }
      },
      global: { provide: { panelCtx: ctx } }
    })
  })
  afterEach(() => {
    wrapper?.unmount()
    resetSettings()
    remoteHostsState.targets = []
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  it('says the host is not connected and shows its saved output', () => {
    expect(wrapper.get('[data-test="remote-connect-overlay"]').text()).toContain('Box — not connected')
    expect(fixture.terminals[0].written.join('')).toContain('last output')
  })

  it('Connect connects it', async () => {
    await wrapper.get('[data-test="remote-connect"]').trigger('click')
    expect(ctx.connectLeaf).toHaveBeenCalledWith('pane-r1')
  })

  it('Enter in the pane connects it; other keys go nowhere', () => {
    const term = fixture.terminals[0]
    term.typed('ls')
    expect(ctx.connectLeaf).not.toHaveBeenCalled()
    expect(ctx.routeInput).not.toHaveBeenCalled()
    term.typed('\r')
    expect(ctx.connectLeaf).toHaveBeenCalledWith('pane-r1')
    expect(ctx.routeInput).not.toHaveBeenCalled()
  })
})
