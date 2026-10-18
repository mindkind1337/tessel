// Live Share, as a guest: a host's agent pane has the same chat button as on
// the host, labelled as the guest's own view. Clicking it only changes the
// guest's view (ctx.liveShareView): nothing typed into the host's terminal,
// nothing closed or restarted. The chat view is read only (the host's
// conversation, from main); a host whose Tessel does not share conversations
// is said so. A pane the host has in chat mode has no terminal: its terminal
// view says so, never a blank terminal. The header shows the host's agent
// (its icon, accent and name) without making the pane a local agent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, ref, nextTick } from 'vue'
import { resetSettings, settings } from '../settings'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = { ...options }
      this.rows = 24
      this.cols = 80
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = { active: { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, length: 1, getLine: () => ({ isWrapped: false, translateToString: () => '' }) } }
      const term = this
      this._core = { _renderService: { dimensions: { css: { get cell() { return { width: term.options.fontSize * 0.6, height: term.options.fontSize * 1.2 } } } } } }
    }
    write(_d, cb) {
      cb?.()
    }
    open(host) {
      this.textarea = document.createElement('textarea')
      this.element = document.createElement('div')
      host.append(this.textarea, this.element)
    }
    resize(cols, rows) {
      this.cols = cols
      this.rows = rows
    }
    loadAddon(addon) {
      addon.term = this
    }
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
    scrollToLine() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return { cols: 120, rows: 30 } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'
import LiveShareChatPane from '../components/LiveShareChatPane.vue'
import LiveShareReaders from '../components/LiveShareReaders.vue'
import NativeChatFileChip from '../components/chat/orca/NativeChatFileChip.vue'

const ChatViewStub = { name: 'NativeChatTranscriptView', props: ['source', 'readOnlyNote', 'backLabel', 'agent'], emits: ['close'], template: '<div data-test="chat-view-stub">{{ readOnlyNote }}</div>' }

