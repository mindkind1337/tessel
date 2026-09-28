// The xterm options that follow Settings (like Orca's terminal-appearance.ts
// and pane-terminal-options.ts): font weights, line height, cursor opacity,
// scroll speed, color contrast, word separators, and whether to draw with
// WebGL. Pure, so the rules are tested without a terminal.
import { LIMITS, limitNumber } from './settings'

// Orca's automatic contrast floor (terminal-contrast-correction.ts): WCAG AA
// on a light background, a mild 3:1 on a dark one.
export const LIGHT_BG_MIN_CONTRAST = 4.5
export const DARK_BG_MIN_CONTRAST = 3

function parseHex(color) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

function luminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Light when black text reads better on it than white text (Orca's rule).
export function isLightBackground(color) {
  const c = parseHex(color)
  if (!c) return false
  return contrast({ r: 0, g: 0, b: 0 }, c) >= contrast({ r: 255, g: 255, b: 255 }, c)
}

// null (automatic): by the background; otherwise the chosen ratio (1 = off).
export function resolveMinimumContrastRatio(background, override) {
  const set = limitNumber('minimumContrastRatio', override)
  if (set !== null) return set
  return isLightBackground(background) ? LIGHT_BG_MIN_CONTRAST : DARK_BG_MIN_CONTRAST
}

export function hexToRgba(hex, alpha) {
  const c = parseHex(hex)
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` : hex
}

// The theme with the cursor's opacity applied (hex cursors only, as Orca).
export function composeTerminalTheme(base, cursorOpacity) {
  const theme = { ...base }
  const alpha = limitNumber('cursorOpacity', cursorOpacity)
  if (alpha !== null && alpha < 1 && theme.cursor && parseHex(theme.cursor)) {
    theme.cursor = hexToRgba(theme.cursor, alpha)
  }
  return theme
}

const num = (key, v, def) => limitNumber(key, v) ?? def

// Every setting-driven xterm option, for a new terminal and live updates.
export function terminalSettingOptions(s, theme) {
  return {
    fontWeight: Math.round(num('fontWeight', s.fontWeight, 500)),
    fontWeightBold: Math.round(num('fontWeightBold', s.fontWeightBold, 700)),
    lineHeight: num('lineHeight', s.lineHeight, 1),
    scrollSensitivity: num('scrollSensitivity', s.scrollSensitivity, 1.15),
    fastScrollSensitivity: num('fastScrollSensitivity', s.fastScrollSensitivity, 5),
    minimumContrastRatio: resolveMinimumContrastRatio(theme && theme.background, s.minimumContrastRatio),
    // '' = xterm's own list.
    wordSeparator: s.wordSeparator ? s.wordSeparator : DEFAULT_WORD_SEPARATOR
  }
}
// xterm's default (OptionsService).
export const DEFAULT_WORD_SEPARATOR = ' ()[]{}\',"`'

// The options among these that change the grid's size: a refit follows.
export const METRIC_OPTIONS = ['fontWeight', 'fontWeightBold', 'lineHeight']

// A WebGL renderer string that means the graphics are done in software
// (no GPU, a VM, Remote Desktop): Auto then keeps xterm's normal renderer.
export function isSoftwareRenderer(renderer) {
  return /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(String(renderer || ''))
}

// The graphics card's name as WebGL reports it ('' when unknown, null
// without WebGL 2 at all). Asked once.
let rendererProbe
export function probeWebglRenderer() {
  if (rendererProbe !== undefined) return rendererProbe
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return (rendererProbe = null)
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    rendererProbe = String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '')
    const lose = gl.getExtension('WEBGL_lose_context')
    if (lose) lose.loseContext()
  } catch {
    rendererProbe = null
  }
  return rendererProbe
}

// Draw with WebGL? 'on' always tries; 'off' never; 'auto' when WebGL 2 is
// there and the graphics are not software-only.
export function useWebgl(mode, renderer) {
  if (mode === 'off') return false
  if (mode === 'on') return true
  const r = renderer === undefined ? probeWebglRenderer() : renderer
  return r !== null && !isSoftwareRenderer(r)
}

export { LIMITS }
