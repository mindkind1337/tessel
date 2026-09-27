// UI themes share terminal backgrounds with their corresponding CSS palette.
// Classic and Warp-inspired leave ANSI colours untouched (programs keep their
// colour semantics); the named palette themes (shared/themePalettes.js) bring
// their own full ANSI palette, as those schemes are known for.
import { PALETTE_THEMES, paletteTheme, paletteVars } from '../../shared/themePalettes'

export const THEMES = Object.freeze([
  { id: 'classic', label: 'Classic', description: 'Original Tessel appearance' },
  { id: 'warp', label: 'Warp-inspired', description: 'Graphite surfaces and soft green accents' },
  ...Object.entries(PALETTE_THEMES).map(([id, t]) => ({ id, label: t.label, description: t.description }))
])

const TERMINAL_THEMES = {
  classic: {
    background: '#15171c',
    foreground: '#d6d9df',
    cursor: '#e8eaee',
    cursorAccent: '#15171c',
    selectionBackground: '#2f4a7a'
  },
  warp: {
    background: '#191b1a',
    foreground: '#dfe5df',
    cursor: '#aed5b2',
    cursorAccent: '#191b1a',
    selectionBackground: '#3b5342'
  }
}

export function isTheme(id) {
  return THEMES.some((theme) => theme.id === id)
}

export function terminalTheme(id) {
  const palette = paletteTheme(id)
  if (palette) return { cursorAccent: palette.term.background, ...palette.term }
  return { ...TERMINAL_THEMES[isTheme(id) ? id : 'classic'] }
}

let appliedVars = []
export function applyTheme(id) {
  const theme = isTheme(id) ? id : 'classic'
  const root = document.documentElement
  // A palette theme: its colours over the classic styles; any other theme
  // clears them.
  for (const name of appliedVars) root.style.removeProperty(name)
  appliedVars = []
  const palette = paletteTheme(theme)
  root.dataset.theme = palette ? 'classic' : theme
  if (palette) {
    for (const [name, value] of Object.entries(paletteVars(palette.ui))) {
      root.style.setProperty(name, value)
      appliedVars.push(name)
    }
  }
  if (window.shellApi?.setWindowTheme) window.shellApi.setWindowTheme(theme)
}
