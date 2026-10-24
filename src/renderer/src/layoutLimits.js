// How wide the workspace sidebar may be dragged: 500 px, or more on a wide
// or ultrawide screen (a third of the window at most), never fixed.
export const SIDEBAR_MIN_MAX = 500
export function sidebarMaxWidth(windowWidth = typeof window !== 'undefined' ? window.innerWidth : 0) {
  return Math.max(SIDEBAR_MIN_MAX, Math.round((Number(windowWidth) || 0) * 0.3))
}

// The window's two resizable edges (the projects sidebar's, the right
// panel's) feel the same: dragged this many px from their own edge they
// collapse (sidebar) or close (panel) when let go, and a second press within
// this many ms resets the width.
export const RESIZE_COLLAPSE_BELOW = 110
export const RESIZE_DOUBLE_CLICK_MS = 400
