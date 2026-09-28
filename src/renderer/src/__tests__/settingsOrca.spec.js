// The settings added to match Orca's: stored values checked on load, and the
// pure rules each one drives (terminal options, editor options, CSS
// variables, usage percentages, git naming, source control order, sound).
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { settings, loadSettings, resetSettings, DEFAULT_SETTINGS, editorFontStack } from '../settings'
import {
  resolveMinimumContrastRatio,
  isLightBackground,
  composeTerminalTheme,
  terminalSettingOptions,
  isSoftwareRenderer,
  useWebgl,
  DEFAULT_WORD_SEPARATOR
} from '../terminalOptions'
import { editorOptionsFor, diffOptionsFor } from '../editor/editorOptions'
import { appearanceVars, uiZoomPercent, stepUiZoom } from '../appearance'
import { displayedUsagePercent, usagePercentLabel } from '../usagePercent'
import { alertPeakGain } from '../notificationsStore'
import { stripTerminalSelectionGutter } from '../../../shared/terminalSelectionGutter'
import { resolveSourceControlGroupOrder, buildDisplaySections } from '../../../shared/sourceControl'
import {
  branchPrefixFor,
  branchNameFor,
  getBranchPrefixIssue,
  normalizeBranchPrefix,
  worktreeBaseDir
} from '../../../shared/worktreeNaming'

afterEach(() => resetSettings())

describe("Orca's defaults", () => {
  it('match Orca (Tessel keeps its agent/ branch prefix)', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      editorFontFamily: '',
      diffShowWhitespace: false,
      diffCollapseUnchanged: false,
      diffWordWrap: false,
      fontWeight: 500,
      fontWeightBold: 700,
      lineHeight: 1,
      cursorOpacity: 1,
      uiZoomLevel: 0,
      inactivePaneOpacity: 0.9,
      dividerThickness: 3,
      terminalPaddingX: 4,
      terminalPaddingY: 4,
      hideMouseWhileTyping: false,
      usagePercentageDisplay: 'used',
      showGitIgnoredFiles: true,
      gpuAcceleration: 'auto',
      minimumContrastRatio: null,
      scrollSensitivity: 1.15,
      fastScrollSensitivity: 5,
      focusFollowsMouse: false,
      copyTrimsGutter: true,
      allowOsc52Clipboard: true,
      wordSeparator: '',
      notificationsEnabled: true,
      notifyTerminalBell: false,
      notifySuppressWhenFocused: true,
      notificationVolume: 100,
      confirmCloseAgent: true,
      confirmDeleteWorkspace: true,
      workspaceDir: '',
      branchPrefix: 'custom',
      branchPrefixCustom: 'agent',
      sourceControlGroupOrder: 'changes-first'
    })
    expect('gpuRendering' in DEFAULT_SETTINGS).toBe(false)
  })
})

