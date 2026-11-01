// @vitest-environment node
// The generic default of the demo's simulated window.shellApi: a method added to
// Tessel later cannot break the demo.
import { describe, it, expect } from 'vitest'
import { createFakeApi, harmlessResult } from '../src/fakeApi'
import { at, leaves, loadPreloadApi } from './preloadApi'

describe('the generic default', () => {
  it('answers any call, at any depth, with a harmless promise', async () => {
    const api = createFakeApi()
    const answer = await api.somethingAddedLater({ any: 'argument' })
    expect(answer.ok).toBe(false)
    expect(await api.a.b.c.d()).toEqual([])
  })

  it('gives an answer every kind of caller can use', async () => {
    const answer = harmlessResult('Not here.')
    // A list.
    expect(Array.isArray(answer)).toBe(true)
    expect(answer.map((x) => x)).toEqual([])
    expect([...answer]).toEqual([])
    // { ok, error }, its error fit to show.
    expect(answer.ok).toBe(false)
    expect(answer.error).toBe('Not here.')
    // An object: nothing to walk, and it serializes as nothing.
    expect(Object.keys(answer)).toEqual([])
    expect(answer.anyField).toBeUndefined()
    expect(JSON.stringify(answer)).toBe('[]')
  })

  it('passes on the sentence to show', async () => {
    const api = createFakeApi({}, { errorText: 'Not in this demo.' })
    expect((await api.github.status()).error).toBe('Not in this demo.')
  })

  it('subscribes to nothing and returns an unsubscribe function', () => {
    const api = createFakeApi()
    for (const on of [api.onSomethingNew, api.group.onChanged]) {
      const stop = on(() => {
        throw new Error('never called')
      })
      expect(typeof stop).toBe('function')
      expect(() => stop()).not.toThrow()
    }
  })

  it('is never taken for a promise or for text', async () => {
    const api = createFakeApi()
    expect(api.anything.then).toBeUndefined()
    // Awaiting a name that was not called must not hang.
    await expect(Promise.resolve(api.anything)).resolves.toBe(api.anything)
    expect(api.anything.toJSON).toBeUndefined()
    expect(api[Symbol.toPrimitive]).toBeUndefined()
  })

  it('is there for "is this method here?" checks', () => {
    const api = createFakeApi()
    expect(typeof api.newMethod).toBe('function')
    expect(!!api.newGroup.newMethod).toBe(true)
    expect('newMethod' in api).toBe(true)
  })

  it('tells who asks (the demo\'s ?debug=1)', async () => {
    const heard = []
    const api = createFakeApi({ chat: {} }, { onUnknown: (path) => heard.push(path) })
    await api.chat.somethingNew()
    expect(heard).toEqual(['chat.somethingNew'])
  })
})

describe('what the demo simulates', () => {
  it('wins over the default, values and functions alike', async () => {
    const api = createFakeApi({ isDev: false, listShells: () => Promise.resolve(['one']) })
    expect(api.isDev).toBe(false)
    expect(await api.listShells()).toEqual(['one'])
  })

  it('keeps a group an object, as in the real API (Tessel checks typeof)', async () => {
    const api = createFakeApi({ chat: { open: () => 'opened' } })
    expect(typeof api.chat).toBe('object')
    expect(typeof api).toBe('object')
    expect(api.chat.open()).toBe('opened')
    // A call the group does not simulate still has its default.
    expect((await api.chat.somethingNew()).ok).toBe(false)
  })
})

describe('the real preload', () => {
  it('every method of src/preload/index.js can be called on an API that simulates none of it', async () => {
    const real = await loadPreloadApi()
    const api = createFakeApi({ isDev: false })
    const paths = leaves(real).filter((leaf) => leaf.kind === 'function')
    // The API is about 460 calls: a much smaller number means this read none of it.
    expect(paths.length).toBeGreaterThan(300)
    for (const { path } of paths) {
      const fn = at(api, path)
      expect(typeof fn, path).toBe('function')
      const answer = fn(() => {})
      if (/(^|\.)on[A-Z]/.test(path)) expect(typeof answer, path).toBe('function')
      else await expect(Promise.resolve(answer), path).resolves.toBeDefined()
    }
  })
})
