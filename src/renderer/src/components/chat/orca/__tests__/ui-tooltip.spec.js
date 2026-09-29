// Tooltip behaviour (after Orca's components/ui/tooltip.tsx on Radix Tooltip,
// shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/index.js'

// Real <Transition>: the stub would wrap the teleported content in an element.
config.global.stubs.transition = false

let wrapper = null
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  vi.useRealTimers()
})

const components = {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
}

function render(template, data = {}) {
  wrapper = mount({ components, data: () => ({ open: false, ...data }), template }, { attachTo: document.body })
  return wrapper
}

// A closed tooltip may still be in the DOM for its exit animation.
const SHOWN = '[data-slot="tooltip-content"]:not(.nc-ui-leave-active)'
const tip = () => document.querySelector(SHOWN)
const pointer = (el, type, init = {}) =>
  el.dispatchEvent(new PointerEvent(type, { bubbles: type !== 'pointerleave', cancelable: true, pointerType: 'mouse', ...init }))

const ATTACH = `
  <TooltipProvider :delay-duration="300">
    <Tooltip>
      <TooltipTrigger as-child>
        <Button variant="ghost" size="icon-sm" aria-label="Attach file" class="attach">+</Button>
      </TooltipTrigger>
      <TooltipContent side="top" :side-offset="4">Attach file</TooltipContent>
    </Tooltip>
    <button class="other">o</button>
  </TooltipProvider>`

describe('Tooltip', () => {
  it('opens on hover after the delay, with role=tooltip and aria-describedby', async () => {
    render(ATTACH)
    const trigger = wrapper.find('.attach')
    expect(trigger.element.tagName).toBe('BUTTON')
    expect(trigger.attributes('data-state')).toBe('closed')
    pointer(trigger.element, 'pointermove')
    await nextTick()
    expect(tip()).toBeNull()
    vi.advanceTimersByTime(300)
    await nextTick()
    const el = tip()
    expect(el.getAttribute('role')).toBe('tooltip')
    expect(el.textContent).toContain('Attach file')
    expect(el.classList.contains('nc-root')).toBe(true)
    expect(el.classList.contains('nc-ui-tooltip-content')).toBe(true)
    expect(el.querySelector('.nc-ui-tooltip-arrow')).not.toBeNull()
    expect(trigger.attributes('aria-describedby')).toBe(el.id)
    expect(trigger.attributes('data-state')).toBe('delayed-open')

    pointer(trigger.element, 'pointerleave')
    await nextTick()
    expect(tip()).toBeNull()
    expect(trigger.attributes('aria-describedby')).toBeUndefined()
  })

  it('opens at once on keyboard focus, not on a click focus; Escape hides it', async () => {
    render(ATTACH)
    const trigger = wrapper.find('.attach').element
    trigger.focus()
    await nextTick()
    expect(tip()).not.toBeNull()
    expect(trigger.getAttribute('data-state')).toBe('instant-open')
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    expect(tip()).toBeNull()

    trigger.blur()
    pointer(trigger, 'pointerdown')
    trigger.focus()
    await nextTick()
    expect(tip()).toBeNull()
  })

  it('blur and click close it', async () => {
    render(ATTACH)
    const trigger = wrapper.find('.attach').element
    trigger.focus()
    await nextTick()
    trigger.blur()
    await nextTick()
    expect(tip()).toBeNull()
    trigger.focus()
    await nextTick()
    trigger.click()
    await nextTick()
    expect(tip()).toBeNull()
  })

  it('skips the delay right after another tooltip closed', async () => {
    render(`
      <TooltipProvider :delay-duration="300">
        <Tooltip><TooltipTrigger class="a">A</TooltipTrigger><TooltipContent>A tip</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger class="b">B</TooltipTrigger><TooltipContent>B tip</TooltipContent></Tooltip>
      </TooltipProvider>`)
    const a = wrapper.find('.a').element
    const b = wrapper.find('.b').element
    pointer(a, 'pointermove')
    vi.advanceTimersByTime(300)
    await nextTick()
    expect(tip().textContent).toContain('A tip')
    pointer(a, 'pointerleave')
    pointer(b, 'pointermove')
    await nextTick()
    expect(tip().textContent).toContain('B tip')
    expect(b.getAttribute('data-state')).toBe('instant-open')
  })

  it('only one tooltip is open at a time', async () => {
    render(`
      <div>
        <Tooltip :default-open="true"><TooltipTrigger class="a">A</TooltipTrigger><TooltipContent>A tip</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger class="b">B</TooltipTrigger><TooltipContent>B tip</TooltipContent></Tooltip>
      </div>`)
    await nextTick()
    wrapper.find('.b').element.focus()
    await nextTick()
    const tips = document.querySelectorAll(SHOWN)
    expect(tips).toHaveLength(1)
    expect(tips[0].textContent).toContain('B tip')
  })

  it('works without a provider (400ms) and with v-model:open', async () => {
    render(`<Tooltip v-model:open="open"><TooltipTrigger class="t">T</TooltipTrigger><TooltipContent :show-arrow="false">tip</TooltipContent></Tooltip>`)
    const trigger = wrapper.find('.t').element
    pointer(trigger, 'pointermove')
    vi.advanceTimersByTime(399)
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(wrapper.vm.open).toBe(true)
    expect(tip().querySelector('.nc-ui-tooltip-arrow')).toBeNull()
  })

  it('wraps a DropdownMenuTrigger that wraps a Button (nested asChild)', async () => {
    render(`
      <DropdownMenu v-model:open="open">
        <Tooltip>
          <TooltipTrigger as-child>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="xs" aria-label="Model" class="picker">Opus</Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Choose a model</TooltipContent>
        </Tooltip>
        <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>`)
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    const button = buttons[0]
    expect(button.classes()).toEqual(expect.arrayContaining(['nc-ui-button', 'picker']))
    expect(button.attributes('aria-haspopup')).toBe('menu')
    button.element.focus()
    await nextTick()
    expect(tip()).not.toBeNull()
    expect(button.attributes('aria-describedby')).toBe(tip().id)
    pointer(button.element, 'pointerdown', { button: 0 })
    await nextTick()
    expect(wrapper.vm.open).toBe(true)
    expect(tip()).toBeNull()
  })
})
