// After Orca's native-chat-windowing-test-harness.tsx and
// NativeChatMessageList.windowing-test-support.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// Shared layout/observer stubs for the NativeChatMessageList suites. jsdom has
// no layout, never fires ResizeObserver (it has none) and has no element
// scrollTo, so windowing only engages against the stubs below.
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { vi } from 'vitest'
import NativeChatMessageList from '../NativeChatMessageList.vue'
import {
  estimateNativeChatRowHeight,
  NATIVE_CHAT_ROW_GAP_PX,
  nativeChatRowContentMetrics
} from '../../../../chat/orca/native-chat-row-height-estimate.js'

export const VIEWPORT_PX = 600
export const TRANSCRIPT_LENGTH = 200

/** Everything the document holds below the last row. Non-zero on purpose. */
export const BELOW_TRANSCRIPT_PX = 24

/** Layout knobs the stubs read and a case writes. */
export const layout = {
  belowTranscriptPx: BELOW_TRANSCRIPT_PX,
  aboveTranscriptPx: 0,
  /** When set, derives the space above the spacer from the rendered DOM. */
  aboveSpacerPx: null,
  measuredRowHeights: []
}

function aboveTranscriptPx(spacer) {
  return spacer && layout.aboveSpacerPx ? layout.aboveSpacerPx(spacer) : layout.aboveTranscriptPx
}

