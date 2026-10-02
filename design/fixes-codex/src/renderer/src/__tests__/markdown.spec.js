import { describe, it, expect } from 'vitest'
import { parseMarkdown, parseInline } from '../../../shared/markdown'

describe('parseMarkdown', () => {
  it('reads the shape of the project notes', () => {
    const blocks = parseMarkdown(`# Project notes: Tessel

Shared notes of the agents.
They write here.

## Journal

- 2026-09-24 Tessel: notes created.
- 2026-09-24 Codex: styled the **team** rows,
  and the \`.pane-team\` tag.
`)
    expect(blocks.map((b) => b.type)).toEqual(['h1', 'p', 'h2', 'ul'])
    expect(blocks[1].parts).toEqual([{ kind: 'text', text: 'Shared notes of the agents. They write here.' }])
    expect(blocks[3].items).toHaveLength(2)
    expect(blocks[3].items[1]).toEqual([
      { kind: 'text', text: '2026-09-24 Codex: styled the ' },
      { kind: 'bold', text: 'team' },
      { kind: 'text', text: ' rows, and the ' },
      { kind: 'code', text: '.pane-team' },
      { kind: 'text', text: ' tag.' }
    ])
  })

  it('keeps code blocks as they are', () => {
    const blocks = parseMarkdown('```\nnpm run build\n  indented\n```')
    expect(blocks).toEqual([{ type: 'code', text: 'npm run build\n  indented' }])
  })

  it('never produces markup from the text', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)> and <b>bold</b>')
    expect(blocks[0].parts).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)> and <b>bold</b>' }])
  })

  it('reads quotes, rules and italics', () => {
    expect(parseMarkdown('> a quote\n\n---').map((b) => b.type)).toEqual(['quote', 'hr'])
    expect(parseInline('an *important* word')).toEqual([
      { kind: 'text', text: 'an ' },
      { kind: 'italic', text: 'important' },
      { kind: 'text', text: ' word' }
    ])
  })
})
