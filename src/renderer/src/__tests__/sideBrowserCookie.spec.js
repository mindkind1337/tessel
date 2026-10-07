// A web page in the side panel: its toolbar's cookie button opens the same
// import dialog as a browser pane in the grid (the panel passes it on).
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, inject } from 'vue'
import SideBrowser from '../components/SideBrowser.vue'

describe('SideBrowser', () => {
  it("passes the cookie import on to the page's toolbar", () => {
    let seen = null
    const Probe = defineComponent({
      setup(_, { expose }) {
        seen = inject('panelCtx')
        expose({ focusAddress() {} })
        return () => h('div')
      }
    })
    const openCookieImport = vi.fn()
    mount(SideBrowser, {
      props: { node: { id: 'web-1', type: 'leaf', kind: 'browser', url: 'https://example.com' }, active: true },
      global: { provide: { panelCtx: { openCookieImport, toast: () => {}, openExternal: () => {} } }, stubs: { BrowserPane: Probe } }
    })
    expect(typeof seen.openCookieImport).toBe('function')
    seen.openCookieImport()
    expect(openCookieImport).toHaveBeenCalledTimes(1)
  })
})
