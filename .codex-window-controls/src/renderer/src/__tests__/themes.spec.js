import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { watch } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { loadSettings, resetSettings, settings } from '../settings'
import { applyTheme, terminalTheme } from '../themes'

describe('appearance preferences', () => {
  let stop
  let wrapper
  let previousApi

  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = {}
    stop = watch(() => settings.theme, applyTheme, { immediate: true, flush: 'sync' })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    stop()
    resetSettings()
    delete document.documentElement.dataset.theme
    window.shellApi = previousApi
  })

  it('keeps the original theme for existing saved workspaces', () => {
    loadSettings({ fontSize: 16, copyOnSelect: false })
    expect(settings.theme).toBe('classic')
    expect(terminalTheme(settings.theme).background).toBe('#15171c')
    expect(settings.fontSize).toBe(16)
    expect(settings.copyOnSelect).toBe(false)
  })

  it('switches in Settings, survives a save/load round trip, and can switch back', async () => {
    wrapper = mount(SettingsDialog)
    const terminal = { options: { theme: terminalTheme(settings.theme) } }
    // xterm receives a new palette; its instance and live buffer remain intact.
    const update = vi.fn((theme) => {
      terminal.options.theme = terminalTheme(theme)
    })
    const unwatch = watch(() => settings.theme, update, { flush: 'sync' })
    try {
      await wrapper.get('#appearance-theme').setValue('warp')
      expect(document.documentElement.dataset.theme).toBe('warp')
      expect(terminal.options.theme.background).toBe('#191b1a')
      const snapshot = JSON.parse(JSON.stringify(settings))
      resetSettings()
      loadSettings(snapshot)
      expect(settings.theme).toBe('warp')
      expect(document.documentElement.dataset.theme).toBe('warp')
      await wrapper.get('#appearance-theme').setValue('classic')
      expect(terminal.options.theme).toEqual(terminalTheme('classic'))
      expect(document.documentElement.dataset.theme).toBe('classic')
      expect(wrapper.emitted('close')).toBeUndefined()
    } finally {
      unwatch()
    }
  })

  it('rejects an invalid theme without changing other preferences', () => {
    loadSettings({ theme: 'warp', fontSize: 17, cursorStyle: 'bar' })
    loadSettings({ theme: '__proto__' })
    expect(settings.theme).toBe('warp')
    expect(settings.fontSize).toBe(17)
    expect(settings.cursorStyle).toBe('bar')
    expect(terminalTheme('__proto__')).toEqual(terminalTheme('classic'))
  })

  it('restores Classic on reset and returns independent xterm palettes', () => {
    loadSettings({ theme: 'warp' })
    resetSettings()
    expect(settings.theme).toBe('classic')
    const palette = terminalTheme('warp')
    palette.background = '#000000'
    expect(terminalTheme('warp').background).toBe('#191b1a')
  })
})
