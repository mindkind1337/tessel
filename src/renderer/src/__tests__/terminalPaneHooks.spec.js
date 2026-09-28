import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { applyAgentStates, clearAgentStatus, agentStatus } from '../agentStatus'
import {
  createAgentState,
  reduceAgentState,
  publicAgentState
} from '../../../shared/agentStateModel'
import { settings, resetSettings } from '../settings'

const fixture = vi.hoisted(() => ({ terminals: [] }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options) {
      this.options = options
      this.rows = 24
      this.cols = 80
      this.lines = ['Answer', '❯ ']
      this.pending = []
      this.parser = { registerOscHandler() {}, registerCsiHandler() {} }
      this.buffer = {
        active: {
          baseY: 0,
          viewportY: 0,
          cursorY: 1,
          cursorX: 2,
          length: 24,
          getLine: (index) => ({
            isWrapped: false,
            translateToString: () => this.lines[index] || '',
            getCell: () => ({ getChars: () => '', isDim: () => false })
          })
        }
      }
      fixture.terminals.push(this)
    }
    write(data, callback) {
      this.pending.push({ data, callback })
    }
    flush(lines) {
      this.lines = lines
      for (const pending of this.pending.splice(0)) pending.callback?.()
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

describe('TerminalPane status integration', () => {
  let wrapper, ctx, state, onData, sequence, previousApi
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(100000)
    previousApi = window.shellApi
    sequence = 0
    fixture.terminals.length = 0
    clearAgentStatus('test-pane')
    resetSettings()
    settings.gpuAcceleration = 'off'
    settings.promptCacheTimer = true
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    )
    state = createAgentState({
      paneId: 'test-pane',
      provider: 'claude',
      launchToken: 'launch',
      startedAt: Date.now()
    })
    const apply = (source, event, extra = {}) => {
      state = reduceAgentState(
        state,
        {
          v: 1,
          id: `e-${++sequence}`,
          paneId: 'test-pane',
          provider: 'claude',
          launchToken: 'launch',
          sessionId: 'session',
          source,
          event,
          at: Date.now(),
          ...extra
        },
        Date.now()
      )
      applyAgentStates({ 'test-pane': publicAgentState(state, Date.now()) })
    }
    window.shellApi = {
      resizePty: vi.fn(),
      onData: (callback) => {
        onData = callback
        return () => {}
      },
      onExit: () => () => {},
      reportAgentScreen: vi.fn((event) => apply('screen', event.event, event))
    }
    ctx = {
      activeId: ref('elsewhere'),
      broadcast: ref(false),
      maximizedId: ref(null),
      highlightId: ref(null),
      voiceName: ref('English'),
      voiceLabel: ref(''),
      voiceLanguages: ref([]),
      notifyAgentDone: vi.fn(),
      notifyAgentLimit: vi.fn(),
      agentReportedDone: vi.fn(),
      teamById: () => null,
      trackOf: () => null,
      setActive: vi.fn()
    }
    wrapper = mount(TerminalPane, {
      props: {
        node: {
          id: 'test-pane',
          kind: 'agent',
          type: 'leaf',
          title: 'Claude',
          agentId: 'claude',
          agentLaunchToken: 'launch'
        }
      },
      global: { provide: { panelCtx: ctx } }
    })
    ctx.hook = (event, extra) => apply('hook', event, extra)
  })
  afterEach(() => {
    wrapper?.unmount()
    clearAgentStatus('test-pane')
    resetSettings()
    window.shellApi = previousApi
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not confirm a stale prompt while xterm still has unparsed output', async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Stop')
    onData({ id: 'test-pane', data: 'A continuation is still being rendered' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(
      window.shellApi.reportAgentScreen.mock.calls.some(([event]) => event.event === 'ScreenReady')
    ).toBe(false)
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    fixture.terminals[0].flush(['Working… esc to interrupt', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    expect(agentStatus['test-pane']).toBe('busy')
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    onData({ id: 'test-pane', data: 'Now the prompt is genuinely ready' })
    fixture.terminals[0].flush(['TASK_COMPLETE', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    await nextTick()
    expect(agentStatus['test-pane']).toBe('idle')
    expect(ctx.notifyAgentDone).toHaveBeenCalledTimes(1)
    expect(ctx.agentReportedDone).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.pane-cache').exists()).toBe(true)
    onData({ id: 'test-pane', data: 'A repaint' })
    fixture.terminals[0].flush(['TASK_COMPLETE', '❯ '])
    await vi.advanceTimersByTimeAsync(1400)
    expect(ctx.notifyAgentDone).toHaveBeenCalledTimes(1)
    expect(ctx.agentReportedDone).toHaveBeenCalledTimes(1)
  })

  it('renders missing managed state honestly and does not turn a silent tool into a completed answer', async () => {
    expect(wrapper.text()).toContain('unknown')
    ctx.hook('UserPromptSubmit')
    onData({ id: 'test-pane', data: 'Running a silent tool' })
    fixture.terminals[0].flush(['Running a silent tool', ''])
    await vi.advanceTimersByTimeAsync(15000)
    await nextTick()
    expect(wrapper.get('.pane-working').text()).toBe('working')
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    expect(wrapper.find('.pane-cache').exists()).toBe(false)
  })

  it('labels the actual approval state in the status description (the hover card shows it)', async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Notification', { notificationType: 'permission_prompt' })
    await nextTick()
    expect(wrapper.get('.pane-icon').attributes('aria-description')).toContain('Main agent state: approval.')
    expect(wrapper.text()).toContain('approve?')
  })

  it('does not use a restored terminal prompt as fresh completion evidence', async () => {
    ctx.hook('UserPromptSubmit')
    ctx.hook('Stop')
    // The mock starts with an old visible empty prompt, like a history replay.
    // No live PTY write has been parsed for this component yet.
    await vi.advanceTimersByTimeAsync(2000)
    expect(window.shellApi.reportAgentScreen).not.toHaveBeenCalled()
    expect(ctx.notifyAgentDone).not.toHaveBeenCalled()
    expect(agentStatus['test-pane']).toBe('busy')
  })
})
