// Live handles to mounted terminal panes, so one pane can hand text to another
// ("send selection to…", "ask … to review"). TerminalPane registers on mount.
const panes = new Map() // paneId -> { paste(text), submit(), getSelection() }

export function registerPane(id, api) {
  panes.set(id, api)
}

export function unregisterPane(id, api) {
  if (panes.get(id) === api) panes.delete(id)
}

export function getPane(id) {
  return panes.get(id) || null
}
