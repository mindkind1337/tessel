// After Orca's NativeChatMessageList.older-history.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX } from '../../../../chat/orca/composables/use-native-chat-older-history-autoload.js'
import {
  deliverResizes,
  fireScroll,
  flush,
  getButton,
  getByText,
  installElementScrollTo,
  layout,
  marker,
  mountList,
  queryButton,
  ROW_PITCH_PX,
  scrollRoot,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver,
  unmountAll
} from './native-chat-windowing-test-harness.js'

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

// jsdom has no IntersectionObserver. This one reports the way a browser does:
// once on observe, then only when the target crosses the edge.
const observations = new Set()
const createdObservers = []
/** Whether the sentinel sits inside the observer's prefetch range right now. */
let sentinelInRange = false

class FakeIntersectionObserver {
  constructor(callback, options = {}) {
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
    this.thresholds = [0]
    this.observation = { callback, observer: this, targets: new Map() }
    observations.add(this.observation)
    createdObservers.push({ root: this.root, rootMargin: this.rootMargin })
  }
  observe(target) {
    this.observation.targets.set(target, null)
  }
  unobserve(target) {
    this.observation.targets.delete(target)
  }
  disconnect() {
    this.observation.targets.clear()
    observations.delete(this.observation)
  }
  takeRecords() {
    return []
  }
}

/** One rendering opportunity's worth of intersection reports. */
async function deliverIntersections() {
  for (const observation of Array.from(observations)) {
    const entries = []
    for (const [target, last] of observation.targets) {
      if (last !== sentinelInRange) {
        observation.targets.set(target, sentinelInRange)
        entries.push({ isIntersecting: sentinelInRange, intersectionRatio: sentinelInRange ? 1 : 0, target, time: 0 })
      }
    }
    if (entries.length > 0) observation.callback(entries, observation.observer)
  }
  await flush()
}

/** Lets a resolved loadEarlier promise report back. */
async function settle() {
  await flush()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flush()
}

function noise(index) {
  // A harness-injected turn: real history the transcript strips before it has a row.
  return {
    id: `noise-${index}`,
    role: 'user',
    blocks: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }],
    timestamp: index + 1,
    source: 'transcript'
  }
}
const markers = (from, to) => Array.from({ length: to - from }, (_, offset) => marker(from + offset))

/** The scroll root's top gutter (pt-10) and the column's gap (gap-5). */
const TOP_GUTTER_PX = 40
const COLUMN_GAP_PX = 20
/** Chrome in flow before the window pushes it down by its height and one gap. */
const IN_FLOW_CHROME_PX = 32
function flowAboveSpacer(spacer) {
  let above = TOP_GUTTER_PX
  for (let node = spacer.previousElementSibling; node; node = node.previousElementSibling) {
    above += IN_FLOW_CHROME_PX + COLUMN_GAP_PX
  }
  return above
}

const lands = () => vi.fn(async () => 'applied')
const neverSettles = () => vi.fn(() => new Promise(() => {}))

function paging({
  messages,
  loadEarlier,
  hasMore = true,
  loadingEarlier = false,
  isVisible = true,
  olderHistoryGeneration = 0,
  readPhase = 'ready'
}) {
  return {
    session: { ...session(messages), hasMore, loadingEarlier, loadEarlier, olderHistoryGeneration, readPhase },
    isVisible,
    isWorking: false,
    expandSignal: false,
    fontScale: 1
  }
}

async function paint() {
  const scroller = scrollRoot()
  for (let pass = 0; pass < 12; pass += 1) {
    const before = scroller.scrollTop
    const resized = deliverResizes()
    await flush()
    if (scroller.scrollTop !== before) {
      fireScroll(scroller)
      await flush()
    } else if (!resized) {
      return
    }
  }
  throw new Error('the transcript never settled')
}

const status = () => document.querySelector('[role="status"]')
const loadEarlierButton = () => queryButton(/load earlier/i)

let restoreScrollTo = () => {}
beforeAll(() => {
  restoreScrollTo = installElementScrollTo()
})
afterAll(() => restoreScrollTo())

