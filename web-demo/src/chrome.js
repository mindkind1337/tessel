// The window around Tessel. Electron draws Windows' minimize, maximize and close
// buttons over the toolbar's right end (which Tessel leaves empty for them): here they
// are drawn by the demo page, inert, in the colours the real title bar gets
// (titleBarColors, the same function src/main/index.js uses). And a discreet tag says
// this is a simulation. Tessel's own CSS is untouched.
import { titleBarColors } from '../../src/shared/themePalettes'

const ICONS = {
  minimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" fill="none"/></svg>',
  maximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" fill="none"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" fill="none"/></svg>'
}

export function installChrome({ t }) {
  const buttons = document.createElement('div')
  buttons.id = 'demo-window-buttons'
  buttons.setAttribute('aria-hidden', 'true')
  buttons.innerHTML = `<span>${ICONS.minimize}</span><span>${ICONS.maximize}</span><span>${ICONS.close}</span>`

  const tag = document.createElement('div')
  tag.id = 'demo-tag'
  tag.textContent = t('demo.tag', 'Simulation')

  const place = () => document.body && document.body.append(buttons, tag)
  if (document.body) place()
  else document.addEventListener('DOMContentLoaded', place)

  return {
    setTheme(theme) {
      try {
        const colors = titleBarColors(theme)
        buttons.style.background = colors.color
        buttons.style.color = colors.symbolColor
      } catch {
        /* keeps its colours */
      }
    }
  }
}
