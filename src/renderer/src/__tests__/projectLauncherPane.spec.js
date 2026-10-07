// The empty project's launcher (ProjectLauncher.vue): its choices, keys,
// "Remember for new projects", and the project's recent conversations (on an
// SSH host only while it is connected: listing never signs in).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProjectLauncher from '../components/ProjectLauncher.vue'

const NOW = Date.now()
const SESSIONS = [
  { agent: 'claude', id: 'aaaaaaaa-1111-4222-8333-444444444444', cwd: 'C:\\proj', title: 'Fix the build', updated: NOW - 300_000 },
  { agent: 'codex', id: 'bbbbbbbb-1111-4222-8333-444444444444', cwd: 'C:\\proj\\sub', title: 'Rename things', updated: NOW - 3_600_000 },
  { agent: 'claude', id: 'cccccccc-1111-4222-8333-444444444444', cwd: 'D:\\other', title: 'Elsewhere', updated: NOW }
]
const AGENTS = [
  { id: 'claude', name: 'Claude Code', accent: null, unchecked: false },
  { id: 'codex', name: 'Codex', accent: null, unchecked: false }
]
const SHELLS = [
  { id: 'powershell', name: 'PowerShell' },
  { id: 'cmd', name: 'Command Prompt' }
]

let api
let wrapper = null
beforeEach(() => {
  api = {
    listSessions: vi.fn(async () => SESSIONS),
    listRemoteSessions: vi.fn(async () => ({ ok: true, sessions: [{ agent: 'claude', id: 'dddddddd-1111-4222-8333-444444444444', cwd: '/srv/app', title: 'On the host', updated: NOW, host: 'ssh-box' }] }))
  }
  window.shellApi = api
})
afterEach(() => {
  if (wrapper) wrapper.unmount()
  wrapper = null
  delete window.shellApi
})