describe('older history auto-load', () => {
  let restoreLayout = () => {}
  let restoreResizeObserver = () => {}
  beforeEach(() => {
    restoreLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
    restoreResizeObserver = stubResizeObserver()
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    observations.clear()
    createdObservers.length = 0
    sentinelInRange = false
    layout.aboveTranscriptPx = 0
    layout.aboveSpacerPx = flowAboveSpacer
  })
  afterEach(() => {
    unmountAll()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    restoreResizeObserver()
    restoreLayout()
    layout.aboveTranscriptPx = 0
    layout.aboveSpacerPx = null
  })

  it('asks for a page once the top sentinel is within prefetch range of the scroller', async () => {
    const loadEarlier = lands()
    await mountList(paging({ messages: markers(100, 150), loadEarlier }))
    await deliverIntersections()
    expect(loadEarlier).not.toHaveBeenCalled()
    expect(createdObservers.at(-1)).toEqual({
      root: scrollRoot(),
      rootMargin: `${NATIVE_CHAT_OLDER_HISTORY_PREFETCH_PX}px 0px 0px 0px`
    })
    sentinelInRange = true
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    expect(loadEarlierButton()).toBeNull()
  })

  // A page of rows the transcript hides leaves the row count unchanged; paging
  // must continue anyway while the reader is still near the top.
  it('keeps paging after each page while the sentinel stays in range', async () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    await paint()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    const hiddenPage = [...Array.from({ length: 20 }, (_, index) => noise(index)), ...base]
    await wrapper.setProps(paging({ messages: hiddenPage, loadEarlier }))
    await paint()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(2)

    await wrapper.setProps(paging({ messages: hiddenPage, loadEarlier, loadingEarlier: true }))
    await settle()
    await wrapper.setProps(paging({ messages: [...markers(80, 100), ...hiddenPage], loadEarlier }))
    await paint()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(3)
  })

  it('stops once a page pushes the sentinel out of range', async () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()

    sentinelInRange = false
    await wrapper.setProps(paging({ messages: [...markers(50, 100), ...base], loadEarlier }))
    await paint()
    await deliverIntersections()
    deliverResizes()
    await flush()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  it('stops, and shows neither status nor button, once history runs out', async () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    await wrapper.setProps(paging({ messages: [...markers(90, 100), ...base], loadEarlier, hasMore: false }))
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    expect(observations.size).toBe(0)
    expect(status()).toBeNull()
    expect(loadEarlierButton()).toBeNull()
  })

  it('stops observing while the lane reports a page loading', async () => {
    const loadEarlier = neverSettles()
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await paint()
    sentinelInRange = false
    await deliverIntersections()
    sentinelInRange = true
    await deliverIntersections()
    expect(observations.size).toBe(0)
    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  // The lane can start and abandon a read before loading is ever rendered; the
  // list must not hold its own latch on the outstanding read. The lane dedupes.
  it('asks again when the lane never reports the outstanding page as loading', async () => {
    const loadEarlier = neverSettles()
    await mountList(paging({ messages: markers(100, 150), loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    sentinelInRange = false
    await deliverIntersections()
    sentinelInRange = true
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
  })

  // A reconnect snapshot or a hide ends the lane's loading while its read is still
  // outstanding; the next page must not wait on a request the lane dropped.
  it('keeps paging when the lane abandons a page that never settles', async () => {
    const loadEarlier = neverSettles()
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    await wrapper.setProps(paging({ messages: base, loadEarlier }))
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
  })

  it('does not observe a hidden transcript', async () => {
    const loadEarlier = lands()
    await mountList(paging({ messages: markers(100, 150), loadEarlier, isVisible: false }))
    sentinelInRange = true
    await deliverIntersections()
    expect(observations.size).toBe(0)
    expect(loadEarlier).not.toHaveBeenCalled()
  })

  it('shows a quiet status line, with a label only once a page is slow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const loadEarlier = lands()
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    expect(status().getAttribute('aria-live')).toBe('polite')
    expect(status().textContent).toBe('')

    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await flush()
    expect(status().textContent).toBe('')
    vi.advanceTimersByTime(200)
    await flush()
    expect(status().textContent).toBe('Loading earlier messages…')
    expect(loadEarlierButton()).toBeNull()
  })

  it('offers a manual load after a failed page, and resumes auto-loading once it succeeds', async () => {
    const loadEarlier = vi.fn().mockResolvedValueOnce('failed').mockResolvedValue('applied')
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    await settle()

    const retry = getButton('Load earlier messages')
    expect(status()).toBeNull()
    expect(observations.size).toBe(0)
    sentinelInRange = false
    await deliverIntersections()
    sentinelInRange = true
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)

    retry.click()
    await settle()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
    expect(loadEarlierButton()).toBeNull()
    expect(status()).not.toBeNull()

    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await wrapper.setProps(paging({ messages: [...markers(80, 100), ...base], loadEarlier }))
    await flush()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(3)
  })

  // Without this the recreated observer would ask for the same stuck page forever.
  it('stops auto-loading, and offers a manual load, when a page made no progress', async () => {
    const loadEarlier = vi.fn().mockResolvedValue('unchanged')
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await wrapper.setProps(paging({ messages: base, loadEarlier }))
    await settle()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    expect(observations.size).toBe(0)
    expect(getButton('Load earlier messages')).toBeTruthy()
  })

  // A failure belongs to one paging generation: a reconnect or reset gives the
  // host another chance without the reader having to click.
  it('resumes auto-loading, with no click, once the lane resets its paging generation', async () => {
    const loadEarlier = vi.fn().mockResolvedValueOnce('failed').mockResolvedValue('applied')
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    sentinelInRange = true
    await deliverIntersections()
    await settle()
    expect(getButton('Load earlier messages')).toBeTruthy()

    await wrapper.setProps(paging({ messages: base, loadEarlier, olderHistoryGeneration: 1 }))
    await flush()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
    expect(loadEarlierButton()).toBeNull()
  })

  it('shows no older-history row while the read is not ready, and re-checks once it is', async () => {
    const loadEarlier = lands()
    const base = markers(100, 150)
    const wrapper = await mountList(paging({ messages: base, loadEarlier, readPhase: 'error' }))
    sentinelInRange = true
    await deliverIntersections()
    expect(observations.size).toBe(0)
    expect(status()).toBeNull()
    expect(loadEarlierButton()).toBeNull()
    expect(loadEarlier).not.toHaveBeenCalled()

    await wrapper.setProps(paging({ messages: base, loadEarlier }))
    await flush()
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
  })

  /** Where a row's top sits in the scroll document. */
  function rowTop(text) {
    const row = getByText(text).closest('[data-index]')
    const spacer = document.querySelector('[data-native-chat-window]')
    if (!row || !spacer) throw new Error(`${text} is not a windowed row`)
    return spacer.offsetTop + Number.parseFloat(row.style.top)
  }

  async function readerAtMarker140(loadEarlier) {
    const base = markers(100, 200)
    const wrapper = await mountList(paging({ messages: base, loadEarlier }))
    await paint()
    const scroller = scrollRoot()
    const spacer = document.querySelector('[data-native-chat-window]')
    await scrollTranscript(document, (spacer?.offsetTop ?? 0) + 40 * ROW_PITCH_PX + 17)
    await paint()
    expect(rowTop('marker-140') - scroller.scrollTop).toBe(-17)

    sentinelInRange = true
    await deliverIntersections()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    sentinelInRange = false
    await wrapper.setProps(paging({ messages: base, loadEarlier, loadingEarlier: true }))
    await settle()
    return { wrapper, base, scroller }
  }

  // KNOWN BUG (reported, in useNativeChatTranscriptWindow): @tanstack/vue-virtual
  // runs setOptions + _willUpdate in ONE pre-render watcher, so a prepend's
  // anchor write lands before the spacer grows and the browser clamps it to the
  // old height (React sets options during render and runs _willUpdate after the
  // commit). Verified: setOptions in a pre watcher and _willUpdate in a
  // post-render watcher makes both cases pass. Flip back to `it` with the fix.
  it('keeps the row the reader is looking at in place across an auto-loaded prepend', async () => {
    const loadEarlier = lands()
    const { wrapper, base, scroller } = await readerAtMarker140(loadEarlier)
    await wrapper.setProps(paging({ messages: [...markers(50, 100), ...base], loadEarlier }))
    await paint()
    expect(rowTop('marker-140') - scroller.scrollTop).toBe(-17)
    expect(scroller.scrollTop).toBe(TOP_GUTTER_PX + 90 * ROW_PITCH_PX + 17)
  })

  // The last page takes the older-history row away with it: anything that row
  // held in flow above the window would leave with it, and move every row.
  // Same known bug as above.
  it('keeps the reader in place when the last page lands and the older-history row leaves', async () => {
    const loadEarlier = lands()
    const { wrapper, base, scroller } = await readerAtMarker140(loadEarlier)
    await wrapper.setProps(paging({ messages: [...markers(50, 100), ...base], loadEarlier, hasMore: false }))
    await paint()
    expect(status()).toBeNull()
    expect(rowTop('marker-140') - scroller.scrollTop).toBe(-17)
  })
})
