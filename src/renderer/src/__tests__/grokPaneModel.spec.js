// A Grok Build pane: the model and effort the main process reads (its session
// summary, its flags, its settings: agentModelSources.js) show in the pane's
// header, go to the team roster (paneModels) and into the sender identity
// recorded with the team messages it sends; its sign-in's tier shows on its
// account chip ("name · SuperGrok"), a Free sign-in as "No subscription".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { resetModelListsForTests } from '../agentModels'
import { paneModels } from '../paneModels'
import { buildSenderSnapshot, senderSummary, senderDetails } from '../senderIdentity'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 6
      this.cols = 140
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      const line = () => ({ isWrapped: false, translateToString: () => '' })
      this.buffer = { active: { baseY: 0, viewportY: 0, get length() { return 6 }, getLine: (y) => (y >= 0 && y < 6 ? line(y) : undefined) } }
    }
    write() {}
    open(host) {
      this.textarea = document.createElement('textarea')
      host.append(this.textarea)
    }
    loadAddon() {}
    registerLinkProvider() {}
    onScroll() {}
    onWriteParsed() {}
    onData() {}
    onResize() {}
    onSelectionChange() {}
    attachCustomKeyEventHandler() {}
    getSelection() {
      return ''
    }
    focus() {}
    dispose() {}
    scrollToBottom() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return { cols: 140, rows: 6 } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

import { resetGrokSignInForTests } from '../grokPlan'

describe('a Grok Build pane: detected model and effort, and its tier', () => {
  let wrapper, host, previousApi
  const node = () => ({ id: 'grok1', num: 4, kind: 'agent', type: 'leaf', title: 'Hopper', paneName: 'Hopper', agentId: 'grok', agentCommand: 'grok', sessionId: '01a1528f-1df9-7b12-a61e-74c0ee13bbbf', team: 't1' })
  const ctx = () => ({
    activeId: ref('grok1'),
    broadcast: ref(false),
    maximizedId: ref(null),
    highlightId: ref(null),
    voiceName: ref(''),
    voiceLabel: ref(''),
    voiceLanguages: ref([]),
    voiceTyping: vi.fn(),
    voiceTypingIn: vi.fn(),
    notifyAgentDone: vi.fn(),
    notifyAgentLimit: vi.fn(),
    teamById: () => null,
    trackOf: () => null,
    unsent: {},
    resolveUnsent: vi.fn(),
    otherPanes: () => [],
    openLauncherAt: vi.fn(),
    setActive: vi.fn(),
    toggleMaximize: vi.fn(),
    closeLeaf: vi.fn()
  })
  const mountPane = (agentModel, grok) => {
    const n = node()
    window.shellApi = {
      resizePty: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      agentModel: vi.fn(agentModel),
      onAgentModelChanged: () => () => {},
      providerSettings: { status: vi.fn(async () => ({ ok: true, grok })) }
    }
    host = document.createElement('div')
    document.body.append(host)
    wrapper = mount(TerminalPane, { props: { node: n }, attachTo: host, global: { provide: { panelCtx: ctx() } } })
    return n
  }

  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    resetModelListsForTests()
    resetGrokSignInForTests()
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  })
  afterEach(() => {
    if (wrapper) wrapper.unmount()
    if (host) host.remove()
    wrapper = null
    resetModelListsForTests()
    resetSettings()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  it('its session’s model and effort: the header, the team roster and the sender identity of its team messages', async () => {
    const n = mountPane(async () => ({ model: 'grok-4.7', name: 'Grok 4.7', effort: 'high', source: 'session' }), null)
    await flushPromises()
    expect(window.shellApi.agentModel).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'grok', sessionId: n.sessionId }))
    expect(wrapper.get('[data-test="pane-header"]').text()).toContain('Grok 4.7 · High')
    expect(paneModels.grok1).toBe('Grok 4.7 · High')
    const sender = buildSenderSnapshot(n, { agentName: 'Grok Build', model: paneModels[n.id] || '', teamId: 't1' })
    expect(sender).toMatchObject({ agentId: 'grok', model: 'Grok 4.7 · High', sessionId: n.sessionId })
    expect(senderSummary(sender)).toContain('Grok 4.7')
    expect(senderDetails(sender)).toContain('Grok 4.7 · High')
  })

  it('its account chip names the sign-in and its tier; a Free sign-in says No subscription', async () => {
    mountPane(async () => null, { signedIn: true, email: 'ada@example.com', tokenFresh: true, planType: 'SuperGrok', plan: { label: 'SuperGrok', tier: 'supergrok', paid: true, kind: 'subscription', source: 'cli', checkedAt: Date.now(), attention: false } })
    await flushPromises()
    const chip = wrapper.get('[data-test="pane-account-chip"]')
    expect(chip.text()).toContain('SuperGrok')
    expect(chip.classes()).not.toContain('warn')
    wrapper.unmount()
    host.remove()
    resetGrokSignInForTests()
    mountPane(async () => null, { signedIn: true, email: 'ada@example.com', tokenFresh: true, planType: 'Free', plan: { label: 'Free', tier: 'free', paid: false, kind: 'subscription', source: 'live', checkedAt: Date.now(), attention: true } })
    await flushPromises()
    const warn = wrapper.get('[data-test="pane-account-chip"]')
    expect(warn.text()).toContain('No subscription')
    expect(warn.classes()).toContain('warn')
  })
})
