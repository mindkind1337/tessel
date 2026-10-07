// An agent missing on its SSH host (App.vue createLeaf): the pane's
// terminal area shows a card (TerminalPane) with the agent's icon, "<Agent>
// is not installed on <host>.", Install, Check again, Open a shell instead.
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

describe("a pane whose agent is not installed on its SSH host", () => {
  let wrapper, ctx, previousApi
  function mountPane(agentMissing) {
    wrapper = mount(TerminalPane, {
      props: {
        node: {
          id: 'pane-m1',
          type: 'leaf',
          kind: 'agent',
          agentId: 'codex',
          agentCommand: 'codex',
          title: 'Codex CLI',
          remoteHostId: 'ssh-box',
          sessionId: 's-1',
          agentMissing
        }
      },
      global: { provide: { panelCtx: ctx } }
    })
    return wrapper
  }
  beforeEach(() => {
    previousApi = window.shellApi
    fixture.terminals.length = 0
    resetSettings()
    settings.gpuAcceleration = 'off'
    remoteHostsState.targets = [{ id: 'ssh-box', label: 'fivem-afterlife', host: 'box.example' }]
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
      connectLeaf: vi.fn(),
      installMissingAgent: vi.fn(),
      recheckMissingAgent: vi.fn(),
      missingAgentShell: vi.fn()
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    resetSettings()
    remoteHostsState.targets = []
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  it('shows the card: the agent icon, "<Agent> is not installed on <host>." and its three buttons', () => {
    mountPane({ agent: 'codex', name: 'Codex CLI', resume: true })
    const card = wrapper.get('[data-test="missing-agent-card"]')
    expect(card.find('.brand-icon').exists()).toBe(true)
    expect(wrapper.get('[data-test="missing-agent-text"]').text()).toBe('Codex CLI is not installed on fivem-afterlife.')
    expect(wrapper.get('[data-test="missing-agent-install"]').text()).toBe('Install Codex CLI')
    expect(wrapper.get('[data-test="missing-agent-check"]').text()).toBe('Check again')
    expect(wrapper.get('[data-test="missing-agent-shell"]').text()).toBe('Open a shell instead')
    // Not the "not connected" placeholder, nor an exited pane.
    expect(wrapper.find('[data-test="remote-connect-overlay"]').exists()).toBe(false)
  })

  it("Install, Check again and Open a shell instead call the pane's actions", async () => {
    mountPane({ agent: 'codex', name: 'Codex CLI', resume: true })
    await wrapper.get('[data-test="missing-agent-install"]').trigger('click')
    expect(ctx.installMissingAgent).toHaveBeenCalledWith('pane-m1')
    await wrapper.get('[data-test="missing-agent-check"]').trigger('click')
    expect(ctx.recheckMissingAgent).toHaveBeenCalledWith('pane-m1')
    await wrapper.get('[data-test="missing-agent-shell"]').trigger('click')
    expect(ctx.missingAgentShell).toHaveBeenCalledWith('pane-m1')
  })

  it('while checking or installing: said, and not asked twice', async () => {
    mountPane({ agent: 'codex', name: 'Codex CLI', checking: true, installing: 'pane-i1' })
    expect(wrapper.get('[data-test="missing-agent-check"]').text()).toBe('Checking…')
    expect(wrapper.get('[data-test="missing-agent-check"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="missing-agent-install"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="missing-agent-installing"]').exists()).toBe(true)
  })

  it('a check that did not find it says so', () => {
    mountPane({ agent: 'codex', name: 'Codex CLI', notFound: true })
    expect(wrapper.get('[data-test="missing-agent-not-found"]').text()).toBe('Still not found on the host.')
  })

  it('no card on a pane whose agent runs', () => {
    mountPane(undefined)
    expect(wrapper.find('[data-test="missing-agent-card"]').exists()).toBe(false)
  })
})
