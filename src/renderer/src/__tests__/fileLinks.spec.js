import { describe, it, expect } from 'vitest'
import { findFileRefs } from '../../../shared/fileLinks'

const refs = (t) => findFileRefs(t).map((r) => [r.path, r.line, r.col])

describe('file references in terminal text', () => {
  it('finds paths with a line and column', () => {
    expect(refs('Error at src/main/index.js:123:5 here')).toEqual([['src/main/index.js', 123, 5]])
    expect(refs('C:\\Proj\\app.ts:12 failed')).toEqual([['C:\\Proj\\app.ts', 12, null]])
    expect(refs('  File "./a/b.py", line 3')).toEqual([['./a/b.py', null, null]])
    expect(refs('app.cs(12,7): error')).toEqual([['app.cs', 12, 7]])
    expect(refs('Updated README.md')).toEqual([['README.md', null, null]])
  })
  it('ignores URLs, versions and e-mails', () => {
    expect(refs('see https://example.com/docs/page.html')).toEqual([])
    expect(refs('released v1.4.0 and 2.1.283')).toEqual([])
    expect(refs('write to me@example.com')).toEqual([])
  })
  it('gives each match its position in the line', () => {
    const [r] = findFileRefs('x src/a.js:1')
    expect(r.index).toBe(2)
    expect(r.text).toBe('src/a.js:1')
  })
})
