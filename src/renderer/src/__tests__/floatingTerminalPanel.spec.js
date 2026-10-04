// The floating terminal's panel (FloatingTerminal.vue): a TerminalPane of its
// own over the workspace, outside the grid's panes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, inject, nextTick, ref } from 'vue'
import fs from 'fs'
import { join } from 'path'

// The pane itself: a stub that shows what it is given (its pane, its ctx).
const seen = { ctx: null, mounts: 0 }
vi.mock('../components/TerminalPane.vue', () => ({
  default: defineComponent({
    props: { node: { type: Object, required: true } },
    setup(props) {
      seen.ctx = inject('panelCtx')
      seen.mounts++
      return () => h('div', { class: 'pane', 'data-pane-id': props.node.id }, [h('textarea', { class: 'xterm-helper-textarea' })])
    }
  })
}))

import FloatingTerminal from '../components/FloatingTerminal.vue'
import { createFloatingTerminal } from '../floatingTerminal'

function memoryStorage() {
  const data = {}
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => (data[k] = String(v)) }
}

describe('floating terminal panel', () => {
  let wrapper, ctl, host, gridCtx, previousApi
  beforeEach(() => {
    seen.ctx = null
    seen.mounts = 0
    previousApi = window.shellApi
    window.shellApi = { writePty: vi.fn(), killPty: vi.fn() }
    let n = 0
    host = { createLeaf: vi.fn(async (shellId, agent, cwd, wt, opts) => ({ type: 'leaf', id: opts.id || `pane-f${++n}`, kind: 'shell', startDir: cwd })) }
    ctl = createFloatingTerminal({
      createLeaf: host.createLeaf,
      killPty: (id) => window.shellApi.killPty(id),
      dropBuffer: () => {},
      storage: memoryStorage(),
      startOptions: () => ({ shellId: 'powershell', cwd: 'C:\\proj', opts: {} })
    })
    // The grid's own ctx (App.vue's): the panel must not use its pane actions.
    gridCtx = {
      activeId: ref('grid-1'),
      maximizedId: ref(null),
      broadcast: ref(true),
      highlightId: ref(null),
      routeInput: vi.fn(),
      setActive: vi.fn(),
      splitLeaf: vi.fn(),
      toggleMaximize: vi.fn(),
      beginPaneDrag: vi.fn(),
      closeLeaf: vi.fn(),
      restartLeaf: vi.fn(),
      otherPanes: () => [],
      toast: vi.fn()
    }
  })
  afterEach(() => {
    if (wrapper) wrapper.unmount()
    wrapper = null
    window.shellApi = previousApi
    document.body.innerHTML = ''
  })

  function mountPanel() {
    const outside = document.createElement('button')
    outside.className = 'grid-thing'
    document.body.append(outside)
    const area = document.createElement('div')
    document.body.append(area)
    wrapper = mount(FloatingTerminal, { props: { ctl }, attachTo: area, global: { provide: { panelCtx: gridCtx } } })
    return { outside }
  }

  it('slides in and out with its state, its terminal kept while hidden', async () => {
    mountPanel()
    const panel = wrapper.find('[data-test="floating-terminal"]')
    expect(panel.classes()).not.toContain('open')
    await ctl.toggle()
    await flushPromises()
    expect(panel.classes()).toContain('open')
    expect(wrapper.find('[data-pane-id="pane-f1"]').exists()).toBe(true)
    ctl.toggle()
    await nextTick()
    expect(panel.classes()).not.toContain('open')
    // Still mounted (off screen): the same pane, not a new one.
    expect(wrapper.find('[data-pane-id="pane-f1"]').exists()).toBe(true)
    await ctl.toggle()
    await flushPromises()
    expect(seen.mounts).toBe(1)
    expect(host.createLeaf).toHaveBeenCalledTimes(1)
  })

  it('gives its pane its own actions, never the grid pane ones', async () => {
    mountPanel()
    await ctl.show()
    await flushPromises()
    const ctx = seen.ctx
    expect(ctx.floating).toBe(true)
    expect(ctx.splitLeaf).toBeNull()
    expect(ctx.toggleMaximize).toBeNull()
    expect(ctx.beginPaneDrag).toBeNull()
    expect(ctx.broadcast.value).toBe(false)
    // Typing goes to its terminal only (no multi-write through the grid).
    ctx.routeInput('pane-f1', 'ls\r')
    expect(window.shellApi.writePty).toHaveBeenCalledWith('pane-f1', 'ls\r')
    expect(gridCtx.routeInput).not.toHaveBeenCalled()
    // Shown with the keyboard: its pane is the active one, the grid's unchanged.
    expect(ctx.activeId.value).toBe('pane-f1')
    ctx.setActive('pane-f1')
    expect(gridCtx.setActive).not.toHaveBeenCalled()
    // Close stops its terminal and hides it.
    ctx.closeLeaf('pane-f1')
    expect(window.shellApi.killPty).toHaveBeenCalledWith('pane-f1')
    expect(gridCtx.closeLeaf).not.toHaveBeenCalled()
    expect(ctl.state.open).toBe(false)
  })

  it('gives the keyboard back to where it was when hidden', async () => {
    const { outside } = mountPanel()
    outside.focus()
    expect(document.activeElement).toBe(outside)
    await ctl.show()
    await flushPromises()
    await nextTick()
    const ta = wrapper.find('.xterm-helper-textarea').element
    expect(document.activeElement).toBe(ta)
    ctl.hide()
    await nextTick()
    expect(document.activeElement).toBe(outside)
  })

  it('asks App to focus the active pane when the old focus is gone', async () => {
    mountPanel()
    await ctl.show()
    await flushPromises()
    await nextTick()
    ctl.hide()
    await nextTick()
    expect(wrapper.emitted('restore-focus')).toHaveLength(1)
  })

  it('hidden with its toolbar button, the keyboard goes back to the active pane (not the button)', async () => {
    mountPanel()
    const toggle = document.createElement('button')
    toggle.setAttribute('data-test', 'floating-terminal-toggle')
    document.body.append(toggle)
    // Clicking the button focuses it, then shows the panel.
    toggle.focus()
    await ctl.show()
    await flushPromises()
    await nextTick()
    toggle.focus()
    ctl.hide()
    await nextTick()
    expect(wrapper.emitted('restore-focus')).toHaveLength(1)
  })

  it('keeps the keyboard while a dialog borrows it; a grid pane takes it', async () => {
    mountPanel()
    await ctl.show()
    await flushPromises()
    await nextTick()
    expect(ctl.hasKeyboard()).toBe(true)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const input = document.createElement('input')
    dialog.append(input)
    document.body.append(dialog)
    input.focus()
    expect(ctl.hasKeyboard()).toBe(true)
    expect(seen.ctx.activeId.value).toBe('pane-f1')
    const gridPane = document.createElement('div')
    gridPane.className = 'pane'
    const ta = document.createElement('textarea')
    gridPane.append(ta)
    document.body.append(gridPane)
    ta.focus()
    expect(ctl.hasKeyboard()).toBe(false)
    expect(seen.ctx.activeId.value).toBe(null)
    // Its pane never defers to itself.
    expect(seen.ctx.floatingHasKeyboard).toBeNull()
  })

  it('does not hide on Escape', async () => {
    mountPanel()
    await ctl.show()
    await flushPromises()
    await wrapper.find('.xterm-helper-textarea').trigger('keydown', { key: 'Escape' })
    expect(ctl.state.open).toBe(true)
  })
})

