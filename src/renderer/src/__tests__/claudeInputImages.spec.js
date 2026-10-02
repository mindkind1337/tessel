// "[Image #N]" in Claude Code's input box (deliver.js waits for each pasted
// image path to become one): only the box under the cursor counts, never
// the images of earlier messages in the conversation above it.
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { claudeInputImages, codexInputImages } from '../agentStatus'

const RULE_ROW = '─'.repeat(50)

// rows on a terminal, the cursor at the end of row `at`.
async function count(rows, at, cols = 70) {
  const term = new Terminal({ cols, rows: rows.length + 2, allowProposedApi: true })
  await new Promise((resolve) => term.write(rows.join('\r\n'), resolve))
  const col = Math.min(cols, rows[at].length + 1)
  await new Promise((resolve) => term.write(`\x1b[${at + 1};${col}H`, resolve))
  return claudeInputImages(term)
}

describe('claudeInputImages', () => {
  it('counts the markers in the input box only', async () => {
    const rows = ['> [Image #1] [Image #2] earlier message', '', 'Two images.', '', RULE_ROW, '> [Image #3] [Image #4] ', RULE_ROW, '  ⏵⏵ bypass permissions on']
    expect(await count(rows, 5)).toBe(2)
  })
  it('an empty box: 0; one image: 1', async () => {
    expect(await count(['> [Image #1] old', RULE_ROW, '> ', RULE_ROW], 2)).toBe(0)
    expect(await count([RULE_ROW, '❯ [Image #5] ', RULE_ROW], 1)).toBe(1)
  })
  it('a long input wrapped over several rows: every marker counted once', async () => {
    const line = '> ' + Array.from({ length: 6 }, (_, i) => `[Image #${i + 1}]`).join(' ') + ' '
    const term = new Terminal({ cols: 30, rows: 12, allowProposedApi: true })
    await new Promise((resolve) => term.write(`${RULE_ROW.slice(0, 30)}\r\n${line}`, resolve))
    const y = term.buffer.active.cursorY
    await new Promise((resolve) => term.write(`\r\n${RULE_ROW.slice(0, 30)}\x1b[${y + 1};${term.buffer.active.cursorX + 1}H`, resolve))
    expect(claudeInputImages(term)).toBe(6)
  })
  it('the cursor not in a box under a rule: not known (null)', async () => {
    expect(await count(['[Image #1] PS C:\> '], 0)).toBe(null)
    expect(await count(['some text', '> [Image #1] '], 1)).toBe(null)
    expect(claudeInputImages(null)).toBe(null)
  })
})

describe('codexInputImages', () => {
  it('counts from its prompt row down to the cursor, not the conversation above', async () => {
    const rows = ['› [Image #1] earlier message', '', '• One image.', '', '› [Image #2] [Image #3] ', '', '  GPT medium · ~\\proj']
    expect(await countWith(codexInputImages, rows, 4)).toBe(2)
  })
  it('a marker the agent wrapped between its words still counts', async () => {
    expect(await countWith(codexInputImages, ['› [Image #1] [Image', '  #2] '], 1)).toBe(2)
  })
  it('no prompt: null', async () => {
    expect(await countWith(codexInputImages, ['PS C:\\> '], 0)).toBe(null)
  })
})

async function countWith(fn, rows, at) {
  const term = new Terminal({ cols: 70, rows: rows.length + 2, allowProposedApi: true })
  await new Promise((resolve) => term.write(rows.join('\r\n'), resolve))
  await new Promise((resolve) => term.write(`\x1b[${at + 1};${rows[at].length + 1}H`, resolve))
  return fn(term)
}

