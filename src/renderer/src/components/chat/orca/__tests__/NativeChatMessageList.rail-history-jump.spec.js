// After Orca's NativeChatMessageList.rail-history-jump.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { mount } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Many frames over a large virtualized transcript: pure CPU work (no real time
// left in it: frames run on the harness clock), which a fully loaded machine
// can stretch past the default 5 s. The cases check positions, not durations.
vi.setConfig({ testTimeout: 30_000 })
import { projectStructuredItemsToNativeChat } from '../../../../chat/orca/shared/structured-agent-session-projection.js'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from '../../../../chat/orca/native-chat-row-height-estimate.js'
import NativeChatMessageList from '../NativeChatMessageList.vue'
import {
  advanceFrame,
  deliverResizes,
  fireScroll,
  flush,
  getButton,
  getByText,
  installElementScrollTo,
  layout,
  marker,
  overrideLayoutProperty,
  queryByText,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver,
  useFrameClock
} from './native-chat-windowing-test-harness.js'
import { rollupFile } from './native-chat-list-stubs.js'

vi.mock('../NativeChatMessageRow.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).MessageRowStub
}))
vi.mock('../NativeChatResolutionReceipt.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).ResolutionReceiptStub
}))
vi.mock('../NativeChatTurnDiffRollup.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).TurnDiffRollupStub
}))
vi.mock('../NativeChatTaskList.vue', async () => ({
  default: (await import('./native-chat-list-stubs.js')).TaskListStub
}))

const TOTAL = 60
const PAGE = 20
/** The scroll root's top gutter, always present. */
const TOP_GUTTER_PX = 40
/** The "load earlier" row plus the column gap under it, while in the column's flow. */
const OLDER_HISTORY_ROW_PX = 52
/** A ~500ms smooth scroll at 60fps. */
const SMOOTH_SCROLL_FRAMES = 30

function message(index) {
  return index % 5 === 0
    ? { id: `message-${index}`, role: 'user', blocks: [{ type: 'text', text: `prompt-${index}` }], timestamp: index + 1, source: 'transcript' }
    : marker(index)
}
const HISTORY = Array.from({ length: TOTAL }, (_, index) => message(index))

/** Every row measures exactly as estimated, so nothing but the jump moves the view. */
const ROW_HEIGHT_BY_TEXT = new Map(
  HISTORY.map((entry) => [
    entry.blocks[0]?.type === 'text' ? entry.blocks[0].text : '',
    estimateNativeChatRowHeight(nativeChatRowContentMetrics(entry), { hasReceipt: false, hasStatus: false, hasTurnDiff: false })
  ])
)

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

/** A lane that pages older history in the way the structured lane does: the page
 *  lands, then the returned promise settles. The outline is the unloaded prompts. */
const PagedTranscript = defineComponent({
  props: { holdPage: { type: Function, default: undefined } },
  setup(props) {
    const loaded = ref(PAGE)
    const loadEarlier = async () => {
      await (props.holdPage?.() ?? Promise.resolve())
      loaded.value = Math.min(TOTAL, loaded.value + PAGE)
      return 'applied'
    }
    const messages = computed(() => HISTORY.slice(TOTAL - loaded.value))
    const railOutline = computed(() =>
      HISTORY.slice(0, TOTAL - loaded.value)
        .filter((entry) => entry.role === 'user')
        .map((entry) => ({ id: entry.id, text: entry.blocks[0]?.type === 'text' ? entry.blocks[0].text : '', hasImages: false }))
    )
    return () =>
      h(NativeChatMessageList, {
        session: { ...session(messages.value), hasMore: loaded.value < TOTAL, loadEarlier },
        railOutline: railOutline.value,
        isWorking: false,
        expandSignal: false,
        fontScale: 1
      })
  }
})

/** Chromium's two scroll kinds: an instant write lands at once; a smooth scroll
 *  eases over frames, and any instant write cancels it. */
function installScrollModel() {
  let animation = null
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function scrollTo(options) {
    const top = typeof options === 'object' ? options.top : undefined
    if (top === undefined) return
    if (typeof options === 'object' && options.behavior === 'smooth') {
      animation = { from: this.scrollTop, to: top, step: 0 }
      return
    }
    animation = null
    this.scrollTop = top
  })
  return {
    frame: () => {
      const scroller = document.querySelector('[data-native-chat-scroll]')
      if (!scroller || !animation) return
      animation.step += 1
      const t = animation.step / SMOOTH_SCROLL_FRAMES
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
      scroller.scrollTop = animation.from + (animation.to - animation.from) * eased
      if (animation.step >= SMOOTH_SCROLL_FRAMES) animation = null
    }
  }
}

