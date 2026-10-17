// The Live Share bridge (window.shellApi.liveShare) with plain arguments.
// Electron copies what goes to the main process with the structured clone,
// which refuses Vue's reactive proxies ("#<Object> could not be cloned"):
// the first invitation, kept in a ref, made Start sharing throw, and the
// dialog only said "Sharing could not start". Objects and arrays are copied
// without their proxies; functions (event listeners) and other values
// (typed arrays, dates) go as they are.
import { toRaw } from 'vue'

export function plainArg(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 20) return value
  const raw = toRaw(value)
  if (Array.isArray(raw)) return raw.map((v) => plainArg(v, depth + 1))
  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) return raw
  const out = {}
  for (const [key, v] of Object.entries(raw)) if (typeof v !== 'function') out[key] = plainArg(v, depth + 1)
  return out
}

export function plainBridge(api) {
  if (!api) return api
  const calls = new Map()
  return new Proxy(api, {
    get(target, key) {
      const v = target[key]
      if (typeof v !== 'function') return v
      if (!calls.has(key)) calls.set(key, (...args) => v.apply(target, args.map((a) => plainArg(a))))
      return calls.get(key)
    }
  })
}
