// The Live Share bridge (window.shellApi.liveShare) with plain arguments.
// Electron copies what goes to the main process with the structured clone,
// which refuses Vue's reactive proxies ("#<Object> could not be cloned"):
// the first invitation, kept in a ref, made Start sharing throw, and the
// dialog only said "Sharing could not start". Objects and arrays are copied
// without their proxies; functions (event listeners) and other values
// (typed arrays, dates) go as they are.
//
// A new object, not a Proxy: the object contextBridge exposes is frozen
// (read-only, non-configurable properties), and a Proxy may not return
// another function for those ("'get' on proxy: property … is a read-only
// and non-configurable data property").
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

export function plainBridge(api, depth = 0) {
  if (!api || typeof api !== 'object' || depth > 3) return api
  const out = {}
  for (const key of Object.keys(api)) {
    const v = api[key]
    // Looked up at each call: a test (or a reload of the bridge) may swap it.
    if (typeof v === 'function') out[key] = (...args) => api[key].apply(api, args.map((a) => plainArg(a)))
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[key] = plainBridge(v, depth + 1)
    else out[key] = v
  }
  return out
}
