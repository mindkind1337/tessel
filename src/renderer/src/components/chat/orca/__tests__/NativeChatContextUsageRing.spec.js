// NativeChatContextUsageRing (after Orca's NativeChatContextUsageRing.test.tsx,
// MIT, Copyright (c) 2026 Lovecast Inc.). The reference dispatched
// pointerover/pointerout (React's pointerenter emulation); Vue listens to
// pointerenter/pointerleave, dispatched here the same way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import NativeChatContextUsageRing from '../NativeChatContextUsageRing.vue'
import { useNativeChatComposerKeyDown } from '../../../../chat/orca/composables/use-native-chat-composer-keydown.js'
import { EMPTY_HISTORY } from '../../../../chat/orca/native-chat-composer-state.js'

// Real <Transition>: the stub would wrap the teleported content in an element.
config.global.stubs.transition = false

const USAGE = {
  usedTokens: 42_000,
  windowTokens: 200_000,
  percentage: 21,
  estimated: false,
  rows: [
    { name: 'Messages', tokens: 30_000, percentage: 15 },
    { name: 'System tools', tokens: 12_000, percentage: 6 }
  ]
}

let wrapper = null
let composer
beforeEach(() => {
  composer = document.createElement('textarea')
  document.body.appendChild(composer)
  composer.focus()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function renderRing(usage = USAGE) {
  wrapper = mount(NativeChatContextUsageRing, { props: { usage }, attachTo: document.body })
  await nextTick()
  const trigger = document.querySelector('button[data-native-chat-context-usage]')
  if (!trigger) throw new Error('Missing context usage ring')
  return trigger
}
// The open card (a closing one, mid-animation, does not count).
const card = () => document.querySelector('[data-slot="popover-content"]:not(.nc-ui-leave-active)')

async function dispatch(target, event) {
  target.dispatchEvent(event)
  await nextTick()
  await nextTick()
}
async function advance(ms) {
  vi.advanceTimersByTime(ms)
  await nextTick()
  await nextTick()
}
const pressEscape = () => dispatch(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
// Returns the mousedown so a test can check the browser was told not to move focus.
async function click(trigger) {
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  await dispatch(trigger, press)
  await dispatch(trigger, new MouseEvent('click', { bubbles: true, cancelable: true }))
  return press
}
function pointer(type, pointerType) {
  const event = new MouseEvent(type === 'over' ? 'pointerenter' : 'pointerleave', { bubbles: false })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  return event
}

describe('NativeChatContextUsageRing', () => {
  it('writes a million-token window with a capital M, in the label and the card', async () => {
    const trigger = await renderRing({ ...USAGE, usedTokens: 26_400, windowTokens: 1_000_000 })
    expect(trigger.getAttribute('aria-label')).toBe('Context 26.4k of 1M tokens, 21% used')
    await click(trigger)
    expect(card().textContent).toContain('26.4k/1M')
  })

  it('opens the breakdown on click without taking focus from the composer', async () => {
    const trigger = await renderRing()
    const press = await click(trigger)
    expect(document.body.textContent).toContain('42k/200k')
    expect(card().textContent).toContain('Messages')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(press.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(composer)
  })

  it('opens on mouse hover and closes on leave without moving focus to the ring', async () => {
    const trigger = await renderRing()
    const hoverTarget = trigger.parentElement
    await dispatch(hoverTarget, pointer('over', 'mouse'))
    await advance(149)
    expect(card()).toBeNull()
    await advance(1)
    expect(card().textContent).toContain('System tools')

    await dispatch(hoverTarget, pointer('out', 'mouse'))
    await advance(100)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(card()).toBeNull()
    await advance(0)
    expect(document.activeElement).toBe(composer)
  })

  it('stays open while the pointer crosses the gap from the ring into the card', async () => {
    const trigger = await renderRing()
    const hoverTarget = trigger.parentElement
    await dispatch(hoverTarget, pointer('over', 'mouse'))
    await advance(150)
    await dispatch(hoverTarget, pointer('out', 'mouse'))
    await advance(50)
    await dispatch(card(), pointer('over', 'mouse'))
    await advance(500)
    expect(card().textContent).toContain('Messages')
  })

  it('stays open when a click follows the hover that opened it', async () => {
    const trigger = await renderRing()
    await dispatch(trigger.parentElement, pointer('over', 'mouse'))
    await advance(150)
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(card()).not.toBeNull()
  })

  it('never opens for a pointer that crosses the ring faster than the hover delay', async () => {
    const trigger = await renderRing()
    const hoverTarget = trigger.parentElement
    await dispatch(hoverTarget, pointer('over', 'mouse'))
    expect(card()).toBeNull()
    await advance(100)
    await dispatch(hoverTarget, pointer('out', 'mouse'))
    await advance(500)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(card()).toBeNull()
  })

  it('opens on click at once, even while a hover is still pending', async () => {
    const trigger = await renderRing()
    await dispatch(trigger.parentElement, pointer('over', 'mouse'))
    await click(trigger)
    expect(card()).not.toBeNull()
  })

  it('stays closed when Escape lands during a pending hover', async () => {
    const trigger = await renderRing()
    await dispatch(trigger.parentElement, pointer('over', 'mouse'))
    await advance(100)
    await pressEscape()
    await advance(500)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(card()).toBeNull()
  })

  it('does not reopen a card dismissed with Escape once a stale hover would have fired', async () => {
    const trigger = await renderRing()
    await dispatch(trigger.parentElement, pointer('over', 'mouse'))
    await click(trigger)
    await pressEscape()
    await advance(500)
    expect(card()).toBeNull()
  })

  it('drops a pending hover when the ring unmounts', async () => {
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const trigger = await renderRing()
    await dispatch(trigger.parentElement, pointer('over', 'mouse'))
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    wrapper = null
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function), true)
  })

  it('opens on a touch tap, whose pointer leaves before the click lands', async () => {
    const trigger = await renderRing()
    const hoverTarget = trigger.parentElement
    await dispatch(hoverTarget, pointer('over', 'touch'))
    expect(card()).toBeNull()
    await dispatch(hoverTarget, pointer('out', 'touch'))
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(card().textContent).toContain('Messages')
  })

  it('closes on Escape and leaves focus in the composer', async () => {
    const trigger = await renderRing()
    await click(trigger)
    expect(card()).not.toBeNull()
    await pressEscape()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(card()).toBeNull()
    await advance(0)
    expect(document.activeElement).toBe(composer)
  })

  it('spends an Escape typed in the composer on closing the card, not on stopping the agent', async () => {
    const interrupt = vi.fn()
    const ComposerWithRing = defineComponent({
      setup() {
        const onKeyDown = useNativeChatComposerKeyDown({
          autocomplete: { mode: 'none' },
          activeSuggestion: 0,
          draft: '',
          history: EMPTY_HISTORY,
          isComposing: () => false,
          isWorking: true,
          completePickerItem: vi.fn(),
          dispatchPickerCommand: vi.fn(),
          dismissPicker: vi.fn(),
          interrupt,
          send: vi.fn(),
          setActiveSuggestion: vi.fn(),
          setDraft: vi.fn(),
          setCaret: vi.fn(),
          setHistory: vi.fn()
        })
        return () => h('div', [h('textarea', { 'data-testid': 'composer', onKeydown: onKeyDown }), h(NativeChatContextUsageRing, { usage: USAGE })])
      }
    })
    wrapper = mount(ComposerWithRing, { attachTo: document.body })
    const field = document.querySelector('[data-testid="composer"]')
    field.focus()
    await click(document.querySelector('button[data-native-chat-context-usage]'))
    const escape = () => dispatch(field, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await escape()
    expect(card()).toBeNull()
    expect(interrupt).not.toHaveBeenCalled()
    await escape()
    expect(interrupt).toHaveBeenCalledOnce()
  })

  it('renders every row when the provider repeats a category name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const trigger = await renderRing({
      ...USAGE,
      rows: [
        { name: 'Tools', tokens: 20_000, percentage: 10 },
        { name: 'Tools', tokens: 10_000, percentage: 5 }
      ]
    })
    await click(trigger)
    const rows = Array.from(card().querySelectorAll('li'), (row) => row.textContent)
    expect(rows).toEqual(['Tools10%', 'Tools5%'])
    expect(warn.mock.calls.flat().join(' ')).not.toContain('Duplicate keys')
  })

  // Tessel: the estimate is said, the ring turns critical past 90%.
  it('says an estimate and marks a nearly spent window', async () => {
    const trigger = await renderRing({ ...USAGE, percentage: 93, estimated: true })
    expect(trigger.classList.contains('nc-context-ring-button--critical')).toBe(true)
    expect(trigger.getAttribute('data-native-chat-context-usage-estimated')).toBe('true')
    await click(trigger)
    expect(card().textContent).toContain('Estimated from the last response.')
  })
})
