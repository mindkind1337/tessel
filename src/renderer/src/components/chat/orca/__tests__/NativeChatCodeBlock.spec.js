// After Orca's NativeChatCodeBlock.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'
import NativeChatCodeBlock from '../NativeChatCodeBlock.vue'

let prevApi, writeClipboard, wrapper
beforeEach(() => {
  prevApi = window.shellApi
  writeClipboard = vi.fn()
  window.shellApi = { writeClipboard }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
  vi.restoreAllMocks()
})

function mountBlock(language, code) {
  wrapper = mount(NativeChatCodeBlock, {
    props: language ? { language } : {},
    slots: { default: () => h('code', null, code) },
    attachTo: document.body
  })
  return wrapper
}

describe('NativeChatCodeBlock', () => {
  it('copies only the fenced code and confirms success', async () => {
    mountBlock('typescript', 'const answer = 42\nconsole.log(answer)\n')
    expect(wrapper.find('[data-code-language="typescript"]').text()).toBe('TypeScript')
    await wrapper.find('button[aria-label="Copy code"]').trigger('click')
    await flushPromises()
    expect(writeClipboard).toHaveBeenCalledWith('const answer = 42\nconsole.log(answer)\n')
    expect(wrapper.find('button[aria-label="Copied"]').exists()).toBe(true)
  })

  it('an unknown language shows its own name; a bare fence has no header and a floating copy', () => {
    mountBlock('ts', 'x')
    expect(wrapper.find('[data-code-language="ts"]').text()).toBe('ts')
    wrapper.unmount()
    mountBlock(undefined, 'y')
    expect(wrapper.find('[data-code-language]').exists()).toBe(false)
    expect(wrapper.find('pre').classes()).toContain('is-bare')
    expect(wrapper.find('.nc-code-copy-float button').exists()).toBe(true)
  })

  it('empty code has no copy button', () => {
    mountBlock('ts', '')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
