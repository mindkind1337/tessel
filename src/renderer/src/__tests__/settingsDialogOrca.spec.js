// The Settings pages for the settings taken from Orca: each row is there with
// Orca's label, and its control changes the shared settings.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings } from '../settings'
import { selectOptions, setSelectValue } from './selectTestUtils'

describe('Settings: the Orca settings', () => {
  let wrapper, previousApi
  function open(section) {
    wrapper = mount(SettingsDialog, { props: { section }, attachTo: document.body })
  }
  function row(label) {
    const r = wrapper.findAll('.set-row').find((el) => el.text().includes(label))
    if (!r) throw new Error(`no row "${label}"`)
    return r
  }
  async function clickSeg(label, choice) {
    const b = row(label)
      .findAll('button')
      .find((el) => el.text() === choice)
    await b.trigger('click')
  }
  async function type(id, value) {
    const input = wrapper.get(`#${id}`)
    input.element.value = String(value)
    await input.trigger('change')
    return input
  }
  // A slider: moved to a value (its input event).
  async function slide(id, value) {
    const input = wrapper.get(`#${id}`)
    input.element.value = String(value)
    await input.trigger('input')
    return input
  }

  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = {}
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    resetSettings()
    window.shellApi = previousApi
    try {
      localStorage.clear()
    } catch {
      /* none */
    }
  })

  it('Editor: font family, the diff switches (a Diffs group) and the Files options', async () => {
    open('editor')
    await type('settings-editor-font', '  Fira Code ')
    expect(settings.editorFontFamily).toBe('Fira Code')
    const diffs = wrapper.get('#set-editor [data-group="diffs"]')
    expect(diffs.get('.set-group-title').text()).toBe('Diffs')
    for (const [label, key] of [
      ['Show whitespace in diffs', 'diffShowWhitespace'],
      ['Collapse unchanged regions', 'diffCollapseUnchanged'],
      ['Wrap lines in diffs', 'diffWordWrap']
    ]) {
      expect(settings[key]).toBe(false)
      const r = row(label)
      expect(r.findAll('.launch-seg-btn')).toHaveLength(0) // a switch, not Off/On
      await r.get('input.set-switch').setValue(true)
      expect(settings[key]).toBe(true)
    }
    // Moved from Appearance: the Files panel's options.
    const files = wrapper.get('#set-editor [data-group="files"]')
    await files.get('[data-setting="showGitIgnoredFiles"]').setValue(false)
    expect(settings.showGitIgnoredFiles).toBe(false)
    const compact = settings.explorerCompactFolders
    await files.get('[data-test="settings-compact-folders"]').setValue(!compact)
    expect(settings.explorerCompactFolders).toBe(!compact)
  })

  it('Terminal: the font (the old Text page), weights as lists, line height and cursor opacity', async () => {
    open('terminal')
    const weight = wrapper.get('#settings-font-weight')
    const labels = (await selectOptions(weight)).map((o) => o.text())
    expect(labels).toHaveLength(9)
    expect(labels[0]).toBe('Thin (100)')
    expect(labels[3]).toBe('Normal (400)')
    await setSelectValue(weight, 600)
    expect(settings.fontWeight).toBe(600)
    await setSelectValue(wrapper.get('#settings-font-weight-bold'), 800)
    expect(settings.fontWeightBold).toBe(800)
    // A weight saved before the lists (350) still shows, as itself.
    settings.fontWeight = 350
    await nextTick()
    expect(wrapper.get('#settings-font-weight').text()).toBe('350')
    await type('settings-line-height', 1.25)
    expect(settings.lineHeight).toBe(1.25)
    await slide('settings-cursor-opacity', 0.4)
    expect(settings.cursorOpacity).toBe(0.4)
    // Moved from Appearance: the padding, and hiding the mouse.
    await type('settings-pad-x', 12)
    await type('settings-pad-y', 2)
    expect([settings.terminalPaddingX, settings.terminalPaddingY]).toEqual([12, 2])
    await row('Hide mouse while typing').get('input').setValue(true)
    expect(settings.hideMouseWhileTyping).toBe(true)
    // No icon before the shell list.
    expect(wrapper.find('#set-terminal .set-shell').exists()).toBe(false)
  })

  it('Appearance: four groups, UI zoom, sliders for the panes', async () => {
    open('appearance')
    expect(wrapper.findAll('#set-appearance .set-group-title').map((h) => h.text())).toEqual(['Interface', 'Panes', 'Left sidebar', 'Status bar'])
    const zoom = row('UI zoom')
    expect(zoom.get('[data-test="ui-zoom-percent"]').text()).toBe('100%')
    await zoom.get('button[aria-label="Zoom in"]').trigger('click')
    expect(settings.uiZoomLevel).toBe(0.5)
    expect(zoom.get('[data-test="ui-zoom-percent"]').text()).toBe('110%')
    await zoom.findAll('button').find((b) => b.text() === 'Reset').trigger('click')
    expect(settings.uiZoomLevel).toBe(0)
    expect(wrapper.get('#settings-inactive-opacity').attributes('type')).toBe('range')
    await slide('settings-inactive-opacity', 0.5)
    expect(settings.inactivePaneOpacity).toBe(0.5)
    expect(row('Inactive pane opacity').get('output').text()).toBe('50%')
    expect(wrapper.get('#settings-divider').attributes('type')).toBe('range')
    await slide('settings-divider', 6)
    expect(settings.dividerThickness).toBe(6)
    expect(row('Divider thickness').get('output').text()).toBe('6 px')
    // Moved out: usage to Stats & Usage, files to Editor, padding to Terminal.
    const page = wrapper.get('#set-appearance')
    for (const gone of ['Usage percentages', 'Usage refresh', 'Show Git-ignored files', 'Compact folders', 'Horizontal padding', 'Hide mouse while typing'])
      expect(page.text()).not.toContain(gone)
    // The status bar's indicators wait for the bar.
    settings.statusBarVisible = false
    await nextTick()
    expect(wrapper.get('[data-status-item="ports"]').attributes('disabled')).toBeDefined()
  })

  it('Stats & Usage: the usage menu settings, with the refresh as a list', async () => {
    window.shellApi = {
      providerUsage: {
        capabilities: async () => ({
          ok: true,
          providers: [
            { id: 'claude', name: 'Claude Code', report: true, quota: true },
            { id: 'kimi', name: 'Kimi', report: false, quota: true }
          ]
        })
      }
    }
    open('stats')
    await flushPromises()
    // Shown in the Usage menu (and the analytics): a chip per provider.
    const kimi = wrapper.get('[data-usage-provider="kimi"]')
    expect(kimi.attributes('aria-pressed')).toBe('true')
    await kimi.trigger('click')
    expect(settings.hiddenUsageProviders).toEqual(['kimi'])
    expect(kimi.attributes('aria-pressed')).toBe('false')
    await kimi.trigger('click')
    expect(settings.hiddenUsageProviders).toEqual([])
    await clickSeg('Usage percentages', 'Remaining')
    expect(settings.usagePercentageDisplay).toBe('remaining')
    const refresh = wrapper.get('#settings-usage-refresh')
    expect((await selectOptions(refresh)).map((o) => o.text())).toEqual(['Off', '2 min', '5 min', '15 min', '30 min', '60 min'])
    await setSelectValue(refresh, 30)
    expect(settings.usageRefreshMinutes).toBe(30)
  })

  it('Terminal: GPU Acceleration, Color Contrast, scroll speed, interaction and word separators', async () => {
    open('terminal')
    expect(row('GPU acceleration').text()).toContain('Auto tries WebGL')
    await clickSeg('GPU acceleration', 'Off')
    expect(settings.gpuAcceleration).toBe('off')
    expect(row('GPU acceleration').text()).toContain('DOM renderer')

    expect(row('Color contrast').text()).toContain('Recommended')
    await clickSeg('Color contrast', 'Custom')
    expect(settings.minimumContrastRatio).toBe(4.5)
    await type('settings-contrast-ratio', 7)
    expect(settings.minimumContrastRatio).toBe(7)
    await clickSeg('Color contrast', 'Off')
    expect(settings.minimumContrastRatio).toBe(1)
    await clickSeg('Color contrast', 'Custom')
    expect(settings.minimumContrastRatio).toBe(7)
    await clickSeg('Color contrast', 'Automatic')
    expect(settings.minimumContrastRatio).toBe(null)

    await type('settings-scroll-normal', 2.5)
    await type('settings-scroll-fast', 50)
    expect([settings.scrollSensitivity, settings.fastScrollSensitivity]).toEqual([2.5, 10])
    await row('Scroll speed').get('button').trigger('click')
    expect([settings.scrollSensitivity, settings.fastScrollSensitivity]).toEqual([1.15, 5])

    await row('Focus follows mouse').get('input').setValue(true)
    await row('Trim gutter on copy').get('input').setValue(false)
    await row('Allow TUI clipboard writes (OSC 52)').get('input').setValue(false)
    expect([settings.focusFollowsMouse, settings.copyTrimsGutter, settings.allowOsc52Clipboard]).toEqual([true, false, false])
    await wrapper.get('#settings-word-separators').setValue(' ()')
    expect(settings.wordSeparator).toBe(' ()')
  })

  it('Notifications: master switch, bell, volume, suppress, test button', async () => {
    open('alerts')
    expect(wrapper.get('#set-alerts-title').text()).toBe('Notifications')
    // The rows the master switch turns on are indented under it.
    for (const label of ['Windows notifications', 'Terminal bell', 'Suppress while focused', 'Sound'])
      expect(row(label).classes()).toContain('set-row-nested')
    expect(row('In-app alerts').classes()).not.toContain('set-row-nested')
    await row('Terminal bell').get('input').setValue(true)
    expect(settings.notifyTerminalBell).toBe(true)
    expect(wrapper.find('#settings-volume').exists()).toBe(false) // no sound chosen
    expect(wrapper.find('[data-test="alerts-preview"]').exists()).toBe(false)
    settings.alertSound = 'chime'
    await nextTick()
    // Sound, volume and its preview on one row.
    expect(row('Sound').find('#settings-volume').exists()).toBe(true)
    expect(row('Sound').find('[data-test="alerts-preview"]').exists()).toBe(true)
    const vol = wrapper.get('#settings-volume')
    vol.element.value = '35'
    await vol.trigger('input')
    expect(settings.notificationVolume).toBe(35)
    await row('Suppress while focused').get('input').setValue(false)
    expect(settings.notifySuppressWhenFocused).toBe(false)
    await wrapper.get('[data-test="test-notification"]').trigger('click')
    expect(wrapper.emitted('test-notification')).toHaveLength(1)
    await row('Enable notifications').get('input').setValue(false)
    expect(settings.notificationsEnabled).toBe(false)
    expect(wrapper.get('[data-test="test-notification"]').attributes('disabled')).toBeDefined()
    expect(row('Terminal bell').get('input').attributes('disabled')).toBeDefined()
    expect(row('Terminal bell').classes()).toContain('set-disabled')
    expect(wrapper.get('[data-test="alerts-preview"]').attributes('disabled')).toBeDefined()
    // In-app alerts do not depend on it.
    expect(row('In-app alerts').get('input').attributes('disabled')).toBeUndefined()
  })

  it('General: running terminals, workspace directory, deleting workspaces', async () => {
    open('general')
    expect(row('Confirm before closing running terminals').text()).toContain(
      'Ask before stopping a running agent or command when closing a terminal.'
    )
    await type('settings-workspace-dir', ' D:\\copies ')
    expect(settings.workspaceDir).toBe('D:\\copies')
    await row('Workspace directory')
      .findAll('button')
      .find((b) => b.text() === 'Reset')
      .trigger('click')
    expect(settings.workspaceDir).toBe('')
    await row('Ask before deleting workspaces').get('input').setValue(false)
    expect(settings.confirmDeleteWorkspace).toBe(false)
  })

  it('Git & Source Control: branch prefix with feedback, group order', async () => {
    open('git')
    const feedback = () => wrapper.get('[data-test="branch-prefix-feedback"]')
    expect(feedback().text()).toBe('Branches will be named agent/feature')
    // The custom prefix on its own row, under the choice.
    const input = wrapper.get('input[aria-label="Custom branch prefix"]')
    expect(row('Branch prefix').find('input').exists()).toBe(false)
    expect(input.element.closest('.set-row').classList.contains('set-row-nested')).toBe(true)
    await input.setValue('bad name')
    expect(feedback().text()).toMatch(/cannot contain spaces/)
    expect(feedback().classes()).toContain('set-error')
    await input.setValue('team/')
    expect(feedback().text()).toBe('Branches will be named team/feature')
    await clickSeg('Branch prefix', 'None')
    expect(settings.branchPrefix).toBe('none')
    expect(wrapper.find('input[aria-label="Custom branch prefix"]').exists()).toBe(false)
    expect(feedback().text()).toBe('New branches get no prefix.')
    await clickSeg('Branch prefix', 'Git username')
    expect(settings.branchPrefix).toBe('git-username')
    expect(feedback().text()).toMatch(/github\.user/)
    // The group order is a select (three long choices).
    await setSelectValue(wrapper.get('#settings-group-order'), 'staged-first')
    expect(settings.sourceControlGroupOrder).toBe('staged-first')
    await clickSeg('Show changed files as', 'List')
    expect(settings.sourceControlViewMode).toBe('list')
  })

  it('About & updates: version, last checked, Check now, release notes, troubleshooting, licenses', async () => {
    const openExternal = vi.fn(async () => ({ ok: true }))
    window.shellApi = { openExternal }
    wrapper = mount(SettingsDialog, {
      props: { section: 'updates', updateStatus: { state: 'none', current: '1.16.0', checkedAt: Date.now() - 5 * 60e3 } },
      attachTo: document.body
    })
    expect(wrapper.get('#set-updates-title').text()).toBe('About & updates')
    expect(wrapper.get('.set-nav-item[data-page="updates"]').text()).toBe('About & updates')
    expect(wrapper.get('[data-test="about-version"]').text()).toBe('1.16.0')
    expect(wrapper.get('[data-test="update-status"]').text()).toMatch(/^You have the latest version · Last checked 5 min\.? ago$/)
    await wrapper.get('[data-test="update-check"]').trigger('click')
    expect(wrapper.emitted('check-updates')).toHaveLength(1)
    await wrapper.get('[data-test="update-notes"]').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/mindkind1337/tessel/releases/tag/v1.16.0')
    // Logs and diagnostics: General's Troubleshooting group, opened from here.
    await wrapper.get('[data-test="about-troubleshooting"]').trigger('click')
    expect(wrapper.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))).toEqual(['general'])
    await wrapper.get('.set-nav-item[data-page="updates"]').trigger('click')
    await wrapper.get('[data-test="about-notices"]').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/mindkind1337/tessel/blob/v1.16.0/THIRD_PARTY_NOTICES.md')
    // A failed check: one sentence, what went wrong behind Details.
    await wrapper.setProps({ updateStatus: { state: 'error', current: '1.16.0', message: 'net::ERR_NAME_NOT_RESOLVED' } })
    expect(wrapper.get('[data-test="update-status"]').text()).toBe('Could not check for updates. Try again later.')
    expect(wrapper.get('#set-updates details').text()).toContain('ERR_NAME_NOT_RESOLVED')
    // Ready: Restart and update, and the new version's notes.
    await wrapper.setProps({ updateStatus: { state: 'ready', current: '1.16.0', version: '1.17.0' } })
    await wrapper.get('[data-test="update-restart"]').trigger('click')
    expect(wrapper.emitted('open-update')).toHaveLength(1)
    await wrapper.get('[data-test="update-notes"]').trigger('click')
    expect(openExternal).toHaveBeenLastCalledWith('https://github.com/mindkind1337/tessel/releases/tag/v1.17.0')
  })

  it('search still finds the settings of the reworked pages', async () => {
    open('general')
    const shown = async (text) => {
      await wrapper.get('input[type="search"]').setValue(text)
      await nextTick()
      await nextTick()
      return wrapper.findAll('.set-page').filter((p) => !p.element.hidden).map((p) => p.attributes('data-page'))
    }
    expect(await shown('volume')).toEqual(['alerts'])
    expect(await shown('group order')).toEqual(['git'])
    expect(await shown('custom prefix')).toEqual(['git'])
    expect(await shown('release notes')).toEqual(['updates'])
    expect(await shown('third-party')).toEqual(['updates'])
    expect(await shown('press enter')).toEqual(['quick-commands'])
    expect(await shown('about')).toContain('updates')
  }, 20000)

  it('search finds the new settings by their Orca names', async () => {
    open('general')
    await wrapper.get('input[type="search"]').setValue('trim gutter')
    await nextTick()
    await nextTick()
    const shownPages = wrapper.findAll('.set-page').filter((p) => !p.element.hidden)
    expect(shownPages.map((p) => p.attributes('data-page'))).toEqual(['terminal'])
  })
})
