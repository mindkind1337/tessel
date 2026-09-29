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
    expect(chatSetOption).toHaveBeenCalledWith(node, { model: other.getAttribute('data-choice') })
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
