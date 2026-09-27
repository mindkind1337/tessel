// Named colour themes (Settings > Appearance): the app's palette (CSS
// variables), the window title bar, and the terminal colours with the full
// ANSI palette each scheme is known for. Classic and Warp-inspired keep their
// own styles (style.css, themes.css) and the programs' ANSI colours.
export const PALETTE_THEMES = {
  dracula: {
    label: 'Dracula',
    description: 'Dark purple with vivid colours',
    ui: { chrome: '#1e1f29', surface: '#21222c', surface2: '#282a36', surface3: '#343746', term: '#282a36', border: '#343746', borderStrong: '#44475a', accent: '#bd93f9', warn: '#ffb86c', danger: '#ff5555', text: '#f8f8f2', textStrong: '#ffffff', textDim: '#8b8fa8' },
    term: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' }
  },
  nord: {
    label: 'Nord',
    description: 'Arctic blue-grey, calm and low-contrast',
    ui: { chrome: '#242933', surface: '#2b303b', surface2: '#2e3440', surface3: '#3b4252', term: '#2e3440', border: '#3b4252', borderStrong: '#4c566a', accent: '#88c0d0', warn: '#ebcb8b', danger: '#bf616a', text: '#d8dee9', textStrong: '#eceff4', textDim: '#8a93a6' },
    term: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e', black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' }
  },
  'tokyo-night': {
    label: 'Tokyo Night',
    description: 'Deep navy with neon accents',
    ui: { chrome: '#16161e', surface: '#1a1b26', surface2: '#1f2335', surface3: '#292e42', term: '#1a1b26', border: '#292e42', borderStrong: '#3b4261', accent: '#7aa2f7', warn: '#e0af68', danger: '#f7768e', text: '#c0caf5', textStrong: '#e0e6ff', textDim: '#737aa2' },
    term: { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c', black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5' }
  },
  gruvbox: {
    label: 'Gruvbox',
    description: 'Warm retro browns and oranges',
    ui: { chrome: '#1d2021', surface: '#242424', surface2: '#282828', surface3: '#3c3836', term: '#282828', border: '#3c3836', borderStrong: '#504945', accent: '#fabd2f', warn: '#fe8019', danger: '#fb4934', text: '#ebdbb2', textStrong: '#fbf1c7', textDim: '#a89984' },
    term: { background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selectionBackground: '#504945', black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984', brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2' }
  },
  'solarized-dark': {
    label: 'Solarized Dark',
    description: 'The classic teal, easy on the eyes',
    ui: { chrome: '#00212b', surface: '#002833', surface2: '#002b36', surface3: '#073642', term: '#002b36', border: '#073642', borderStrong: '#1b4a55', accent: '#268bd2', warn: '#b58900', danger: '#dc322f', text: '#93a1a1', textStrong: '#eee8d5', textDim: '#657b83' },
    term: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' }
  }
}

// A palette theme by id, never a name from the object's prototype.
export function paletteTheme(id) {
  return typeof id === 'string' && Object.hasOwn(PALETTE_THEMES, id) ? PALETTE_THEMES[id] : null
}

// The CSS variables a palette theme sets on <html>.
export function paletteVars(ui) {
  return {
    '--chrome': ui.chrome,
    '--surface': ui.surface,
    '--surface-2': ui.surface2,
    '--surface-3': ui.surface3,
    '--term': ui.term,
    '--backdrop': ui.chrome,
    '--border': ui.border,
    '--border-strong': ui.borderStrong,
    '--accent': ui.accent,
    '--warn': ui.warn,
    '--danger': ui.danger,
    '--text': ui.text,
    '--text-strong': ui.textStrong,
    '--text-dim': ui.textDim
  }
}

// The window's title bar (Windows overlay buttons) for a theme id.
export function titleBarColors(id) {
  if (id === 'warp') return { color: '#161917', symbolColor: '#dfe5df' }
  const t = paletteTheme(id)
  if (t) return { color: t.ui.chrome, symbolColor: t.ui.text }
  return { color: '#101216', symbolColor: '#d6d9df' }
}
