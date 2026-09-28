import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings } from '../settings'

const agents = [
  { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
  { id: 'codex', name: 'Codex CLI', command: 'codex', available: true },
  { id: 'aider', name: 'Aider', command: 'aider', available: false }
]

// The fields save on change (when you leave them), like a real edit.
const change = async (w, v) => {
  w.element.value = v
  await w.trigger('change')
}

describe('Settings > Agents', () => {
  let wrapper, previousApi, opened

  beforeEach(() => {
    resetSettings()
    settings.agentPrefs = {}
    opened = []
    previousApi = window.shellApi
    window.shellApi = { openExternal: (u) => opened.push(u) }
    wrapper = mount(SettingsDialog, { props: { agents }, attachTo: document.body })
  })

  afterEach(() => {
    wrapper?.unmount()
    settings.agentPrefs = {}
    resetSettings()
    window.shellApi = previousApi
  })

  it('offers only installed, turned-on agents as the default agent', async () => {
    const opts = () => wrapper.findAll('#settings-default-agent option').map((o) => o.attributes('value'))
    expect(opts()).toEqual(['', 'claude', 'codex'])
    await wrapper.get('[data-agent="codex"] .set-switch').setValue(false)
    expect(settings.agentPrefs.codex.enabled).toBe(false)
    expect(opts()).toEqual(['', 'claude'])
  })

  it('Yolo shows a warning; Customize saves command, arguments and variables; Reset clears them', async () => {
    expect(wrapper.find('.agents-warn').exists()).toBe(false)
    await wrapper.findAll('#set-agents .launch-seg-btn')[1].trigger('click')
    expect(settings.agentPermissions).toBe('yolo')
    expect(wrapper.find('.agents-warn').exists()).toBe(true)

    const row = wrapper.get('[data-agent="claude"]')
    await row.findAll('button').find((b) => b.text() === 'Customize').trigger('click')
    const inputs = row.findAll('.agent-custom input')
    await change(inputs[0], 'C:\\tools\\claude.cmd')
    await change(inputs[1], '--model sonnet')
    await change(row.get('textarea'), 'BAD NAME=1')
    expect(row.text()).toMatch(/not a valid variable name/)
    await change(row.get('textarea'), 'ANTHROPIC_MODEL=x')
    expect(row.text()).not.toMatch(/not a valid/)
    expect(settings.agentPrefs.claude).toEqual({ command: 'C:\\tools\\claude.cmd', args: '--model sonnet', env: 'ANTHROPIC_MODEL=x' })
    expect(row.text()).toMatch(/customized/)

    await row.findAll('button').find((b) => b.text() === 'Reset').trigger('click')
    expect(settings.agentPrefs.claude).toBeUndefined()
  })

  it('Docs opens the agent’s documentation', async () => {
    await wrapper.get('[data-agent="claude"]').findAll('button').find((b) => b.text() === 'Docs').trigger('click')
    expect(opened).toEqual(['https://code.claude.com/docs'])
  })
})
