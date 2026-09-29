// Port of Orca's components/ui/switch.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.).
// The reference checked Tailwind class strings; the port checks the classes
// that carry the same geometry (switch.css) and the same attributes.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Switch from '../ui/Switch.vue'
import SwitchIndicator from '../ui/SwitchIndicator.vue'

describe('Switch', () => {
  it('renders the checked state with symmetric track geometry', () => {
    const wrapper = mount(Switch, { props: { checked: true }, attrs: { 'aria-label': 'Example setting' } })
    const html = wrapper.html()

    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(wrapper.classes()).toContain('nc-ui-switch-track')
    expect(wrapper.find('[data-slot="switch-thumb"]').attributes('data-state')).toBe('checked')
  })

  it('renders a visual-only indicator without switch semantics', () => {
    const html = mount(SwitchIndicator, { props: { checked: false } }).html()

    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-state="unchecked"')
    expect(html).not.toContain('role="switch"')
  })

  it('renders compact indicator geometry', () => {
    const wrapper = mount(SwitchIndicator, { props: { checked: true, size: 'compact' } })

    expect(wrapper.classes()).toContain('nc-ui-switch-track--compact')
    const thumb = wrapper.find('[data-slot="switch-thumb"]')
    expect(thumb.classes()).toContain('nc-ui-switch-thumb--compact')
    expect(thumb.attributes('data-state')).toBe('checked')
  })

  it('toggles through v-model:checked and stays put when disabled', async () => {
    const wrapper = mount(Switch, { props: { checked: false } })
    await wrapper.trigger('click')
    expect(wrapper.emitted('update:checked')).toEqual([[true]])

    const disabled = mount(Switch, { props: { checked: false, disabled: true } })
    await disabled.trigger('click')
    expect(disabled.emitted('update:checked')).toBeUndefined()
  })

  it('works uncontrolled from defaultChecked', async () => {
    const wrapper = mount(Switch, { props: { defaultChecked: true } })
    expect(wrapper.attributes('aria-checked')).toBe('true')
    await wrapper.trigger('click')
    expect(wrapper.attributes('aria-checked')).toBe('false')
    expect(wrapper.emitted('update:checked')).toEqual([[false]])
  })
})