describe('loadSettings for the new settings', () => {
  it('keeps valid values', () => {
    loadSettings({
      fontWeight: 300,
      lineHeight: 1.4,
      uiZoomLevel: -1.5,
      gpuAcceleration: 'on',
      minimumContrastRatio: 7,
      usagePercentageDisplay: 'remaining',
      branchPrefix: 'git-username',
      sourceControlGroupOrder: 'untracked-first',
      wordSeparator: ' ()',
      notificationVolume: 40
    })
    expect(settings).toMatchObject({
      fontWeight: 300,
      lineHeight: 1.4,
      uiZoomLevel: -1.5,
      gpuAcceleration: 'on',
      minimumContrastRatio: 7,
      usagePercentageDisplay: 'remaining',
      branchPrefix: 'git-username',
      sourceControlGroupOrder: 'untracked-first',
      wordSeparator: ' ()',
      notificationVolume: 40
    })
  })

  it('clamps numbers to their range and drops malformed values', () => {
    loadSettings({
      fontWeight: 5000,
      fontWeightBold: 42.4,
      lineHeight: 0.2,
      cursorOpacity: 3,
      uiZoomLevel: 99,
      inactivePaneOpacity: -1,
      dividerThickness: 40,
      scrollSensitivity: 'fast',
      fastScrollSensitivity: NaN,
      minimumContrastRatio: 99,
      gpuAcceleration: 'maybe',
      usagePercentageDisplay: 'half',
      branchPrefix: 'weird',
      sourceControlGroupOrder: 'random',
      notifyTerminalBell: 'yes',
      workspaceDir: 'x'.repeat(5000)
    })
    expect(settings.fontWeight).toBe(900)
    expect(settings.fontWeightBold).toBe(100)
    expect(settings.lineHeight).toBe(1)
    expect(settings.cursorOpacity).toBe(1)
    expect(settings.uiZoomLevel).toBe(5)
    expect(settings.inactivePaneOpacity).toBe(0)
    expect(settings.dividerThickness).toBe(32)
    expect(settings.scrollSensitivity).toBe(1.15)
    expect(settings.fastScrollSensitivity).toBe(5)
    expect(settings.minimumContrastRatio).toBe(21)
    expect(settings.gpuAcceleration).toBe('auto')
    expect(settings.usagePercentageDisplay).toBe('used')
    expect(settings.branchPrefix).toBe('custom')
    expect(settings.sourceControlGroupOrder).toBe('changes-first')
    expect(settings.notifyTerminalBell).toBe(false)
    expect(settings.workspaceDir).toBe('')
  })

  it('reads null contrast as Automatic', () => {
    settings.minimumContrastRatio = 5
    loadSettings({ minimumContrastRatio: null })
    expect(settings.minimumContrastRatio).toBe(null)
  })

  it('migrates the old graphics card switch: off stays off, on becomes Auto', () => {
    loadSettings({ gpuRendering: false })
    expect(settings.gpuAcceleration).toBe('off')
    resetSettings()
    loadSettings({ gpuRendering: true })
    expect(settings.gpuAcceleration).toBe('auto')
    resetSettings()
    loadSettings({ gpuRendering: false, gpuAcceleration: 'on' })
    expect(settings.gpuAcceleration).toBe('on')
  })

  it('keeps the old "Ask before closing an agent pane" choice for running terminals', () => {
    loadSettings({ confirmCloseAgent: false })
    expect(settings.confirmCloseAgent).toBe(false)
  })

  it('reset puts them back to their defaults', () => {
    loadSettings({ fontWeight: 300, gpuAcceleration: 'off', workspaceDir: 'D:/wt', minimumContrastRatio: 7 })
    resetSettings()
    expect(settings.fontWeight).toBe(500)
    expect(settings.gpuAcceleration).toBe('auto')
    expect(settings.workspaceDir).toBe('')
    expect(settings.minimumContrastRatio).toBe(null)
  })
})

