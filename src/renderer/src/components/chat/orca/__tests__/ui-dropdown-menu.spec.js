// DropdownMenu behaviour (after Orca's components/ui/dropdown-menu.tsx on
// Radix DropdownMenu, shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  SwitchIndicator
} from '../ui/index.js'

// Real <Transition>: the stub would wrap the teleported content in an element.
config.global.stubs.transition = false

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  document.body.style.pointerEvents = ''
  vi.useRealTimers()
})

const components = {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  SwitchIndicator
}

const MENU = `
  <div>
    <DropdownMenu v-model:open="open" :modal="modal">
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="xs" class="picker" aria-label="Model">Opus</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" :collision-padding="8" class="menu">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup v-model="model" aria-label="Model">
          <DropdownMenuRadioItem value="opus">Opus</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="sonnet">Sonnet</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="haiku" disabled>Haiku</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem class="copy" @select="events.push('copy')">Copy<DropdownMenuShortcut>Ctrl+C</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem role="switch" :aria-checked="fast" aria-label="Fast mode" @select="(e) => { e.preventDefault(); fast = !fast }">
          <span>Fast</span><SwitchIndicator :checked="fast" />
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger class="more">More</DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="submenu">
            <DropdownMenuItem class="fork" @select="events.push('fork')">Fork</DropdownMenuItem>
            <DropdownMenuItem class="split">Split</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem variant="destructive" inset class="delete" @select="events.push('delete')">Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <button class="outside">out</button>
  </div>`

function render(data = {}, template = MENU) {
  wrapper = mount(
    {
      components,
      data: () => ({ open: false, modal: true, model: 'sonnet', fast: false, events: [], ...data }),
      template
    },
    { attachTo: document.body }
  )
  return wrapper
}

const menu = () => document.querySelector('[data-slot="dropdown-menu-content"]:not(.nc-ui-leave-active)')
const submenu = () => document.querySelector('[data-slot="dropdown-menu-sub-content"]:not(.nc-ui-leave-active)')
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const pointer = (el, type, init = {}) =>
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: type !== 'pointerleave', cancelable: true, button: 0, pointerType: 'mouse', ...init })
  )
const active = () => document.activeElement

async function openWithKeyboard(k = 'Enter') {
  const trigger = wrapper.find('.picker').element
  trigger.focus()
  key(trigger, k)
  await nextTick()
  await nextTick()
  return trigger
}

