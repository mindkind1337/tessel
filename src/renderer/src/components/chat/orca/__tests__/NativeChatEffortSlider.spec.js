import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NativeChatEffortSlider from '../NativeChatEffortSlider.vue'

const descriptor = (n) => ({
  id: 'effort',
  kind: { type: 'select', currentValue: 'c1', choices: Array.from({ length: n }, (_, i) => ({ value: `c${i}`, label: `C${i}` })) }
})
const widthOf = (n) => {
  const w = mount(NativeChatEffortSlider, { props: { descriptor: descriptor(n) } })
  const width = w.get('.nc-effort-slider').attributes('style')
  w.unmount()
  return parseInt(/width:\s*(\d+)px/.exec(width)[1], 10)
}

describe('the effort slider', () => {
  it('keeps its base width up to five levels and grows beyond, so the dots keep their spacing', () => {
    expect(widthOf(3)).toBe(76)
    expect(widthOf(5)).toBe(78)
    expect(widthOf(6)).toBe(93)
    expect(widthOf(8)).toBe(123)
  })
})
