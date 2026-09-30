import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings } from '../settings'
import { updateFailureText, updateKindLabel } from '../agentUpdateErrors'

const agents = [
  { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
  { id: 'codex', name: 'Codex CLI', command: 'codex', available: true }
]
const agentUpdates = {
  checkedAt: Date.now(),
  agents: {
    claude: { id: 'claude', name: 'Claude Code', installed: '2.1.0', latest: '2.2.0', update: true, steps: ['claude update'] },
    codex: { id: 'codex', name: 'Codex CLI', installed: '0.9.0', latest: '0.9.0', update: false, steps: ['npm install -g @openai/codex@latest'] }
  }
}
const failed = {
  agentId: 'codex',
  name: 'Codex CLI',
  at: Date.now() - 1000,
  ok: false,
  kind: 'network',
  from: '0.8.0',
  to: '0.9.0',
  detail: 'npm error code ENOTFOUND',
  file: 'C:\\logs\\installs\\Update-Codex-CLI-20260928-101010.log',
  via: 'background'
}
const succeeded = { ...failed, agentId: 'claude', name: 'Claude Code', ok: true, kind: 'ok', from: '2.0.0', to: '2.1.0', version: '2.1.0', detail: '', via: 'pane' }

describe('Settings > Agents: updates', () => {
  let wrapper, previousApi
  const mountWith = (props = {}) => {
    wrapper = mount(SettingsDialog, {
      props: { agents, section: 'agents', agentUpdates, agentUpdateHistory: { entries: [failed, succeeded], last: { codex: failed, claude: succeeded } }, ...props },
      attachTo: document.body
    })
  }
  beforeEach(() => {
    resetSettings()
    settings.agentPrefs = {}
    previousApi = window.shellApi
    window.shellApi = {}
  })
  afterEach(() => {
    wrapper?.unmount()
    resetSettings()
    window.shellApi = previousApi
  })

  it('shows each agent’s last result: versions, failed with the reason in plain words, and View log', async () => {
    mountWith()
    const codex = wrapper.get('[data-test="agent-update-last-codex"]')
    expect(codex.element.closest('.agent-set-header')).toBeNull()
    expect(codex.element.closest('.agent-set-details')).not.toBeNull()
    expect(codex.text()).toContain('0.8.0 → 0.9.0')
    expect(codex.text()).toContain('failed (Network error)')
    expect(codex.text()).toContain(updateFailureText('network', 'Codex CLI'))
    expect(codex.text()).toContain('npm error code ENOTFOUND')
    await wrapper.get('[data-test="view-update-log-codex"]').trigger('click')
    expect(wrapper.emitted('open-update-log')[0]).toEqual([failed.file])
    const claude = wrapper.get('[data-test="agent-update-last-claude"]')
    expect(claude.text()).toContain('2.0.0 → 2.1.0, succeeded')
  })

  it('Update runs in the background; Run in a terminal is the secondary action', async () => {
    mountWith()
    await wrapper.get('[data-test="update-agent-claude"]').trigger('click')
    expect(wrapper.emitted('update-agent')[0]).toEqual(['claude'])
    await wrapper.get('[data-test="update-agent-pane-claude"]').trigger('click')
    expect(wrapper.emitted('update-agent-in-pane')[0]).toEqual(['claude'])
    expect(wrapper.find('[data-test="update-agent-pane-codex"]').exists()).toBe(false) // no update for it
  })

  it('a running update shows a spinner and Updating…', () => {
    mountWith({ agentUpdateJobs: { claude: { agentId: 'claude', name: 'Claude Code', phase: 'updating', via: 'background', startedAt: Date.now() } } })
    const job = wrapper.get('[data-test="agent-update-job-claude"]')
    expect(job.text()).toContain('Updating in the background…')
    expect(job.find('.sb-spin').exists()).toBe(true)
    expect(wrapper.get('[data-test="update-agent-claude"]').text()).toContain('Updating…')
    expect(wrapper.find('[data-test="update-agent-pane-claude"]').exists()).toBe(false)
  })

  it('files in use by its panes: Close and reopen them', async () => {
    const inUse = { ...succeeded, ok: false, kind: 'in-use', at: Date.now() }
    mountWith({
      agentUpdateJobs: { claude: { agentId: 'claude', name: 'Claude Code', phase: 'failed', inUse: true, error: 'its files are in use by its panes', startedAt: Date.now() - 5000 } },
      agentUpdateHistory: { entries: [inUse], last: { claude: inUse } }
    })
    const last = wrapper.get('[data-test="agent-update-last-claude"]')
    expect(last.text()).toContain('Tessel can close and reopen them')
    await wrapper.get('[data-test="close-reopen-claude"]').trigger('click')
    expect(wrapper.emitted('close-reopen-agent-update')[0]).toEqual(['claude'])
  })

  it('the update history lists the last attempts', async () => {
    mountWith()
    const history = wrapper.get('[data-test="agent-update-history"]')
    expect(history.text()).toContain('Update history (2)')
    await history.get('button').trigger('click')
    const rows = wrapper.findAll('[data-test="agent-update-history-entry"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Network error')
    expect(rows[1].text()).toContain('in a terminal')
    expect(updateKindLabel('timeout')).toBe('Timed out')
  })
})
