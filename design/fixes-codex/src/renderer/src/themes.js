// UI themes share terminal backgrounds with their corresponding CSS palette.
// Leave ANSI colors untouched: programs keep their existing color semantics.
export const THEMES = Object.freeze([
  { id: 'classic', label: 'Classic', description: 'Original Tessel appearance' },
  { id: 'warp', label: 'Warp-inspired', description: 'Graphite surfaces and soft green accents' }
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
  return { ...TERMINAL_THEMES[isTheme(id) ? id : 'classic'] }
}

export function applyTheme(id) {
  const theme = isTheme(id) ? id : 'classic'
  document.documentElement.dataset.theme = theme
  if (window.shellApi?.setWindowTheme) window.shellApi.setWindowTheme(theme)
}
