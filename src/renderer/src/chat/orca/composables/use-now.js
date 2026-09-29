// After Orca's use-now.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a ref/computed value; read it with .value outside templates.
import { shallowRef, toValue, watch } from 'vue'
import { installWindowVisibilityInterval } from '../lib/window-visibility-interval.js'

const nowClocks = new Map()

export function createSharedNowClock(
  intervalMs,
  deps = {
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle),
  },
) {
  let now = deps.now()
  let stopInterval = null
  const listeners = new Set()

  const tick = () => {
    now = deps.now()
    for (const listener of listeners) {
      listener()
    }
  }

  return {
    getSnapshot: () => now,
    subscribe: (listener) => {
      listeners.add(listener)
      if (!stopInterval) {
        // Why: all mounted relative-time labels at this cadence share one
        // visibility-gated timer. installWindowVisibilityInterval runs tick
        // immediately on (re)start — so remounted or newly-visible labels catch
        // up at once — and pauses the interval while the window is hidden, so
        // backgrounded agent rows stop re-rendering for ticks no one can see.
        stopInterval = installWindowVisibilityInterval({
          run: tick,
          intervalMs,
          setIntervalFn: deps.setInterval,
          clearIntervalFn: deps.clearInterval,
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stopInterval) {
          stopInterval()
          stopInterval = null
        }
      }
    },
  }
}

function getSharedNowClock(intervalMs) {
  let clock = nowClocks.get(intervalMs)
  if (!clock) {
    clock = createSharedNowClock(intervalMs)
    nowClocks.set(intervalMs, clock)
  }
  return clock
}

// A disabled consumer releases its subscription and retains a frozen snapshot.
// Vue subscribes synchronously on activation, refreshing the clock immediately.
export function useNow(intervalMs, enabled = true) {
  const snapshot = shallowRef(getSharedNowClock(toValue(intervalMs)).getSnapshot())
  watch(
    [() => toValue(intervalMs), () => toValue(enabled)],
    ([interval, active], _old, onCleanup) => {
      const clock = getSharedNowClock(interval)
      snapshot.value = clock.getSnapshot()
      if (active) {
        const off = clock.subscribe(() => {
          snapshot.value = clock.getSnapshot()
        })
        snapshot.value = clock.getSnapshot()
        onCleanup(off)
      }
    },
    { immediate: true, flush: 'sync' },
  )
  return snapshot
}
