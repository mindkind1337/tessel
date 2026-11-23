import { describe, it, expect } from 'vitest'
import { devUpdateBadgeShown } from '../devUpdateBadge'

describe('devUpdateBadgeShown', () => {
  it('shows new builds', () => {
    expect(devUpdateBadgeShown({ state: 'available', behind: 2 })).toBe(true)
  })

  it('hides after an update that only changed the window: it has already reloaded', () => {
    expect(devUpdateBadgeShown({ state: 'updated', mainChanged: false, depsChanged: false })).toBe(false)
  })

  it('stays after an update that needs a restart', () => {
    expect(devUpdateBadgeShown({ state: 'updated', mainChanged: true, depsChanged: false })).toBe(true)
    expect(devUpdateBadgeShown({ state: 'updated', mainChanged: false, depsChanged: true })).toBe(true)
  })

  it('stays when the update does not say what changed, like the dialog', () => {
    expect(devUpdateBadgeShown({ state: 'updated' })).toBe(true)
  })

  it('hides for every other state', () => {
    for (const state of ['none', 'disabled', 'error']) expect(devUpdateBadgeShown({ state })).toBe(false)
    expect(devUpdateBadgeShown(null)).toBe(false)
  })
})
