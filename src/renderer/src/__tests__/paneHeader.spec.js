// The terminal pane's header (TerminalPane.vue), like Orca's: its status, icon,
// title and at most one state badge; the rest (model, branch, team, Yolo,
// the other states, the voice language, a new pane next to it) is in the
// pane's menu, which opens in the page's top layer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { setApproval, clearAgentStatus } from '../agentStatus'
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
import TerminalPane from '../components/TerminalPane.vue'

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
    expect(h.get('[data-test="pane-model-chip"]').text()).toBe('Opus')
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
    expect(actions).toEqual(['Voice typing (Français)', 'More options', 'Maximize pane', 'Close pane'])
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
