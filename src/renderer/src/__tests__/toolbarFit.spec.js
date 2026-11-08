import { describe, it, expect } from 'vitest'
import { toolbarFitLevel, TOOLBAR_CENTRE_MIN } from '../toolbarFit'

// The toolbar's three levels, from the room it has (App.vue measures, this decides).
describe('toolbarFitLevel', () => {
  const groups = { left: 300, right: 420, secondary: 240, more: 28, version: 60 }
  it('everything shown while the two groups and the command box\u2019s icon fit', () => {
    expect(toolbarFitLevel({ avail: 1000, ...groups })).toBe(0)
    expect(toolbarFitLevel({ avail: 300 + 420 + TOOLBAR_CENTRE_MIN, ...groups })).toBe(0)
  })
  it('the secondary buttons go under "more" when that is enough', () => {
    expect(toolbarFitLevel({ avail: 700, ...groups })).toBe(1)
    // What the right group becomes: 420 - 240 + 28 = 208; 300 + 208 + 60 = 568.
    expect(toolbarFitLevel({ avail: 568, ...groups })).toBe(1)
  })
  it('then the version and the box\u2019s words go too', () => {
    expect(toolbarFitLevel({ avail: 567, ...groups })).toBe(2)
    expect(toolbarFitLevel({ avail: 200, ...groups })).toBe(2)
  })
  it('a dev chip or a pill that comes makes it tighter at the same window width (the groups are measured, not the window)', () => {
    const avail = 800
    expect(toolbarFitLevel({ avail, ...groups })).toBe(0)
    expect(toolbarFitLevel({ avail, ...groups, left: 400 })).toBe(1)
  })
  it('no room known: nothing hidden', () => {
    expect(toolbarFitLevel({ avail: 0, ...groups })).toBe(0)
  })
})