describe('Live Share guest: the chat button of a host’s agent pane', () => {
  let wrapper, host, previousApi, ctx, api
  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    api = {
      resizePty: vi.fn(),
      writePty: vi.fn(),
      killPty: vi.fn(),
      restartPty: vi.fn(),
      onData: () => () => {},
      onExit: () => () => {},
      attachPty: vi.fn(async () => ({ ok: true, buffer: '', backend: 'liveshare', shell: { id: 'liveshare', name: 'Ada' } })),
      agentModel: vi.fn(async () => null),
      liveShare: { open: vi.fn(), leave: vi.fn(), chatWatch: vi.fn(async () => ({ ok: true, last: null })) }
    }
    window.shellApi = api
    host = document.createElement('div')
    document.body.append(host)
    ctx = {
      activeId: ref('pane-ls1-a'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref('EN'),
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
      closeLeaf: vi.fn(),
      routeInput: vi.fn(),
      restartLeaf: vi.fn(),
      switchToChat: vi.fn(),
      switchToTerminal: vi.fn(),
      liveShareView: vi.fn(),
      liveShareChatSource: vi.fn((id) => ({ id, open: vi.fn(), close: vi.fn(), onEvent: () => () => {} }))
    }
  })
  afterEach(() => {
    wrapper?.unmount()
    host.remove()
    resetSettings()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  const guestLeaf = (liveShare) =>
    reactive({ id: 'pane-ls1-a', type: 'leaf', kind: 'shell', title: 'Claude Code', backend: 'liveshare', attached: true, liveShare: { session: 1, cols: 120, rows: 30, canType: true, host: 'Ada', kind: 'agent', agentId: 'claude', terminal: true, ...liveShare } })
  async function show(node) {
    wrapper = mount(TerminalPane, { props: { node }, attachTo: host, global: { provide: { panelCtx: ctx }, stubs: { NativeChatTranscriptView: ChatViewStub } } })
    await flushPromises()
    return node
  }
  // What reaches the host's pane (typing, closing, restarting) or switches
  // the host's own mode.
  const reachedHost = () => [api.writePty, api.killPty, api.restartPty, api.liveShare.open, ctx.closeLeaf, ctx.restartLeaf, ctx.switchToChat, ctx.switchToTerminal].some((fn) => fn.mock.calls.length)

  it('shows the chat button, labelled as your own view; a click only changes your view', async () => {
    const node = await show(guestLeaf({ chat: 'shared', view: 'terminal' }))
    const btn = wrapper.find('[data-test="pane-chat-toggle"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toMatch(/^Your view: terminal\./)
    expect(btn.attributes('title')).toContain('Ada’s pane does not change')
    expect(btn.attributes('aria-pressed')).toBe('false')
    await btn.trigger('click')
    expect(ctx.liveShareView).toHaveBeenCalledWith('pane-ls1-a', 'chat')
    expect(reachedHost()).toBe(false)
    expect(api.liveShare.chatWatch).not.toHaveBeenCalled()

    // Its chat shown (main's setGuestView): the conversation, read only, over the terminal.
    node.liveShare.view = 'chat'
    await nextTick()
    await flushPromises()
    const view = wrapper.find('[data-test="liveshare-chat-view"]')
    expect(view.exists()).toBe(true)
    const stub = wrapper.findComponent(ChatViewStub)
    expect(stub.props('source')).toMatchObject({ id: 'pane-ls1-a' })
    expect(stub.text()).toContain('Read only')
    expect(wrapper.find('[data-test="pane-chat-toggle"]').attributes('aria-pressed')).toBe('true')
    await wrapper.find('[data-test="pane-chat-toggle"]').trigger('click')
    expect(ctx.liveShareView).toHaveBeenLastCalledWith('pane-ls1-a', 'terminal')
    // Its own "back to the terminal" too.
    stub.vm.$emit('close')
    expect(ctx.liveShareView).toHaveBeenLastCalledWith('pane-ls1-a', 'terminal')
    expect(reachedHost()).toBe(false)
  })

  it('no button on a host pane with no conversation (a shell)', async () => {
    await show(guestLeaf({ chat: null, kind: 'shell', agentId: null }))
    expect(wrapper.find('[data-test="pane-chat-toggle"]').exists()).toBe(false)
  })

  it('a host pane with no conversation to send: the button shows, off, with the reason as its tooltip', async () => {
    const node = await show(guestLeaf({ chat: 'unavailable', chatWhy: 'ssh', agentId: 'antigravity' }))
    const btn = wrapper.find('[data-test="pane-chat-toggle"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('This agent’s conversation can’t be read from the SSH server')
    await btn.trigger('click')
    expect(ctx.liveShareView).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="liveshare-chat-view"]').exists()).toBe(false)
    node.liveShare.chatWhy = 'agent'
    await nextTick()
    expect(wrapper.find('[data-test="pane-chat-toggle"]').attributes('title')).toBe('This agent’s conversation can’t be read by Tessel')
    node.liveShare.chatWhy = 'none'
    await nextTick()
    expect(wrapper.find('[data-test="pane-chat-toggle"]').attributes('title')).toContain('No conversation to show yet')
  })

  it('a host whose Tessel does not share conversations: the chat view says so, with the way back', async () => {
    await show(guestLeaf({ chat: 'old-host', view: 'chat' }))
    expect(wrapper.find('[data-test="pane-chat-toggle"]').exists()).toBe(true)
    const note = wrapper.find('[data-test="liveshare-chat-unavailable"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Ada’s Tessel does not share conversations yet')
    expect(wrapper.findComponent(ChatViewStub).exists()).toBe(false)
    await wrapper.find('[data-test="liveshare-chat-back"]').trigger('click')
    expect(ctx.liveShareView).toHaveBeenCalledWith('pane-ls1-a', 'terminal')
    expect(reachedHost()).toBe(false)
  })

  it('a pane the host has in chat mode: its terminal view says there is none, never a blank terminal', async () => {
    const node = reactive({ id: 'pane-ls1-c', type: 'leaf', kind: 'shell', title: 'Codex chat', backend: 'liveshare', liveShare: { session: 1, host: 'Ada', kind: 'agent', agentId: 'codex', terminal: false, chat: 'shared', view: 'terminal', canType: false } })
    wrapper = mount(LiveShareChatPane, { props: { node }, attachTo: host, global: { provide: { panelCtx: ctx }, stubs: { NativeChatTranscriptView: ChatViewStub } } })
    await flushPromises()
    const note = wrapper.find('[data-test="liveshare-no-terminal"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Ada has this pane in chat mode: it has no terminal to show.')
    expect(wrapper.find('.xterm, .term-host').exists()).toBe(false)
    expect(api.attachPty).not.toHaveBeenCalled()
    const btn = wrapper.find('[data-test="pane-chat-toggle"]')
    expect(btn.attributes('title')).toMatch(/^Your view: terminal\./)
    await wrapper.find('[data-test="liveshare-show-chat"]').trigger('click')
    expect(ctx.liveShareView).toHaveBeenCalledWith('pane-ls1-c', 'chat')
    node.liveShare.view = 'chat'
    await nextTick()
    expect(wrapper.find('[data-test="liveshare-no-terminal"]').exists()).toBe(false)
    expect(wrapper.findComponent(ChatViewStub).props('source')).toMatchObject({ id: 'pane-ls1-c' })
    await btn.trigger('click')
    expect(ctx.liveShareView).toHaveBeenLastCalledWith('pane-ls1-c', 'terminal')
    expect(reachedHost()).toBe(false)
  })

  it('a host’s agent pane shows the agent’s own icon, accent and name; display only, never a local agent', async () => {
    ctx.agents = ref([{ id: 'codex', name: 'Codex' }])
    const node = reactive({ id: 'pane-ls1-b', type: 'leaf', kind: 'shell', agentId: null, title: 'Brahe', accent: '#10a37f', shellId: 'liveshare', shellName: 'Ada', backend: 'liveshare', attached: true, liveShare: { session: 1, cols: 120, rows: 30, canType: true, host: 'Ada', kind: 'agent', agentId: 'codex', terminal: true, chat: 'shared', view: 'terminal' } })
    await show(node)
    const icon = wrapper.find('.pane-icon')
    expect(icon.classes()).toContain('agent')
    expect(icon.attributes('data-agent')).toBe('codex')
    expect(icon.attributes('aria-label')).toBe('Codex')
    expect(icon.attributes('style')).toContain('--accent: #10a37f')
    expect(wrapper.find('.pane-nav').classes()).toContain('agent')
    expect(wrapper.findComponent({ name: 'BrandIcon' }).props()).toMatchObject({ kind: 'codex', accent: '#10a37f', label: 'Brahe' })
    expect(wrapper.find('[data-test="pane-title"]').text()).toBe('Brahe')
    // Still the host's pane, not an agent of this computer: no state dot,
    // model, sub-agents or account here, nothing asked about it.
    expect(node.kind).toBe('shell')
    expect(node.agentId).toBe(null)
    expect(wrapper.find('.pane-status-dot').exists()).toBe(false)
    expect(wrapper.find('[data-test="pane-model-chip"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pane-account-chip"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'AgentChildren' }).exists()).toBe(false)
    expect(api.agentModel).not.toHaveBeenCalled()
    expect(reachedHost()).toBe(false)
  })

  it('a host’s shell pane keeps the terminal icon', async () => {
    await show(guestLeaf({ chat: null, kind: 'shell', agentId: null }))
    expect(wrapper.find('.pane-icon').classes()).not.toContain('agent')
    expect(wrapper.find('.pane-icon').attributes('data-agent')).toBeUndefined()
  })
})

describe('Live Share host: who reads a pane’s conversation', () => {
  it('the pane header shows the guests reading it now (their count, their names in its tooltip)', async () => {
    const readers = ref(['Alex'])
    const ctx = { liveShareReaders: vi.fn((id) => (id === 'pane-1' ? readers.value : [])) }
    const w = mount(LiveShareReaders, { props: { paneId: 'pane-1' }, global: { provide: { panelCtx: ctx } } })
    const badge = w.find('[data-test="pane-liveshare-readers"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('1')
    expect(badge.attributes('title')).toBe('Reading this conversation in Live Share: Alex')
    readers.value = ['Alex', 'Bea']
    await nextTick()
    expect(w.find('[data-test="pane-liveshare-readers"]').text()).toBe('2')
    readers.value = []
    await nextTick()
    expect(w.find('[data-test="pane-liveshare-readers"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('a conversation from another computer: its files never open here', () => {
  it('a file chip opens only for this computer’s conversations', () => {
    const prev = window.shellApi
    window.shellApi = { openFile: vi.fn() }
    try {
      const block = { path: 'C:/Users/ada/notes.txt', name: 'notes.txt' }
      const mine = mount(NativeChatFileChip, { props: { block } })
      expect(mine.find('button').exists()).toBe(true)
      mine.unmount()
      const theirs = mount(NativeChatFileChip, { props: { block }, global: { provide: { nativeChatLocalFiles: false } } })
      expect(theirs.find('button').exists()).toBe(false)
      theirs.unmount()
    } finally {
      window.shellApi = prev
    }
  })
})
