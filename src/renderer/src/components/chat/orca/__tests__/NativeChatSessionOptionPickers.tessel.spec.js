// NativeChatSessionOptionPickers in a Tessel pane: the real menu primitives,
// fed as the lead does (useNativeChatSessionOptionCommand's dispatch and
// confirmed values, tesselSessionOptionSnapshot / tesselSessionOptionSurface),
// with the "permission mode (header)" and "model menu" cases of
// chatPane.spec.js: Claude's modes, Yolo only for a chat started in Yolo, a
// capped worker gets neither Yolo nor Auto, a choice goes through the
// pane's setOption (ctx.chatSetOption) and shows only once confirmed, a
// refusal stays and says so, Codex: Manual and Yolo, never Yolo during a
// turn; the menu's a11y and Escape.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, flushPromises, mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, reactive } from 'vue'
import NativeChatSessionOptionPickers from '../NativeChatSessionOptionPickers.vue'
import { tesselSessionOptionSnapshot, tesselSessionOptionSurface } from '../native-chat-session-option-pickers.js'
import { useNativeChatSessionOptionCommand } from '../../../../chat/orca/composables/use-native-chat-session-option-command.js'
import { modelsFor } from '../../../../agentModels.js'

config.global.stubs.transition = false

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  document.body.style.pointerEvents = ''
})

async function mountPane(extraNode = {}, { isWorking = false, chatSetOption = vi.fn(async () => ({ ok: true })), toast = vi.fn() } = {}) {
  const node = reactive({ id: 'c1', agentId: 'claude', model: null, effort: null, chatPermissionMode: 'default', chatLaunchYolo: false, maxPermissions: null, ...extraNode })
  const state = reactive({ isWorking })
  const Pane = defineComponent({
    setup() {
      const command = useNativeChatSessionOptionCommand({
        scopeKey: () => node.id,
        node: () => node,
        agent: () => node.agentId,
        isWorking: () => state.isWorking,
        values: () => ({ ...(node.model ? { model: node.model } : {}), ...(node.effort ? { effort: node.effort } : {}) }),
        permissionMode: () => node.chatPermissionMode,
        // The pane's ctx.chatSetOption (so the worker cap follows).
        setOption: (payload) => chatSetOption(node, payload)
      })
      const snapshot = computed(() =>
        tesselSessionOptionSnapshot({ agent: node.agentId, models: modelsFor(node.agentId), values: command.confirmedValues.value, modeBlocked: command.modeBlocked })
      )
      const surface = tesselSessionOptionSurface(command.dispatch)
      return () =>
        h('div', [
          h('textarea', { 'data-test': 'chat-input' }),
          h(NativeChatSessionOptionPickers, { surface, snapshot: snapshot.value, isWorking: state.isWorking })
        ])
    }
  })
  wrapper = mount(Pane, { attachTo: document.body, global: { provide: { panelCtx: { toast } } } })
  await flushPromises()
  return { node, state, chatSetOption, toast }
}

const trigger = (which) => document.querySelector(`[data-native-chat-picker="${which}"]`)
async function openMenu(which) {
  trigger(which).dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
  await flushPromises()
  await nextTick()
}
const menu = () => document.querySelector('[role="menu"]:not(.nc-ui-leave-active)')
const modeGroup = () => menu() && [...menu().querySelectorAll('[role="group"]')].find((g) => g.getAttribute('aria-label') === 'Permission mode')
const modes = () =>
  [...modeGroup().querySelectorAll('[role="menuitemradio"]')].map((o) => ({ id: o.getAttribute('data-choice'), disabled: o.getAttribute('aria-disabled') === 'true' }))
const modeItem = (id) => modeGroup().querySelector(`[data-choice="${id}"]`)
async function pick(el) {
  el.click()
  await flushPromises()
  await nextTick()
}

// PointerEvent is not in every jsdom: a MouseEvent with its fields.
if (typeof globalThis.PointerEvent === 'undefined') {
  globalThis.PointerEvent = class extends MouseEvent {}
}

