// Shared plumbing for the ui/ primitives: the parts of Radix that shadcn/ui's
// components (Orca's components/ui/*.tsx, shadcn/ui, MIT, Copyright (c) 2026
// Lovecast Inc.) lean on, rewritten for Vue with no extra package.
//
// - Primitive: renders `as` (an element name or a component), or with
//   `asChild` renders its single slot child with the primitive's attributes
//   and listeners merged in (Radix's Slot). The child's own props win, both
//   listeners run (the child's first, so a child calling
//   event.preventDefault() stops the primitive's behaviour), class and style
//   are joined.
// - useControllableOpen: an `open` prop that works controlled (v-model:open or
//   :open) and uncontrolled (defaultOpen), like Radix's useControllableState.
// - chainHandlers / bindWith: the consumer's listener first, then ours.
// - elementOf: the DOM element behind a template ref (element or component).
import {
  Comment,
  Fragment,
  Text,
  cloneVNode,
  computed,
  defineComponent,
  getCurrentInstance,
  h,
  normalizeClass,
  normalizeStyle,
  ref
} from 'vue'
// The --nc-* tokens load before any primitive's own styles, so a content
// class (one class, like the reference's utilities) wins over .nc-root's
// background on the same element and a consumer's scoped class wins over both.
import '../orca-tokens.css'

const isListener = (key) => /^on[A-Z]/.test(key)

// The first real node of a slot, looking through fragments (v-if / v-for).
export function firstElementVNode(nodes) {
  for (const node of nodes || []) {
    if (node == null || typeof node !== 'object') continue
    if (node.type === Comment) continue
    if (node.type === Text) continue
    if (node.type === Fragment) {
      const inner = firstElementVNode(node.children)
      if (inner) return inner
      continue
    }
    return node
  }
  return null
}

function toHandlerList(value) {
  if (!value) return []
  return Array.isArray(value) ? value.flat(Infinity).filter(Boolean) : [value]
}

// Radix Slot's mergeProps: slot props first, the child's own props win;
// listeners are chained (child first), class and style joined.
export function mergeSlotProps(slotProps, childProps) {
  const out = { ...slotProps }
  for (const key of Object.keys(childProps || {})) {
    const childValue = childProps[key]
    const slotValue = slotProps[key]
    if (isListener(key) && slotValue && childValue) {
      out[key] = [...toHandlerList(childValue), ...toHandlerList(slotValue)]
    } else if (key === 'class') {
      out.class = normalizeClass([slotValue, childValue])
    } else if (key === 'style') {
      out.style = normalizeStyle([slotValue, childValue])
    } else {
      out[key] = childValue
    }
  }
  return out
}

export const Primitive = defineComponent({
  name: 'NcPrimitive',
  inheritAttrs: false,
  props: {
    as: { type: [String, Object, Function], default: 'div' },
    asChild: { type: Boolean, default: false }
  },
  setup(props, { attrs, slots }) {
    return () => {
      if (props.asChild) {
        const child = firstElementVNode(slots.default ? slots.default() : [])
        if (!child) return null
        // cloneVNode with extra props marks the clone FULL_PROPS, so props we
        // add (aria-expanded, data-state…) are patched on every update even
        // when the compiler thought the child's props were static.
        const clone = cloneVNode(child, {})
        clone.props = mergeSlotProps(attrs, child.props || {})
        return clone
      }
      const as = props.as
      return h(as, attrs, typeof as === 'string' ? slots.default?.() : slots)
    }
  }
})

// Consumer listeners (from $attrs) run before the primitive's own, like
// Radix's composeEventHandlers; ours bail out when the consumer called
// event.preventDefault().
export function chainHandlers(...handlers) {
  const list = handlers.flatMap(toHandlerList)
  if (list.length <= 1) return list[0]
  return (...args) => {
    for (const fn of list) fn(...args)
  }
}

// attrs + our props + our listeners (chained after the consumer's).
export function bindWith(attrs, own, listeners = {}) {
  const out = { ...attrs, ...own }
  for (const [key, fn] of Object.entries(listeners)) out[key] = chainHandlers(attrs[key], fn)
  return out
}

export function elementOf(value) {
  const el = value && value.$el !== undefined ? value.$el : value
  return el && el.nodeType === 1 ? el : null
}

// A function ref that stores the element behind an element or component ref.
export function elementRef(target) {
  return (value) => {
    target.value = elementOf(value)
  }
}

// Radix's useControllableState for `open`: a Boolean prop declared with
// `default: undefined` so "not passed" (uncontrolled) differs from false.
export function useControllableOpen(props, emit, key = 'open', defaultKey = 'defaultOpen', event = 'update:open') {
  const inner = ref(!!props[defaultKey])
  const value = computed(() => (props[key] === undefined ? inner.value : props[key]))
  function set(next) {
    if (next === value.value) return
    inner.value = next
    emit(event, next)
  }
  return { value, set }
}

// The consumer's scoped-style attribute for content teleported to <body>:
// Vue only puts it on a component's own root element, and a teleport has
// none, so a consumer's scoped class on PopoverContent (width…) would not
// match without it.
export function useParentScopeAttrs() {
  const instance = getCurrentInstance()
  const scopeId = instance && instance.vnode.scopeId
  return scopeId ? { [scopeId]: '' } : {}
}

// A cancelable event handed to consumer listeners (openAutoFocus,
// escapeKeyDown…): they call event.preventDefault() to keep the default.
export function cancelableEvent(name, originalEvent) {
  return new CustomEvent(name, { cancelable: true, detail: { originalEvent } })
}
