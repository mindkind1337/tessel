import { afterEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { h } from 'vue'
import fs from 'node:fs'
import path from 'node:path'
import ThemedSelect from '../components/ui/ThemedSelect.vue'
let wrapper
const option = (value, label, props = {}) => h('option', { value, ...props }, label)
function render(props = {}) {
  wrapper = mount(ThemedSelect, {
    props: { modelValue: 'a', ...props },
    attrs: { 'aria-label': 'Model' },
    slots: {
      default: () => [
        option('a', 'Alpha'),
        h('optgroup', { label: 'Other models' }, [
          option('b', 'Beta', { disabled: true }),
          option('c', 'Charlie')
        ]),
        option(4, 'Delta')
      ]
    },
    attachTo: document.body
  })
  return wrapper.get('[role="combobox"]')
}
const list = () => document.querySelector('[role="listbox"]')
afterEach(() => {
  wrapper?.unmount()
  document.body.replaceChildren()
})
describe('ThemedSelect', () => {
  it('teleports a themed list with groups, checked choice and disabled options', async () => {
    const trigger = render()
    await trigger.trigger('click')
    expect(list().parentElement).toBe(document.body)
    expect(list().querySelector('[role="group"]').getAttribute('aria-label')).toBe('Other models')
    expect(list().querySelector('[aria-selected="true"]').textContent).toContain('Alpha')
    list().querySelector('[data-value="b"]').click()
    await flushPromises()
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(list()).not.toBeNull()
  })
  it('supports navigation, skips disabled options, commits and returns focus', async () => {
    const trigger = render()
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(
      document.getElementById(trigger.attributes('aria-activedescendant')).textContent
    ).toContain('Charlie')
    await trigger.trigger('keydown', { key: 'End' })
    await trigger.trigger('keydown', { key: 'Home' })
    expect(
      document.getElementById(trigger.attributes('aria-activedescendant')).textContent
    ).toContain('Alpha')
    await trigger.trigger('keydown', { key: 'End' })
    await trigger.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')[0]).toEqual([4])
    expect(wrapper.emitted('change')[0][0].target.value).toBe('4')
    expect(list()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
  })
  it('supports typeahead, Escape without committing, and Space', async () => {
    const trigger = render()
    await trigger.trigger('keydown', { key: 'c' })
    expect(
      document.getElementById(trigger.attributes('aria-activedescendant')).textContent
    ).toContain('Charlie')
    await trigger.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('change')).toBeUndefined()
    await trigger.trigger('keydown', { key: ' ' })
    await trigger.trigger('keydown', { key: ' ' })
    expect(wrapper.emitted('update:modelValue')[0]).toEqual(['a'])
  })
  it('closes on outside pointer, outside scroll and Tab but allows internal scrolling', async () => {
    const trigger = render()
    await trigger.trigger('click')
    list().dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(list()).not.toBeNull()
    document.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(list()).toBeNull()
    await trigger.trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(list()).toBeNull()
    await trigger.trigger('click')
    await trigger.trigger('keydown', { key: 'Tab' })
    expect(list()).toBeNull()
  })
  it('flips above when the trigger is near the bottom and respects trigger width', async () => {
    const trigger = render()
    trigger.element.getBoundingClientRect = () => ({
      left: 30,
      top: innerHeight - 50,
      bottom: innerHeight - 20,
      width: 240
    })
    await trigger.trigger('click')
    expect(list().style.bottom).not.toBe('')
    expect(list().style.minWidth).toBe('240px')
  })
  it('cannot open while disabled and follows changed values', async () => {
    const trigger = render({ disabled: true })
    await trigger.trigger('click')
    expect(list()).toBeNull()
    await wrapper.setProps({ disabled: false, modelValue: 'c' })
    expect(trigger.text()).toContain('Charlie')
  })
})
it('renderer components never use native select controls', () => {
  const root = path.resolve('src/renderer/src')
  const files = fs.readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.vue'))
  expect(
    files.filter((file) => /<select(?:\s|>)/i.test(fs.readFileSync(path.join(root, file), 'utf8')))
  ).toEqual([])
})
