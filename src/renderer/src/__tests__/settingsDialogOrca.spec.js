// The Settings pages for the settings taken from Orca: each row is there with
// Orca's label, and its control changes the shared settings.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { settings, resetSettings } from '../settings'

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

  it('Editor: font family and the three diff options', async () => {
    open('editor')
    await type('settings-editor-font', '  Fira Code ')
    expect(settings.editorFontFamily).toBe('Fira Code')
    for (const [label, key] of [
      ['Diff Show Whitespace', 'diffShowWhitespace'],
      ['Collapse Unchanged Regions', 'diffCollapseUnchanged'],
      ['Diff Word Wrap', 'diffWordWrap']
    ]) {
      expect(settings[key]).toBe(false)
      await clickSeg(label, 'On')
      expect(settings[key]).toBe(true)
    }
  })

  it('Text: weights, line height and cursor opacity, kept in range', async () => {
    open('text')
    await type('settings-font-weight', 350)
    expect(settings.fontWeight).toBe(350)
    const bold = await type('settings-font-weight-bold', 2000)
    expect(settings.fontWeightBold).toBe(900)
    expect(bold.element.value).toBe('900')
    await type('settings-line-height', 1.25)
    expect(settings.lineHeight).toBe(1.25)
    await type('settings-cursor-opacity', 0.4)
    expect(settings.cursorOpacity).toBe(0.4)
  })

  it('Appearance: UI Zoom, panes, padding, mouse, usage percentages, git-ignored files', async () => {
    open('appearance')
    const zoom = row('UI Zoom')
    expect(zoom.get('[data-test="ui-zoom-percent"]').text()).toBe('100%')
    await zoom.get('button[aria-label="Zoom in"]').trigger('click')
    expect(settings.uiZoomLevel).toBe(0.5)
    expect(zoom.get('[data-test="ui-zoom-percent"]').text()).toBe('110%')
    await zoom.findAll('button').find((b) => b.text() === 'Reset').trigger('click')
    expect(settings.uiZoomLevel).toBe(0)
    await type('settings-inactive-opacity', 0.5)
    expect(settings.inactivePaneOpacity).toBe(0.5)
    await type('settings-divider', 6)
    expect(settings.dividerThickness).toBe(6)
    await type('settings-pad-x', 12)
    await type('settings-pad-y', 2)
    expect([settings.terminalPaddingX, settings.terminalPaddingY]).toEqual([12, 2])
    await row('Hide Mouse While Typing').get('input').setValue(true)
    expect(settings.hideMouseWhileTyping).toBe(true)
    await clickSeg('Usage percentages', 'Remaining')
    expect(settings.usagePercentageDisplay).toBe('remaining')
    await row('Show Git-Ignored Files').get('input').setValue(false)
    expect(settings.showGitIgnoredFiles).toBe(false)
  })

  it('Terminal: GPU Acceleration, Color Contrast, scroll speed, interaction and word separators', async () => {
    open('terminal')
    expect(row('GPU Acceleration').text()).toContain('Auto tries WebGL')
    await clickSeg('GPU Acceleration', 'Off')
    expect(settings.gpuAcceleration).toBe('off')
    expect(row('GPU Acceleration').text()).toContain('DOM renderer')

    expect(row('Color Contrast').text()).toContain('Recommended')
    await clickSeg('Color Contrast', 'Custom')
    expect(settings.minimumContrastRatio).toBe(4.5)
    await type('settings-contrast-ratio', 7)
    expect(settings.minimumContrastRatio).toBe(7)
    await clickSeg('Color Contrast', 'Off')
    expect(settings.minimumContrastRatio).toBe(1)
    await clickSeg('Color Contrast', 'Custom')
    expect(settings.minimumContrastRatio).toBe(7)
    await clickSeg('Color Contrast', 'Automatic')
    expect(settings.minimumContrastRatio).toBe(null)

    await type('settings-scroll-normal', 2.5)
    await type('settings-scroll-fast', 50)
    expect([settings.scrollSensitivity, settings.fastScrollSensitivity]).toEqual([2.5, 10])
    await row('Scroll Speed').get('button').trigger('click')
    expect([settings.scrollSensitivity, settings.fastScrollSensitivity]).toEqual([1.15, 5])

    await row('Focus Follows Mouse').get('input').setValue(true)
    await row('Trim Gutter on Copy').get('input').setValue(false)
    await row('Allow TUI Clipboard Writes (OSC 52)').get('input').setValue(false)
    expect([settings.focusFollowsMouse, settings.copyTrimsGutter, settings.allowOsc52Clipboard]).toEqual([true, false, false])
    await wrapper.get('#settings-word-separators').setValue(' ()')
    expect(settings.wordSeparator).toBe(' ()')
  })

  it('Notifications: master switch, bell, volume, suppress, test button', async () => {
    open('alerts')
    expect(wrapper.get('#set-alerts-title').text()).toBe('Notifications')
    await row('Terminal Bell').get('input').setValue(true)
    expect(settings.notifyTerminalBell).toBe(true)
    expect(wrapper.find('#settings-volume').exists()).toBe(false) // no sound chosen
    settings.alertSound = 'chime'
    await nextTick()
    const vol = wrapper.get('#settings-volume')
    vol.element.value = '35'
    await vol.trigger('input')
    expect(settings.notificationVolume).toBe(35)
    await row('Suppress While Focused').get('input').setValue(false)
    expect(settings.notifySuppressWhenFocused).toBe(false)
    await wrapper.get('[data-test="test-notification"]').trigger('click')
    expect(wrapper.emitted('test-notification')).toHaveLength(1)
    await row('Enable Notifications').get('input').setValue(false)
    expect(settings.notificationsEnabled).toBe(false)
    expect(wrapper.get('[data-test="test-notification"]').attributes('disabled')).toBeDefined()
    expect(row('Terminal Bell').get('input').attributes('disabled')).toBeDefined()
  })

  it('General: running terminals, workspace directory, deleting workspaces', async () => {
    open('general')
    expect(row('Confirm before closing running terminals').text()).toContain(
      'Ask before stopping a running agent or command when closing a terminal.'
    )
    await type('settings-workspace-dir', ' D:\\copies ')
    expect(settings.workspaceDir).toBe('D:\\copies')
    await row('Workspace Directory')
      .findAll('button')
      .find((b) => b.text() === 'Reset')
      .trigger('click')
    expect(settings.workspaceDir).toBe('')
    await row('Ask Before Deleting Workspaces').get('input').setValue(false)
    expect(settings.confirmDeleteWorkspace).toBe(false)
  })

  it('Git & Source Control: branch prefix with feedback, group order', async () => {
    open('git')
    const feedback = () => wrapper.get('[data-test="branch-prefix-feedback"]')
    expect(feedback().text()).toBe('Branches will be named agent/feature')
    const input = row('Branch Prefix').get('input[aria-label="Custom branch prefix"]')
    await input.setValue('bad name')
    expect(feedback().text()).toMatch(/cannot contain spaces/)
    await input.setValue('team/')
    expect(feedback().text()).toBe('Branches will be named team/feature')
    await clickSeg('Branch Prefix', 'None')
    expect(settings.branchPrefix).toBe('none')
    expect(row('Branch Prefix').find('input').exists()).toBe(false)
    await clickSeg('Branch Prefix', 'Git Username')
    expect(settings.branchPrefix).toBe('git-username')
    await clickSeg('Source Control Group Order', 'Staged first')
    expect(settings.sourceControlGroupOrder).toBe('staged-first')
  })

  it('search finds the new settings by their Orca names', async () => {
    open('general')
    await wrapper.get('input[type="search"]').setValue('trim gutter')
    await nextTick()
    await nextTick()
    const shownPages = wrapper.findAll('.set-page').filter((p) => !p.element.hidden)
    expect(shownPages.map((p) => p.attributes('data-page'))).toEqual(['terminal'])
  })
})
