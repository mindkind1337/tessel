// NativeChatSessionOptionPickers (after Orca's NativeChatSessionOptionPickers
// .test.tsx, MIT, Copyright (c) 2026 Lovecast Inc.): the same stand-ins for
// the menu primitives (every row rendered, a radio group that reports
// picks), the same cases.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../ui/index.js', async (importOriginal) => {
  const actual = await importOriginal()
  const { defineComponent: dc, h: hh, inject: inj, provide: prov } = await import('vue')
  const GROUP = Symbol('group')
  const slot = (name = 'div', attrs = {}) =>
    dc({
      inheritAttrs: false,
      setup(_, { slots, attrs: a }) {
        return () => hh(name, { ...a, ...attrs }, slots.default?.())
      }
    })
  return {
    ...actual,
    Button: dc({ setup: (_, { slots }) => () => hh('button', slots.default?.()) }),
    Tooltip: dc({ setup: (_, { slots }) => () => slots.default?.() }),
    TooltipTrigger: dc({ setup: (_, { slots }) => () => slots.default?.() }),
    TooltipContent: slot('div'),
    DropdownMenu: dc({
      props: { defaultOpen: Boolean },
      setup: (p, { slots }) => () => hh('div', { 'data-testid': 'dropdown-root', 'data-open': p.defaultOpen ? 'true' : 'false' }, slots.default?.())
    }),
    DropdownMenuTrigger: dc({
      props: { disabled: Boolean, asChild: Boolean },
      setup: (p, { slots }) => () => hh('div', { 'data-disabled': p.disabled ? 'true' : undefined }, slots.default?.())
    }),
    DropdownMenuContent: dc({
      props: { side: String, collisionPadding: Number, align: String },
      setup: (p, { slots }) => () => hh('div', { 'data-testid': 'session-option-menu', 'data-side': p.side, 'data-collision-padding': p.collisionPadding }, slots.default?.())
    }),
    DropdownMenuLabel: slot('div'),
    DropdownMenuSeparator: dc({ setup: () => () => hh('hr') }),
    // Forwards role/aria-* and hands select an event: the switch rows set both,
    // and preventDefault is how a toggle keeps the menu open.
    DropdownMenuItem: dc({
      inheritAttrs: false,
      props: { disabled: Boolean },
      emits: ['select'],
      setup: (p, { slots, attrs, emit }) => () =>
        hh('button', { ...attrs, disabled: p.disabled, onClick: () => emit('select', { preventDefault: () => {} }) }, slots.default?.())
    }),
    // The value binding and change contract the real group provides; the
    // selected value is exposed as data-radio-value.
    DropdownMenuRadioGroup: dc({
      props: { modelValue: [String, Boolean, Number] },
      emits: ['update:modelValue'],
      setup(p, { slots, attrs, emit }) {
        prov(GROUP, { value: () => p.modelValue, select: (v) => emit('update:modelValue', v) })
        return () => hh('div', { role: 'radiogroup', 'aria-label': attrs['aria-label'], 'data-radio-value': p.modelValue ?? '' }, slots.default?.())
      }
    }),
    DropdownMenuRadioItem: dc({
      inheritAttrs: false,
      props: { value: [String, Boolean, Number], disabled: Boolean },
      setup(p, { slots }) {
        const group = inj(GROUP)
        return () => {
          const selected = p.value !== undefined && p.value === group.value()
          return hh(
            'button',
            { role: 'radio', 'aria-checked': selected ? 'true' : 'false', disabled: p.disabled, 'data-value': p.value, 'data-state': selected ? 'checked' : 'unchecked', onClick: () => group.select(p.value) },
            slots.default?.()
          )
        }
      }
    })
  }
})

import NativeChatSessionOptionPickers from '../NativeChatSessionOptionPickers.vue'

const surface = { getSnapshot: vi.fn(() => []), setOption: vi.fn(), invokeAction: vi.fn(), subscribe: vi.fn(() => vi.fn()) }

function model(overrides = {}) {
  return {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: { type: 'select', currentValue: 'opus', choices: [{ value: 'opus', label: 'Opus 4.8' }, { value: 'sonnet', label: 'Sonnet 5' }] },
    valueSource: 'applied',
    transport: 'catalog',
    settable: true,
    ...overrides
  }
}
const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]
const effort = { id: 'effort', label: 'Effort', category: 'thought_level', kind: { type: 'select', currentValue: 'high', choices: EFFORT_CHOICES }, valueSource: 'applied', transport: 'catalog', settable: true }
// A select with nothing picked.
const unknownEffort = { ...effort, kind: { type: 'select', choices: EFFORT_CHOICES }, valueSource: 'unknown' }
const fast = { id: 'fastMode', label: 'Fast mode', category: 'mode', kind: { type: 'boolean', currentValue: true }, valueSource: 'applied', transport: 'catalog', settable: true }

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function render(props) {
  wrapper = mount(NativeChatSessionOptionPickers, { props: { surface, isWorking: false, ...props }, attachTo: document.body })
  return wrapper
}
const buttonNamed = (name) =>
  [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === name) || null
