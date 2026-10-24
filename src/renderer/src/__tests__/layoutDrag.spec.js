// Dragging the projects sidebar's edge or the right panel's (layoutDrag.js,
// WorkspaceSidebar.vue, App.vue's startTaskResize): the edge follows the
// pointer through its own style, once a frame; App's width is set once,
// when it is let go (set on every frame it re-rendered the window and the
// sidebar's rows); the terminals are told to fit once, at the end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { beginLayoutDrag, frameFollower, layoutDragging, _resetLayoutDragForTests } from '../layoutDrag'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import { resetSettings } from '../settings'
import { RESIZE_COLLAPSE_BELOW, RESIZE_DOUBLE_CLICK_MS } from '../layoutLimits'

// Animation frames run by hand.
let frames = []
function runFrame() {
  const due = frames
  frames = []
  for (const f of due) f.cb(0)
}
let layoutEvents = 0
const countLayout = () => layoutEvents++

beforeEach(() => {
  frames = []
  layoutEvents = 0
  _resetLayoutDragForTests()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (cb) => {
    frames.push({ id: ++id, cb })
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (n) => {
    frames = frames.filter((f) => f.id !== n)
  })
  window.addEventListener('terminal-layout-change', countLayout)
})
afterEach(() => {
  window.removeEventListener('terminal-layout-change', countLayout)
  vi.unstubAllGlobals()
  _resetLayoutDragForTests()
})

describe('layoutDrag', () => {
  it('is on while a drag runs; its end tells the terminals once, when the last drag ends', () => {
    expect(layoutDragging()).toBe(false)
    const a = beginLayoutDrag()
    const b = beginLayoutDrag()
    expect(layoutDragging()).toBe(true)
    a()
    a()
    expect(layoutDragging()).toBe(true)
    expect(layoutEvents).toBe(0)
    b()
    expect(layoutDragging()).toBe(false)
    expect(layoutEvents).toBe(1)
  })

  it('covers the window with one element for the cursor while it runs, never a rule on every element', () => {
    const end = beginLayoutDrag()
    expect(document.body.classList.contains('ws-resizing')).toBe(true)
    expect(document.querySelectorAll('.layout-drag-shield')).toHaveLength(1)
    const second = beginLayoutDrag()
    expect(document.querySelectorAll('.layout-drag-shield')).toHaveLength(1)
    second()
    end()
    expect(document.body.classList.contains('ws-resizing')).toBe(false)
    expect(document.querySelectorAll('.layout-drag-shield')).toHaveLength(0)
    // Switching such a rule on restyled the whole window (~100 ms) at both ends.
    const css = fs.readFileSync(join(process.cwd(), 'src/renderer/src/style.css'), 'utf8')
    expect(css).not.toMatch(/\.ws-resizing\s+\*/)
    expect(css).toMatch(/\.layout-drag-shield \{[^}]*cursor: col-resize/)
    // The hidden projects' panes are left as they are until it ends.
    expect(css).toMatch(/body\.ws-resizing \.ws-layer\.hidden \.view-room \{\s*content-visibility: hidden;/)
  })

  it('applies the last width asked for once a frame, and at once when let go', () => {
    const applied = []
    const follow = frameFollower((px) => applied.push(px))
    follow.set(300)
    follow.set(310)
    follow.set(320)
    expect(applied).toEqual([])
    expect(frames).toHaveLength(1)
    runFrame()
    expect(applied).toEqual([320])
    follow.set(330)
    expect(follow.finish()).toBe(330)
    expect(applied).toEqual([320, 330])
    // The frame asked for is cancelled: nothing applied twice.
    runFrame()
    expect(applied).toEqual([320, 330])
    expect(frameFollower(() => {}).finish()).toBe(null)
  })
})

describe('the right panel’s edge (App.vue startTaskResize)', () => {
  const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
  function slice(from, to) {
    const a = source.indexOf(from)
    const b = source.indexOf(to, a)
    if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
    return source.slice(a, b)
  }
  function load() {
    let drag = null
    const ctx = {
      taskPanelWidth: { value: 330 },
      taskResizing: { value: false },
      TASK_PANEL_DEFAULT: 330,
      RESIZE_COLLAPSE_BELOW,
      RESIZE_DOUBLE_CLICK_MS,
      taskPanelOpen: { value: true },
      taskPanelShown: { value: 330 },
      clampTaskPanel: (w) => Math.round(Math.min(1200, Math.max(260, w))),
      trackPointerDrag: (_e, handlers) => (drag = handlers),
      beginLayoutDrag,
      frameFollower,
      nextTick,
      document,
      window,
      Date,
      Event
    }
    vm.createContext(ctx)
    vm.runInContext(slice('let taskResizeLastDown = 0', '// Looked up through an index') + '\nthis.startTaskResize = startTaskResize', ctx)
    // The handle sits in a slot beside the panel (outside its clip).
    const aside = document.createElement('aside')
    aside.getBoundingClientRect = () => ({ right: 1900 })
    const slot = document.createElement('div')
    const handle = document.createElement('div')
    slot.append(handle)
    const content = document.createElement('div')
    content.className = 'side-panel'
    content.getBoundingClientRect = () => ({ width: 329 })
    aside.append(content)
    document.body.append(slot, aside)
    ctx.startTaskResize({ button: 0, preventDefault() {}, currentTarget: handle })
    return { ctx, aside, content, drag: () => drag }
  }

  it('follows the pointer by its own style once a frame; its width and the terminals’ fit come once, when let go', async () => {
    const { ctx, aside, content, drag } = load()
    expect(ctx.taskResizing.value).toBe(true)
    expect(layoutDragging()).toBe(true)
    // Its tabs keep their width against the window's edge until it ends.
    expect(content.style.width).toBe('329px')
    expect(content.style.alignSelf).toBe('flex-end')
    drag().onMove({ clientX: 1500 })
    drag().onMove({ clientX: 1480 })
    runFrame()
    expect(aside.style.flexBasis).toBe('420px')
    drag().onMove({ clientX: 1450 })
    runFrame()
    expect(aside.style.flexBasis).toBe('450px')
    // Nothing else moved meanwhile: no width, no refit.
    expect(ctx.taskPanelWidth.value).toBe(330)
    expect(layoutEvents).toBe(0)
    drag().onMove({ clientX: 1440 })
    drag().onEnd()
    expect(aside.style.flexBasis).toBe('460px')
    expect(content.style.width).toBe('')
    expect(content.style.alignSelf).toBe('')
    expect(ctx.taskPanelWidth.value).toBe(460)
    expect(ctx.taskResizing.value).toBe(false)
    await nextTick()
    expect(layoutDragging()).toBe(false)
    expect(layoutEvents).toBe(1)
  })

  it('closes when dragged shut like the sidebar collapses, keeping its width; a second press resets it', async () => {
    const { ctx, aside, drag } = load()
    drag().onMove({ clientX: 1900 - RESIZE_COLLAPSE_BELOW + 5 })
    runFrame()
    drag().onEnd()
    expect(ctx.taskPanelOpen.value).toBe(false)
    expect(ctx.taskPanelWidth.value).toBe(330)
    expect(aside.style.flexBasis).toBe('330px')
    await nextTick()
    expect(layoutEvents).toBe(1)
    // Dragged back out before it is let go: it stays open.
    const again = load()
    again.drag().onMove({ clientX: 1900 - 50 })
    again.drag().onMove({ clientX: 1500 })
    again.drag().onEnd()
    expect(again.ctx.taskPanelOpen.value).toBe(true)
    expect(again.ctx.taskPanelWidth.value).toBe(400)
  })

  it('has the sidebar’s handle: 12 px straddling the border, beside the panel, same shared limits', () => {
    const css = fs.readFileSync(join(process.cwd(), 'src/renderer/src/style.css'), 'utf8')
    expect(css).toMatch(/\.task-resize \{[^}]*left: -6px;[^}]*width: 12px;[^}]*cursor: col-resize/)
    expect(css).toMatch(/\.task-panel\.resizing \{\s*transition: none;/)
    expect(source).toContain('class="task-resize-slot"')
    expect(source).toContain('RESIZE_COLLAPSE_BELOW')
    const sidebar = fs.readFileSync(join(process.cwd(), 'src/renderer/src/components/WorkspaceSidebar.vue'), 'utf8')
    expect(sidebar).toContain('RESIZE_COLLAPSE_BELOW')
    expect(sidebar).toContain('RESIZE_DOUBLE_CLICK_MS')
  })

  it('keeps one style object for the panel until its width changes (a re-render never puts the old width back mid-drag)', () => {
    expect(source).toContain(":style=\"taskPanelStyle\"")
    expect(source).toMatch(/const taskPanelStyle = computed\(\(\) => \(\{ flexBasis: taskPanelShown\.value \+ 'px' \}\)\)/)
  })

  it('the sidebar’s width is App’s once, when its edge is let go (no frame of its own)', () => {
    const fn = slice('function resizeSidebar(w)', 'function toggleSidebar()')
    expect(fn).not.toMatch(/requestAnimationFrame|terminal-layout-change/)
  })
})

