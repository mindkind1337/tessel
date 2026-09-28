import { describe, it, expect } from 'vitest'
import { reviewMessage } from '../../../shared/reviewComments'

describe('review line comments', () => {
  it('one message: the general text, then each comment by file and line with its code', () => {
    const msg = reviewMessage('Please tidy up.', [
      { file: 'src/b.js', line: 4, side: 'new', code: 'const x = 1', text: 'Name this better' },
      { file: 'src/a.js', line: 12, side: 'old', code: 'oldCall()', text: 'Why was this removed?' },
      { file: 'src/a.js', line: 3, side: 'new', code: '', text: '  ' } // empty: left out
    ])
    expect(msg).toBe(
      [
        'Please tidy up.',
        '',
        'Comments on specific lines (2):',
        '- src/a.js:12 (removed line): Why was this removed?',
        '  > oldCall()',
        '- src/b.js:4: Name this better',
        '  > const x = 1'
      ].join('\n')
    )
  })
  it('comments alone, or nothing at all', () => {
    expect(reviewMessage('', [{ file: 'a', line: 1, side: 'new', text: 'x' }])).toMatch(/^Comments on specific lines \(1\):/)
    expect(reviewMessage('  ', [])).toBe('')
  })
})
