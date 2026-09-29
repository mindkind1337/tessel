// Popover behaviour (after Orca's components/ui/popover.tsx on Radix Popover,
// shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.).
import { afterEach, describe, expect, it } from 'vitest'
import { config, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui/index.js'

// Real <Transition>: the stub would wrap the teleported content in an element.
config.global.stubs.transition = false

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

function render(template, data = {}, methods = {}) {
  wrapper = mount(
    {
      components: { Button, Popover, PopoverContent, PopoverTrigger },
      data: () => ({ open: false, events: [], ...data }),
      methods,
      template
    },
    { attachTo: document.body }
  )
  return wrapper
}

const content = () => document.querySelector('[data-slot="popover-content"]')
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

const BASIC = `
  <div>
    <Popover v-model:open="open">
      <PopoverTrigger class="trigger">Open</PopoverTrigger>
      <PopoverContent class="panel" aria-label="Details"><button class="inside">In</button></PopoverContent>
    </Popover>
    <button class="outside">Out</button>
  </div>`

describe('Popover', () => {
  it('toggles from the trigger, teleports the content with nc-root, focuses inside', async () => {
    render(BASIC)
    const trigger = wrapper.find('.trigger')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-haspopup')).toBe('dialog')
    expect(trigger.attributes('data-state')).toBe('closed')
    expect(content()).toBeNull()

    await trigger.trigger('click')
    await nextTick()
    expect(wrapper.vm.open).toBe(true)
    const el = content()
    expect(el.parentElement).toBe(document.body)
    expect(el.classList.contains('nc-root')).toBe(true)
    expect(el.classList.contains('nc-ui-popover-content')).toBe(true)
    expect(el.classList.contains('panel')).toBe(true)
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('aria-label')).toBe('Details')
    expect(el.getAttribute('data-state')).toBe('open')
    expect(el.getAttribute('data-side')).toBe('bottom')
    expect(el.getAttribute('data-align')).toBe('center')
    expect(el.style.position).toBe('fixed')
    expect(trigger.attributes('aria-controls')).toBe(el.id)
    expect(document.activeElement).toBe(el.querySelector('.inside'))

    await trigger.trigger('click')
    expect(wrapper.vm.open).toBe(false)
  })

  it('Escape closes and returns focus to the trigger', async () => {
    render(BASIC, { open: true })
    await nextTick()
    key(document.activeElement, 'Escape')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.trigger').element)
  })

  it('a pointer down outside closes it without pulling focus back', async () => {
    render(BASIC, { open: true })
    await nextTick()
    const outside = wrapper.find('.outside').element
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    outside.focus()
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(document.activeElement).toBe(outside)
  })

  it('a pointer down inside or on the trigger does not dismiss', async () => {
    render(BASIC, { open: true })
    await nextTick()
    content().querySelector('.inside').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    wrapper.find('.trigger').element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.vm.open).toBe(true)
  })

  it('focus moving outside closes it', async () => {
    render(BASIC, { open: true })
    await nextTick()
    wrapper.find('.outside').element.focus()
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
  })

  it('openAutoFocus / closeAutoFocus can be prevented', async () => {
    render(
      `<div>
        <input class="composer" />
        <Popover v-model:open="open">
          <PopoverTrigger class="trigger">Open</PopoverTrigger>
          <PopoverContent side="top" align="end" :side-offset="8"
            @open-auto-focus="(e) => e.preventDefault()"
            @close-auto-focus="(e) => e.preventDefault()"><button class="inside">In</button></PopoverContent>
        </Popover>
      </div>`
    )
    const composer = wrapper.find('.composer').element
    composer.focus()
    // Room above the trigger (jsdom has no layout).
    wrapper.find('.trigger').element.getBoundingClientRect = () => ({ left: 300, top: 500, width: 40, height: 20, right: 340, bottom: 520 })
    wrapper.vm.open = true
    await nextTick()
    await nextTick()
    expect(content().getAttribute('data-side')).toBe('top')
    expect(content().getAttribute('data-align')).toBe('end')
    expect(document.activeElement).toBe(composer)
    key(composer, 'Escape')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(document.activeElement).toBe(composer)
  })

  it('asChild trigger: the child keeps its own listeners, which run first and can cancel the toggle', async () => {
    render(
      `<Popover v-model:open="open">
        <PopoverTrigger as-child>
          <Button variant="ghost" class="ring" aria-label="Usage" @click="(e) => { events.push('child'); if (block) e.preventDefault() }">R</Button>
        </PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>`,
      { block: true }
    )
    const button = wrapper.find('button')
    expect(button.classes()).toEqual(expect.arrayContaining(['nc-ui-button', 'ring']))
    expect(button.attributes('data-slot')).toBe('popover-trigger')
    expect(button.attributes('aria-label')).toBe('Usage')
    await button.trigger('click')
    expect(wrapper.vm.events).toEqual(['child'])
    expect(wrapper.vm.open).toBe(false)
    wrapper.vm.block = false
    await button.trigger('click')
    expect(wrapper.vm.open).toBe(true)
    expect(button.attributes('aria-expanded')).toBe('true')
  })

  it('works uncontrolled with defaultOpen', async () => {
    render(`<Popover default-open><PopoverTrigger>T</PopoverTrigger><PopoverContent>Body</PopoverContent></Popover>`)
    await nextTick()
    expect(content()).not.toBeNull()
  })

  it('applies the consumer scoped-style attribute to the teleported content', async () => {
    const Scoped = {
      __scopeId: 'data-v-test1234',
      components: { Popover, PopoverContent, PopoverTrigger },
      template: `<Popover default-open><PopoverTrigger>T</PopoverTrigger><PopoverContent class="w">Body</PopoverContent></Popover>`
    }
    wrapper = mount(Scoped, { attachTo: document.body })
    await nextTick()
    expect(content().hasAttribute('data-v-test1234')).toBe(true)
  })
})