describe('permission mode (the options pill)', () => {
  it.each(['model', 'options'])('the %s menu changes effort by dragging and keyboard without closing', async (which) => {
    const chatSetOption = vi.fn(async (_node, payload) => ({ ok: true, ...payload }))
    const { node } = await mountPane({ model: 'opus', effort: 'medium' }, { chatSetOption })
    expect(trigger('model').textContent).toContain('Medium')
    expect(trigger('model').querySelector('.nc-picker-model-name').textContent).toContain('Opus')
    expect(trigger('options').textContent.trim()).toBe('Manual')
    await openMenu(which)
    const slider = menu().querySelector('[role="slider"]')
    expect(slider).not.toBeNull()
    expect(slider.getAttribute('aria-valuetext')).toBe('Medium')
    slider.getBoundingClientRect = () => ({ left: 0, width: 116 })
    slider.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 8, bubbles: true }))
    slider.dispatchEvent(new PointerEvent('pointermove', { clientX: 108, bubbles: true }))
    expect(chatSetOption).not.toHaveBeenCalled()
    slider.dispatchEvent(new PointerEvent('pointerup', { clientX: 108, bubbles: true }))
    await flushPromises()
    expect(chatSetOption).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    expect(trigger('model').textContent).toContain('Max')
    expect(trigger('options').textContent.trim()).toBe('Manual')
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(chatSetOption).not.toHaveBeenCalled()
    expect(slider.getAttribute('aria-valuetext')).toBe('Extra high')
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(chatSetOption).not.toHaveBeenCalled()
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(trigger(which)).toBe(document.activeElement)
    expect(chatSetOption).toHaveBeenCalledExactlyOnceWith(node, { model: 'opus', effort: 'max' })
  })

  it('omits the slider for a model without effort levels', async () => {
    await mountPane({ model: 'haiku' })
    await openMenu('model')
    expect(menu().querySelector('[role="slider"]')).toBeNull()
  })

  it('applies nothing after opening or after changing back to the initial effort', async () => {
    const { chatSetOption } = await mountPane({ model: 'opus', effort: 'medium' })
    for (const change of [false, true]) {
      await openMenu('model')
      const slider = menu().querySelector('[role="slider"]')
      if (change) {
        for (const key of ['End', 'Home', 'ArrowRight']) {
          slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
          await nextTick()
        }
      }
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await flushPromises()
    }
    expect(chatSetOption).not.toHaveBeenCalled()
  })

  it('does not apply a model selection changed back before closing', async () => {
    const { chatSetOption } = await mountPane({ model: 'opus', effort: 'medium' })
    await openMenu('model')
    await pick(menu().querySelector('[data-choice="sonnet"]'))
    await pick(menu().querySelector('[data-choice="opus"]'))
    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(chatSetOption).not.toHaveBeenCalled()
  })

  it('applies one model/effort pair when clicking outside after selecting both', async () => {
    const { node, chatSetOption } = await mountPane({ model: 'opus', effort: 'medium' })
    await openMenu('model')
    await pick(menu().querySelector('[data-choice="sonnet"]'))
    const slider = menu().querySelector('[role="slider"]')
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await nextTick()
    expect(chatSetOption).not.toHaveBeenCalled()
    document.querySelector('[data-test="chat-input"]').dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
    await flushPromises()
    expect(chatSetOption).toHaveBeenCalledExactlyOnceWith(node, { model: 'sonnet', effort: 'low' })
  })

  it('applies the pending effort and chosen mode together when the mode closes the menu', async () => {
    const { node, chatSetOption } = await mountPane({ model: 'opus', effort: 'medium' })
    await openMenu('options')
    menu().querySelector('[role="slider"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await nextTick()
    expect(chatSetOption).not.toHaveBeenCalled()
    await pick(modeItem('plan'))
    expect(chatSetOption).toHaveBeenCalledExactlyOnceWith(node, { model: 'opus', effort: 'max', permissionMode: 'plan' })
  })

  it('removes unsupported effort when a model without levels is selected', async () => {
    const { node, chatSetOption } = await mountPane({ model: 'opus', effort: 'max' })
    await openMenu('model')
    await pick(menu().querySelector('[data-choice="haiku"]'))
    expect(menu().querySelector('[role="slider"]')).toBeNull()
    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(chatSetOption).toHaveBeenCalledExactlyOnceWith(node, { model: 'haiku' })
  })

  it('Claude: its modes; Yolo only for a chat started in Yolo', async () => {
    await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: false })
    await openMenu('options')
    expect(modes()).toEqual([
      { id: 'default', disabled: false },
      { id: 'acceptEdits', disabled: false },
      { id: 'plan', disabled: false },
      { id: 'auto', disabled: false },
      { id: 'bypassPermissions', disabled: true }
    ])
    expect(modeItem('bypassPermissions').getAttribute('title')).toBe('Yolo only for a chat started in Yolo (Settings > Agents)')
    expect(modeItem('default').getAttribute('aria-checked')).toBe('true')
    expect(trigger('options').getAttribute('aria-label')).toMatch(/Manual/)
  })

  it('a choice goes through ctx.chatSetOption (so the worker cap follows); shown only once confirmed', async () => {
    let confirm
    const chatSetOption = vi.fn(
      (leaf, p) =>
        new Promise((r) => {
          confirm = () => {
            leaf.chatPermissionMode = p.permissionMode
            r({ ok: true, permissionMode: p.permissionMode, permissions: 'manual' })
          }
        })
    )
    const { node } = await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
    await openMenu('options')
    await pick(modeItem('plan'))
    expect(chatSetOption).toHaveBeenCalledWith(node, { permissionMode: 'plan' })
    // Not confirmed yet: still Manual, and nothing else can be picked meanwhile.
    expect(trigger('options').textContent).toContain('Manual')
    await openMenu('options')
    expect(modeItem('default').getAttribute('aria-checked')).toBe('true')
    expect(modeItem('plan').getAttribute('aria-checked')).toBe('false')
    expect(modeItem('acceptEdits').getAttribute('aria-disabled')).toBe('true')
    confirm()
    await flushPromises()
    await nextTick()
    expect(modeItem('plan').getAttribute('aria-checked')).toBe('true')
    expect(trigger('options').textContent).toContain('Plan')
  })

  it('refused: stays as it was, and says so', async () => {
    const chatSetOption = vi.fn(async () => ({ ok: false, error: 'no' }))
    const { toast } = await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
    await openMenu('options')
    await pick(modeItem('acceptEdits'))
    expect(chatSetOption).toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Could not update option: no', expect.any(Object))
    await openMenu('options')
    expect(modeItem('default').getAttribute('aria-checked')).toBe('true')
    expect(modeItem('acceptEdits').getAttribute('aria-checked')).toBe('false')
  })

  it('a capped worker: no Yolo and no Auto, even started in Yolo', async () => {
    const chatSetOption = vi.fn(async () => ({ ok: true }))
    await mountPane({ chatPermissionMode: 'default', chatLaunchYolo: true, maxPermissions: 'manual' }, { chatSetOption })
    await openMenu('options')
    const o = modes()
    expect(o.find((x) => x.id === 'bypassPermissions').disabled).toBe(true)
    expect(o.find((x) => x.id === 'auto').disabled).toBe(true)
    await pick(modeItem('bypassPermissions'))
    expect(chatSetOption).not.toHaveBeenCalled()
  })

  it('Codex: Manual and Yolo; never Yolo during a turn (it would stop the turn)', async () => {
    const chatSetOption = vi.fn(async () => ({ ok: true }))
    const { state } = await mountPane({ agentId: 'codex', chatPermissionMode: 'default', chatLaunchYolo: true }, { chatSetOption })
    await openMenu('options')
    expect(modes()).toEqual([
      { id: 'default', disabled: false },
      { id: 'bypassPermissions', disabled: false }
    ])
    state.isWorking = true
    await nextTick()
    expect(modes().find((x) => x.id === 'bypassPermissions').disabled).toBe(true)
    await pick(modeItem('bypassPermissions'))
    expect(chatSetOption).not.toHaveBeenCalled()
  })

  it('the mode it is in is never shown as blocked (a Codex chat in Yolo, during a turn)', async () => {
    await mountPane({ agentId: 'codex', chatPermissionMode: 'bypassPermissions', chatLaunchYolo: true }, { isWorking: true })
    await openMenu('options')
    expect(modes().find((x) => x.id === 'bypassPermissions').disabled).toBe(false)
    expect(modeItem('bypassPermissions').getAttribute('aria-checked')).toBe('true')
  })
})

