import { describe, it, expect } from 'vitest'
import { THEMES, isTheme, terminalTheme, applyTheme } from '../themes'
import { PALETTE_THEMES, paletteVars, titleBarColors } from '../../../shared/themePalettes'

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']
const HEX = /^#[0-9a-f]{6}$/i

describe('palette themes', () => {
  it('each has a full app palette and a full terminal palette', () => {
    for (const [id, t] of Object.entries(PALETTE_THEMES)) {
      expect(isTheme(id)).toBe(true)
      for (const v of Object.values(paletteVars(t.ui))) expect(v, id).toMatch(HEX)
      const term = terminalTheme(id)
      for (const c of [...ANSI, ...ANSI.map((a) => `bright${a[0].toUpperCase()}${a.slice(1)}`), 'background', 'foreground', 'cursor', 'cursorAccent'])
        expect(term[c], `${id} ${c}`).toMatch(HEX)
      expect(titleBarColors(id).color).toBe(t.ui.chrome)
    }
    expect(THEMES.map((t) => t.id).slice(0, 2)).toEqual(['classic', 'warp'])
  })

  it('classic keeps the programs’ own ANSI colours', () => {
    expect(terminalTheme('classic').red).toBeUndefined()
  })

  it('applying one sets its colours; going back to classic clears them', () => {
    window.shellApi = {}
    applyTheme('nord')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--accent')).toBe(PALETTE_THEMES.nord.ui.accent)
    expect(root.dataset.theme).toBe('classic')
    applyTheme('warp')
    expect(root.style.getPropertyValue('--accent')).toBe('')
    expect(root.dataset.theme).toBe('warp')
  })
})
