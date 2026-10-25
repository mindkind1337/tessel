// The count on the Changes tab's badge (scmState.js changeCount): every
// change, also when the list holds only the first ones.
import { describe, it, expect } from 'vitest'
import { changeCount } from '../scmState'

describe('changeCount', () => {
  it('counts the rows listed', () => {
    expect(changeCount({ repo: true, entries: [{}, {}] })).toBe(2)
  })
  it('a list cut short counts every change', () => {
    expect(changeCount({ repo: true, truncated: true, totalEntries: 12345, entries: [{}, {}] })).toBe(12345)
  })
  it('no repository, no status: 0', () => {
    expect(changeCount({ repo: false })).toBe(0)
    expect(changeCount(null)).toBe(0)
  })
})
