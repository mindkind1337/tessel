// The chat view over a terminal pane (TerminalPane.vue): its right-click menu
// actions, the background listing, why a message waits, which approval is
// open, a question's header badge, a model with no effort, and nothing dropped
// or right-clicked on the chat ever reaching the terminal under it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { agentStates, clearAgentStatus, setApproval } from '../agentStatus'
import { resetSettings, settings } from '../settings'
import { effectiveAgent, launchSignature } from '../../../shared/agentPrefs'
import { resetModelListsForTests } from '../agentModels'

const screen = { rows: Array.from({ length: 24 }, () => '') }
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 80
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = {
        active: { baseY: 0, viewportY: 0, length: 24, getLine: (y) => ({ isWrapped: false, translateToString: () => screen.rows[y] || '' }) }
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
    clearSelection() {}
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
import TerminalPane from '../components/TerminalPane.vue'

const sig = (agentId, perms = 'manual') => launchSignature(effectiveAgent({ id: agentId, command: agentId }, {}, perms, null))
const TOKEN = 'launch-token-0123456789'

describe('the chat view of a terminal pane, closer to the chat pane', () => {
  let wrapper, host, previousApi, ctx, writePty, readClipboard
  function mountPane(extra = {}, { model = null, typing = false } = {}) {
    resetSettings()
    settings.agentSessionOptions = {}
    resetModelListsForTests()
    settings.gpuRendering = false
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    writePty = vi.fn()
    readClipboard = vi.fn(async () => 'from clipboard')
    window.shellApi = {
      resizePty: vi.fn(),
      writePty,
      readClipboard,
      writeClipboard: vi.fn(),
      pathForFile: () => 'C:/Users/me/shot.png',
      onData: () => () => {},
      onExit: () => () => {},
      agentModel: vi.fn(async () => model)
    }
    ctx = {
      activeId: ref('cp'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref('EN'),
      voiceLanguages: ref([]),
      notifyAgentDone: vi.fn(),
      notifyAgentLimit: vi.fn(),
      teamById: () => null,
      trackOf: () => null,
      unsent: {},
      otherPanes: () => [],
      openLauncherAt: vi.fn(),
      setActive: vi.fn(),
      toggleMaximize: vi.fn(),
      splitLeaf: vi.fn(),
      closeLeaf: vi.fn(),
      restartLeaf: vi.fn(),
      paneUserTyping: () => typing,
      toast: vi.fn()
    }
    const node = { id: 'cp', num: 1, kind: 'agent', type: 'leaf', title: 'claude', shellName: 'PowerShell', agentId: 'claude', agentCommand: 'claude', launchSig: sig('claude'), chatView: true, agentLaunchToken: TOKEN, ...extra }
    host = document.createElement('div')
    document.body.append(host)
    wrapper = mount(TerminalPane, { props: { node }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    return wrapper.props('node')
  }
  afterEach(() => {
    wrapper.unmount()
    host.remove()
    clearAgentStatus('cp')
    resetSettings()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })
  const view = () => wrapper.findComponent({ name: 'NativeChatTranscriptView' })
  const state = (extra) => {
    agentStates.cp = { paneId: 'cp', provider: 'claude', launchToken: TOKEN, state: 'idle', confirmed: true, hookSeen: true, since: 100, ...extra }
  }

  it("the right-click menu acts on this pane: split, maximize, close", async () => {
    mountPane()
    await flushPromises()
    const actions = view().props('paneActions')
    actions.onSplitRight()
    actions.onSplitDown()
    actions.onToggleExpand()
    actions.onClosePane()
    expect(ctx.splitLeaf.mock.calls).toEqual([
      ['cp', 'row'],
      ['cp', 'col']
    ])
    expect(ctx.toggleMaximize).toHaveBeenCalledWith('cp')
    expect(ctx.closeLeaf).toHaveBeenCalledWith('cp')
    expect(actions.isPaneExpanded).toBe(false)
  })

  it("the agent's last background listing goes to the dock", async () => {
    mountPane()
    state({ backgroundIds: ['bsrv'], backgroundListedAt: 5000 })
    await flushPromises()
    expect(view().props('background')).toEqual({ ids: ['bsrv'], listedAt: 5000 })
  })

  it('why a message waits: a line typed in the terminal, or an approval first', async () => {
    mountPane({}, { typing: true })
    await flushPromises()
    expect(view().props('sendHeldReason')()).toContain('a line is typed in its terminal')
    wrapper.unmount()
    host.remove()
    mountPane()
    state({ state: 'approval', reason: 'permission', since: 777 })
    await flushPromises()
    expect(view().props('sendHeldReason')()).toContain('approval')
    // Which approval is open (an answered one stays hidden until another).
    expect(view().props('waiting')).toMatchObject({ approval: true, approvalKey: 777 })
  })

  it('a question it asks is badged as a question, not an approval', async () => {
    mountPane()
    state({ state: 'approval', reason: 'input', since: 300 })
    setApproval('cp', true)
    await flushPromises()
    const badge = document.querySelector('[data-test="pane-badge"]')
    expect(badge.textContent.trim()).toBe('question?')
  })

  it('an effort for a model that has none (Haiku): said so, not "at restart"', async () => {
    mountPane({}, { model: { model: 'haiku', effort: null, source: 'session' } })
    await flushPromises()
    await flushPromises()
    const res = await view().props('setOption')({ effort: 'high' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no reasoning effort')
  })

  it('its model and effort are looked up with the arguments it was launched with (a --effort from Settings)', async () => {
    mountPane({ launchSig: JSON.stringify(['claude', '--model opus --effort medium', []]) })
    await flushPromises()
    expect(window.shellApi.agentModel.mock.calls[0][0].command).toContain('--effort medium')
  })

  it('a drop or a right-click on the chat view never reaches the terminal under it', async () => {
    mountPane()
    settings.rightClickPaste = true
    await flushPromises()
    const over = document.querySelector('[data-test="terminal-chat-view"]')
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [{ name: 'a.txt' }], getData: () => '', effectAllowed: 'all', dropEffect: 'none' } })
    over.dispatchEvent(drop)
    over.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(writePty).not.toHaveBeenCalled()
    expect(readClipboard).not.toHaveBeenCalled()
  })
})
