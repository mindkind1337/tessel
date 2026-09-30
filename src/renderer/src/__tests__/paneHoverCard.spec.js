// The terminal pane header's hover card (the sidebar's Orca-style card)
// replaces the header title's native multi-line tooltip; the sidebar's agent
// card shows the same model line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { settings, resetSettings } from '../settings'
import { paneModels } from '../paneModels'
import { modelLabel } from '../../../shared/modelLabel'
import AgentHoverDetails from '../components/sidebar/AgentHoverDetails.vue'

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
    }
    write(data, callback) {
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

const MODEL = 'Opus 5.5 (1M)'
let wrapper, previousApi

async function wait(ms) {
  vi.advanceTimersByTime(ms)
  await nextTick()
  await nextTick()
}
const cards = () => [...document.querySelectorAll('.pane-hover-card')]

function mountPane(extra = {}) {
  const ctx = {
    activeId: ref('elsewhere'),
    broadcast: ref(false),
    maximizedId: ref(null),
    highlightId: ref(null),
    voiceName: ref('English'),
    voiceLabel: ref(''),
    voiceLanguages: ref([]),
    agents: ref([{ id: 'claude', name: 'Claude Code' }]),
    notifyAgentDone: vi.fn(),
    notifyAgentLimit: vi.fn(),
    agentReportedDone: vi.fn(),
    teamById: (id) => (id === 'tm1' ? { id: 'tm1', name: 'Team 2', color: '#4af', leadId: 'p-other' } : null),
    trackOf: () => null,
    setActive: vi.fn(),
    beginPaneDrag: vi.fn()
  }
  wrapper = mount(TerminalPane, {
    props: {
      node: {
        id: 'hover-pane',
        num: 2,
        kind: 'agent',
        type: 'leaf',
        title: 'Claude Code',
        agentId: 'claude',
        agentLaunchToken: 'launch',
        accent: '#d97757',
        team: 'tm1',
        modelChoice: { model: MODEL },
        autoTitle: 'Fix the cart',
        ...extra
      }
    },
    global: { provide: { panelCtx: ctx } },
    attachTo: document.body
  })
  return wrapper
}

beforeEach(() => {
  vi.useFakeTimers()
  previousApi = window.shellApi
  resetSettings()
  settings.gpuAcceleration = 'off'
  settings.autoTitles = true
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  window.shellApi = {
    resizePty: vi.fn(),
    onData: () => () => {},
    onExit: () => () => {},
    agentModel: vi.fn(async () => null)
  }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  for (const k of Object.keys(paneModels)) delete paneModels[k]
  document.body.innerHTML = ''
  resetSettings()
  window.shellApi = previousApi
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('pane header hover card', () => {
  it('the header title, number, icon and state carry no native tooltip; the text stays for screen readers', async () => {
    const w = mountPane()
    await wait(0)
    const left = w.find('[data-test="pane-hover-trigger"]')
    expect(left.findAll('[title]').map((e) => e.attributes('title'))).toEqual([])
    // The header shows only the agent's name: the conversation's title is in
    // the hover card, not beside it.
    expect(w.find('.pane-subtitle').exists()).toBe(false)
    expect(w.find('[data-test="pane-header"]').text()).not.toContain('Fix the cart')
    const title = w.find('[data-test="pane-title"]')
    expect(title.text()).toBe('Claude Code')
    expect(title.attributes('title')).toBeUndefined()
    const desc = title.attributes('aria-description')
    expect(desc).toContain('Fix the cart')
    expect(desc).toContain(`Model: ${modelLabel(MODEL)}`)
    expect(desc).toContain('Team: Team 2')
    expect(desc).toContain('Double-click to rename')
  })

  it("opens after Orca's 400 ms below the header and shows the pane's details", async () => {
    const w = mountPane()
    await wait(0)
    const trigger = w.find('[data-test="pane-hover-trigger"]')
    await trigger.trigger('pointerover')
    await wait(350)
    expect(cards()).toHaveLength(0)
    await wait(60)
    const [card] = cards()
    expect(card).toBeTruthy()
    // Teleported to the body, above the panes.
    expect(card.parentElement).toBe(document.body)
    expect(card.dataset.side).toBe('bottom')
    expect(card.querySelector('[data-hover-heading]').textContent).toBe('Claude Code')
    // Not renamed: the agent's name is the heading, not repeated.
    expect(card.querySelector('[data-hover-agent]')).toBeNull()
    expect(card.querySelector('[data-hover-model]').textContent).toBe(`Model: ${modelLabel(MODEL)}`)
    expect(card.querySelector('[data-hover-conversation]').textContent).toBe('Fix the cart')
    expect(card.querySelector('[data-hover-state]')).toBeTruthy()
    expect(card.querySelector('[data-hover-team]').textContent).toContain('Team 2')
    expect(card.textContent).not.toContain('Pane 2')
    expect(card.querySelector('[data-hover-hint]').textContent).toContain('Double-click to rename')
    // Only one card per pane.
    expect(cards()).toHaveLength(1)
  })

  it('a renamed pane shows its agent with the icon under its name', async () => {
    const w = mountPane({ title: 'Reviewer', titleSet: true })
    await wait(0)
    await w.find('[data-test="pane-hover-trigger"]').trigger('pointerover')
    await wait(410)
    const [card] = cards()
    expect(card.querySelector('[data-hover-heading]').textContent).toBe('Reviewer')
    expect(card.querySelector('[data-hover-agent]').textContent).toBe('Claude Code')
    // Named by you: no conversation title.
    expect(card.querySelector('[data-hover-conversation]')).toBeNull()
  })

  it('closes when the pointer leaves, on Esc, and on a press in the header (a drag)', async () => {
    const w = mountPane()
    await wait(0)
    const trigger = w.find('[data-test="pane-hover-trigger"]')
    const open = async () => {
      await trigger.trigger('pointerleave')
      await trigger.trigger('pointerover')
      await wait(410)
      expect(cards()).toHaveLength(1)
    }

    await open()
    await trigger.trigger('pointerleave')
    await wait(100)
    expect(cards()).toHaveLength(1)
    await wait(30)
    expect(cards()).toHaveLength(0)

    await open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(cards()).toHaveLength(0)

    await open()
    w.find('[data-test="pane-title"]').element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    await nextTick()
    expect(cards()).toHaveLength(0)
    // Still closed while the pointer stays (dragging the header).
    await trigger.trigger('pointerover')
    await wait(500)
    expect(cards()).toHaveLength(0)
  })

  it('stays closed while a pane is being dragged', async () => {
    const w = mountPane()
    await wait(0)
    document.body.classList.add('pane-dragging')
    await w.find('[data-test="pane-hover-trigger"]').trigger('pointerover')
    await wait(500)
    expect(cards()).toHaveLength(0)
    document.body.classList.remove('pane-dragging')
  })
})

describe("sidebar agent card's model line", () => {
  const row = {
    id: 'p1',
    num: 1,
    kind: 'agent',
    iconKind: 'claude',
    accent: null,
    title: 'Claude Code',
    primary: 'Fix the cart',
    secondary: '',
    dotState: 'working',
    sleeping: false,
    time: null
  }

  it('shows the model the pane header found, right under the agent', () => {
    paneModels.p1 = MODEL
    const w = mount(AgentHoverDetails, { props: { row } })
    const identity = w.find('.hc-identity')
    const lines = identity.findAll('.hc-agent').map((e) => e.text())
    expect(lines).toEqual(['Claude Code', `Model: ${MODEL}`])
    w.unmount()
  })

  it('no model known: no model line', () => {
    const w = mount(AgentHoverDetails, { props: { row } })
    expect(w.find('[data-hover-model]').exists()).toBe(false)
    w.unmount()
  })
})
