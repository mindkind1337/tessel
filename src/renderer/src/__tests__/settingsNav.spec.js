import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'

// Settings is a page with a sidebar: one page shows at a time.
const visiblePages = (w) =>
  w
    .findAll('.set-page')
    .filter((p) => !p.element.hidden)
    .map((p) => p.attributes('data-page'))
const shown = (el) => !el.closest('[hidden]')
const settle = async () => {
  await nextTick()
  await nextTick()
  await nextTick()
}

// Mounting the whole settings dialog is CPU work (nothing here is timed); on a
// fully loaded machine it can pass the default 5 s.
describe('Settings pages', { timeout: 30_000 }, () => {
  let wrapper, previousApi

  beforeEach(() => {
    resetSettings()
    try {
      localStorage.clear()
    } catch {
      // no storage
    }
    previousApi = window.shellApi
    window.shellApi = {}
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    resetSettings()
    window.shellApi = previousApi
  })

  it('opens on General, and a nav entry shows its page (and is remembered)', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    expect(visiblePages(wrapper)).toEqual(['general'])
    expect(wrapper.get('.set-nav-item[data-page="general"]').attributes('aria-current')).toBe(
      'page'
    )

    await wrapper.get('.set-nav-item[data-page="text"]').trigger('click')
    expect(visiblePages(wrapper)).toEqual(['text'])
    expect(wrapper.get('#set-text h2').text()).toBe('Text')
    expect(wrapper.get('.set-nav-item[data-page="text"]').attributes('aria-current')).toBe('page')
    expect(
      wrapper.get('.set-nav-item[data-page="general"]').attributes('aria-current')
    ).toBeUndefined()
    expect(localStorage.getItem('tessel.settingsPage')).toBe('text')

    wrapper.unmount()
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    expect(visiblePages(wrapper)).toEqual(['text'])
  })

  it('the section prop opens its page', async () => {
    for (const section of ['accounts', 'agents', 'orchestration', 'quick-commands', 'stats']) {
      wrapper = mount(SettingsDialog, { props: { section }, attachTo: document.body })
      expect(visiblePages(wrapper)).toEqual([section])
      expect(wrapper.get(`#set-${section}`).element.hidden).toBe(false)
      wrapper.unmount()
    }
    wrapper = null
  })

  it('mounts analytics only on its page and forwards known worktree paths', async () => {
    wrapper = mount(SettingsDialog, {
      props: { worktreePaths: ['C:/project/copy'] },
      attachTo: document.body,
      global: {
        stubs: {
          StatsUsage: {
            props: ['worktreePaths'],
            template: '<div class="stats-stub">{{ worktreePaths.join() }}</div>'
          }
        }
      }
    })
    expect(wrapper.find('.stats-stub').exists()).toBe(false)
    await wrapper.get('input[type="search"]').setValue('tokens')
    await settle()
    expect(visiblePages(wrapper)).toContain('stats')
    expect(wrapper.find('.stats-stub').exists()).toBe(false)
    await wrapper.get('.set-nav-item[data-page="stats"]').trigger('click')
    await settle()
    expect(visiblePages(wrapper)).toEqual(['stats'])
    expect(wrapper.get('.stats-stub').text()).toBe('C:/project/copy')
    await wrapper.get('.set-nav-item[data-page="general"]').trigger('click')
    expect(wrapper.find('.stats-stub').exists()).toBe(false)
  })

  it('search finds "Font" across pages, with its page name; clearing it goes back', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    await wrapper.get('input[type="search"]').setValue('font')
    await settle()
    expect(visiblePages(wrapper)).toContain('text')
    expect(visiblePages(wrapper)).not.toContain('updates')
    const font = wrapper.get('#settings-font').element
    expect(shown(font)).toBe(true)
    expect(wrapper.get('#set-text h2').text()).toBe('Text')
    // Rows that don't match are hidden, even on the matching page.
    expect(shown(wrapper.get('[aria-labelledby="settings-cursor-label"]').element)).toBe(false)
    expect(wrapper.find('.set-nav-item[aria-current]').exists()).toBe(false)

    await wrapper.get('input[type="search"]').setValue('zzqx')
    await settle()
    expect(visiblePages(wrapper)).toEqual([])
    expect(wrapper.get('.set-empty').text()).toMatch(/No settings match/)

    await wrapper.get('input[type="search"]').setValue('')
    await settle()
    expect(visiblePages(wrapper)).toEqual(['general'])
    expect(wrapper.findAll('[data-sh]')).toHaveLength(0) // nothing the search hid stays hidden
    await wrapper.get('.set-nav-item[data-page="text"]').trigger('click')
    expect(shown(wrapper.get('[aria-labelledby="settings-cursor-label"]').element)).toBe(true)
  })

  it('Ctrl+F focuses the search; Escape there empties it before closing', async () => {
    wrapper = mount(SettingsDialog, { attachTo: document.body })
    const search = wrapper.get('input[type="search"]')
    await wrapper.get('[role="dialog"]').trigger('keydown', { key: 'f', ctrlKey: true })
    expect(document.activeElement).toBe(search.element)
    await search.setValue('theme')
    await search.trigger('keydown', { key: 'Escape' })
    expect(search.element.value).toBe('')
    expect(wrapper.emitted('close')).toBeUndefined()
    await search.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
