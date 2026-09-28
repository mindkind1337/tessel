import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'
import { setUiLanguage } from '../i18n'
import { THEMES } from '../themes'

const visiblePages = (wrapper) =>
  wrapper.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))

describe('Settings in French', () => {
  let wrapper, previousApi

  beforeEach(async () => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = {}
    await setUiLanguage('fr')
    wrapper = mount(SettingsDialog, { attachTo: document.body })
  })

  afterEach(async () => {
    wrapper?.unmount()
    window.shellApi = previousApi
    await setUiLanguage('en')
  })

  it('shows the pages, groups and choices in French, and back in English', async () => {
    const nav = wrapper.get('.set-side').text()
    expect(nav).toContain('Apparence')
    expect(nav).toContain('Configurer')
    expect(wrapper.get('#set-agents').text()).toContain('Empêcher la mise en veille')
    expect(THEMES[0].label).toBe('Classique')
    await setUiLanguage('en')
    await nextTick()
    expect(wrapper.get('.set-side').text()).toContain('Appearance')
    expect(THEMES[0].label).toBe('Classic')
  })

  it('search finds rows by their French text, and a page by its English title', async () => {
    await wrapper.get('.set-search input').setValue('graisse')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toEqual(['text'])
    await wrapper.get('.set-search input').setValue('appearance')
    await nextTick()
    await nextTick()
    expect(visiblePages(wrapper)).toContain('appearance')
  })
})
