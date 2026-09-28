import { describe, it, expect } from 'vitest'
import { fuzzyScore, fuzzyFilter } from '../../../shared/fuzzy'

const FILES = [
  'src/renderer/src/App.vue',
  'src/renderer/src/components/ReviewPanel.vue',
  'src/main/review.js',
  'src/main/index.js',
  'docs/app-overview.md',
  'package.json'
]

describe('fuzzy file search', () => {
  it('finds letters in order anywhere, never out of order', () => {
    expect(fuzzyScore('apvue', 'src/renderer/src/App.vue')).toBeGreaterThan(0)
    expect(fuzzyScore('eupa', 'src/renderer/src/App.vue')).toBe(-1)
  })
  it('ranks a name match first', () => {
    expect(fuzzyFilter('review', FILES).slice(0, 2)).toEqual(['src/main/review.js', 'src/renderer/src/components/ReviewPanel.vue'])
    expect(fuzzyFilter('app', FILES)[0]).toBe('src/renderer/src/App.vue')
    expect(fuzzyFilter('pkg', FILES)[0]).toBe('package.json')
  })
  it('an empty query lists the first files; nothing matching gives nothing', () => {
    expect(fuzzyFilter('', FILES, 3)).toEqual(FILES.slice(0, 3))
    expect(fuzzyFilter('zzz', FILES)).toEqual([])
  })
})