export function marker(index) {
  return {
    id: `message-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: `marker-${index}` }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

export const ROW_PX = estimateNativeChatRowHeight(nativeChatRowContentMetrics(marker(0)), {
  hasReceipt: false,
  hasStatus: false,
  hasTurnDiff: false
})
export const ROW_PITCH_PX = ROW_PX + NATIVE_CHAT_ROW_GAP_PX

/** Replace a layout property on every HTML element, and hand back the undo. */
export function overrideLayoutProperty(name, descriptor) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor })
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
}

/** The spacer's reserved height: windowed rows are absolutely positioned in it. */
export function reservedTranscriptHeight(root) {
  const spacer = root.querySelector('[data-native-chat-window]')
  return spacer ? Number.parseFloat(spacer.style.height) || 0 : 0
}

// The virtualizer measures with `offsetHeight`, so that is the one thing a DOM
// without layout has to answer for windowing to engage at all. Rows report the
// height their own estimate predicted unless `layout.measuredRowHeights` says so.
// `scrollGeometry` gives the scroll root a document to scroll (clamping scrollTop).
export function stubLayout({
  scrollGeometry = false,
  offsetChain = false,
  viewportHeight = () => VIEWPORT_PX,
  isVisible = () => true
} = {}) {
  let scrollTops = new WeakMap()
  let wasLaidOut = isVisible()
  /** Losing the box drops the retained offset, the way `display: none` does. */
  const laidOut = () => {
    const nowLaidOut = isVisible()
    if (wasLaidOut && !nowLaidOut) scrollTops = new WeakMap()
    wasLaidOut = nowLaidOut
    return nowLaidOut
  }
  const restores = [
    overrideLayoutProperty('offsetHeight', {
      get() {
        if (!laidOut()) return 0
        if (this.hasAttribute('data-native-chat-scroll')) return viewportHeight()
        if (this.hasAttribute('data-native-chat-window')) {
          return reservedTranscriptHeight(this.parentElement ?? this)
        }
        const index = this.dataset.index
        if (index !== undefined) return layout.measuredRowHeights[Number(index)] ?? ROW_PX
        // The transcript column: as tall as the window it wraps, plus what sits under it.
        return this.hasAttribute('data-native-chat-column')
          ? reservedTranscriptHeight(this) + layout.belowTranscriptPx
          : 0
      }
    })
  ]
  if (scrollGeometry) {
    restores.push(
      overrideLayoutProperty('clientHeight', {
        get() {
          return this.hasAttribute('data-native-chat-scroll') && laidOut() ? viewportHeight() : 0
        }
      }),
      overrideLayoutProperty('scrollHeight', {
        get() {
          return this.hasAttribute('data-native-chat-scroll') && laidOut()
            ? aboveTranscriptPx(this.querySelector('[data-native-chat-window]')) +
                reservedTranscriptHeight(this) +
                layout.belowTranscriptPx
            : 0
        }
      }),
      overrideLayoutProperty('scrollTop', {
        get() {
          if (this.hasAttribute('data-native-chat-scroll') && !laidOut()) return 0
          return scrollTops.get(this) ?? 0
        },
        set(value) {
          if (this.hasAttribute('data-native-chat-scroll') && !laidOut()) return
          // A browser clamps; without this `scrollTop = scrollHeight` would park
          // the view past the end and every distance-from-bottom would read 0.
          const max = Math.max(0, this.scrollHeight - this.clientHeight)
          scrollTops.set(this, Math.min(Math.max(0, value), max))
        }
      })
    )
  }
  if (offsetChain) {
    restores.push(
      overrideLayoutProperty('offsetTop', {
        get() {
          return this.hasAttribute('data-native-chat-window') ? aboveTranscriptPx(this) : 0
        }
      }),
      overrideLayoutProperty('offsetParent', {
        get() {
          return this.parentElement?.closest('[data-native-chat-scroll]') ?? null
        }
      })
    )
  }
  return () => {
    for (const restore of restores.toReversed()) restore()
  }
}

const resizeObservations = new Set()

/** Records what production observes and delivers only when a target's height
 *  actually changed, and only when a test says a frame was painted. Entries
 *  carry no `borderBoxSize`, so the virtualizer falls back to `offsetHeight`. */
export function stubResizeObserver() {
  const original = window.ResizeObserver
  class TestResizeObserver {
    constructor(callback) {
      this.observation = { callback, observed: new Map() }
      resizeObservations.add(this.observation)
    }
    observe(target) {
      this.observation.observed.set(target, -1)
    }
    unobserve(target) {
      this.observation.observed.delete(target)
    }
    disconnect() {
      this.observation.observed.clear()
      resizeObservations.delete(this.observation)
    }
  }
  window.ResizeObserver = TestResizeObserver
  return () => {
    resizeObservations.clear()
    if (original) window.ResizeObserver = original
    else delete window.ResizeObserver
  }
}

/** Deliver one round of resize callbacks; true when anything was delivered. */
export function deliverResizes() {
  let delivered = false
  for (const observation of Array.from(resizeObservations)) {
    const entries = []
    for (const [target, lastHeight] of observation.observed) {
      const height = target.offsetHeight
      if (height !== lastHeight) {
        observation.observed.set(target, height)
        entries.push({ target })
      }
    }
    if (entries.length > 0) {
      delivered = true
      observation.callback(entries, undefined)
    }
  }
  return delivered
}

/** jsdom has no element scrollTo (happy-dom's writes the offset at once) and no
 *  scrollIntoView (a no-op without layout). */
export function installElementScrollTo() {
  const hadScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  const hadIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  HTMLElement.prototype.scrollTo = function scrollTo(options, y) {
    if (typeof options === 'object' && options !== null) {
      if (typeof options.top === 'number') this.scrollTop = options.top
    } else if (typeof y === 'number') {
      this.scrollTop = y
    }
  }
  if (!hadIntoView) Element.prototype.scrollIntoView = function scrollIntoView() {}
  return () => {
    if (hadScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', hadScrollTo)
    else delete HTMLElement.prototype.scrollTo
    if (!hadIntoView) delete Element.prototype.scrollIntoView
  }
}

export function session(messages) {
  return {
    messages,
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

export function listProps(messages, isVisible = true) {
  return {
    session: session(messages),
    isVisible,
    isWorking: false,
    expandSignal: false,
    fontScale: 1
  }
}

/** A simulated frame clock, so what depends on time (animation frames, the
 *  virtualizer's scroll-end debounce, idle timers) happens at the same point
 *  of a case on any machine, however loaded: one frame is 16 ms of simulated
 *  time, advanced only by the case. */
export const FRAME_MS = 16
export function useFrameClock() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date']
  })
  return () => vi.useRealTimers()
}
/** Runs the timers and animation frames due in the next `ms` of simulated time. */
export async function advanceFrame(ms = FRAME_MS) {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Vue renders on the next tick; a few ticks let the virtualizer's own
 *  re-renders (onChange → next render) settle too. */
export async function flush(ticks = 4) {
  for (let tick = 0; tick < ticks; tick += 1) await nextTick()
}

const mounted = []
/** Mounts the list attached to the document (the rail's popover teleports). */
export async function mountList(props) {
  const wrapper = mount(NativeChatMessageList, { props, attachTo: document.body })
  mounted.push(wrapper)
  await flush()
  return wrapper
}
export function unmountAll() {
  while (mounted.length) mounted.pop().unmount()
  document.body.replaceChildren()
}

export function scrollRoot(root = document) {
  const scroller = root.querySelector('[data-native-chat-scroll]')
  if (!scroller) throw new Error('no transcript scroll root')
  return scroller
}

/** Reads the window, and refuses to pass if there is no window to read. */
export function windowState(root = document) {
  const spacer = root.querySelector('[data-native-chat-window]')
  if (!spacer) throw new Error('transcript is not windowed: no spacer, every row is mounted')
  const totalSize = Number.parseFloat(spacer.style.height)
  if (!(totalSize > 0)) throw new Error(`transcript reserved no height (${spacer.style.height})`)
  return {
    totalSize,
    indexes: Array.from(root.querySelectorAll('[data-index]'))
      .map((row) => Number(row.dataset.index))
      .sort((left, right) => left - right)
  }
}

export function fireScroll(element) {
  element.dispatchEvent(new Event('scroll'))
}

/** jsdom fires no scroll event for an assignment to `scrollTop`. */
export async function scrollTranscript(root, top) {
  const scroller = scrollRoot(root)
  scroller.scrollTop = top
  fireScroll(scroller)
  await flush()
}

/** Queries by text, the way Testing Library's getByText does (exact, trimmed). */
export function queryByText(text, root = document.body) {
  const matches = (node) =>
    typeof text === 'string' ? node.textContent.trim() === text : text.test(node.textContent)
  for (const element of root.querySelectorAll('*')) {
    if (!matches(element)) continue
    if (Array.from(element.children).some(matches)) continue
    return element
  }
  return null
}
export function getByText(text, root) {
  const found = queryByText(text, root)
  if (!found) throw new Error(`no element with text ${text}`)
  return found
}
export function queryAllByText(text, root = document.body) {
  const matches = (node) =>
    typeof text === 'string' ? node.textContent.trim() === text : text.test(node.textContent)
  return Array.from(root.querySelectorAll('*')).filter(
    (element) => matches(element) && !Array.from(element.children).some(matches)
  )
}

function accessibleName(element) {
  return (element.getAttribute('aria-label') ?? element.textContent ?? '').trim()
}
/** Buttons by accessible name (aria-label, else text). */
export function queryAllButtons(name, root = document.body) {
  return Array.from(root.querySelectorAll('button, [role="button"]')).filter((button) => {
    const label = accessibleName(button)
    return typeof name === 'string' ? label === name : name.test(label)
  })
}
export function queryButton(name, root) {
  return queryAllButtons(name, root)[0] ?? null
}
export function getButton(name, root) {
  const button = queryButton(name, root)
  if (!button) throw new Error(`no button named ${name}`)
  return button
}