async function open(props = {}) {
  wrapper = mount(ProjectLauncher, { props: { name: 'proj', cwd: 'C:\\proj', agents: AGENTS, shells: SHELLS, ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const picks = () => wrapper.emitted('pick') || []
const key = (k) => wrapper.find('[data-test="project-launcher"]').trigger('keydown', { key: k })

describe('the launcher of an empty project', () => {
  it('lists the agents, a terminal, a browser page and the recent conversations of the project', async () => {
    await open()
    expect(wrapper.find('[data-test="launcher-agent-claude"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="launcher-agent-codex"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="launcher-terminal"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="launcher-browser"]').exists()).toBe(true)
    const rows = wrapper.findAll('[data-test="launcher-session"]')
    expect(rows.map((r) => r.text())).toEqual([expect.stringContaining('Fix the build'), expect.stringContaining('Rename things')])
    expect(rows[0].text()).toContain('Claude Code')
    expect(rows[0].text()).toContain('5m ago')
    // Focused: its keys work at once.
    expect(document.activeElement).toBe(wrapper.find('[data-test="project-launcher"]').element)
  })

  it('each choice says what to start', async () => {
    await open()
    await wrapper.find('[data-test="launcher-agent-codex"]').trigger('click')
    await wrapper.find('[data-test="launcher-terminal"]').trigger('click')
    await wrapper.find('[data-test="launcher-browser"]').trigger('click')
    await wrapper.findAll('[data-test="launcher-session"]')[1].trigger('click')
    expect(picks().map((p) => p[0])).toEqual([
      { kind: 'agent', id: 'codex' },
      { kind: 'terminal', shellId: 'powershell' },
      { kind: 'browser' },
      { kind: 'session', session: SESSIONS[1] }
    ])
  })

  it('keys: a number picks; the arrows and Enter pick; Esc starts nothing', async () => {
    await open()
    await key('2')
    expect(picks().at(-1)[0]).toEqual({ kind: 'agent', id: 'codex' })
    await key('3')
    expect(picks().at(-1)[0]).toEqual({ kind: 'terminal', shellId: 'powershell' })
    await key('ArrowDown')
    await key('ArrowDown')
    await key('ArrowDown')
    await key('Enter')
    expect(picks().at(-1)[0]).toEqual({ kind: 'browser' })
    await key('ArrowUp')
    await key('ArrowUp')
    await key('ArrowUp')
    await key('ArrowUp')
    await key('Enter')
    expect(picks().at(-1)[0].kind).toBe('session')
    const n = picks().length
    await key('Escape')
    await key('9')
    expect(picks().length).toBe(n)
  })

  it('Remember for new projects goes with an agent or a terminal', async () => {
    await open()
    await wrapper.find('[data-test="launcher-remember"]').setValue(true)
    await key('1')
    expect(picks().at(-1)).toEqual([{ kind: 'agent', id: 'claude' }, { remember: true }])
    await wrapper.find('[data-test="launcher-browser"]').trigger('click')
    expect(picks().at(-1)).toEqual([{ kind: 'browser' }, { remember: false }])
  })

  it('More… opens the Agent Session History', async () => {
    await open()
    await wrapper.find('[data-test="launcher-more-sessions"]').trigger('click')
    expect(wrapper.emitted('more-sessions')).toHaveLength(1)
  })

  it('no agent installed: it says so, the terminal is the first choice', async () => {
    await open({ agents: [] })
    expect(wrapper.text()).toContain('No agent is installed')
    await key('1')
    expect(picks().at(-1)[0].kind).toBe('terminal')
  })
})

describe('the launcher of an SSH project', () => {
  const remote = { hostId: 'ssh-box', host: 'Box', path: '/srv/app' }
  it('not connected: nothing is asked of the host, its conversations wait for Connect', async () => {
    await open({ cwd: null, remote, shells: [], hostConnected: false, agents: [{ id: 'claude', name: 'Claude Code', unchecked: true }] })
    expect(api.listRemoteSessions).not.toHaveBeenCalled()
    expect(api.listSessions).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Connect to Box to see its recent conversations.')
    expect(wrapper.text()).toContain('Not checked on the host yet')
    expect(wrapper.find('[data-test="launcher-shell"]').exists()).toBe(false)
    await key('2')
    // The host's login shell: no shell to pass.
    expect(picks().at(-1)[0]).toEqual({ kind: 'terminal', shellId: null })
  })

  it("connected: the host's own conversations of the project, resumed there", async () => {
    await open({ cwd: null, remote, shells: [], hostConnected: false, agents: [] })
    await wrapper.setProps({ hostConnected: true })
    await flushPromises()
    expect(api.listRemoteSessions).toHaveBeenCalledWith({ hostId: 'ssh-box', limit: 50 })
    const rows = wrapper.findAll('[data-test="launcher-session"]')
    expect(rows).toHaveLength(1)
    await rows[0].trigger('click')
    expect(picks().at(-1)[0]).toMatchObject({ kind: 'session', session: { id: 'dddddddd-1111-4222-8333-444444444444', host: 'ssh-box' } })
  })
})

describe('an agent missing on the SSH host', () => {
  it('shows as Install…, and picking it (click or key) asks for its install, never remembered', async () => {
    await open({
      cwd: null,
      remote: { hostId: 'ssh-box', host: 'Box', path: '/srv/app' },
      agents: [AGENTS[0], { id: 'codex', name: 'Codex', accent: null, unchecked: false, missing: true }]
    })
    const row = wrapper.get('[data-test="launcher-agent-codex"]')
    expect(row.text()).toContain('Install Codex…')
    expect(wrapper.find('[data-test="launcher-missing-codex"]').exists()).toBe(true)
    await wrapper.get('[data-test="launcher-remember"]').setValue(true)
    await row.trigger('click')
    await key('2')
    expect(picks()).toEqual([
      [{ kind: 'install', id: 'codex' }, { remember: false }],
      [{ kind: 'install', id: 'codex' }, { remember: false }]
    ])
  })
})