// App.vue: the floating terminal's pane is never put in a workspace's tree,
// so the grid, the sidebar, team pickers and the saved layout (all made from
// the trees) never list it; its terminal is kept at the startup clean-up.
describe('floating terminal in App.vue', () => {
  const src = fs.readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.vue'), 'utf8')
  it('is rendered outside the grid and its leaf never enters a tree', () => {
    expect(src).toMatch(/<FloatingTerminal :ctl="floating"/)
    const grid = src.slice(src.indexOf('<SplitNode :node="view.tree" />') - 400, src.indexOf('<SplitNode :node="view.tree" />'))
    expect(grid).not.toMatch(/FloatingTerminal/)
    // Nothing assigns its leaf into a tree or a workspace.
    expect(src).not.toMatch(/floating\.state\.leaf/)
  })
  it('a grid pane that mounts or the keyboard given back after a dialog never goes under it', () => {
    expect(src).toMatch(/floatingHasKeyboard: \(\) => floating\.hasKeyboard\(\)/)
    const fn = src.slice(src.indexOf('function focusActiveInput()'), src.indexOf('function focusActiveInput()') + 400)
    expect(fn).toMatch(/if \(floating\.hasKeyboard\(\)\)/)
    const pane = fs.readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'components', 'TerminalPane.vue'), 'utf8')
    expect(pane).toMatch(/if \(isActive\.value && !\(ctx\.floatingHasKeyboard && ctx\.floatingHasKeyboard\(\)\)\) termFocus\(\)/)
    const editor = fs.readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'components', 'EditorPane.vue'), 'utf8')
    expect(editor).toMatch(/if \(isActive\.value && !\(ctx\.floatingHasKeyboard && ctx\.floatingHasKeyboard\(\)\)\) focusEditor\(\)/)
  })
  it('keeps its terminal when unused host terminals are closed', () => {
    const at = src.indexOf('window.shellApi.reconcilePtys(ids)')
    expect(src.slice(at - 200, at)).toMatch(/ids\.push\(\.\.\.floating\.ptyIds\(\)\)/)
  })
})
