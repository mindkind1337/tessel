// After Orca's NativeChatMessageTimestamp.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { intlLocale, setMessages } from '../../../../i18n'
import NativeChatMessageTimestamp from '../NativeChatMessageTimestamp.vue'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  setMessages('en', {})
})

const mountTime = (props) =>
  (wrapper = mount(NativeChatMessageTimestamp, { props, attachTo: document.body }))

describe('NativeChatMessageTimestamp', () => {
  it.each([null, Number.NaN, Infinity, -Infinity, 8.64e15 + 1])(
    'omits missing or invalid time %s',
    (timestamp) => {
      mountTime({ timestamp, focusable: true })
      expect(wrapper.find('time').exists()).toBe(false)
      expect(wrapper.text()).toBe('')
    }
  )

  it.each([0, Date.parse('2026-09-06T19:04:05Z')])(
    'renders absolute time and full metadata for %s',
    (timestamp) => {
      mountTime({ timestamp })
      const time = wrapper.find('time')
      expect(time.attributes('datetime')).toBe(new Date(timestamp).toISOString())
      expect(time.text()).toBe(
        new Intl.DateTimeFormat(intlLocale(), { hour: 'numeric', minute: '2-digit' }).format(
          timestamp
        )
      )
      expect(time.attributes('aria-label')).toBe(
        new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'full', timeStyle: 'long' }).format(
          timestamp
        )
      )
      expect(time.attributes('tabindex')).toBeUndefined()
    }
  )

  it('provides a focus target only when requested for user metadata', () => {
    mountTime({ timestamp: 0, focusable: true })
    const time = wrapper.find('time').element
    time.focus()
    expect(document.activeElement).toBe(time)
    expect(time.getAttribute('tabindex')).toBe('0')
  })

  it('updates settled time when the UI language changes without a parent rerender', async () => {
    const timestamp = Date.parse('2026-09-06T19:04:05Z')
    mountTime({ timestamp })
    setMessages('fr', {})
    await nextTick()
    const locale = intlLocale()
    expect(locale.startsWith('fr')).toBe(true)
    const time = wrapper.find('time')
    expect(time.text()).toBe(
      new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(timestamp)
    )
    expect(time.attributes('aria-label')).toBe(
      new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(timestamp)
    )
    expect(time.attributes('datetime')).toBe(new Date(timestamp).toISOString())
  })
})
