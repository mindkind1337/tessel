// The header's model chip for the agents whose model Tessel reads from their
// own files and footer: Antigravity CLI and Muse Code, as their files and
// screens are on a real PC (Gemini 4 Argon at high; muse-wonder-1.0 at
// medium, with a sub-agent line under Muse's footer).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { resetSettings, settings } from '../settings'
import { resetModelListsForTests, modelLists } from '../agentModels'

const screen = { rows: [] }
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 120
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      const line = (y) => ({ isWrapped: false, translateToString: () => screen.rows[y - (24 - screen.rows.length)] || '' })
      this.buffer = { active: { baseY: 0, viewportY: 0, length: 24, getLine: (y) => (y >= 0 && y < 24 ? line(y) : undefined) } }
    }
    write(_data, done) {
      if (typeof done === 'function') queueMicrotask(done)
    }
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
      return { cols: 120, rows: 24 }
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { onDidChangeResults() {} } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
import TerminalPane from '../components/TerminalPane.vue'

const AGY_LIST = {
  models: ['Medium', 'High', 'Low'].map((e) => ({ id: `gemini-4-argon-${e.toLowerCase()}`, label: `Gemini 4 Argon (${e})` })).concat([{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' }])
}
const MUSE_LIST = {
  models: [
    { id: 'muse-wonder-1.0', label: 'muse-wonder-1.0', effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], isDefault: true },
    { id: 'muse-spark-1.3', label: 'muse-spark-1.3', effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }
  ],
  fetchedAt: 1
}

describe('pane header model: Antigravity and Muse', () => {
  let wrapper, host, previousApi, output
  const ctx = () => ({
    activeId: ref('p1'),
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
    otherPanes: () => [],
    setActive: vi.fn(),
    toggleMaximize: vi.fn(),
    closeLeaf: vi.fn()
  })
  const mountPane = async (node) => {
    wrapper = mount(TerminalPane, { props: { node: { id: 'p1', type: 'leaf', kind: 'agent', startDir: 'C:\\TRADING', ...node } }, attachTo: host, global: { provide: { panelCtx: ctx() } } })
    await flushPromises()
    await flushPromises()
  }
  const chip = () => {
    const el = wrapper.find('[data-test="pane-model-chip"]')
    return el.exists() ? el.text() : ''
  }
  beforeEach(() => {
    resetSettings()
    settings.gpuRendering = false
    resetModelListsForTests()
    modelLists.antigravity = AGY_LIST
    modelLists.muse = MUSE_LIST
    screen.rows = []
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    output = null
    window.shellApi = { resizePty: vi.fn(), onData: (cb) => ((output = cb), () => {}), onExit: () => () => {}, agentModel: vi.fn(async () => null) }
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => {
    if (wrapper) wrapper.unmount()
    wrapper = null
    host.remove()
    resetSettings()
    resetModelListsForTests()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })

  it('Antigravity: the model and effort its conversation notes', async () => {
    window.shellApi.agentModel.mockResolvedValue({ model: 'Gemini 4 Argon (High)', name: 'Gemini 4 Argon', effort: 'high', source: 'session' })
    await mountPane({ agentId: 'antigravity', agentCommand: 'agy', sessionId: '89cec4e6-00f8-47a4-b013-796a12edd5e4' })
    expect(chip()).toBe('Gemini 4 Argon · High')
  })

  it('Antigravity: its footer when its files say nothing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await mountPane({ agentId: 'antigravity', agentCommand: 'agy' })
      expect(chip()).toBe('')
      // Its screen comes back (re-attached after a restart): the next check reads it.
      screen.rows = ['────', '>', '────', '? for shortcuts                                    Gemini 4 Argon · high']
      vi.advanceTimersByTime(20000)
      await flushPromises()
      expect(chip()).toBe('Gemini 4 Argon · High')
    } finally {
      vi.useRealTimers()
    }
  })

  it('Muse: the model of its log with the effort its settings keep', async () => {
    window.shellApi.agentModel.mockResolvedValue({ model: 'muse-wonder-1.0', effort: 'medium', source: 'session' })
    await mountPane({ agentId: 'muse', agentCommand: 'muse --trust-workspace', sessionId: '01a153a8-4f9d-7502-a036-aba8fd32aded' })
    // Its list's label only repeats the id: named as its footer would be.
    expect(chip()).toBe('Muse Wonder 1.0 · Medium')
  })

  it('Muse: its footer when its files say nothing, a sub-agent line under it', async () => {
    screen.rows = ['› ', 'muse-wonder-1.0 · medium · C:\\TRADING · YOLO', '└ ◇ Retester erreur API et vues  running 2m 31s']
    await mountPane({ agentId: 'muse', agentCommand: 'muse --trust-workspace' })
    expect(chip()).toBe('Muse Wonder 1.0 · Medium')
  })

  it('after a restart of Tessel: the model it showed, at once, until its files are read again', async () => {
    let answer
    window.shellApi.agentModel.mockImplementation(() => new Promise((done) => (answer = done)))
    const node = { agentId: 'muse', agentCommand: 'muse', sessionId: '01a153a8-4f9d-7502-a036-aba8fd32aded', lastModel: { model: 'muse-wonder-1.0', effort: 'medium' } }
    await mountPane(node)
    expect(chip()).toBe('Muse Wonder 1.0 · Medium')
    answer({ model: 'muse-spark-1.3', effort: 'high', source: 'session' })
    await flushPromises()
    expect(chip()).toBe('Muse Spark 1.3 · High')
    // Kept with the layout for the next start.
    expect(wrapper.props('node').lastModel).toEqual({ model: 'muse-spark-1.3', effort: 'high' })
  })

  it('its files not read in time (Tessel starting): what it shows stays; nothing shown, its footer says it', async () => {
    window.shellApi.agentModel.mockResolvedValue({ keep: true })
    await mountPane({ agentId: 'antigravity', agentCommand: 'agy', lastModel: { model: 'gemini-4-argon', name: 'Gemini 4 Argon', effort: 'high' } })
    expect(chip()).toBe('Gemini 4 Argon · High')
    wrapper.unmount()
    screen.rows = ['muse-wonder-1.0 · medium · C:\TRADING · YOLO']
    await mountPane({ agentId: 'muse', agentCommand: 'muse' })
    expect(chip()).toBe('Muse Wonder 1.0 · Medium')
  })

  it('its screen back (re-attached after a restart): its footer is read then, not 20 s later', async () => {
    await mountPane({ agentId: 'antigravity', agentCommand: 'agy' })
    expect(chip()).toBe('')
    screen.rows = ['────', '>', '────', '? for shortcuts                                    Gemini 4 Argon · high']
    output({ id: 'p1', data: 'its screen' })
    await new Promise((done) => setTimeout(done, 400))
    await flushPromises()
    expect(chip()).toBe('Gemini 4 Argon · High')
  })
})
