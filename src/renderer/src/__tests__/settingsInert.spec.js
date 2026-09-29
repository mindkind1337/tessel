import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'

describe('Settings makes the rest of the window inert, and always gives it back', () => {
  let prev
  beforeEach(() => {
    prev = window.shellApi
    window.shellApi = { openExternal() {} }
  })
  afterEach(() => {
    document.body.innerHTML = ''
    window.shellApi = prev
  })

  it('a mark left by an earlier Settings (a hot reload) is lifted; closing lifts its own', () => {
    const sidebar = document.createElement('nav')
    sidebar.id = 'sidebar'
    // What an earlier Settings that never unmounted left behind.
    sidebar.setAttribute('inert', '')
    sidebar.setAttribute('data-settings-inert', '')
    const userInert = document.createElement('div')
    userInert.setAttribute('inert', '') // not ours: kept
    document.body.append(sidebar, userInert)
    const host = document.createElement('div')
    document.body.append(host)
    const w = mount(SettingsDialog, { props: { agents: [] }, attachTo: host })
    // Inert again while open (this Settings' own mark)...
    expect(sidebar.hasAttribute('inert')).toBe(true)
    w.unmount()
    // ...and clickable once it closes; someone else's inert stays.
    expect(sidebar.hasAttribute('inert')).toBe(false)
    expect(sidebar.hasAttribute('data-settings-inert')).toBe(false)
    expect(userInert.hasAttribute('inert')).toBe(true)
  })
})
