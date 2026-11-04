// Settings > Agents, an agent's variables: the warning for a text that cannot
// be read comes from the saved text, so it is there when Settings opens again
// (the variables of such a text are all ignored at launch until it is fixed).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings } from '../settings'

const agents = [{ id: 'claude', name: 'Claude Code', command: 'claude', available: true }]

describe('the variables warning of an agent', () => {
  let previousApi
  let wrapper
  beforeEach(() => {
    previousApi = window.shellApi
    window.shellApi = { openExternal() {} }
    resetSettings()
  })
  afterEach(() => {
    if (wrapper) wrapper.unmount()
    resetSettings()
    window.shellApi = previousApi
  })

  it('shows for a saved text that cannot be read, without any edit; gone once the text is fixed', async () => {
    settings.agentPrefs = { claude: { env: 'no equals here' } }
    wrapper = mount(SettingsDialog, { props: { agents }, attachTo: document.body })
    const warn = wrapper.find('.agent-env-error')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toMatch(/NAME=value/)
    expect(warn.text()).toMatch(/Not used until fixed/)
    settings.agentPrefs = { claude: { env: 'ANTHROPIC_MODEL=x' } }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.agent-env-error').exists()).toBe(false)
  })

  it('nothing for an agent without variables', () => {
    wrapper = mount(SettingsDialog, { props: { agents }, attachTo: document.body })
    expect(wrapper.find('.agent-env-error').exists()).toBe(false)
  })
})
