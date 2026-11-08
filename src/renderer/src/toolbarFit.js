// How tight the toolbar is, from the room it has: 0, everything shown; 1, the
// secondary buttons under the "more" button; 2, also the brand's version and
// the command box's words gone (its icon stays). Measured, not guessed from
// the window's width: the dev chips (restart, new builds), the update pill,
// an agent request and the Live Share pill come and go, and a fixed
// breakpoint left the icons over the version with them (2026-11-08).
// avail: the toolbar's content width; left/right: the two groups' widths with
// everything shown; secondary: what the right group loses when its secondary
// buttons hide (their widths and the separators'); more: the "more" button's
// width; version: the brand version's width; centre: the least the command
// box needs (its icon) with the centre's padding.
export const TOOLBAR_CENTRE_MIN = 60
export function toolbarFitLevel({ avail, left, right, secondary = 0, more = 28, version = 0, centre = TOOLBAR_CENTRE_MIN }) {
  if (!(avail > 0)) return 0
  if (left + right + centre <= avail) return 0
  if (left + (right - secondary + more) + centre <= avail) return 1
  // Level 2 is what remains: the version gone and the box at its icon; the
  // toolbar may still overflow in a very small window, nothing more to take.
  void version
  return 2
}