describe('terminal options', () => {
  it('Color Contrast Automatic: 3 on a dark background, 4.5 on a light one; else the chosen ratio', () => {
    expect(isLightBackground('#1e1e1e')).toBe(false)
    expect(isLightBackground('#fafafa')).toBe(true)
    expect(resolveMinimumContrastRatio('#101010', null)).toBe(3)
    expect(resolveMinimumContrastRatio('#ffffff', null)).toBe(4.5)
    expect(resolveMinimumContrastRatio('#101010', 1)).toBe(1)
    expect(resolveMinimumContrastRatio('#101010', 8)).toBe(8)
    expect(resolveMinimumContrastRatio('#101010', 50)).toBe(21)
  })

  it('Cursor Opacity turns a hex cursor into rgba, and leaves 1 alone', () => {
    expect(composeTerminalTheme({ cursor: '#ff0000', background: '#000' }, 0.5).cursor).toBe('rgba(255, 0, 0, 0.5)')
    expect(composeTerminalTheme({ cursor: '#ff0000' }, 1).cursor).toBe('#ff0000')
    expect(composeTerminalTheme({ cursor: 'red' }, 0.5).cursor).toBe('red')
  })

  it('gives xterm the weights, line height, scroll speeds, contrast and word separators', () => {
    const o = terminalSettingOptions(
      { ...DEFAULT_SETTINGS, fontWeight: 400, lineHeight: 1.2, wordSeparator: ' ' },
      { background: '#000000' }
    )
    expect(o).toEqual({
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1.2,
      scrollSensitivity: 1.15,
      fastScrollSensitivity: 5,
      minimumContrastRatio: 3,
      wordSeparator: ' '
    })
    expect(terminalSettingOptions(DEFAULT_SETTINGS, {}).wordSeparator).toBe(DEFAULT_WORD_SEPARATOR)
  })

  it('GPU Acceleration: Auto skips software graphics; On and Off are what they say', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe(true)
    expect(isSoftwareRenderer('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)')).toBe(true)
    expect(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)')).toBe(false)
    expect(useWebgl('auto', 'ANGLE (NVIDIA GeForce)')).toBe(true)
    expect(useWebgl('auto', 'SwiftShader')).toBe(false)
    expect(useWebgl('auto', null)).toBe(false)
    expect(useWebgl('on', null)).toBe(true)
    expect(useWebgl('off', 'NVIDIA')).toBe(false)
  })
})

describe('Trim Gutter on Copy', () => {
  it('removes only the indent every line shares', () => {
    expect(stripTerminalSelectionGutter('  one\n    two\n  three')).toBe('one\n  two\nthree')
    expect(stripTerminalSelectionGutter('  a\r\n\r\n  b')).toBe('a\r\n\r\nb')
    expect(stripTerminalSelectionGutter('a\n  b')).toBe('a\n  b')
    expect(stripTerminalSelectionGutter('   ')).toBe('   ')
  })
})

describe('editor options', () => {
  it('Editor Font Family follows the terminal font when empty', () => {
    expect(editorFontStack({ fontFamily: 'Consolas', editorFontFamily: '' })).toMatch(/^"Consolas"/)
    expect(editorFontStack({ fontFamily: 'Consolas', editorFontFamily: 'Fira Code' })).toMatch(/^"Fira Code"/)
    expect(editorFontStack({ fontFamily: 'Consolas', editorFontFamily: "'A', B" })).toMatch(/^'A', B, /)
    expect(editorOptionsFor({ ...DEFAULT_SETTINGS, editorFontFamily: 'Fira Code' }).fontFamily).toMatch(/^"Fira Code"/)
  })

  it('diffs: whitespace, unchanged regions and word wrap', () => {
    const off = diffOptionsFor(DEFAULT_SETTINGS)
    expect(off).toMatchObject({
      ignoreTrimWhitespace: true,
      hideUnchangedRegions: { enabled: false },
      wordWrap: 'off',
      diffWordWrap: 'off',
      minimap: { enabled: false }
    })
    const on = diffOptionsFor({ ...DEFAULT_SETTINGS, diffShowWhitespace: true, diffCollapseUnchanged: true, diffWordWrap: true })
    expect(on).toMatchObject({ ignoreTrimWhitespace: false, hideUnchangedRegions: { enabled: true }, wordWrap: 'on' })
  })
})

describe('appearance', () => {
  it('UI Zoom steps by half a level from -3 to 5 (Chromium levels)', () => {
    expect(uiZoomPercent(0)).toBe(100)
    expect(uiZoomPercent(1)).toBe(120)
    expect(uiZoomPercent(-1)).toBe(83)
    expect(stepUiZoom(0, 'in')).toBe(0.5)
    expect(stepUiZoom(5, 'in')).toBe(5)
    expect(stepUiZoom(-3, 'out')).toBe(-3)
    expect(stepUiZoom(2, 'reset')).toBe(0)
  })

  it('pane look as CSS variables', () => {
    expect(appearanceVars(DEFAULT_SETTINGS)).toEqual({
      '--divider-thickness': '3px',
      '--term-pad-x': '4px',
      '--term-pad-y': '4px',
      '--inactive-pane-opacity': '0.9'
    })
    expect(appearanceVars({ dividerThickness: 99, terminalPaddingX: 10, terminalPaddingY: 0, inactivePaneOpacity: 1 })).toEqual({
      '--divider-thickness': '32px',
      '--term-pad-x': '10px',
      '--term-pad-y': '0px',
      '--inactive-pane-opacity': '1'
    })
  })
})

