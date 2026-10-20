// A computed that hands back the SAME value while a recompute produces the
// same data. The lists App builds for its panels (the sidebar's projects, the
// board's agent panes) are rebuilt whenever any agent's state moves, which
// happens about once a second while agents work; as new arrays they re-render
// every panel and card that receives them (measured: hundreds of task cards
// each second). Equal data keeps the old array, so nothing downstream runs.
import { computed } from 'vue'

export function stableComputed(getter) {
  let lastJson = null
  let lastValue
  return computed(() => {
    const value = getter()
    let json
    try {
      json = JSON.stringify(value)
    } catch {
      // Not plain data (a cycle): handed out as it is.
      lastJson = null
      return value
    }
    if (lastJson !== null && json === lastJson) return lastValue
    lastJson = json
    lastValue = value
    return value
  })
}
