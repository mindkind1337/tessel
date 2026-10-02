// Pane menu > Model (TerminalPane.vue): Orca's per-session picker. A running
// Claude Code gets /model (its "Switch model?" answered, the result read from
// its screen); a running Codex opens its own picker or restarts to apply; a
// pane that is not running keeps the choice for its next start.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { setApproval, clearAgentStatus } from '../agentStatus'
import { resetSettings, settings } from '../settings'
import { effectiveAgent, launchSignature } from '../../../shared/agentPrefs'
import { resetModelListsForTests, modelLists } from '../agentModels'
import { parseCursorModelList } from '../../../shared/agentModelProbe'

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
    attachCustomWheelEventHandler() {}
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
import TerminalPane from '../components/TerminalPane.vue'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// Tessel types a command, then Enter on its own (a busy test run can be slow).
const ENTER = '\r'
const sigWithout = (agentId) => launchSignature(effectiveAgent({ id: agentId, command: agentId }, {}, 'manual', null))

describe('pane menu > Model', () => {
  let wrapper, host, previousApi, listeners, writes, ctx
  function mountPane(extra = {}) {
    resetSettings()
    settings.agentSessionOptions = {}
    resetModelListsForTests()
    settings.gpuRendering = false
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    listeners = []
    writes = []
    window.shellApi = {
      resizePty: vi.fn(),
      writePty: (id, data) => writes.push([id, data]),
      onData: (cb) => {
        listeners.push(cb)
        return () => (listeners = listeners.filter((l) => l !== cb))
      },
      onExit: () => () => {},
      agentModel: vi.fn(async () => null)
    }
    ctx = {
      activeId: ref('mp'),
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
      closeLeaf: vi.fn(),
      restartLeaf: vi.fn(),
      toast: vi.fn()
    }
    const agentId = extra.agentId || 'claude'
    const node = {
      id: 'mp',
      num: 1,
      kind: 'agent',
      type: 'leaf',
      title: agentId,
      shellName: 'PowerShell',
      agentId,
      agentCommand: agentId,
      launchSig: sigWithout(agentId),
      ...extra
    }
    host = document.createElement('div')
    document.body.append(host)
    wrapper = mount(TerminalPane, { props: { node }, attachTo: host, global: { provide: { panelCtx: ctx } } })
    return wrapper.props('node')
  }
  afterEach(() => {
    wrapper.unmount()
    host.remove()
    clearAgentStatus('mp')
    resetSettings()
    settings.agentSessionOptions = {}
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  const ctxMenu = () => document.body.querySelector(':scope > .ctx-menu:not(.pane-model-menu)')
  const modelMenu = () => document.body.querySelector('[data-test="pane-model-menu"]')
  async function openModelMenu() {
    await flushPromises()
    await wrapper.get('[data-test="pane-menu-btn"]').trigger('click')
    await nextTick()
    ctxMenu().querySelector('[data-test="pane-model"]').click()
    await nextTick()
    return modelMenu()
  }
  const emit = (data) => listeners.forEach((l) => l({ id: 'mp', data }))
  const typed = () => vi.waitFor(() => expect(writes.at(-1)).toEqual(['mp', ENTER]), { timeout: 3000 })

  it('a running Claude: /model typed, "Switch model?" answered with Enter, applied without a restart', async () => {
    const node = mountPane()
    const m = await openModelMenu()
    expect(m).not.toBeNull()
    expect(m.querySelector('[data-test="sop-model-default"]').getAttribute('aria-checked')).toBe('true')
    m.querySelector('[data-model="sonnet"]').click()
    await typed()
    expect(writes).toEqual([
      ['mp', '/model sonnet'],
      ['mp', '\r']
    ])
    emit('Switch model?\r\n This conversation is cached for the current model')
    expect(writes.at(-1)).toEqual(['mp', '\r'])
    expect(writes).toHaveLength(3)
    emit(' ⎿  Set model to Sonnet 5')
    await flushPromises()
    expect(node.sessionOptions).toEqual({ model: 'sonnet' })
    // It runs that model now: no "Restart to apply".
    expect(node.launchSig).toBe(launchSignature(effectiveAgent({ id: 'claude', command: 'claude' }, {}, 'manual', { model: 'sonnet' })))
    expect(modelMenu()).toBeNull()
    await wrapper.get('[data-test="pane-menu-btn"]').trigger('click')
    await nextTick()
    expect(ctxMenu().querySelector('[data-test="menu-restart-apply"]')).toBeNull()
    expect(ctxMenu().querySelector('[data-test="pane-model"]').textContent).toContain('Sonnet')
  })

  it('Claude keeps its model: said, nothing changes', async () => {
    const node = mountPane()
    const m = await openModelMenu()
    m.querySelector('[data-model="opus"]').click()
    await typed()
    emit('Kept model as Sonnet')
    await flushPromises()
    expect(node.sessionOptions).toBeUndefined()
    expect(ctx.toast).toHaveBeenCalledWith('Claude kept the current model.', { kind: 'error' })
  })

  it('effort with /effort; fast mode is /fast, an action', async () => {
    const node = mountPane({ sessionOptions: { model: 'opus' } })
    let m = await openModelMenu()
    m.querySelector('[data-option="effort"][data-value="max"]').click()
    await typed()
    expect(writes).toEqual([
      ['mp', '/effort max'],
      ['mp', '\r']
    ])
    await flushPromises()
    expect(node.sessionOptions).toEqual({ model: 'opus', effort: 'max' })
    m = await openModelMenu()
    m.querySelector('[data-test="sop-toggle"]').click()
    await typed()
    expect(writes.slice(2)).toEqual([
      ['mp', '/fast'],
      ['mp', '\r']
    ])
  })

  it("a running Cursor: a model goes as /model with its name (an id would only filter its picker); an effort or Fast opens its picker", async () => {
    const node = mountPane({ agentId: 'cursor', sessionOptions: { model: 'gpt-5.3-codex' } })
    modelLists.cursor = {
      fetchedAt: Date.now(),
      models: parseCursorModelList(
        [
          'auto - Auto (current, default)',
          'gpt-5.3-codex-low - Codex 5.3 Low',
          'gpt-5.3-codex - Codex 5.3',
          'gpt-5.3-codex-high - Codex 5.3 High',
          'gpt-5.3-codex-high-fast - Codex 5.3 High Fast',
          'claude-opus-5-high - Claude Opus 5 1M',
          'claude-opus-5-thinking-high - Claude Opus 5 1M Thinking'
        ].join('\n')
      )
    }
    let m = await openModelMenu()
    expect([...m.querySelectorAll('[data-test="sop-model"]')].map((b) => b.dataset.model)).toEqual(['auto', 'claude-opus-5', 'gpt-5.3-codex'])
    expect(m.querySelector('[data-test="sop-note"]').textContent).toContain('switches at once')
    m.querySelector('[data-model="claude-opus-5"]').click()
    await typed()
    expect(writes).toEqual([
      ['mp', '/model Claude Opus 5'],
      ['mp', ENTER]
    ])
    await flushPromises()
    // Nothing kept for the next start: Cursor remembers its pick itself.
    expect(node.sessionOptions).toEqual({ model: 'gpt-5.3-codex' })
    m = await openModelMenu()
    m.querySelector('[data-option="effort"][data-value="high"]').click()
    await vi.waitFor(() => expect(writes).toHaveLength(4), { timeout: 3000 })
    expect(writes.slice(2)).toEqual([
      ['mp', '/model'],
      ['mp', ENTER]
    ])
    await flushPromises()
    expect(ctx.toast).toHaveBeenLastCalledWith(expect.stringContaining('Tab'), expect.anything())
  })

  it('while it asks for an approval nothing is typed', async () => {
    mountPane()
    setApproval('mp', true)
    const m = await openModelMenu()
    expect(m.querySelector('[data-test="sop-disabled"]').textContent).toContain('It is working')
    m.querySelector('[data-model="sonnet"]').click()
    await wait(200)
    expect(writes).toEqual([])
  })

  it('a running Codex: a model applies at restart (Restart to apply); its own picker is one click away', async () => {
    const node = mountPane({ agentId: 'codex' })
    const m = await openModelMenu()
    expect(m.querySelector('[data-test="sop-note"]').textContent).toContain('applies when the agent restarts')
    m.querySelector('[data-model="gpt-5.5"]').click()
    await nextTick()
    expect(writes).toEqual([])
    expect(node.sessionOptions).toEqual({ model: 'gpt-5.5' })
    await wrapper.get('[data-test="pane-menu-btn"]').trigger('click')
    await nextTick()
    expect(ctxMenu().querySelector('[data-test="menu-restart-apply"]')).not.toBeNull()
    // Back to the default: nothing to restart for.
    ctxMenu().querySelector('[data-test="pane-model"]').click()
    await nextTick()
    modelMenu().querySelector('[data-test="sop-model-default"]').click()
    await nextTick()
    expect(node.sessionOptions).toBeUndefined()
    // Choose in agent picker…: /model typed one key at a time.
    await wrapper.get('[data-test="pane-menu-btn"]').trigger('click')
    await nextTick()
    expect(ctxMenu().querySelector('[data-test="menu-restart-apply"]')).toBeNull()
    ctxMenu().querySelector('[data-test="pane-model"]').click()
    await nextTick()
    modelMenu().querySelector('[data-test="sop-agent-picker"]').click()
    await typed()
    expect(writes.map((w) => w[1]).join('')).toBe('/model\r')
    expect(writes.length).toBe(7)
  })

  it('the header chip: the model in use, effort only when not the default; a click opens the picker', async () => {
    mountPane({ modelChoice: { model: 'opus', effort: 'high' } })
    await flushPromises()
    const chip = () => wrapper.get('[data-test="pane-model-chip"]')
    expect(chip().text()).toBe('Opus · High')
    wrapper.props('node').modelChoice = { model: 'opus', effort: 'max' }
    await wrapper.vm.$nextTick()
    // The header refreshes its model on its own schedule; ask now.
    window.shellApi.agentModel.mockResolvedValueOnce(null)
    await wrapper.setProps({ node: { ...wrapper.props('node'), sessionId: 's2' } })
    await flushPromises()
    expect(chip().text()).toBe('Opus · Max')
    await chip().trigger('click')
    await nextTick()
    expect(modelMenu()).not.toBeNull()
  })

  it("the chip shows what the session reports (Codex's turn), its effort when not the default", async () => {
    mountPane({ agentId: 'codex' })
    window.shellApi.agentModel.mockResolvedValue({ model: 'gpt-5.5', effort: 'high', source: 'session' })
    await wrapper.setProps({ node: { ...wrapper.props('node'), sessionId: 's1' } })
    await flushPromises()
    expect(wrapper.get('[data-test="pane-model-chip"]').text()).toBe('GPT-5.5 · High')
    window.shellApi.agentModel.mockResolvedValue({ model: 'gpt-5.5', effort: 'medium', source: 'session' })
    await wrapper.setProps({ node: { ...wrapper.props('node'), sessionId: 's3' } })
    await flushPromises()
    expect(wrapper.get('[data-test="pane-model-chip"]').text()).toBe('GPT-5.5 · Medium')
  })

  it('a pane launched with its own model shows it over the default from settings, until its session says otherwise', async () => {
    mountPane({ sessionOptions: { model: 'opus' } })
    window.shellApi.agentModel.mockResolvedValue({ model: 'claude-sonnet-5', effort: null, source: 'settings' })
    await wrapper.setProps({ node: { ...wrapper.props('node'), sessionId: 's1' } })
    await flushPromises()
    expect(wrapper.get('[data-test="pane-model-chip"]').text()).toContain('Opus')
    window.shellApi.agentModel.mockResolvedValue({ model: 'claude-haiku-4-5', effort: null, source: 'session' })
    await wrapper.setProps({ node: { ...wrapper.props('node'), sessionId: 's2' } })
    await flushPromises()
    expect(wrapper.get('[data-test="pane-model-chip"]').text()).toContain('Haiku')
  })

  it('a pane asleep keeps the choice for its next start; the default from Settings is named', async () => {
    const node = mountPane({ sleeping: { at: 1 } })
    settings.agentSessionOptions = { claude: { model: 'haiku', valuesByModel: {} } }
    const m = await openModelMenu()
    expect(m.querySelector('[data-test="sop-note"]').textContent).toBe('Applies when the agent starts.')
    expect(m.querySelector('[data-test="sop-model-default"]').textContent).toContain('Default from Settings (Haiku)')
    m.querySelector('[data-model="opus"]').click()
    await nextTick()
    expect(writes).toEqual([])
    expect(node.sessionOptions).toEqual({ model: 'opus' })
  })

  // The chat view over the terminal: its model and effort pickers go the
  // same way as this menu (so the header and the chat agree).
  const chatView = () => wrapper.findComponent({ name: 'NativeChatTranscriptView' })
  it("the chat view's pickers: the pane's models and values; a pick types /model, confirmed from the screen", async () => {
    const node = mountPane({ chatView: true })
    await flushPromises()
    const view = chatView()
    expect(view.exists()).toBe(true)
    expect(view.props('sessionOptions').models.map((m) => m.id)).toContain('sonnet')
    const pending = view.props('setOption')({ model: 'sonnet' })
    await typed()
    expect(writes).toEqual([
      ['mp', '/model sonnet'],
      ['mp', '\r']
    ])
    emit(' ⎿  Set model to Sonnet 5')
    expect(await pending).toEqual({ ok: true })
    expect(node.sessionOptions).toEqual({ model: 'sonnet' })
  })

  it('the chat view types nothing while a line is typed in the terminal, or for an option it does not have', async () => {
    mountPane({ chatView: true })
    ctx.paneUserTyping = () => true
    await flushPromises()
    const res = await chatView().props('setOption')({ effort: 'max' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('A line is typed')
    ctx.paneUserTyping = () => false
    expect((await chatView().props('setOption')({ permissionMode: 'plan' })).ok).toBe(false)
    expect(writes).toEqual([])
  })
})
