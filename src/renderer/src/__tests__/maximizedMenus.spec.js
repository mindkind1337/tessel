// A maximized pane (z-index 100) and the toolbar's menus (usage,
// notifications, Live Share: z-index 60): the menus opened under the pane,
// out of sight. While a pane is maximized the workspace is its own stacking
// layer (style.css), so they open over it again.
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss from 'postcss'

const css = postcss.parse(readFileSync(join(__dirname, '..', 'style.css'), 'utf8'))

// The value of prop for el: the last top-level rule of style.css that sets it
// and matches el (the rules this case depends on are equally specific).
function declared(el, prop) {
  let value = null
  css.walkRules((rule) => {
    if (rule.parent && rule.parent.type !== 'root') return
    const decl = rule.nodes.filter((d) => d.type === 'decl' && d.prop === prop).at(-1)
    if (!decl) return
    const matches = rule.selectors.some((sel) => {
      try {
        return el.matches(sel)
      } catch {
        return false // a selector jsdom does not know (::before…)
      }
    })
    if (matches) value = decl.value
  })
  return value
}

// The window as App.vue lays it out: the toolbar with its menus open (usage,
// UsageMenu.vue; notifications, NotificationsMenu.vue), then the workspace
// and its panes.
let workspace, pane, menus
beforeEach(() => {
  document.body.innerHTML = `
    <div class="app">
      <div class="toolbar"><div class="tb-right">
        <div class="notif-wrap"><div class="notif-menu usage-roster" data-menu="usage"></div></div>
        <div class="notif-wrap"><div class="notif-menu" role="dialog" data-menu="notifications"></div></div>
      </div></div>
      <div class="workspace">
        <div class="workspace-main"><div class="view-room"><div class="pane"></div><div class="pane"></div></div></div>
      </div>
    </div>`
  workspace = document.querySelector('.workspace')
  pane = document.querySelector('.pane')
  menus = [...document.querySelectorAll('[data-menu]')]
})

describe('the toolbar menus and a maximized pane', () => {
  it('the maximized pane is above the menus in the same layer: the workspace is isolated meanwhile', () => {
    pane.classList.add('maximized')
    const paneZ = Number(declared(pane, 'z-index'))
    expect(menus.map((m) => m.dataset.menu)).toEqual(['usage', 'notifications'])
    for (const menu of menus) {
      const menuZ = Number(declared(menu, 'z-index'))
      expect(menuZ, menu.dataset.menu).toBeGreaterThan(0) // over an isolated workspace (z-index auto)
      expect(paneZ, menu.dataset.menu).toBeGreaterThan(menuZ) // why the workspace must be isolated
    }
    expect(declared(workspace, 'isolation')).toBe('isolate')
    // The toolbar itself is no stacking layer that would trap its menus.
    const toolbar = document.querySelector('.toolbar')
    expect(declared(toolbar, 'z-index')).toBe(null)
    expect(declared(toolbar, 'isolation')).toBe(null)
  })

  it('no pane maximized: the workspace stays as before', () => {
    expect(declared(workspace, 'isolation')).toBe(null)
  })
})
