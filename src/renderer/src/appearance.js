// Settings > Appearance that style the whole window: the UI zoom and the
// pane look (dividers, padding, dimmed inactive panes) as CSS variables.
import { limitNumber, LIMITS, UI_ZOOM_STEP } from './settings'

// Chromium's zoom: each level multiplies the size by 1.2 (Orca's ui-zoom-level).
export const UI_ZOOM_BASE = 1.2
export function uiZoomFactor(level) {
  return UI_ZOOM_BASE ** (limitNumber('uiZoomLevel', level) ?? 0)
}
export function uiZoomPercent(level) {
  return Math.round(100 * uiZoomFactor(level))
}
export function stepUiZoom(level, direction) {
  if (direction === 'reset') return 0
  const [lo, hi] = LIMITS.uiZoomLevel
  const cur = limitNumber('uiZoomLevel', level) ?? 0
  return Math.max(lo, Math.min(hi, cur + (direction === 'in' ? UI_ZOOM_STEP : -UI_ZOOM_STEP)))
}

// The CSS variables for these settings.
export function appearanceVars(s) {
  const n = (key, v, def) => limitNumber(key, v) ?? def
  return {
    '--divider-thickness': `${Math.round(n('dividerThickness', s.dividerThickness, 3))}px`,
    '--term-pad-x': `${Math.round(n('terminalPaddingX', s.terminalPaddingX, 4))}px`,
    '--term-pad-y': `${Math.round(n('terminalPaddingY', s.terminalPaddingY, 4))}px`,
    '--inactive-pane-opacity': String(n('inactivePaneOpacity', s.inactivePaneOpacity, 0.9))
  }
}

export function applyAppearance(s, root = document.documentElement) {
  for (const [name, value] of Object.entries(appearanceVars(s))) root.style.setProperty(name, value)
  // Panes changed size: terminals refit.
  window.dispatchEvent(new Event('terminal-layout-change'))
}

// The whole app zoomed like Chromium's Ctrl+/- (webFrame): terminals are
// drawn again at the new scale, so their text stays sharp.
export function applyUiZoom(level) {
  const z = limitNumber('uiZoomLevel', level) ?? 0
  if (window.shellApi && window.shellApi.setUiZoomLevel) window.shellApi.setUiZoomLevel(z)
}
