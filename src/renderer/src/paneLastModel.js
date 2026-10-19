// The model an agent pane's header showed last ({ model, name?, effort? }),
// kept with the layout (App.vue serializeNode): a pane still running after
// Tessel restarts shows it at once, until its files or its screen are read
// again (that took a minute and more at a start, every pane asking while the
// conversations were listed). Display only, never sent to the agent.
const TEXT = /^[^\u0000-\u001f\u007f]{1,120}$/
const EFFORT = /^[a-z]{2,12}$/

const text = (v) => (typeof v === 'string' && TEXT.test(v.trim()) ? v.trim() : null)

// -> a clean copy of a saved value, or null.
export function savedPaneModel(v) {
  if (!v || typeof v !== 'object') return null
  const model = text(v.model)
  if (!model) return null
  const name = text(v.name)
  const effort = typeof v.effort === 'string' && EFFORT.test(v.effort) ? v.effort : null
  return { model, ...(name ? { name } : {}), ...(effort ? { effort } : {}) }
}

// What to keep of what the header shows now (its own saved value: nothing new).
export function paneModelToSave(shown) {
  if (!shown || shown.source === 'saved') return null
  return savedPaneModel(shown)
}

export function samePaneModel(a, b) {
  const x = savedPaneModel(a)
  const y = savedPaneModel(b)
  if (!x || !y) return !x && !y
  return x.model === y.model && (x.name || '') === (y.name || '') && (x.effort || '') === (y.effort || '')
}