const buttonsMatching = (re) => [...document.querySelectorAll('button')].filter((b) => re.test(b.getAttribute('aria-label') ?? b.textContent.trim()))
const allText = (s) => [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent.trim() === s)
const switchNamed = (name) => document.querySelector(`[role="switch"][aria-label="${name}"]`)

describe('NativeChatSessionOptionPickers', () => {
  it('opens the native picker requested by a structured slash command', async () => {
    render({ snapshot: [model(), effort], pickerRequest: null })
    await wrapper.setProps({ pickerRequest: { id: 'model', sequence: 1 } })
    expect(buttonNamed('Model Opus 4.8').closest('[data-testid="dropdown-root"]').getAttribute('data-open')).toBe('true')
    await wrapper.setProps({ pickerRequest: { id: 'effort', sequence: 2 } })
    expect(buttonNamed('Effort High').closest('[data-testid="dropdown-root"]').getAttribute('data-open')).toBe('true')
  })

  it('prefers collision-aware upward placement for model and option menus', () => {
    render({ snapshot: [model(), effort] })
    const menus = document.querySelectorAll('[data-testid="session-option-menu"]')
    expect(menus).toHaveLength(2)
    for (const menu of menus) {
      expect(menu.getAttribute('data-side')).toBe('top')
      expect(menu.getAttribute('data-collision-padding')).toBe('8')
    }
  })

  it('renders model and joined option labels, and hides an empty options pill', async () => {
    render({ snapshot: [model(), effort, fast] })
    expect(buttonNamed('Model Opus 4.8').textContent).toContain('Opus 4.8')
    expect(buttonNamed('Model Opus 4.8').textContent).not.toContain('Model:')
    expect(buttonNamed('Effort High · Fast').textContent).toContain('High · Fast')
    expect(buttonNamed('Model Opus 4.8').compareDocumentPosition(buttonNamed('Effort High · Fast')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    await wrapper.setProps({ snapshot: [model()] })
    expect(buttonsMatching(/Effort/)).toHaveLength(0)
  })

  it('names a lone unknown effort control explicitly', () => {
    render({ snapshot: [model(), unknownEffort] })
    expect(buttonNamed('Effort').textContent).toContain('Effort')
  })

  it('disables both picker triggers while the agent is working', () => {
    render({ snapshot: [model(), effort], isWorking: true })
    expect(buttonNamed('Model Opus 4.8').parentElement.getAttribute('data-disabled')).toBe('true')
    expect(buttonNamed('Effort High').parentElement.getAttribute('data-disabled')).toBe('true')
  })

  it('does not duplicate titles for unknown values or misname generic controls', async () => {
    render({ snapshot: [model({ kind: { type: 'select', choices: [] }, valueSource: 'unknown' }), unknownEffort] })
    expect(buttonNamed('Model').textContent).toContain('Model')
    expect(buttonNamed('Model').textContent).not.toContain('Model: Model')
    expect(buttonNamed('Effort').textContent).not.toContain('Effort: Effort')
    await wrapper.setProps({ snapshot: [model(), fast] })
    expect(buttonNamed('Session options Fast').textContent).toContain('Fast')
    expect(buttonsMatching(/^Effort/)).toHaveLength(0)
  })

  // The terminal transport typed the value at the agent and has not read it
  // back, so the pill says so; the structured transport's per-turn report is
  // the confirmation.
  it('hedges a dispatched value the terminal transport produced', () => {
    render({ snapshot: [model({ valueSource: 'dispatched', transport: 'catalog' })] })
    expect(allText('Model').length).toBeGreaterThan(0)
    expect(allText('Sent to the agent — not confirmed').length).toBeGreaterThan(0)
  })

  it('does not hedge a dispatched value the structured transport produced', () => {
    render({ snapshot: [model({ valueSource: 'dispatched', transport: 'agent-session' })] })
    expect(allText('Model').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/not confirmed/)
  })

  it.each(['catalog', 'agent-session'])('does not hedge a reported value on the %s transport', (transport) => {
    render({ snapshot: [model({ valueSource: 'reported', transport })] })
    expect(allText('Model').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/not confirmed/)
  })

  it('renders agent-picker routes as one action instead of radio choices', async () => {
    const invokeAction = vi.fn().mockResolvedValue({ snapshot: [] })
    render({
      surface: { ...surface, invokeAction },
      snapshot: [
        model({
          kind: { type: 'select', choices: [{ value: 'gpt-5.5', label: 'GPT-5.5' }, { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' }] },
          valueSource: 'unknown',
          action: { type: 'agent-picker' }
        })
      ]
    })
    expect(buttonNamed('Choose in agent picker…')).not.toBeNull()
    expect(document.body.textContent).not.toContain('GPT-5.5')
    expect(document.body.textContent).not.toContain('GPT-5.2 Codex')
    buttonNamed('Choose in agent picker…').click()
    await flushPromises()
    expect(invokeAction).toHaveBeenCalledWith('model')
  })

  it('uses a Toggle action for unknown flip-only options via invokeAction', async () => {
    const invokeAction = vi.fn().mockResolvedValue({ snapshot: [] })
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render({
      surface: { ...surface, setOption, invokeAction },
      snapshot: [model(), { ...fast, kind: { type: 'boolean', currentValue: false }, valueSource: 'unknown', action: { type: 'toggle-command' } }]
    })
    expect(allText('Toggle fast mode')).toHaveLength(1)
    expect(allText('On')).toHaveLength(0)
    expect(allText('Off')).toHaveLength(0)
    buttonNamed('Toggle fast mode').click()
    await flushPromises()
    expect(invokeAction).toHaveBeenCalledWith('fastMode')
    expect(setOption).not.toHaveBeenCalled()
  })

  it('uses one switch row for a boolean option without inventing a selection', async () => {
    const setOption = vi.fn().mockResolvedValue({ snapshot: [] })
    render({ surface: { ...surface, setOption }, snapshot: [model(), { ...fast, kind: { type: 'boolean', currentValue: true }, valueSource: 'applied', action: undefined }] })
    expect(allText('Toggle fast mode')).toHaveLength(0)
    // One control, not an On/Off pair, and the row carries the label itself.
    expect(document.querySelector('[role="radio"][aria-label="On"]')).toBeNull()
    const fastSwitch = switchNamed('Fast mode')
    expect(fastSwitch.getAttribute('aria-checked')).toBe('true')
    expect(fastSwitch.querySelector('[data-slot="switch-indicator"]').getAttribute('data-state')).toBe('checked')
    // The label is not duplicated by a separate group header.
    expect(allText('Fast mode')).toHaveLength(1)
    fastSwitch.click()
    await flushPromises()
    expect(setOption).toHaveBeenCalledWith('fastMode', false)

    setOption.mockClear()
    await wrapper.setProps({
      snapshot: [model(), { id: 'thinking', label: 'Thinking', category: 'mode', kind: { type: 'boolean', currentValue: true }, valueSource: 'unknown', transport: 'catalog', settable: true }]
    })
    expect(document.body.textContent).not.toContain('Current value unknown')
    const thinkingSwitch = switchNamed('Thinking')
    expect(thinkingSwitch.getAttribute('aria-checked')).toBe('true')
    thinkingSwitch.click()
    await flushPromises()
    expect(setOption).toHaveBeenCalledWith('thinking', false)
  })

  // Both arms: `default` and `unreported` make opposite claims.
  it.each([
    { name: 'a live unreported boolean is never labelled a default', valueSource: 'unknown', transport: 'agent-session', shown: 'Not reported', hidden: 'Default' },
    { name: 'a draft catalog default says so', valueSource: 'default', transport: 'catalog', shown: 'Default', hidden: 'Not reported' }
  ])('$name', ({ valueSource, transport, shown, hidden }) => {
    render({ snapshot: [model(), { ...fast, kind: { type: 'boolean', currentValue: false }, valueSource, transport }] })
    expect(allText(shown).length).toBeGreaterThan(0)
    expect(allText(hidden)).toHaveLength(0)
    // The marker qualifies the value; it is not part of the control's name,
    // but it still reaches assistive tech.
    const control = switchNamed('Fast mode')
    const describedBy = control.getAttribute('aria-describedby') ?? ''
    expect(describedBy).not.toBe('')
    expect(document.getElementById(describedBy).textContent).toBe(shown)
  })

  it('drops the marker once something has picked the value', () => {
    render({ snapshot: [model(), { ...fast, valueSource: 'reported' }] })
    expect(allText('Default')).toHaveLength(0)
    expect(allText('Not reported')).toHaveLength(0)
  })

  it('tooltips a dispatched option pill with the category alone', () => {
    render({ snapshot: [model(), { id: 'thinking', label: 'Thinking', category: 'mode', kind: { type: 'boolean', currentValue: true }, valueSource: 'dispatched', transport: 'catalog', settable: true }] })
    expect(allText('Thinking').length).toBeGreaterThan(0)
    expect(allText('Sent to the agent — not confirmed').length).toBeGreaterThan(0)
  })

  // Tessel: choices forbidden now, a refusal as { ok: false }, a radio pick.
  it('a radio pick sets the option; a disabled choice (and the current one) does nothing', async () => {
    const setOption = vi.fn().mockResolvedValue({ ok: true })
    render({
      surface: { ...surface, setOption },
      snapshot: [model(), { ...effort, kind: { type: 'select', currentValue: 'high', choices: [{ value: 'low', label: 'Low', disabled: true, disabledReason: 'Not now' }, ...EFFORT_CHOICES.slice(1), { value: 'max', label: 'Max' }] } }]
    })
    const low = document.querySelector('[role="radio"][data-value="low"]')
    expect(low.disabled).toBe(true)
    expect(low.textContent).toContain('Not now')
    low.click()
    document.querySelector('[role="radio"][data-value="high"]').click()
    await flushPromises()
    expect(setOption).not.toHaveBeenCalled()
    document.querySelector('[role="radio"][data-value="max"]').click()
    await flushPromises()
    expect(setOption).toHaveBeenCalledWith('effort', 'max')
  })

  it('a refusal ({ ok: false }) or a throw says "Could not update option" (the pane\'s toast) and the rows come back', async () => {
    const toast = vi.fn()
    const setOption = vi.fn().mockResolvedValueOnce({ ok: false, error: 'no' }).mockRejectedValueOnce(new Error('pipe'))
    wrapper = mount(NativeChatSessionOptionPickers, {
      props: { surface: { ...surface, setOption }, isWorking: false, snapshot: [model(), effort] },
      global: { provide: { panelCtx: { toast } } },
      attachTo: document.body
    })
    document.querySelector('[role="radio"][data-value="low"]').click()
    await flushPromises()
    expect(toast).toHaveBeenLastCalledWith('Could not update option: no', expect.any(Object))
    expect(wrapper.emitted('error')[0][0]).toBe('Could not update option: no')
    expect(document.querySelector('[role="radio"][data-value="low"]').disabled).toBe(false)
    document.querySelector('[role="radio"][data-value="low"]').click()
    await flushPromises()
    expect(toast).toHaveBeenLastCalledWith('Could not update option: pipe', expect.any(Object))
  })

  it('while a write is on its way, every row waits (the pills stay, for the focus to return)', async () => {
    let resolve
    const setOption = vi.fn(() => new Promise((r) => (resolve = r)))
    render({ surface: { ...surface, setOption }, snapshot: [model(), effort, fast] })
    document.querySelector('[role="radio"][data-value="low"]').click()
    await flushPromises()
    expect(document.querySelector('[role="radio"][data-value="sonnet"]').disabled).toBe(true)
    expect(document.querySelector('[role="radio"][data-value="high"]').disabled).toBe(true)
    expect(switchNamed('Fast mode').disabled).toBe(true)
    document.querySelector('[role="radio"][data-value="sonnet"]').click()
    expect(setOption).toHaveBeenCalledTimes(1)
    expect(buttonNamed('Model Opus 4.8').parentElement.getAttribute('data-disabled')).toBe(null)
    resolve({ ok: true })
    await flushPromises()
    expect(document.querySelector('[role="radio"][data-value="sonnet"]').disabled).toBe(false)
  })

  it('an option settable during a turn keeps its pill and rows; the others wait', () => {
    const mode = { id: 'permissionMode', label: 'Permission mode', category: 'mode', kind: { type: 'select', currentValue: 'default', choices: [{ value: 'default', label: 'Manual' }, { value: 'plan', label: 'Plan' }] }, valueSource: 'reported', transport: 'agent-session', settable: true, settableWhileWorking: true }
    render({ snapshot: [model(), effort, mode], isWorking: true })
    expect(buttonNamed('Model Opus 4.8').parentElement.getAttribute('data-disabled')).toBe('true')
    expect(buttonsMatching(/^Effort/)[0].parentElement.getAttribute('data-disabled')).toBe(null)
    expect(document.querySelector('[role="radio"][data-value="plan"]').disabled).toBe(false)
    expect(document.querySelector('[role="radio"][data-value="low"]').disabled).toBe(true)
  })

  it('nothing without a surface or a model', async () => {
    render({ surface: null, snapshot: [model()] })
    expect(document.querySelector('button')).toBeNull()
    await wrapper.setProps({ surface, snapshot: [effort] })
    expect(document.querySelector('button')).toBeNull()
  })
})
