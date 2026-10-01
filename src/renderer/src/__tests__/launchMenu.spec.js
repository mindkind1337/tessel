import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LaunchMenu from '../components/LaunchMenu.vue'

describe('LaunchMenu', () => {
  it('offers a browser pane, even with no agent installed', async () => {
    const w = mount(LaunchMenu, { props: { shells: [], agents: [] }, attachTo: document.body })
    const item = w.find('[data-test="launch-browser"]')
    expect(item.exists()).toBe(true)
    expect(item.text()).toContain('Browser')
    await item.trigger('click')
    expect(w.emitted('launch')).toEqual([[{ kind: 'browser' }]])
    w.unmount()
  })

  it('offers OpenCode as a chat only when OpenCode is installed', async () => {
    const none = mount(LaunchMenu, { props: { shells: [], agents: [{ id: 'opencode', name: 'OpenCode', command: 'opencode', available: false, install: ['npm install -g opencode-ai'] }] }, attachTo: document.body })
    expect(none.find('[data-test="launch-chat-opencode"]').exists()).toBe(false)
    none.unmount()
    const w = mount(LaunchMenu, { props: { shells: [], agents: [{ id: 'opencode', name: 'OpenCode', command: 'opencode', available: true }] }, attachTo: document.body })
    const item = w.get('[data-test="launch-chat-opencode"]')
    expect(item.text()).toContain('OpenCode (chat)')
    await item.trigger('click')
    expect(w.emitted('launch')).toEqual([[{ kind: 'chat', id: 'opencode' }]])
    w.unmount()
  })
})

describe('agents not installed', () => {
  const agents = [
    { id: 'cline', name: 'Cline', command: 'cline', available: false, install: ['npm install -g cline'], installConfirm: false },
    { id: 'cursor', name: 'Cursor CLI', command: 'cursor-agent', available: false, install: ["irm 'https://cursor.com/install?win32=true' | iex"], installShell: 'powershell', installSource: 'https://cursor.com/docs/cli/installation', installConfirm: true },
    { id: 'zcode', name: 'ZCode', command: 'zcode', available: false, install: null, docsUrl: 'https://zcode.z.ai/' },
    { id: 'mystery', name: 'Mystery', command: 'mystery', available: false, install: null, docsUrl: null },
    { id: 'claude', name: 'Claude Code', command: 'claude', available: true, install: ['npm install -g @anthropic-ai/claude-code'], docsUrl: 'https://code.claude.com/docs' }
  ]

  it('offers Install for a known installer, the install page otherwise, and hides the rest', async () => {
    const w = mount(LaunchMenu, { props: { shells: [], agents }, attachTo: document.body })
    expect(w.find('[data-test="launch-install-cline"]').exists()).toBe(true)
    expect(w.find('[data-test="launch-install-cursor"]').exists()).toBe(true)
    expect(w.find('[data-test="launch-install-zcode"]').exists()).toBe(false)
    expect(w.find('[data-test="launch-docs-zcode"]').exists()).toBe(true)
    expect(w.find('[data-test="launch-docs-cursor"]').exists()).toBe(false)
    expect(w.find('[data-test="launch-install-mystery"]').exists()).toBe(false)
    expect(w.find('[data-test="launch-docs-mystery"]').exists()).toBe(false)
    // Installed: started, never offered for install.
    expect(w.find('[data-test="launch-install-claude"]').exists()).toBe(false)
    expect(w.find('[data-test="launch-docs-claude"]').exists()).toBe(false)
    // A confirmed install says so before the click.
    expect(w.get('[data-test="launch-install-cursor"]').attributes('title')).toContain('asks first')
    await w.get('[data-test="launch-install-cursor"]').trigger('click')
    expect(w.emitted('install')[0][0].id).toBe('cursor')
    await w.get('[data-test="launch-docs-zcode"]').trigger('click')
    expect(w.emitted('docs')[0][0].docsUrl).toBe('https://zcode.z.ai/')
    w.unmount()
  })
})

describe('effort without a chosen model', () => {
  it("the picker offers the running model's effort; the menu launches with that model and effort", async () => {
    const SessionOptionPicker = (await import('../components/SessionOptionPicker.vue')).default
    const { modelsFor } = await import('../agentModels')
    const p = mount(SessionOptionPicker, { props: { agentId: 'claude', models: modelsFor('claude'), values: null, fallbackModel: 'opus' } })
    const efforts = p.findAll('[data-test="sop-option"][data-option="effort"]').map((b) => b.attributes('data-value'))
    expect(efforts).toContain('high')
    await p.get('[data-test="sop-option"][data-option="effort"][data-value="high"]').trigger('click')
    expect(p.emitted('set')[0][0]).toEqual({ optionId: 'effort', value: 'high' })
    p.unmount()

    const agents = [{ id: 'claude', name: 'Claude Code', command: 'claude', available: true }]
    const w = mount(LaunchMenu, { props: { shells: [], agents }, attachTo: document.body })
    await w.get('[data-test="launch-model-pill"]').trigger('click')
    await w.get('[data-test="sop-option"][data-option="effort"][data-value="high"]').trigger('click')
    await w.findAll('.launch-item').find((b) => b.text().includes('Claude Code') && !b.text().includes('chat')).trigger('click')
    const launched = w.emitted('launch').at(-1)[0]
    expect(launched.sessionOptions.effort).toBe('high')
    expect(typeof launched.sessionOptions.model).toBe('string')
    w.unmount()
  })
})