/** The row's own prose. */
function rowText(row) {
  return /(?:prompt|marker)-\d+/.exec(row.querySelector('p')?.textContent ?? '')?.[0] ?? ''
}

let restoreScrollTo = () => {}
beforeAll(() => {
  restoreScrollTo = installElementScrollTo()
})
afterAll(() => restoreScrollTo())

// A rail jump scrolls smoothly. Started by a reader following the end — where
// paging older history in leaves them — its first frames used to re-arm follow
// and the next one rebased the view, cancelling the jump near the bottom.
describe('jumping from the rail while following the end', () => {
  let restore = []
  let scrollModel
  let lastEventScrollTop = 0

  let stopClock = () => {}
  beforeEach(() => {
    stopClock = useFrameClock()
    const undoLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
    const stubbedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    restore = [
      undoLayout,
      stubResizeObserver(),
      overrideLayoutProperty('offsetHeight', {
        get() {
          const estimated = this.dataset.index === undefined ? undefined : ROW_HEIGHT_BY_TEXT.get(rowText(this))
          return estimated ?? stubbedHeight?.get?.call(this) ?? 0
        }
      }),
      // The rail stands down in a narrow pane.
      overrideLayoutProperty('clientWidth', { get: () => 800 }),
      // Rows sit at their `top` inside the spacer, which sits under the chrome.
      overrideLayoutProperty('offsetTop', {
        get() {
          if (this.hasAttribute('data-native-chat-window')) return layout.aboveTranscriptPx
          return this.dataset.index === undefined ? 0 : Number.parseFloat(this.style.top) || 0
        }
      }),
      overrideLayoutProperty('offsetParent', {
        get() {
          if (this.dataset.index !== undefined) return this.closest('[data-native-chat-window]')
          return this.parentElement?.closest('[data-native-chat-scroll]') ?? null
        }
      })
    ]
    // The older-history row counts only while it sits in the column's flow.
    Object.defineProperty(layout, 'aboveTranscriptPx', {
      configurable: true,
      get: () => {
        const button = Array.from(document.querySelectorAll('button')).find((b) => /load earlier messages/i.test(b.textContent))
        return TOP_GUTTER_PX + (button?.closest('[data-native-chat-column]') ? OLDER_HISTORY_ROW_PX : 0)
      }
    })
    scrollModel = installScrollModel()
    lastEventScrollTop = 0
  })

  afterEach(() => {
    stopClock()
    vi.restoreAllMocks()
    Object.defineProperty(layout, 'aboveTranscriptPx', { configurable: true, writable: true, value: 0 })
    for (const undo of restore.toReversed()) undo()
  })

  function scroller() {
    const element = document.querySelector('[data-native-chat-scroll]')
    if (!element) throw new Error('no transcript scroll root')
    return element
  }

  /** One painted frame: layout clamps the offset to the new document, observers
   *  deliver, a smooth scroll advances, any offset change dispatches one scroll
   *  event, and queued callbacks and animation frames run. */
  async function frame() {
    const element = scroller()
    const offset = element.scrollTop
    element.scrollTop = offset
    deliverResizes()
    scrollModel.frame()
    await flush()
    if (element.scrollTop !== lastEventScrollTop) {
      lastEventScrollTop = element.scrollTop
      fireScroll(element)
    }
    // The timers and the animation frame of one simulated frame.
    await advanceFrame()
    await flush()
  }
  async function settle(frames) {
    for (let index = 0; index < frames; index += 1) await frame()
  }
  function distanceFromBottom() {
    const element = scroller()
    return element.scrollHeight - element.clientHeight - element.scrollTop
  }
  /** Where the prompt's row sits relative to the top of the viewport. */
  function rowOffsetFromViewportTop(prompt) {
    const row = getByText(prompt).closest('[data-index]')
    if (!row) throw new Error(`${prompt} has no mounted row`)
    return layout.aboveTranscriptPx + Number.parseFloat(row.style.top) - scroller().scrollTop
  }
  const dialog = () => document.querySelector('[role="dialog"]')
  const transcriptText = (text) => queryByText(text, scroller())

  it.each([
    ['in the page that exhausts older history', 'prompt-5', false],
    ['in a page with older history still behind it', 'prompt-25', false],
    ['that is already loaded', 'prompt-45', true]
  ])('lands on a message %s', async (_case, prompt, loaded) => {
    wrapper = mount(PagedTranscript, { attachTo: document.body })
    await settle(10)
    // Anti-vacuous: the reader starts pinned to the very end.
    expect(distanceFromBottom()).toBe(0)
    expect(transcriptText(prompt) !== null).toBe(loaded)

    getButton('Your messages').click()
    await frame()
    getButton(prompt).click()
    await settle(60)

    // The failure mode: the jump cancelled itself a few pixels above the end.
    expect(distanceFromBottom()).toBeGreaterThan(100)
    expect(Math.abs(rowOffsetFromViewportTop(prompt))).toBeLessThanOrEqual(2)
  })

  it('lets a later pick of a loaded message win over a jump still paging', async () => {
    let releaseFirstPage = null
    let held = false
    const holdPage = () => {
      if (held) return Promise.resolve()
      held = true
      return new Promise((resolve) => {
        releaseFirstPage = resolve
      })
    }
    wrapper = mount(PagedTranscript, { props: { holdPage }, attachTo: document.body })
    await settle(10)
    getButton('Your messages').click()
    await frame()
    getButton('prompt-5').click()
    await frame()
    // Anti-vacuous: the older page is in flight.
    expect(releaseFirstPage).not.toBeNull()
    // The list stays open while the pick pages in, so the reader picks again in place.
    getButton('prompt-45').click()
    await settle(40)
    releaseFirstPage?.()
    await settle(60)
    // The superseded jump would have kept paging and pulled the reader to prompt-5.
    expect(transcriptText('prompt-5')).toBeNull()
    expect(Math.abs(rowOffsetFromViewportTop('prompt-45'))).toBeLessThanOrEqual(2)
  })

  /** Holds the first older page in flight until released; later pages land at once. */
  function holdFirstPage() {
    let release = null
    let asked = 0
    return {
      holdPage: () => {
        asked += 1
        return asked > 1
          ? Promise.resolve()
          : new Promise((resolve) => {
              release = resolve
            })
      },
      release: () => release?.(),
      asked: () => asked
    }
  }
  async function pickUnloadedWhilePaging(prompt) {
    getButton('Your messages').click()
    await frame()
    getButton(prompt).click()
    await frame()
  }

  it('keeps the list open with the pick marked busy until its history lands', async () => {
    const pages = holdFirstPage()
    wrapper = mount(PagedTranscript, { props: { holdPage: pages.holdPage }, attachTo: document.body })
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)
    // The failure mode: picking closed the list, so the busy item was never seen.
    expect(dialog()).not.toBeNull()
    expect(getButton('prompt-5').getAttribute('aria-busy')).toBe('true')

    pages.release()
    await settle(60)
    expect(dialog()).toBeNull()
    expect(Math.abs(rowOffsetFromViewportTop('prompt-5'))).toBeLessThanOrEqual(2)
  })

  it.each([
    ['a wheel over the transcript', () => scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))],
    ['a scroll key', () => scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }))],
    ['a touch drag', () => scroller().dispatchEvent(new Event('touchmove', { bubbles: true }))],
    ['a scrollbar grab', () => scroller().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))]
  ])('leaves the reader where they are after %s while the jump pages', async (_case, input) => {
    const pages = holdFirstPage()
    wrapper = mount(PagedTranscript, { props: { holdPage: pages.holdPage }, attachTo: document.body })
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    // Anti-vacuous: the older page is in flight.
    expect(pages.asked()).toBe(1)
    expect(getButton('prompt-5').getAttribute('aria-busy')).toBe('true')

    input()
    await frame()
    // Abandoning the jump settles the pick: nothing is left pulsing in an open list.
    expect(dialog()).toBeNull()
    pages.release()
    await settle(60)
    // The abandoned jump would have paged on and pulled the reader up to prompt-5.
    expect(pages.asked()).toBe(1)
    expect(transcriptText('prompt-5')).toBeNull()
    expect(distanceFromBottom()).toBe(0)
  })

  it('leaves the reader where they are after a wheel over the rail while the jump pages', async () => {
    const pages = holdFirstPage()
    wrapper = mount(PagedTranscript, { props: { holdPage: pages.holdPage }, attachTo: document.body })
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)

    // The rail forwards its wheel to the transcript: the reader is scrolling.
    getButton('Your messages').dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
    await frame()
    // Anti-vacuous: the wheel moved the transcript.
    expect(distanceFromBottom()).toBe(40)
    pages.release()
    await settle(60)
    expect(pages.asked()).toBe(1)
    expect(transcriptText('prompt-5')).toBeNull()
    expect(distanceFromBottom()).toBe(40)
  })

  it('keeps paging when the reader wheels the open message list', async () => {
    const pages = holdFirstPage()
    wrapper = mount(PagedTranscript, { props: { holdPage: pages.holdPage }, attachTo: document.body })
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)
    // The list scrolls itself; the transcript is not being read.
    dialog().dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true }))
    pages.release()
    await settle(60)
    expect(pages.asked()).toBeGreaterThan(1)
    expect(Math.abs(rowOffsetFromViewportTop('prompt-5'))).toBeLessThanOrEqual(2)
  })

  it('stays at the latest message when "Jump to latest" is pressed while the jump pages', async () => {
    const pages = holdFirstPage()
    wrapper = mount(PagedTranscript, { props: { holdPage: pages.holdPage }, attachTo: document.body })
    await settle(10)
    // A reader parked above the end, so the button shows.
    scroller().scrollTop = 200
    await settle(2)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)

    getButton('Jump to latest').click()
    await frame()
    pages.release()
    await settle(60)
    expect(pages.asked()).toBe(1)
    expect(transcriptText('prompt-5')).toBeNull()
    expect(distanceFromBottom()).toBe(0)
  })
})

