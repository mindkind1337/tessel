// After Orca's components/native-chat/native-chat-disclosure-store.ts (MIT,
// Copyright (c) 2026 Lovecast Inc.). The reference has no test file of its
// own; these cases follow how its rows use it (NativeChatToolRun.ask-row /
// identity tests: a row's open state survives unmount and remount under the
// store).
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import {
  MAX_NATIVE_CHAT_DISCLOSURES,
  NativeChatDisclosureContext,
  provideNativeChatDisclosures,
  useNativeChatDisclosure,
  useNativeChatDisclosures
} from '../native-chat-disclosure-store.js'

describe('useNativeChatDisclosures', () => {
  it('reads what was written, reactively', () => {
    const store = useNativeChatDisclosures()
    const seen = computed(() => store.read('a'))
    expect(seen.value).toBeUndefined()
    store.write('a', true)
    expect(seen.value).toBe(true)
    store.write('a', false)
    expect(seen.value).toBe(false)
  })

  it(`keeps at most ${MAX_NATIVE_CHAT_DISCLOSURES} entries, dropping the oldest`, () => {
    const store = useNativeChatDisclosures()
    for (let i = 0; i < MAX_NATIVE_CHAT_DISCLOSURES; i++) store.write(`k${i}`, true)
    expect(store.read('k0')).toBe(true)
    store.write('new', true)
    expect(store.read('k0')).toBeUndefined()
    expect(store.read('k1')).toBe(true)
    expect(store.read('new')).toBe(true)
  })

  it('rewriting the same value changes nothing', () => {
    const store = useNativeChatDisclosures()
    let runs = 0
    const seen = computed(() => {
      runs++
      return store.read('a')
    })
    store.write('a', true)
    void seen.value
    const before = runs
    store.write('a', true)
    void seen.value
    expect(runs).toBe(before)
  })
})

const Row = defineComponent({
  props: { disclosureKey: { type: String, default: undefined }, initialOpen: { type: Boolean, default: false } },
  setup(props) {
    const { open, setOpen } = useNativeChatDisclosure(
      () => props.disclosureKey,
      () => props.initialOpen
    )
    return () => h('button', { class: 'row', 'data-open': String(open.value), onClick: () => setOpen(!open.value) })
  }
})

describe('useNativeChatDisclosure', () => {
  it('falls back to local state without a store', async () => {
    const wrapper = mount(Row, { props: { disclosureKey: 'a' } })
    expect(wrapper.attributes('data-open')).toBe('false')
    await wrapper.trigger('click')
    expect(wrapper.attributes('data-open')).toBe('true')
  })

  it('local state resets when the key or initialOpen changes', async () => {
    const wrapper = mount(Row, { props: { disclosureKey: 'a' } })
    await wrapper.trigger('click')
    await wrapper.setProps({ disclosureKey: 'b' })
    expect(wrapper.attributes('data-open')).toBe('false')
    await wrapper.setProps({ initialOpen: true })
    expect(wrapper.attributes('data-open')).toBe('true')
  })

  it('a keyed row under a store keeps the reader choice across unmount and remount', async () => {
    const mounted = ref(true)
    const Host = defineComponent({
      setup() {
        provideNativeChatDisclosures()
        return () => (mounted.value ? h(Row, { disclosureKey: 'ask:1' }) : h('span'))
      }
    })
    const wrapper = mount(Host)
    await wrapper.find('.row').trigger('click')
    expect(wrapper.find('.row').attributes('data-open')).toBe('true')
    mounted.value = false
    await nextTick()
    mounted.value = true
    await nextTick()
    expect(wrapper.find('.row').attributes('data-open')).toBe('true')
  })

  it('an unkeyed row under a store stays local', async () => {
    const store = useNativeChatDisclosures()
    const wrapper = mount(Row, { global: { provide: { [NativeChatDisclosureContext]: store } } })
    await wrapper.trigger('click')
    expect(wrapper.attributes('data-open')).toBe('true')
    expect(store.read(undefined)).toBeUndefined()
  })

  it('a stored value wins over initialOpen, and open is writable (v-model)', async () => {
    const store = useNativeChatDisclosures()
    store.write('diff:1', true)
    let disclosure = null
    const Probe = defineComponent({
      setup() {
        disclosure = useNativeChatDisclosure('diff:1', false)
        return () => h('i', String(disclosure.open.value))
      }
    })
    const wrapper = mount(Probe, { global: { provide: { [NativeChatDisclosureContext]: store } } })
    expect(wrapper.text()).toBe('true')
    disclosure.open.value = false
    await nextTick()
    expect(wrapper.text()).toBe('false')
    expect(store.read('diff:1')).toBe(false)
  })
})