describe('DropdownMenu', () => {
  it('opens on pointer down, renders role=menu teleported with nc-root, focuses the menu', async () => {
    render()
    const trigger = wrapper.find('.picker')
    expect(trigger.attributes('aria-haspopup')).toBe('menu')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    trigger.element.click()
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    pointer(trigger.element, 'pointerdown')
    await nextTick()
    await nextTick()
    const el = menu()
    expect(wrapper.vm.open).toBe(true)
    expect(el.getAttribute('role')).toBe('menu')
    expect(el.parentElement).toBe(document.body)
    expect(el.classList.contains('nc-root')).toBe(true)
    expect(el.classList.contains('nc-ui-menu-content')).toBe(true)
    expect(el.classList.contains('menu')).toBe(true)
    expect(el.getAttribute('aria-labelledby')).toBe(trigger.attributes('id'))
    expect(trigger.attributes('aria-controls')).toBe(el.id)
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(trigger.attributes('data-state')).toBe('open')
    expect(active()).toBe(el)
    expect(el.querySelector('[role="separator"]')).not.toBeNull()
    expect(el.querySelector('[data-slot="dropdown-menu-shortcut"]').textContent).toBe('Ctrl+C')
  })

  it('from the keyboard: first item focused, arrows rove (no wrap, disabled skipped), Home/End', async () => {
    render()
    await openWithKeyboard()
    const items = [...menu().querySelectorAll('[data-nc-menu-item]')]
    const enabled = items.filter((el) => !el.hasAttribute('data-disabled'))
    expect(active()).toBe(enabled[0])
    expect(enabled[0].hasAttribute('data-highlighted')).toBe(true)
    key(active(), 'ArrowDown')
    expect(active()).toBe(enabled[1])
    key(active(), 'ArrowDown')
    expect(active().classList.contains('copy')).toBe(true)
    key(active(), 'ArrowUp')
    expect(active()).toBe(enabled[1])
    key(active(), 'End')
    expect(active().classList.contains('delete')).toBe(true)
    key(active(), 'ArrowDown')
    expect(active().classList.contains('delete')).toBe(true)
    key(active(), 'Home')
    expect(active()).toBe(enabled[0])
  })

  it('ArrowDown on the trigger opens too; typeahead jumps to an item', async () => {
    render()
    await openWithKeyboard('ArrowDown')
    expect(menu()).not.toBeNull()
    key(active(), 'd')
    expect(active().classList.contains('delete')).toBe(true)
    key(active(), 'Tab')
    expect(active().classList.contains('delete')).toBe(true)
  })

  it('Enter selects an item, closes and returns focus to the trigger', async () => {
    render()
    const trigger = await openWithKeyboard()
    const copy = menu().querySelector('.copy')
    copy.focus()
    key(copy, 'Enter')
    await nextTick()
    expect(wrapper.vm.events).toEqual(['copy'])
    expect(wrapper.vm.open).toBe(false)
    expect(active()).toBe(trigger)
  })

  it('a click selects; a prevented select keeps the menu open (role=switch item)', async () => {
    render({ open: true })
    await nextTick()
    const toggle = menu().querySelector('[role="switch"]')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Fast mode')
    toggle.click()
    await nextTick()
    expect(wrapper.vm.fast).toBe(true)
    expect(wrapper.vm.open).toBe(true)
    expect(menu().querySelector('[role="switch"]').getAttribute('aria-checked')).toBe('true')
    menu().querySelector('.delete').click()
    await nextTick()
    expect(wrapper.vm.events).toEqual(['delete'])
    expect(wrapper.vm.open).toBe(false)
  })

  it('radio group: menuitemradio with aria-checked, v-model, disabled items ignored', async () => {
    render({ open: true })
    await nextTick()
    const radios = [...menu().querySelectorAll('[role="menuitemradio"]')]
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios[1].getAttribute('data-state')).toBe('checked')
    expect(menu().querySelector('[role="group"]').getAttribute('aria-label')).toBe('Model')
    radios[2].click()
    await nextTick()
    expect(wrapper.vm.model).toBe('sonnet')
    expect(wrapper.vm.open).toBe(true)
    radios[0].click()
    await nextTick()
    expect(wrapper.vm.model).toBe('opus')
    expect(wrapper.vm.open).toBe(false)
  })

  it('item data attributes: variant, inset, disabled', async () => {
    render({ open: true })
    await nextTick()
    const del = menu().querySelector('.delete')
    expect(del.getAttribute('role')).toBe('menuitem')
    expect(del.getAttribute('data-variant')).toBe('destructive')
    expect(del.hasAttribute('data-inset')).toBe(true)
    const haiku = [...menu().querySelectorAll('[role="menuitemradio"]')][2]
    expect(haiku.hasAttribute('data-disabled')).toBe(true)
    expect(haiku.getAttribute('aria-disabled')).toBe('true')
  })

  it('Escape closes and returns focus to the trigger', async () => {
    render()
    const trigger = await openWithKeyboard()
    key(active(), 'Escape')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(active()).toBe(trigger)
  })

  it('a pointer down outside closes; modal blocks outside pointer events while open', async () => {
    render()
    pointer(wrapper.find('.picker').element, 'pointerdown')
    await nextTick()
    await nextTick()
    expect(document.body.style.pointerEvents).toBe('none')
    pointer(wrapper.find('.outside').element, 'pointerdown')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('non-modal: outside interaction closes without taking focus back', async () => {
    render({ modal: false })
    pointer(wrapper.find('.picker').element, 'pointerdown')
    await nextTick()
    await nextTick()
    expect(document.body.style.pointerEvents).toBe('')
    const outside = wrapper.find('.outside').element
    pointer(outside, 'pointerdown')
    outside.focus()
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(active()).toBe(outside)
  })

  it('pointer down on the open trigger closes it', async () => {
    render()
    const trigger = wrapper.find('.picker').element
    pointer(trigger, 'pointerdown')
    await nextTick()
    pointer(trigger, 'pointerdown')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
  })

  it('hovering an item focuses it', async () => {
    render({ open: true })
    await nextTick()
    const copy = menu().querySelector('.copy')
    pointer(copy, 'pointermove')
    expect(active()).toBe(copy)
    pointer(copy, 'pointerleave')
    expect(active()).toBe(menu())
  })

  it('sub-menu: ArrowRight opens and focuses its first item, ArrowLeft closes back to its trigger', async () => {
    render()
    await openWithKeyboard()
    const more = menu().querySelector('.more')
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    expect(more.querySelector('svg')).not.toBeNull()
    more.focus()
    key(more, 'ArrowRight')
    await nextTick()
    await nextTick()
    const sub = submenu()
    expect(sub.getAttribute('role')).toBe('menu')
    expect(sub.classList.contains('nc-root')).toBe(true)
    expect(sub.classList.contains('submenu')).toBe(true)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(more.getAttribute('data-state')).toBe('open')
    expect(active()).toBe(sub.querySelector('.fork'))
    key(active(), 'ArrowDown')
    expect(active()).toBe(sub.querySelector('.split'))
    key(active(), 'ArrowLeft')
    await nextTick()
    expect(submenu()).toBeNull()
    expect(active()).toBe(more)
    expect(wrapper.vm.open).toBe(true)
  })

  it('sub-menu: selecting an item closes the whole menu; Escape inside closes everything', async () => {
    render()
    const trigger = await openWithKeyboard()
    const more = menu().querySelector('.more')
    more.focus()
    key(more, 'Enter')
    await nextTick()
    await nextTick()
    submenu().querySelector('.fork').click()
    await nextTick()
    expect(wrapper.vm.events).toEqual(['fork'])
    expect(wrapper.vm.open).toBe(false)

    await openWithKeyboard()
    const more2 = menu().querySelector('.more')
    more2.focus()
    key(more2, 'ArrowRight')
    await nextTick()
    await nextTick()
    key(active(), 'Escape')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(active()).toBe(trigger)
  })

  it('sub-menu: opens on hover after 100ms and closes when another item is hovered', async () => {
    vi.useFakeTimers()
    render({ open: true })
    await nextTick()
    const more = menu().querySelector('.more')
    pointer(more, 'pointermove')
    expect(active()).toBe(more)
    vi.advanceTimersByTime(100)
    await nextTick()
    expect(submenu()).not.toBeNull()
    // Pointer into the sub-menu: stays open.
    pointer(more, 'pointerleave')
    pointer(submenu(), 'pointerenter')
    vi.advanceTimersByTime(400)
    await nextTick()
    expect(submenu()).not.toBeNull()
    // A pointer down inside the sub-menu is not outside the root menu.
    pointer(submenu().querySelector('.split'), 'pointerdown')
    await nextTick()
    expect(wrapper.vm.open).toBe(true)
    pointer(menu().querySelector('.copy'), 'pointermove')
    await nextTick()
    expect(submenu()).toBeNull()
  })

  it('checkbox item toggles v-model:checked', async () => {
    render(
      { open: true, on: false },
      `<DropdownMenu v-model:open="open"><DropdownMenuTrigger>t</DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuCheckboxItem v-model:checked="on">Wrap</DropdownMenuCheckboxItem></DropdownMenuContent></DropdownMenu>`
    )
    await nextTick()
    const item = menu().querySelector('[role="menuitemcheckbox"]')
    expect(item.getAttribute('aria-checked')).toBe('false')
    item.click()
    await nextTick()
    expect(wrapper.vm.on).toBe(true)
  })

  it('defaultOpen and a disabled trigger', async () => {
    render(
      {},
      `<div><DropdownMenu default-open><DropdownMenuTrigger class="a">a</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>x</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <DropdownMenu v-model:open="open"><DropdownMenuTrigger class="b" disabled>b</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>y</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>`
    )
    await nextTick()
    expect(menu()).not.toBeNull()
    const b = wrapper.find('.b')
    expect(b.attributes('disabled')).toBeDefined()
    pointer(b.element, 'pointerdown')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
  })
})