describe('usage percentages', () => {
  it('shows used or remaining, rounded once', () => {
    expect(displayedUsagePercent(20.4, 'used')).toBe(20)
    expect(displayedUsagePercent(20.5, 'remaining')).toBe(79)
    expect(displayedUsagePercent(NaN, 'remaining')).toBe(0)
    expect(usagePercentLabel(30, 'used')).toBe('30% used')
    expect(usagePercentLabel(30, 'remaining')).toBe('70% left')
  })
})

describe('notification volume', () => {
  it('scales the alert sound', () => {
    expect(alertPeakGain(100)).toBeCloseTo(0.18)
    expect(alertPeakGain(50)).toBeCloseTo(0.09)
    expect(alertPeakGain(0)).toBe(0)
    expect(alertPeakGain(500)).toBeCloseTo(0.18)
  })
})

describe('Source Control Group Order', () => {
  it('puts the chosen group first', () => {
    const entries = [
      { path: 'a', area: 'unstaged', status: 'modified' },
      { path: 'b', area: 'staged', status: 'modified' },
      { path: 'c', area: 'untracked', status: 'untracked' }
    ]
    const ids = (o) => buildDisplaySections(entries, resolveSourceControlGroupOrder(o)).map((s) => s.id)
    expect(ids('changes-first')).toEqual(['unstaged', 'staged', 'untracked'])
    expect(ids('staged-first')).toEqual(['staged', 'unstaged', 'untracked'])
    expect(ids('untracked-first')).toEqual(['untracked', 'unstaged', 'staged'])
    expect(ids('nonsense')).toEqual(['unstaged', 'staged', 'untracked'])
  })
})

describe('task copy naming (Branch Prefix, Workspace Directory)', () => {
  it('Branch Prefix: git username, custom or none', () => {
    expect(branchPrefixFor({ branchPrefix: 'custom', branchPrefixCustom: 'agent' }, null)).toBe('agent')
    expect(branchPrefixFor({ branchPrefix: 'custom', branchPrefixCustom: ' team// ' }, null)).toBe('team')
    expect(branchPrefixFor({ branchPrefix: 'git-username' }, 'octo')).toBe('octo')
    expect(branchPrefixFor({ branchPrefix: 'git-username' }, '')).toBe(null)
    expect(branchPrefixFor({ branchPrefix: 'git-username' }, 'bad name')).toBe(null)
    expect(branchPrefixFor({ branchPrefix: 'none', branchPrefixCustom: 'x' }, 'octo')).toBe(null)
    expect(() => branchPrefixFor({ branchPrefix: 'custom', branchPrefixCustom: 'a:b' }, null)).toThrow(/Settings/)
    expect(branchNameFor('fix', 'agent')).toBe('agent/fix')
    expect(branchNameFor('fix', null)).toBe('fix')
    expect(normalizeBranchPrefix('/a//b/')).toBe('a/b')
    expect(getBranchPrefixIssue('a..b')).toBe('invalid-characters')
    expect(getBranchPrefixIssue('team/front')).toBe(null)
  })

  it('Workspace Directory: next to the project by default, else inside it or in a shared folder', () => {
    const w = path.win32
    expect(worktreeBaseDir('C:\\src\\proj', '', w)).toBe('C:\\src\\proj.worktrees')
    expect(worktreeBaseDir('C:\\src\\proj', '.tessel\\worktrees', w)).toBe('C:\\src\\proj\\.tessel\\worktrees\\proj')
    expect(worktreeBaseDir('C:\\src\\proj', 'D:\\wt', w)).toBe('D:\\wt\\proj')
  })
})
