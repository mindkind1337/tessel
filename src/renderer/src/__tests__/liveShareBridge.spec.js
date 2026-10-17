import { describe, it, expect, vi } from 'vitest'
import { reactive, ref } from 'vue'
import { plainArg, plainBridge } from '../liveShareBridge'

describe('liveShareBridge', () => {
  it('reactive objects become plain data the structured clone accepts', () => {
    const r = ref({})
    r.value = { label: 'x', rights: { type: true }, list: [reactive({ a: 1 })] }
    expect(() => structuredClone({ invite: { ...r.value } })).toThrow()
    const out = plainArg({ invite: { ...r.value } })
    expect(() => structuredClone(out)).not.toThrow()
    expect(out).toEqual({ invite: { label: 'x', rights: { type: true }, list: [{ a: 1 }] } })
  })
  it('keeps functions, typed arrays and primitives as they are', () => {
    const fn = () => {}
    const bytes = new Uint8Array([1, 2])
    expect(plainArg(fn)).toBe(fn)
    expect(plainArg(bytes)).toBe(bytes)
    expect(plainArg('a')).toBe('a')
    expect(plainArg(null)).toBe(null)
  })
  it('the bridge passes plain arguments, the same listener, and other properties', () => {
    const api = { start: vi.fn((arg) => structuredClone(arg)), onHost: vi.fn((fn) => fn), version: 3 }
    const bridge = plainBridge(api)
    const r = ref({ rights: { type: false } })
    expect(bridge.start({ invite: { ...r.value } })).toEqual({ invite: { rights: { type: false } } })
    const listener = () => {}
    expect(bridge.onHost(listener)).toBe(listener)
    expect(bridge.version).toBe(3)
    expect(bridge.start).toBe(bridge.start)
    expect(plainBridge(null)).toBe(null)
  })
  it('works on a frozen object like the one contextBridge exposes (a Proxy threw there)', () => {
    const exposed = Object.freeze({ onHost: vi.fn((fn) => fn), start: vi.fn((arg) => structuredClone(arg)), nested: Object.freeze({ ping: vi.fn(() => 'pong') }) })
    const bridge = plainBridge(exposed)
    const listener = () => {}
    expect(bridge.onHost(listener)).toBe(listener)
    expect(bridge.start({ invite: { ...ref({ rights: { type: true } }).value } })).toEqual({ invite: { rights: { type: true } } })
    expect(bridge.nested.ping()).toBe('pong')
  })
})
