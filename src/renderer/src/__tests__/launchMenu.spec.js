import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LaunchMenu from '../components/LaunchMenu.vue'

describe('LaunchMenu', () => {
  it('offers a browser pane, even with no agent installed', async () => {
    const w = mount(LaunchMenu, { props: { shells: [], agents: [] }, attachTo: document.body })
    const item = w.find('[data-test="launch-browser"]')
    expect(item.exists()).toBe(true)
    expect(item.text()).toContain('Browser')
    await item.trigger('click')
    expect(w.emitted('launch')).toEqual([[{ kind: 'browser' }]])
    w.unmount()
  })
})
