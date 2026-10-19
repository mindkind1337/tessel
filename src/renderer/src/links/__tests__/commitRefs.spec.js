import { describe, expect, it } from 'vitest'
import { findCommitRefs, isCommitHash, looksLikeCommitHash, MAX_REFS } from '../commitRefs.js'

const hashes = (text) => findCommitRefs(text).map((r) => r.hash)

describe('findCommitRefs', () => {
  it('finds the hashes agents write: inline, in brackets, after "commit", as a range', () => {
    expect(hashes('Pushed to GitHub (`1f6ccc70`), done.')).toEqual(['1f6ccc70'])
    expect(hashes('commit abc1234 fixes it')).toEqual(['abc1234'])
    expect(hashes('merged (e2eb0ce5)')).toEqual(['e2eb0ce5'])
    expect(hashes('abc1234..def5678')).toEqual(['abc1234', 'def5678'])
    expect(hashes('abc1234...def5678')).toEqual(['abc1234', 'def5678'])
    expect(hashes('b99e8635 Merge branch')).toEqual(['b99e8635'])
    expect(hashes('ends with b99e8635.')).toEqual(['b99e8635'])
    expect(hashes('b99e8635: the fix')).toEqual(['b99e8635'])
    expect(hashes('a'.repeat(39) + '1')).toEqual(['a'.repeat(39) + '1'])
  })

  it('gives where each one is', () => {
    expect(findCommitRefs('see abc1234 now')).toEqual([{ index: 4, length: 7, hash: 'abc1234' }])
  })

  it('never a word, a number, a colour, a UUID, a path, a URL part or a file name', () => {
    for (const text of [
      'deadbeef and defaced',
      '1234567 items',
      'abc123',
      'ABC1234',
      'Abc1234',
      '0xabc1234',
      'color #a1b2c3d4',
      '123e4567-e89b-12d3-a456-426614174000',
      'src/abc1234/x.js',
      'https://github.com/o/r/commit/abc1234',
      'abc1234.js',
      'user@abc1234',
      'v1.2-3-gabc1234',
      'x.abc1234',
      '?sha=abc1234&x',
      'a'.repeat(40) + '1',
      'abc1234_def'
    ])
      expect(hashes(text), text).toEqual([])
  })

  it('stops at MAX_REFS per text', () => {
    const many = Array.from({ length: MAX_REFS + 5 }, (_, i) => `abc${String(1000 + i)}`).join(' ')
    expect(findCommitRefs(many)).toHaveLength(MAX_REFS)
  })
})

describe('isCommitHash / looksLikeCommitHash', () => {
  it('hex only, 7 to 40, lower case; prose needs a digit and a letter', () => {
    expect(isCommitHash('deadbeef')).toBe(true)
    expect(isCommitHash('--all')).toBe(false)
    expect(isCommitHash('HEAD')).toBe(false)
    expect(isCommitHash('abc123')).toBe(false)
    expect(isCommitHash('abc1234^{commit}')).toBe(false)
    expect(looksLikeCommitHash('deadbeef')).toBe(false)
    expect(looksLikeCommitHash('1234567')).toBe(false)
    expect(looksLikeCommitHash('dead1eef')).toBe(true)
  })
})