describe('model menu', () => {
  it('aria-expanded and aria-controls, the focus goes in, Esc closes it back to the chip and goes no further', async () => {
    const claude = modelsFor('claude')
    await mountPane({ model: claude[0].id })
    const chip = trigger('model')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    await openMenu('model')
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(chip.getAttribute('aria-controls')).toBe(menu().id)
    expect(menu().contains(document.activeElement)).toBe(true)
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    try {
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      document.activeElement.dispatchEvent(esc)
      await flushPromises()
    } finally {
      window.removeEventListener('keydown', seen)
    }
    expect(seen).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip)
  })

  it('a choice goes through the pane, closes the menu back to the chip, and shows once confirmed', async () => {
    const claude = modelsFor('claude')
    const chatSetOption = vi.fn(async (leaf, p) => {
      leaf.model = p.model
      return { ok: true }
    })
    const { node } = await mountPane({ model: claude[0].id }, { chatSetOption })
    await openMenu('model')
    const other = [...menu().querySelectorAll('[role="menuitemradio"]')].find((b) => b.getAttribute('data-choice') !== claude[0].id)
    await pick(other)
    expect(chatSetOption).not.toHaveBeenCalled()
    expect(menu()).not.toBeNull()
    menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(chatSetOption).toHaveBeenCalledExactlyOnceWith(node, { model: other.getAttribute('data-choice'), effort: 'medium' })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger('model'))
    expect(trigger('model').textContent).toContain(claude.find((m) => m.id === node.model).label)
  })

  it('a click elsewhere closes it and leaves the focus where the user went (the reference modal menu keeps Tab inside)', async () => {
    const claude = modelsFor('claude')
    await mountPane({ model: claude[0].id })
    await openMenu('model')
    expect(menu()).not.toBeNull()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.activeElement.dispatchEvent(tab)
    await flushPromises()
    expect(menu()).not.toBeNull()
    expect(menu().contains(document.activeElement)).toBe(true)
    const input = document.querySelector('[data-test="chat-input"]')
    input.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }))
    await flushPromises()
    expect(menu()).toBeNull()
    input.focus()
    await flushPromises()
    expect(document.activeElement).toBe(input)
  })

  it('waits for the end of a turn (the reference disables the pill while working)', async () => {
    const claude = modelsFor('claude')
    await mountPane({ model: claude[0].id }, { isWorking: true })
    expect(trigger('model').disabled).toBe(true)
    await openMenu('model')
    expect(menu()).toBeNull()
  })
})

describe('the reported full id and the listed alias', () => {
  it('claude-opus-5-5 reported: the listed "Opus 5.5" (opus) row is the current one, no extra row', () => {
    const models = [
      { id: 'opus', label: 'Opus 5.5', options: [] },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', options: [] }
    ]
    const snap = tesselSessionOptionSnapshot({ agent: 'claude', models, values: { model: 'claude-opus-5-5' } })
    const option = snap.options ? snap.options.find((o) => o.id === 'model') : snap.find((o) => o.id === 'model')
    expect(option.kind.currentValue).toBe('opus')
    expect(option.kind.choices.map((c) => c.value)).toEqual(['opus', 'claude-fable-5-1'])
  })
})
