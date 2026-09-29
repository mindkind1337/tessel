import {
  createApp,
  isRef,
  nextTick,
  onScopeDispose,
  proxyRefs,
  computed,
  shallowRef,
  unref,
} from 'vue'
import { afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const cleanups = new Set()
afterEach(() => {
  for (const cleanup of [...cleanups]) cleanup()
})

export function renderHook(setup, { initialProps = {} } = {}) {
  const props = shallowRef(initialProps)
  const fields = {}
  const refs = new Proxy(fields, {
    get: (_target, key) => (fields[key] ??= computed(() => props.value[key])),
  })
  let api
  const app = createApp({
    setup() {
      api = setup(refs)
      return () => null
    },
  })
  const root = document.createElement('div')
  app.mount(root)
  const value = isRef(api) ? null : proxyRefs(api)
  const result = {
    get current() {
      return isRef(api) ? unref(api) : value
    },
  }
  const unmount = () => {
    app.unmount()
    cleanups.delete(unmount)
  }
  cleanups.add(unmount)
  return {
    result,
    rerender: (next) => {
      props.value = next
    },
    unmount,
  }
}

export function cleanup() {
  for (const dispose of [...cleanups]) dispose()
}

export function useExternalSnapshot(subscribe, getSnapshot) {
  const snapshot = shallowRef(getSnapshot())
  onScopeDispose(
    subscribe(() => {
      snapshot.value = getSnapshot()
    }),
  )
  return snapshot
}

export function act(fn) {
  const result = fn()
  return result?.then ? Promise.resolve(result).then(flushPromises).then(nextTick) : nextTick()
}

export const waitFor = vi.waitFor
