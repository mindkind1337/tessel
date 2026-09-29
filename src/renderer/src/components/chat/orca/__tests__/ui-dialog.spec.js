// Dialog behaviour (after Orca's components/ui/dialog.tsx on Radix Dialog,
// shadcn/ui, MIT, Copyright (c) 2026 Lovecast Inc.).
import { afterEach, describe, expect, it } from 'vitest'
import { config, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setMessages } from '../../../../i18n'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../ui/index.js'

// Real <Transition>: the stub would wrap the teleported content in an element.
config.global.stubs.transition = false

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  setMessages('en', {})
})

const components = { Button, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger }

function render(template, data = {}) {
  wrapper = mount({ components, data: () => ({ open: false, ...data }), template }, { attachTo: document.body })
  return wrapper
}

const panel = () => document.querySelector('[data-slot="dialog-content"]')
const overlay = () => document.querySelector('[data-slot="dialog-overlay"]')
const key = (el, k, init = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))

const BASIC = `
  <div>
    <Dialog v-model:open="open">
      <DialogTrigger as-child><Button class="opener">Preview</Button></DialogTrigger>
      <DialogContent class="preview">
        <DialogHeader>
          <DialogTitle>image.png</DialogTitle>
          <DialogDescription>Full-size image preview</DialogDescription>
        </DialogHeader>
        <input class="first" />
        <DialogFooter show-close-button><Button class="save">Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>`

describe('Dialog', () => {
  it('opens a labelled modal panel over an overlay and focuses the first field', async () => {
    render(BASIC)
    const opener = wrapper.find('.opener')
    expect(opener.attributes('aria-haspopup')).toBe('dialog')
    await opener.trigger('click')
    await nextTick()
    const el = panel()
    expect(el.getAttribute('role')).toBe('dialog')
    expect(el.getAttribute('aria-modal')).toBe('true')
    expect(el.classList.contains('nc-root')).toBe(true)
    expect(el.classList.contains('nc-ui-dialog-content')).toBe(true)
    expect(el.classList.contains('preview')).toBe(true)
    const title = el.querySelector('[data-slot="dialog-title"]')
    expect(title.tagName).toBe('H2')
    expect(el.getAttribute('aria-labelledby')).toBe(title.id)
    expect(el.getAttribute('aria-describedby')).toBe(el.querySelector('[data-slot="dialog-description"]').id)
    expect(overlay()).not.toBeNull()
    expect(overlay().classList.contains('nc-root')).toBe(true)
    expect(document.activeElement).toBe(el.querySelector('.first'))
  })

  it('has an sr-only "Close" button (translated) that closes and returns focus to the trigger', async () => {
    setMessages('fr', { chat: { orca: { ui: { close: 'Fermer' } } } })
    render(BASIC)
    await wrapper.find('.opener').trigger('click')
    await nextTick()
    const close = panel().querySelector('.nc-ui-dialog-close')
    expect(close.getAttribute('data-slot')).toBe('dialog-close')
    expect(close.querySelector('.nc-ui-sr-only').textContent).toBe('Fermer')
    close.click()
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.opener').element)
  })

  it('the footer close button closes', async () => {
    render(BASIC, { open: true })
    await nextTick()
    const footerClose = [...panel().querySelectorAll('[data-slot="dialog-footer"] button')].find(
      (b) => b.textContent.trim() === 'Close'
    )
    expect(footerClose.classList.contains('nc-ui-button--outline')).toBe(true)
    footerClose.click()
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
  })

  it('Escape closes; a prevented escapeKeyDown keeps it open', async () => {
    render(
      `<Dialog v-model:open="open"><DialogContent @escape-key-down="(e) => { if (keep) e.preventDefault() }">
        <DialogTitle>T</DialogTitle></DialogContent></Dialog>`,
      { open: true, keep: true }
    )
    await nextTick()
    key(panel(), 'Escape')
    await nextTick()
    expect(wrapper.vm.open).toBe(true)
    wrapper.vm.keep = false
    key(panel(), 'Escape')
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
  })

  it('a pointer down on the overlay closes; inside does not', async () => {
    render(BASIC, { open: true })
    await nextTick()
    panel().querySelector('.first').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.vm.open).toBe(true)
    overlay().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.vm.open).toBe(false)
  })

  it('traps Tab inside the panel', async () => {
    render(BASIC, { open: true })
    await nextTick()
    const el = panel()
    const tabbables = [...el.querySelectorAll('input, button')]
    const first = tabbables[0]
    const last = tabbables[tabbables.length - 1]
    last.focus()
    key(last, 'Tab')
    expect(document.activeElement).toBe(first)
    key(first, 'Tab', { shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('keeps focus inside while open (focus moved outside comes back)', async () => {
    render(`<div><button class="out">o</button>${BASIC}</div>`, { open: true })
    await nextTick()
    wrapper.find('.out').element.focus()
    expect(panel().contains(document.activeElement)).toBe(true)
  })

  it('showCloseButton false hides the X, and without a trigger focus returns to what had it', async () => {
    render(
      `<div><button class="before">b</button>
        <Dialog v-model:open="open"><DialogContent :show-close-button="false"><DialogTitle>T</DialogTitle><DialogClose class="x">x</DialogClose></DialogContent></Dialog></div>`
    )
    const before = wrapper.find('.before').element
    before.focus()
    wrapper.vm.open = true
    await nextTick()
    await nextTick()
    expect(panel().querySelector('.nc-ui-dialog-close')).toBeNull()
    panel().querySelector('.x').click()
    await nextTick()
    expect(document.activeElement).toBe(before)
  })
})
