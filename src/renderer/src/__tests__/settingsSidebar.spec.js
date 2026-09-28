// Orca's settings for the sidebar and the status bar: defaults, validation,
// and where they show in Settings > Appearance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { settings, loadSettings, resetSettings, DEFAULT_SETTINGS } from '../settings'
import SettingsDialog from '../components/SettingsDialog.vue'

beforeEach(() => {
  resetSettings()
  window.shellApi = {}
})
afterEach(() => {
  delete window.shellApi
  resetSettings()
})

describe('sidebar and status bar settings', () => {
  it("default like Orca's", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      sidebarGroupBy: 'repo',
      sidebarSortBy: 'recent',
      sidebarProjectOrderBy: 'manual',
      showSleepingWorkspaces: true,
      alwaysShowDefaultBranchWorkspace: true,
      hideDefaultBranchWorkspace: false,
      agentActivityDisplayMode: 'compact',
      compactWorktreeCards: false,
      leftSidebarAppearanceMode: 'default',
      leftSidebarTintColor: '#18181b',
      leftSidebarTintOpacity: 0.08,
      statusBarVisible: true,
      statusBarItems: ['ssh', 'resource-usage', 'ports']
    })
  })

  it('keeps only valid saved values', () => {
    loadSettings({
      sidebarGroupBy: 'status',
      sidebarSortBy: 'smart',
      statusBarItems: ['ports', 'claude', 'ports', 7],
      worktreeCardProperties: ['inline-agents', 'pr'],
      sidebarFilterRepoIds: ['ws1', 3],
      leftSidebarTintOpacity: 2,
      leftSidebarTintColor: 'red',
      agentActivityDisplayMode: 'full'
    })
    expect(settings.sidebarGroupBy).toBe('repo')
    expect(settings.sidebarSortBy).toBe('smart')
    expect(settings.statusBarItems).toEqual(['ports'])
    expect(settings.worktreeCardProperties).toEqual(['inline-agents'])
    expect(settings.sidebarFilterRepoIds).toEqual(['ws1'])
    expect(settings.leftSidebarTintOpacity).toBe(0.35)
    expect(settings.leftSidebarTintColor).toBe('#18181b')
    expect(settings.agentActivityDisplayMode).toBe('full')
  })

  it('Settings > Appearance > Window & Sidebar has Orca\'s rows', async () => {
    const w = mount(SettingsDialog, { props: { section: 'appearance' } })
    const text = w.find('section[data-page="appearance"]').text()
    for (const s of [
      'Window & Sidebar',
      'Left Sidebar Appearance',
      'Make the left sidebar match your terminal, stay default, or use a tint.',
      'Status Bar',
      'Choose which indicators appear in the status bar.',
      'Remote Hosts',
      'Resource Manager',
      'Show live workspace ports. Click it for workspace-scoped ports and external listeners.',
      'Workspace Card Layout',
      'Workspace cards can use compact or detailed layouts.'
    ])
      expect(text).toContain(s)
    const ports = w.find('[aria-label="Ports"]')
    await ports.trigger('change')
    expect(settings.statusBarItems).toEqual(['ssh', 'resource-usage'])
    w.unmount()
  })
})
