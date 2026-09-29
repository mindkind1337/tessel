import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SessionsDialog from '../components/SessionsDialog.vue'

let wrapper
const previousApi = window.shellApi
afterEach(() => {
  wrapper?.unmount()
  window.shellApi = previousApi
})

describe('multi-agent conversation history', () => {
  it('filters the new agents, searches titles, and resumes the selected conversation in its saved folder', async () => {
    const rows = [
      {
        agent: 'gemini',
        id: 'gemini-session',
        cwd: 'C:/Project',
        title: 'Gemini login',
        updated: Date.now()
      },
      {
        agent: 'qwen',
        id: 'qwen-session',
        cwd: 'C:/Project',
        title: 'Qwen database',
        updated: Date.now()
      },
      {
        agent: 'opencode',
        id: 'ses_open',
        cwd: 'D:/Other',
        title: 'OpenCode layout',
        updated: Date.now()
      }
    ]
    window.shellApi = { listSessions: vi.fn().mockResolvedValue(rows), writeClipboard: vi.fn() }
    wrapper = mount(SessionsDialog)
    await flushPromises()
    expect(wrapper.findAll('.session-row')).toHaveLength(3)
    await wrapper
      .findAll('.mcp-cat')
      .find((b) => b.text() === 'OpenCode')
      .trigger('click')
    expect(wrapper.findAll('.session-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('OpenCode layout')
    await wrapper.find('.session-row .primary').trigger('click')
    expect(wrapper.emitted('resume')).toEqual([[rows[2]]])
    await wrapper
      .findAll('.mcp-cat')
      .find((b) => b.text() === 'All')
      .trigger('click')
    await wrapper.find('input').setValue('database')
    expect(wrapper.findAll('.session-row')).toHaveLength(1)
    expect(wrapper.text()).toContain('Qwen database')
  })

  it('allows copying an unknown-folder session but never resumes it in the current workspace', async () => {
    const unknown = {
      agent: 'gemini',
      id: 'saved-id',
      cwd: '',
      title: 'Older conversation',
      updated: Date.now()
    }
    window.shellApi = {
      listSessions: vi.fn().mockResolvedValue([unknown]),
      writeClipboard: vi.fn()
    }
    wrapper = mount(SessionsDialog, { props: { cwd: 'C:/Current' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Unknown folder')
    const resume = wrapper.find('.session-row .primary')
    expect(resume.attributes('disabled')).toBeDefined()
    await resume.trigger('click')
    expect(wrapper.emitted('resume')).toBeUndefined()
    await wrapper
      .findAll('.session-row button')
      .find((b) => b.text() === 'Copy ID')
      .trigger('click')
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('saved-id')
    await wrapper
      .findAll('.mcp-cat')
      .find((b) => b.text().startsWith('Only '))
      .trigger('click')
    await flushPromises()
    expect(window.shellApi.listSessions).toHaveBeenLastCalledWith({ cwd: null, limit: 80 })
  })

  it('shows a filter for each agent that has conversations', async () => {
    const rows = [{ agent: 'droid', id: 'droid-session', cwd: 'C:/P', title: 'Droid task', updated: Date.now() }]
    window.shellApi = { listSessions: vi.fn().mockResolvedValue(rows), writeClipboard: vi.fn() }
    wrapper = mount(SessionsDialog)
    await flushPromises()
    const chips = wrapper.findAll('.mcp-cat').map((b) => b.text())
    expect(chips).toContain('Droid')
    expect(chips).toContain('Claude Code')
    expect(chips).not.toContain('Grok')
  })
})
