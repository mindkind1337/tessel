// Settings > Browser: "Clear cookies" asks first (a danger confirmation).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'

describe('Settings > Browser > Clear cookies', { timeout: 30_000 }, () => {
  let previousApi, api
  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    api = { clearImportedCookies: vi.fn().mockResolvedValue({ ok: true }) }
    window.shellApi = { browser: api }
  })
  afterEach(() => {
    window.shellApi = previousApi
    resetSettings()
  })

  async function clickClear(answer) {
    const askConfirm = vi.fn().mockResolvedValue(answer)
    const wrapper = mount(SettingsDialog, { props: { section: 'browser' }, global: { provide: { askConfirm } } })
    await wrapper.get('[data-test="settings-clear-cookies"]').trigger('click')
    await flushPromises()
    wrapper.unmount()
    return askConfirm
  }

  it('asks with a danger confirmation and does nothing on Cancel', async () => {
    const askConfirm = await clickClear(false)
    expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(api.clearImportedCookies).not.toHaveBeenCalled()
  })

  it('clears once confirmed', async () => {
    await clickClear(true)
    expect(api.clearImportedCookies).toHaveBeenCalledTimes(1)
  })
})
