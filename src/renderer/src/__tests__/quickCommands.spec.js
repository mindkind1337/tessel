import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { settings, loadSettings, resetSettings, validQuickCommand } from '../settings'
import SettingsDialog from '../components/SettingsDialog.vue'

describe('quick commands', () => {
  beforeEach(() => {
    settings.quickCommands = []
    window.shellApi = {}
  })

  it('loads only well-formed ones, and a reset keeps them', () => {
    loadSettings({
      quickCommands: [
        { id: 'qc-1', name: 'Tests', text: 'npm test', enter: true },
        { id: 'qc-2', name: '', text: 'x', enter: true },
        { id: 'qc-3', name: 'No enter flag', text: 'x' },
        'junk'
      ]
    })
    expect(settings.quickCommands.map((q) => q.id)).toEqual(['qc-1'])
    resetSettings()
    expect(settings.quickCommands.map((q) => q.id)).toEqual(['qc-1'])
    expect(validQuickCommand({ id: 'a', name: 'n', text: 'x'.repeat(20001), enter: false })).toBe(false)
  })

  it('are added and removed in Settings', async () => {
    const w = mount(SettingsDialog, { attachTo: document.body })
    const form = w.findAll('form.custom-agent-form').at(-1)
    const [name, text] = form.findAll('input.set-number')
    await name.setValue('Run tests')
    await text.setValue('npm test')
    await form.trigger('submit')
    expect(settings.quickCommands).toMatchObject([{ name: 'Run tests', text: 'npm test', enter: true }])
    await w.find('#set-quick-commands .quick-row .exit-btn').trigger('click')
    expect(settings.quickCommands).toEqual([])
    await form.trigger('submit')
    expect(w.find('#set-quick-commands .mcp-error').text()).toMatch(/name and the text/)
    w.unmount()
  })
})