describe('the projects sidebar’s edge (WorkspaceSidebar.vue)', () => {
  let w
  beforeEach(() => {
    resetSettings()
    window.shellApi = {}
  })
  afterEach(() => {
    w?.unmount()
    document.body.innerHTML = ''
    delete window.shellApi
  })
  const at = (type, x, target = window) => target.dispatchEvent(new MouseEvent(type, { clientX: x, button: 0, bubbles: true }))

  it('follows the pointer by its own style; App gets the width once, at the end, then the terminals fit', async () => {
    w = mount(WorkspaceSidebar, { props: { projects: [], currentId: null, width: 280, now: Date.now(), teams: [] }, attachTo: document.body })
    const nav = w.find('nav.osb').element
    at('pointerdown', 280, w.find('.osb-resize').element)
    expect(layoutDragging()).toBe(true)
    at('pointermove', 330)
    at('pointermove', 360)
    runFrame()
    expect(nav.style.flexBasis).toBe('360px')
    at('pointermove', 400)
    runFrame()
    expect(nav.style.flexBasis).toBe('400px')
    expect(w.emitted('resize')).toBeUndefined()
    expect(layoutEvents).toBe(0)
    at('pointermove', 410)
    at('pointerup', 410)
    expect(nav.style.flexBasis).toBe('410px')
    expect(w.emitted('resize')).toEqual([[410]])
    expect(w.emitted('resize-end')).toHaveLength(1)
    await nextTick()
    expect(layoutDragging()).toBe(false)
    expect(layoutEvents).toBe(1)
  })

  it('dragged far left, it still collapses at its old width', async () => {
    w = mount(WorkspaceSidebar, { props: { projects: [], currentId: null, width: 280, now: Date.now(), teams: [] }, attachTo: document.body })
    at('pointerdown', 280, w.find('.osb-resize').element)
    at('pointermove', 150)
    runFrame()
    at('pointermove', 60)
    at('pointerup', 60)
    expect(w.emitted('resize')).toEqual([[280]])
    expect(w.emitted('toggle')).toHaveLength(1)
    expect(w.emitted('resize-end')).toHaveLength(1)
    await nextTick()
    expect(layoutDragging()).toBe(false)
  })
})