describe('revealing a diff while a rail jump pages', () => {
  let restoreLayout = () => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    restoreLayout()
    vi.restoreAllMocks()
  })

  const journalItem = (itemId, body, sequence) => ({ itemId, body, sequence, observedAt: sequence * 1000, revision: 1 })
  const prompt = (itemId, text, sequence) =>
    journalItem(itemId, { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }, sequence)
  const patch = '@@ -1 +1 @@\n-before\n+after'
  const OLDER = prompt('older', 'Oldest prompt', 1)
  const LOADED = [
    prompt('user', 'Edit it', 2),
    journalItem('diff', { kind: 'diff', path: 'src/a.ts', patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length } }, 3),
    prompt('user-2', 'Second prompt', 4),
    prompt('user-3', 'Third prompt', 5),
    ...Array.from({ length: 200 }, (_, index) =>
      journalItem(`tail-${index}`, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `marker-${index}` }] }, index + 6)
    )
  ]

  const DiffTranscript = defineComponent({
    props: { holdPage: { type: Function, required: true } },
    setup(props) {
      const loadedOlder = ref(false)
      const items = computed(() => (loadedOlder.value ? [OLDER, ...LOADED] : LOADED))
      const loadEarlier = async () => {
        await props.holdPage()
        loadedOlder.value = true
        return 'applied'
      }
      return () =>
        h(NativeChatMessageList, {
          session: { ...session(projectStructuredItemsToNativeChat(items.value)), hasMore: !loadedOlder.value, loadEarlier },
          journalItems: items.value,
          railOutline: loadedOlder.value ? [] : [{ id: 'older', text: 'Oldest prompt', hasImages: false }],
          isWorking: false,
          expandSignal: false,
          fontScale: 1
        })
    }
  })

  it('keeps the diff in view when its page lands', async () => {
    let release = () => {}
    const holdPage = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const scrollTo = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => {})
    wrapper = mount(DiffTranscript, { props: { holdPage }, attachTo: document.body })
    await flush()

    getButton('Your messages').click()
    await flush()
    getButton('Oldest prompt').click()
    await flush()
    // Anti-vacuous: the older page is in flight.
    expect(holdPage).toHaveBeenCalledTimes(1)
    getButton(/1 changed file/).click()
    await flush()
    rollupFile('src/a.ts').click()
    await flush()
    await scrollTranscript(document, 6000)
    expect(getByText('Edited file')).toBeTruthy()
    scrollTo.mockClear()

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    // The abandoned jump would have taken the pin and smooth-scrolled up to the
    // oldest prompt; the prepend's own anchoring is an instant write.
    expect(scrollTo.mock.calls.filter(([options]) => options?.behavior === 'smooth')).toEqual([])
    expect(getByText('Edited file')).toBeTruthy()
  })
})
