// The chat view's permission mode picker, as a terminal pane runs it
// (TerminalPane.vue): the mode shown (hook, else the launch), why Yolo
// needs a restart, and Shift+Tab one press at a time, each checked on the
// agent's footer, never while a line is typed, a message is being typed or an
// approval is open.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { agentStates, clearAgentStatus, setApproval } from '../agentStatus'
import { resetSettings, settings } from '../settings'
import { effectiveAgent, launchSignature } from '../../../shared/agentPrefs'
import { resetModelListsForTests } from '../agentModels'

// The terminal's screen: its last row is Claude Code's footer.
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

const FOOTER = { default: '  ? for shortcuts', acceptEdits: '  ⏵⏵ accept edits on (shift+tab to cycle)', plan: '  ⏸ plan mode on (shift+tab to cycle)' }
const CYCLE = ['default', 'acceptEdits', 'plan']
const sig = (agentId, perms = 'manual') => launchSignature(effectiveAgent({ id: agentId, command: agentId }, {}, perms, null))

describe("the chat view's permission mode (terminal pane)", () => {
  let wrapper, host, previousApi, writes, ctx, mode
  function mountPane(extra = {}) {
    resetSettings()
    settings.agentSessionOptions = {}
    resetModelListsForTests()
    settings.gpuRendering = false
    previousApi = window.shellApi
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    writes = []
    mode = 'default'
    screen.rows[23] = FOOTER.default
    window.shellApi = {
      resizePty: vi.fn(),
      // A fake Claude Code: Shift+Tab moves its footer to the next mode.
      writePty: (id, data) => {
        writes.push([id, data])
        if (data === '\x1b[Z') {
          mode = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]
          screen.rows[23] = FOOTER[mode]
        }
      },
      onData: () => () => {},
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
    const node = { id: 'mp', num: 1, kind: 'agent', type: 'leaf', title: agentId, shellName: 'PowerShell', agentId, agentCommand: agentId, launchSig: sig(agentId), chatView: true, ...extra }
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
    window.shellApi = previousApi
    vi.unstubAllGlobals()
  })
  const view = () => wrapper.findComponent({ name: 'NativeChatTranscriptView' })

  it('before any hook: the launch (Yolo or not); Yolo without it needs a restart, named', async () => {
    mountPane({ launchYolo: true, launchSig: sig('claude', 'yolo') })
    await flushPromises()
    expect(view().props('permissionMode')).toBe('bypassPermissions')
    expect(view().props('modeBlocked')('bypassPermissions')).toBe('')
    wrapper.unmount()
    host.remove()
    mountPane()
    await flushPromises()
    expect(view().props('permissionMode')).toBe('default')
    expect(view().props('modeBlocked')('bypassPermissions')).toContain('Restart in Yolo')
    expect(view().props('modeBlocked')('dontAsk')).toContain('--permission-mode')
    expect((await view().props('setPermissionMode')('bypassPermissions')).ok).toBe(false)
    expect(writes).toEqual([])
  })

  it("follows its hook's mode (Shift+Tab pressed in the terminal too)", async () => {
    const token = 'launch-token-0123456789'
    mountPane({ agentLaunchToken: token })
    agentStates.mp = { paneId: 'mp', provider: 'claude', launchToken: token, state: 'idle', confirmed: true, permissionMode: 'plan', permissionModeAt: 100 }
    await flushPromises()
    expect(view().props('permissionMode')).toBe('plan')
    agentStates.mp = { ...agentStates.mp, permissionMode: 'acceptEdits', permissionModeAt: 200 }
    await flushPromises()
    expect(view().props('permissionMode')).toBe('acceptEdits')
  })

  it('a pick: Shift+Tab one press at a time until the footer shows it, then shown', async () => {
    mountPane()
    await flushPromises()
    const res = await view().props('setPermissionMode')('plan')
    expect(res).toEqual({ ok: true })
    expect(writes).toEqual([
      ['mp', '\x1b[Z'],
      ['mp', '\x1b[Z']
    ])
    await flushPromises()
    expect(view().props('permissionMode')).toBe('plan')
  })

  it('types nothing while a line is typed there, a message is being typed, or an approval is open', async () => {
    mountPane()
    await flushPromises()
    ctx.paneUserTyping = () => true
    expect((await view().props('setPermissionMode')('plan')).error).toContain('A line is typed')
    ctx.paneUserTyping = () => false
    ctx.paneDelivering = () => true
    expect((await view().props('setPermissionMode')('plan')).error).toContain('A message is being typed')
    ctx.paneDelivering = () => false
    setApproval('mp', true)
    await flushPromises()
    expect((await view().props('setPermissionMode')('plan')).error).toContain('approval')
    expect(writes).toEqual([])
  })

  it('a mode Shift+Tab never reaches: back where it started, said so', async () => {
    mountPane()
    await flushPromises()
    const res = await view().props('setPermissionMode')('auto')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('does not offer this mode')
    expect(writes).toHaveLength(3)
    expect(mode).toBe('default')
  })

  it('Codex: no keys from the pane (its own /permissions picker, from the chat view)', async () => {
    mountPane({ agentId: 'codex', launchYolo: true, launchSig: sig('codex', 'yolo') })
    await flushPromises()
    expect(view().props('permissionMode')).toBe('bypassPermissions')
    expect((await view().props('setPermissionMode')('default')).ok).toBe(false)
    expect(writes).toEqual([])
  })
})
