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

  it('lists no install chips (they are in Settings > Agents)', async () => {
    const w = mount(LaunchMenu, { props: { shells: [], agents }, attachTo: document.body })
    expect(w.find('.launch-install').exists()).toBe(false)
    expect(w.find('[data-test^="launch-install-"]').exists()).toBe(false)
    expect(w.find('[data-test^="launch-docs-"]').exists()).toBe(false)
    expect(w.text()).toContain('Claude Code')
    expect(w.text()).not.toContain('Cursor CLI')
    w.unmount()
  })
})

describe('model at launch', () => {
  it('no model pill: an agent starts with its default from Settings', async () => {
    const agents = [{ id: 'claude', name: 'Claude Code', command: 'claude', available: true }]
    const w = mount(LaunchMenu, { props: { shells: [], agents }, attachTo: document.body })
    expect(w.find('[data-test="launch-model-pill"]').exists()).toBe(false)
    await w.findAll('.launch-item').find((b) => b.text().includes('Claude Code') && !b.text().includes('chat')).trigger('click')
    expect(w.emitted('launch').at(-1)[0]).toEqual({ kind: 'agent', id: 'claude' })
    w.unmount()
  })
})

describe('on an SSH project', () => {
  it('an agent missing on the host: Install… (asks for its install), never offered as ready; its chat neither', async () => {
    const agents = [
      { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
      { id: 'codex', name: 'Codex CLI', command: 'codex', available: false, installOnHost: true }
    ]
    const w = mount(LaunchMenu, { props: { shells: [], agents }, attachTo: document.body })
    const install = w.get('[data-test="launch-host-install-codex"]')
    expect(install.text()).toContain('Install Codex CLI…')
    expect(w.find('[data-test="launch-chat-codex"]').exists()).toBe(false)
    expect(w.findAll('.launch-item').filter((b) => b.text().trim() === 'Codex CLI')).toHaveLength(0)
    await install.trigger('click')
    expect(w.emitted('launch')).toEqual([[{ kind: 'install', id: 'codex' }]])
    w.unmount()
  })
})
