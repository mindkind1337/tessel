// Letting go of an xterm terminal that was opened a moment ago.
//
// xterm's Viewport (and its render service) schedules work when a terminal
// opens: a setTimeout for its first scroll-area sync, an animation frame after
// a reset. A pane that is mounted and unmounted right away (the layout was
// rebuilt: a pane opened, a tile moved, nine panes remounted at once) disposed
// the terminal before those ran, and each one threw "Cannot read properties of
// undefined (reading 'dimensions')" in the log (2026-10-24 18:58). A terminal
// opened less than FRESH_MS ago is disposed after that work had its turn.
export const FRESH_MS = 1000
export const DISPOSE_DELAY_MS = 100

// term: an xterm Terminal; openedAt: Date.now() when term.open() ran (0: not
// opened). -> 'now' | 'later'
export function disposeTerminal(term, openedAt, { now = Date.now, later = setTimeout } = {}) {
  if (!term) return 'now'
  const run = () => {
    try {
      term.dispose()
    } catch {
      /* already gone */
    }
  }
  if (openedAt && now() - openedAt < FRESH_MS) {
    later(run, DISPOSE_DELAY_MS)
    return 'later'
  }
  run()
  return 'now'
}
