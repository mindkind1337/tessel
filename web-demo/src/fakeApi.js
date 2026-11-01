// The generic default of the simulated window.shellApi (src/preload/index.js
// defines the real one, about 460 calls). Every call the demo does not simulate
// on purpose lands here, so a method added to Tessel later cannot break the demo:
//
//   - any name is there, at any depth: api.anything.at.all is callable;
//   - on*(callback) subscribes to nothing and returns its unsubscribe function;
//   - any other call resolves to a harmless "not here" answer (harmlessResult).
//
// Nothing here touches the network, the disk or the page.

// The answer to a call nobody simulates. It satisfies what callers do with an
// answer, whichever shape they expect:
//   - a list: it is an empty array (.map, .length, for...of);
//   - { ok, error }: ok is false, and error is a sentence fit to show, never a
//     raw code (a caller may put it in a toast);
//   - an object: unknown fields are undefined, and it has no enumerable keys.
export function harmlessResult(error = '') {
  const result = []
  Object.defineProperty(result, 'ok', { value: false })
  Object.defineProperty(result, 'error', { value: error })
  return result
}

// Names a value must not answer to, or it would be taken for something else:
// awaited as a promise, serialized or converted to text as a function.
const NOT_A_METHOD = new Set(['then', 'catch', 'finally', 'toJSON', 'toString', 'valueOf', 'constructor', 'prototype', 'length', 'name', 'arguments', 'caller'])

const isSubscription = (name) => /^on[A-Z]/.test(name)
const isPlainObject = (v) => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

// The API object. `simulated`: what the demo really does, a tree of plain objects
// holding functions and values; anything else falls to the generic default.
// options.onUnknown(path, args): told of every call that fell through.
export function createFakeApi(simulated = {}, options = {}) {
  const { errorText = '', onUnknown = null } = options
  const unsubscribe = () => {}

  function node(path, own) {
    const children = new Map()
    const name = path.length ? path[path.length - 1] : ''
    // A group the demo simulates is an object, as in the real API (Tessel checks
    // `typeof api.chat === 'object'`). A name nobody simulates may be a group or a
    // method: it is both, so it has to be a function.
    const target = own ? {} : function shellApiCall() {}
    return new Proxy(target, {
      get(_target, key) {
        if (typeof key === 'symbol') return undefined
        if (own && Object.hasOwn(own, key)) {
          const value = own[key]
          if (!isPlainObject(value)) return value
        } else if (NOT_A_METHOD.has(key)) return undefined
        if (!children.has(key)) {
          const value = own && Object.hasOwn(own, key) ? own[key] : null
          children.set(key, node([...path, key], value))
        }
        return children.get(key)
      },
      set(_target, key, value) {
        if (own) own[key] = value
        children.delete(key)
        return true
      },
      has() {
        return true
      },
      apply(_target, _this, args) {
        if (onUnknown) onUnknown(path.join('.'), args)
        if (isSubscription(name)) return unsubscribe
        return Promise.resolve(harmlessResult(errorText))
      }
    })
  }
  return node([], simulated)
}
