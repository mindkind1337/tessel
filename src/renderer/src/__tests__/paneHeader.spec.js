// The terminal pane's header (TerminalPane.vue), like Orca's: its status, icon,
// title and at most one state badge; the rest (model, branch, team, Yolo,
// the other states, the voice language, a new pane next to it) is in the
// pane's menu, which opens in the page's top layer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { setApproval, clearAgentStatus, applyAgentStates } from '../agentStatus'
import { resetSettings, settings } from '../settings'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 80
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = {
        active: { baseY: 0, viewportY: 0, length: 1, getLine: () => ({ isWrapped: false, translateToString: () => '' }) }
      }
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
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 }
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import { Terminal } from '@xterm/xterm'
import TerminalPane from '../components/TerminalPane.vue'
import ChatPane from '../components/chat/ChatPane.vue'

describe('terminal pane header', () => {
  let wrapper, ctx, previousApi, host
  const node = () => ({
    id: 'hp',
    num: 3,
    kind: 'agent',
    type: 'leaf',
    title: 'Claude',
    shellName: 'Claude Code',
    agentId: 'claude',
    sessionOptions: { model: 'opus' },
    modelChoice: { model: 'opus' },
    launchYolo: true,
    team: 't1',
    worktree: { branch: 'feat/header', path: 'C:\\copies\\header' }
  })
  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    window.shellApi = {
      resizePty: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      agentModel: vi.fn(async () => null)
    }
    ctx = {
      activeId: ref('hp'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('Français'),
      voiceLabel: ref('FR'),
      voiceLanguages: ref([{ tip: 'fr-tip', tag: 'fr-CA', name: 'Français' }, { tip: 'en-tip', tag: 'en-US', name: 'English' }]),
      voiceTyping: vi.fn(),
      voiceTypingIn: vi.fn(),
      notifyAgentDone: vi.fn(),
      notifyAgentLimit: vi.fn(),
      teamById: (id) => (id === 't1' ? { id: 't1', name: 'Blue', color: '#48f', leadId: 'hp' } : null),
      trackOf: () => ({ level: 'warn', minutes: 12, reason: 'Nothing new for 12 min' }),
      unsent: { hp: true },
      resolveUnsent: vi.fn(),
      otherPanes: () => [],
      openLauncherAt: vi.fn(),
      setActive: vi.fn(),
      toggleMaximize: vi.fn(),
      closeLeaf: vi.fn()
    }
    host = document.createElement('div')
    document.body.append(host)
    wrapper = mount(TerminalPane, { props: { node: node() }, attachTo: host, global: { provide: { panelCtx: ctx } } })
  })
  afterEach(() => {
    wrapper.unmount()
    host.remove()
    clearAgentStatus('hp')
    resetSettings()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  const header = () => wrapper.get('[data-test="pane-header"]')
  const menu = () => document.body.querySelector(':scope > .ctx-menu')

  it('terminal and chat header menus have the same sections and action order', async () => {
    ctx.unsent = {}
    ctx.trackOf = () => null
    ctx.paneFolder = () => 'C:/project'
    ctx.switchToChat = vi.fn()
    ctx.switchToTerminal = vi.fn()
    ctx.chatSetOption = vi.fn()
    ctx.chatPermissions = () => 'yolo'
    window.shellApi.chat = { history: async () => ({ ok: true, open: true, events: [], live: { status: 'idle' } }), onEvent: () => () => {} }
    wrapper.unmount()
    wrapper = mount(TerminalPane, { props: { node: { ...node(), sessionId: 'session-1', agentCommand: 'claude' } }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    await header().get('[data-test="pane-menu-btn"]').trigger('click')
    await flushPromises()
    const entries = element => [...element.children].filter(child => child.matches('.ctx-menu-item,.ctx-menu-sep,.ctx-menu-chips,.ctx-menu-facts')).map(child => {
      if (!child.matches('.ctx-menu-item')) return child.className
      const clone = child.cloneNode(true)
      clone.querySelectorAll('.ctx-menu-shortcut').forEach(shortcut => shortcut.remove())
      // The same entry: a chat pane goes on in a terminal; a terminal agent's
      // pane shows its chat view (nothing restarts).
      return clone.textContent.trim().replace('Continue in a terminal', 'Open as chat').replace('Switch to chat view', 'Open as chat')
    })
    const terminalEntries = entries(menu())
    const chat = mount(ChatPane, {
      props: { node: { ...node(), kind: 'chat', sessionId: 'session-1', projectDir: 'C:/project' } },
      attachTo: document.body,
      global: { provide: { panelCtx: ctx }, stubs: { NativeChatView: true } }
    })
    try {
      await flushPromises()
      await chat.get('[data-test="chat-more"]').trigger('click')
      await flushPromises()
      const chatMenu = document.querySelector('[data-test="chat-header-menu"]')
      expect(entries(chatMenu)).toEqual(terminalEntries)
      for (const label of ['Copy output', 'Clear', 'Reset Terminal', 'Find', 'Restart asking first']) {
        const button = [...chatMenu.querySelectorAll('button')].find(el => el.textContent.includes(label))
        expect(button.disabled, label).toBe(true)
        expect(button.title, label).not.toBe('')
      }
    } finally { chat.unmount() }
  })

  it('Reset Terminal clears leftover input modes in the pane and the host, without writing to the program', async () => {
    const write = vi.spyOn(Terminal.prototype, 'write')
    window.shellApi.resetPtyModes = vi.fn()
    window.shellApi.writePty = vi.fn()
    try {
      await header().get('[data-test="pane-menu-btn"]').trigger('click')
      await flushPromises()
      menu().querySelector('[data-test="menu-reset-terminal"]').click()
      await flushPromises()
      const written = write.mock.calls.map(([data]) => data).join('')
      for (const mode of ['[?1000l', '[?1006l', '[?2004l', '[?1l', '[?1049l', '[?1004l']) expect(written).toContain(mode)
      expect(window.shellApi.resetPtyModes).toHaveBeenCalledWith('hp')
      expect(window.shellApi.writePty).not.toHaveBeenCalled()
      expect(menu()).toBeNull()
    } finally { write.mockRestore() }
  })

  it('shows its name, program and no number', async () => {
    await wrapper.setProps({ node: { ...node(), paneName: 'Bohr', num: 17 } })
    expect(wrapper.get('[data-test="pane-title"]').text()).toBe('Bohr')
    expect(wrapper.find('.pane-agent-label').exists()).toBe(false)
    expect(wrapper.find('.pane-num').exists()).toBe(false)
  })

  it('a model chosen by its family name shows the version the agent reports (Opus 5.5)', async () => {
    wrapper.unmount()
    window.shellApi.agentModel = vi.fn(async () => ({ model: 'claude-opus-5-5', effort: null, source: 'session' }))
    wrapper = mount(TerminalPane, { props: { node: node() }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    await flushPromises()
    expect(header().get('[data-test="pane-model-chip"]').text()).toBe('Opus 5.5')
  })

  it('shows only the status, icon, title and one badge', async () => {
    await flushPromises()
    const h = header()
    expect(h.get('.pane-title').text()).toBe('Claude')
    expect(h.find('.pane-icon .pane-status-dot').exists()).toBe(true)
    // Branch, team and Yolo are no longer in the header.
    for (const gone of ['.pane-model', '.pane-branch', '.pane-team', '[data-test="pane-yolo"]', '.mic-lang', '.mic-caret'])
      expect(h.find(gone).exists(), gone).toBe(false)
    expect(h.text()).not.toContain('feat/header')
    expect(h.text()).not.toContain('Blue')
    // The model it uses: one dim chip after the name (a click opens the picker).
    expect(h.get('[data-test="pane-model-chip"]').text()).toBe('Opus 5.5') // the alias shows its newest version until the agent reports one
    expect(h.text()).not.toContain('FR')
    // Several states at once (a message not confirmed, quiet 12 min,
    // unknown): one badge, the most urgent.
    expect(h.findAll('[data-test="pane-badge"]')).toHaveLength(1)
    expect(h.get('[data-test="pane-badge"]').text()).toBe('not confirmed')
    await h.get('[data-test="pane-badge"]').trigger('click')
    expect(ctx.resolveUnsent).toHaveBeenCalledWith('hp')
    setApproval('hp', true)
    await nextTick()
    expect(h.findAll('[data-test="pane-badge"]')).toHaveLength(1)
    expect(h.get('[data-test="pane-badge"]').text()).toBe('approve?')
    // No pane-wide "Drag to move this pane" tooltip over the header (it
    // showed through other panes' popovers); the title's hover card and its description say it.
    expect(h.attributes('title')).toBeUndefined()
    expect(h.get('.pane-title').attributes('title')).toBeUndefined()
    expect(h.get('.pane-title').attributes('aria-description')).toContain('Drag the header to move the pane')
    expect(h.get('.pane-title').attributes('aria-description')).toContain('Branch: feat/header')
    // Actions: voice (icon only), …, maximize, close. "+" is in the menu.
    const actions = h.findAll('.pane-nav-actions > button').map((b) => b.attributes('aria-label'))
    // A Claude Code agent's pane: its chat view toggle first.
    expect(actions).toEqual(['Show chat view', 'Voice typing (Français)', 'More options', 'Maximize pane', 'Close pane'])
  })

  it('the chat view shows over the terminal and goes away again: nothing stopped, nothing started', async () => {
    ctx.unsent = {}
    ctx.trackOf = () => null
    ctx.switchToChat = vi.fn()
    ctx.restartLeaf = vi.fn()
    window.shellApi.killPty = vi.fn()
    window.shellApi.writePty = vi.fn()
    window.shellApi.transcriptView = { open: vi.fn(async () => ({ ok: false, code: 'missing' })), close: vi.fn(), onEvent: () => () => {} }
    const n = reactive({ ...node(), sessionId: '22222222-3333-4444-8555-666666666666', accountId: null })
    wrapper.unmount()
    wrapper = mount(TerminalPane, { props: { node: n }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    await header().get('[data-test="pane-chat-toggle"]').trigger('click')
    await flushPromises()
    expect(n.chatView).toBe(true)
    expect(wrapper.find('[data-test="terminal-chat-view"]').exists()).toBe(true)
    expect(window.shellApi.transcriptView.open).toHaveBeenCalledWith({ agent: 'claude', sessionId: n.sessionId, paneId: 'hp', accountId: null })
    expect(header().get('[data-test="pane-chat-toggle"]').attributes('aria-label')).toBe('Show terminal')
    // The pane menu says the same, and switches back.
    await header().get('[data-test="pane-menu-btn"]').trigger('click')
    await flushPromises()
    const item = document.body.querySelector('[data-test="menu-open-as-chat"]')
    expect(item.textContent).toContain('Switch to terminal view')
    item.click()
    await flushPromises()
    expect(n.chatView).toBeFalsy()
    expect(wrapper.find('[data-test="terminal-chat-view"]').exists()).toBe(false)
    expect(ctx.switchToChat).not.toHaveBeenCalled()
    expect(ctx.restartLeaf).not.toHaveBeenCalled()
    expect(window.shellApi.killPty).not.toHaveBeenCalled()
    expect(window.shellApi.writePty).not.toHaveBeenCalled()
  })

  it('an agent found in a shell has no chat view (one on an SSH host has, read on the host); OpenCode keeps its chat pane', async () => {
    ctx.unsent = {}
    ctx.trackOf = () => null
    for (const extra of [{ detected: true }]) {
      wrapper.unmount()
      wrapper = mount(TerminalPane, { props: { node: { ...node(), ...extra } }, attachTo: host, global: { provide: { panelCtx: ctx } } })
      expect(wrapper.find('[data-test="pane-chat-toggle"]').exists(), JSON.stringify(extra)).toBe(false)
    }
    // OpenCode: its button opens its own chat pane, once its conversation is known.
    ctx.switchToChat = vi.fn()
    wrapper.unmount()
    wrapper = mount(TerminalPane, { props: { node: { ...node(), agentId: 'opencode' } }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    expect(wrapper.find('[data-test="pane-chat-toggle"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
    wrapper = mount(TerminalPane, { props: { node: { ...node(), agentId: 'opencode', sessionId: 'ses_' + 'a'.repeat(26) } }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    await wrapper.find('[data-test="pane-chat-toggle"]').trigger('click')
    expect(ctx.switchToChat).toHaveBeenCalledWith(node().id)
    delete ctx.switchToChat
  })

  it('an agent whose turn ended while its background work runs: monitoring dot and badge, then idle', async () => {
    ctx.unsent = {}
    ctx.trackOf = () => null
    wrapper.unmount()
    wrapper = mount(TerminalPane, { props: { node: { ...node(), agentLaunchToken: 'launch-hp' } }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    const published = (extra = {}) => ({
      hp: { paneId: 'hp', provider: 'claude', launchToken: 'launch-hp', sessionId: 's-1', state: 'idle', reason: 'ready', source: 'screen', since: 1, observedAt: 1, hookSeen: true, confirmed: true, stale: false, children: [], childrenTruncated: false, ...extra }
    })
    applyAgentStates(published({ monitoring: true, backgroundTasks: 2 }))
    await flushPromises()
    const h = header()
    expect(h.get('.pane-icon').classes()).toContain('monitoring')
    expect(h.get('[data-test="pane-badge"]').text()).toBe('monitoring')
    applyAgentStates(published())
    await flushPromises()
    expect(h.get('.pane-icon').classes()).not.toContain('monitoring')
    expect(h.find('[data-test="pane-badge"]').exists()).toBe(false)
  })

  it('the … menu opens in <body> and holds what the header no longer shows', async () => {
    await flushPromises()
    await header().get('[data-test="pane-menu-btn"]').trigger('click')
    await nextTick()
    const m = menu()
    expect(m).not.toBeNull()
    expect(host.contains(m)).toBe(false)
    const text = m.textContent
    expect(m.querySelector('[data-test="pane-branch"]').textContent).toContain('feat/header')
    expect(m.querySelector('[data-test="pane-team"]').textContent).toContain('Blue · lead')
    expect(m.querySelector('[data-test="pane-yolo"]').textContent).toContain('Yolo')
    expect(m.querySelector('[data-test="pane-stuck"]').textContent).toContain('12 min')
    expect(m.querySelector('[data-test="pane-model"]').textContent).toContain('Opus')
    expect(text).toContain('Open terminal or agent here…')
    // The states the badge did not show stay reachable.
    m.querySelector('[data-test="menu-unsent"]').click()
    expect(ctx.resolveUnsent).toHaveBeenCalledWith('hp')
    await nextTick()
    expect(menu()).toBeNull()
    // The voice language, picked from the menu.
    await header().get('[data-test="pane-menu-btn"]').trigger('click')
    await nextTick()
    const chips = [...menu().querySelectorAll('[data-test="pane-voice-langs"] .ctx-chip')]
    expect(chips.map((c) => c.textContent.trim())).toEqual(['FR', 'EN', '⌨'])
    chips[1].click()
    expect(ctx.voiceTypingIn).toHaveBeenCalledWith('hp', 'en-tip')
    await nextTick()
    await header().get('[data-test="pane-menu-btn"]').trigger('click')
    await nextTick()
    ;[...menu().querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.includes('Open terminal or agent here')).click()
    expect(ctx.openLauncherAt).toHaveBeenCalledWith(expect.any(Object), 'hp')
  })
})
