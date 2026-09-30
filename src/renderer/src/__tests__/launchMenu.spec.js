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
