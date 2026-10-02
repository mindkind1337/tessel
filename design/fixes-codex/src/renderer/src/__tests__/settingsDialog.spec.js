import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'

describe('Settings modal accessibility', () => {
  let wrapper, host, opener, terminal, alreadyInert, previousApi

  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = {}
    host = document.createElement('div')
    host.innerHTML =
      '<button>Settings</button><textarea></textarea><div inert="existing"><button>Hidden</button></div><div class="modal-host"></div>'
    document.body.append(host)
    opener = host.querySelector('button')
    terminal = host.querySelector('textarea')
    alreadyInert = host.querySelector('[inert]')
    opener.focus()
    wrapper = mount(SettingsDialog, { attachTo: host.querySelector('.modal-host') })
  })

  afterEach(() => {
    wrapper?.unmount()
    host.remove()
    resetSettings()
    window.shellApi = previousApi
  })

  it('wraps Tab and Shift+Tab within the modal, including from its initial focus', async () => {
    const dialog = wrapper.get('[role="dialog"]')
    const first = wrapper.get('[aria-label="Close settings"]')
    const last = wrapper.get('.set-foot button')
    expect(document.activeElement).toBe(dialog.element)
    expect(dialog.attributes('aria-modal')).toBe('true')
    await dialog.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first.element)
    await first.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last.element)
    await last.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first.element)
    dialog.element.focus()
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last.element)
  })

  it('blocks background focus and restores the opener and existing inert state on close', () => {
    expect(terminal.hasAttribute('inert')).toBe(true)
    terminal.focus() // jsdom permits this; the focus guard must still contain it.
    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element)
    wrapper.unmount()
    wrapper = null
    expect(document.activeElement).toBe(opener)
    expect(terminal.hasAttribute('inert')).toBe(false)
    expect(alreadyInert.getAttribute('inert')).toBe('existing')
    terminal.focus()
    expect(document.activeElement).toBe(terminal)
  })

  it('names every select and number input and exposes the selected cursor', async () => {
    for (const control of wrapper.findAll('select, input[type="number"]')) {
      expect(control.element.labels.length).toBeGreaterThan(0)
      expect(control.element.labels[0].textContent.trim()).not.toBe('')
    }
    const cursors = wrapper.findAll('[aria-labelledby="settings-cursor-label"] button')
    expect(cursors.map((c) => c.attributes('aria-pressed'))).toEqual(['true', 'false', 'false'])
    await cursors[1].trigger('click')
    expect(cursors.map((c) => c.attributes('aria-pressed'))).toEqual(['false', 'true', 'false'])
  })

  it('keeps Escape and clicking the backdrop available to close Settings', async () => {
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    await wrapper.get('.help-backdrop').trigger('pointerdown')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})
