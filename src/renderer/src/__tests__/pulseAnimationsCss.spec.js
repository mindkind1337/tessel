import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '../style.css'), 'utf8')
const keyframes = (name) => {
  const m = css.match(new RegExp('@keyframes ' + name + ' \\{([\\s\\S]*?)\\n\\}'))
  return m ? m[1] : null
}

// The status dots pulse on the compositor (transform and opacity of a ring):
// a stepped box-shadow animation cost the window a style recalculation at
// every step, 600 a second with five dots pulsing (2026-11-06).
describe('the pulsing status dots', () => {
  it.each(['agent-pulse', 'attention-pulse', 'monitoring-pulse'])('%s animates transform and opacity only', (name) => {
    const body = keyframes(name)
    expect(body).not.toBeNull()
    expect(body).toMatch(/transform:/)
    expect(body).toMatch(/opacity:/)
    expect(body).not.toMatch(/box-shadow|background|width|height|border/)
  })

  it('the working sweep under an agent pane\u2019s header moves with transform, not background-position', () => {
    const body = keyframes('agent-sweep')
    expect(body).not.toBeNull()
    expect(body).toMatch(/transform:/)
    expect(body).not.toMatch(/background/)
    // Clipped by the header while outside it (the bar is half the width and travels past both ends).
    expect(css).toMatch(/\.pane-nav\.agent\.busy \{\s*clip-path: inset\(/)
  })

  it('the pulses run on the dots\u2019 ::after ring, never on the dots themselves', () => {
    // Comments stripped: a comment before a rule would count as its selector.
    const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    for (const [, selector, body] of rules) {
      if (!/animation:\s*(agent|attention|monitoring)-pulse/.test(body)) continue
      for (const s of selector.split(',')) expect(s.trim()).toMatch(/::after$/)
    }
    expect(css).toMatch(/\.asd-dot\.asd-working::after/)
    expect(css).toMatch(/\.pane-icon\.busy \.pane-status-dot::after/)
    expect(css).toMatch(/\.ws-busy::after/)
  })
})
