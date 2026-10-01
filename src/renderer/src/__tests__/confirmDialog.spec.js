import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmDialog from '../components/ConfirmDialog.vue'

describe('confirmation keyboard navigation', () => {
  let wrapper
  let opener
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    opener?.remove()
    opener = null
  })

  function open(props = {}) {
    opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    wrapper = mount(ConfirmDialog, { props: { title: 'Confirm', ...props }, attachTo: document.body })
    return wrapper.findAll('button')
  }

  it.each([false, true])('keeps Tab and Shift+Tab inside, including an optional alternative: %s', async (alternative) => {
    const buttons = open(alternative ? { altLabel: 'Alternative' } : {})
    const first = buttons[0]
    const last = buttons.at(-1)
    expect(document.activeElement).toBe(last.element)
    const parentKeydown = vi.fn()
    document.body.addEventListener('keydown', parentKeydown)
    try {
      await last.trigger('keydown', { key: 'Tab' })
      expect(document.activeElement).toBe(first.element)
      await first.trigger('keydown', { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(last.element)
      expect(parentKeydown).not.toHaveBeenCalled()
      // Non-boundary Tab keeps the browser's native order, including Alt.
      first.element.focus()
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      first.element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    } finally {
      document.body.removeEventListener('keydown', parentKeydown)
    }
  })

  it('returns focus to the opener when closed', () => {
    open()
    wrapper.unmount()
    wrapper = null
    expect(document.activeElement).toBe(opener)
  })

  it('keeps focus when an outer settings modal contains document focus', () => {
    const containOuterFocus = vi.fn((event) => {
      if (event.target.closest('[role="alertdialog"]')) opener.focus()
    })
    document.addEventListener('focusin', containOuterFocus)
    try {
      const buttons = open()
      expect(document.activeElement).toBe(buttons.at(-1).element)
      buttons[0].element.focus()
      expect(document.activeElement).toBe(buttons[0].element)
      expect(containOuterFocus.mock.calls.every(([event]) => !event.target.closest('[role="alertdialog"]'))).toBe(true)
    } finally {
      document.removeEventListener('focusin', containOuterFocus)
    }
  })

  it('does not throw if the opener was removed while confirming', () => {
    open()
    opener.remove()
    expect(() => wrapper.unmount()).not.toThrow()
    wrapper = null
  })

  it('preserves Cancel, alternative, confirm, Escape and backdrop answers', async () => {
    const buttons = open({ altLabel: 'Alternative' })
    await buttons[0].trigger('click')
    await buttons[1].trigger('click')
    await buttons[2].trigger('click')
    await buttons[2].trigger('keydown', { key: 'Escape' })
    await wrapper.get('.confirm-backdrop').trigger('pointerdown')
    expect(wrapper.emitted('answer')).toEqual([[false], ['alt'], [true], [false], [false]])
  })
})

describe('confirmation with a command', () => {
  it('shows the command exactly, and its details', () => {
    const w = mount(ConfirmDialog, {
      props: { title: 'Install Cursor CLI?', code: "irm 'https://cursor.com/install?win32=true' | iex", details: [{ label: 'Shell', value: 'Windows PowerShell' }, { label: 'Source', value: 'https://cursor.com/docs/cli/installation' }] }
    })
    expect(w.get('[data-test="confirm-code"]').text()).toBe("irm 'https://cursor.com/install?win32=true' | iex")
    expect(w.get('.confirm-details').text()).toContain('https://cursor.com/docs/cli/installation')
    expect(w.get('.confirm-details').text()).toContain('Windows PowerShell')
    w.unmount()
  })
})
