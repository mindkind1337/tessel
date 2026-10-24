// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { paneOpenLine, SLOW_PANE_MS } from '../paneTiming'

describe('paneOpenLine', () => {
  it('lists the steps that took time, in order', () => {
    expect(paneOpenLine('claude local', 'pane-12-345', 240.4, [['env', 0.2], ['status hooks', 9], ['terminal host', 190.6], ['register', 38]])).toBe(
      'claude local pane-12-345 opened in 240 ms (steps: status hooks 9, terminal host 191, register 38)'
    )
  })
  it('marks a slow pane and tolerates bad input', () => {
    expect(paneOpenLine('shell ssh2', 'pane-1', SLOW_PANE_MS, [])).toBe('shell ssh2 pane-1 opened in 1500 ms (SLOW)')
    expect(paneOpenLine(undefined, undefined, NaN, null)).toBe('shell  opened in 0 ms')
  })
  it('never carries anything but a kind, an id and durations', () => {
    const line = paneOpenLine('codex local\nC:\\secret', 'pane-1\r\nx', 5, [['a b\nC:\\x', 3]])
    expect(line).not.toMatch(/[\r\n\\]|C:/)
  })
  it('index.js logs it from pty:create (local and ssh2 panes)', () => {
    const src = fs.readFileSync(join(__dirname, '..', '..', 'main', 'index.js'), 'utf8')
    expect(src.match(/log\.info\('pane', paneOpenLine\(/g)).toHaveLength(2)
  })
})

describe('the renderer logs a pane that opened', () => {
  it('createLeaf marks its steps and logs them (App.vue)', () => {
    const src = fs.readFileSync(join(__dirname, '..', '..', 'renderer', 'src', 'App.vue'), 'utf8')
    expect(src).toMatch(/logPaneOpened\(`\$\{agent \? agent\.id : 'shell'\}/)
    for (const step of ['status hooks', 'account', 'create terminal', 'host agent check', 'start line']) expect(src).toContain(`paneStep('${step}')`)
  })
})
