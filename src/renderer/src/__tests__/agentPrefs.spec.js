import { describe, it, expect } from 'vitest'
import { parseEnvText, effectiveAgent, agentEnabled } from '../../../shared/agentPrefs'

const claude = { id: 'claude', command: 'claude' }
const goose = { id: 'goose', command: 'goose' }

describe('per-agent settings', () => {
  it('reads NAME=value lines; refuses bad names and Tessel’s own variables', () => {
    expect(parseEnvText('# a comment\nFOO=bar baz\n\nX_1= y ')).toEqual({ env: { FOO: 'bar baz', X_1: 'y' } })
    expect(parseEnvText('1BAD=x').error).toMatch(/not a valid variable name/)
    expect(parseEnvText('no equals').error).toMatch(/NAME=value/)
    expect(parseEnvText('TESSEL_PANE_ID=x').error).toMatch(/set by Tessel/)
    expect(parseEnvText('A='.padEnd(20000, 'x')).error).toMatch(/too large/)
  })

  it('Manual adds nothing; Yolo adds the agent’s own flag, unless you set arguments', () => {
    expect(effectiveAgent(claude, {}, 'manual')).toEqual({ command: 'claude', args: '', env: {} })
    expect(effectiveAgent(claude, {}, 'yolo').args).toBe('--dangerously-skip-permissions')
    expect(effectiveAgent(claude, { claude: { args: '--model sonnet' } }, 'yolo').args).toBe('--model sonnet')
    expect(effectiveAgent(goose, {}, 'yolo').env).toEqual({ GOOSE_MODE: 'auto' })
    expect(effectiveAgent({ id: 'unknown', command: 'x' }, {}, 'yolo').args).toBe('')
  })

  it('a command of your own and variables; turned off agents are not offered', () => {
    const prefs = { claude: { command: 'C:\\tools\\claude.cmd', env: 'ANTHROPIC_MODEL=x', enabled: false } }
    expect(effectiveAgent(claude, prefs, 'manual')).toEqual({ command: 'C:\\tools\\claude.cmd', args: '', env: { ANTHROPIC_MODEL: 'x' } })
    expect(agentEnabled(prefs, 'claude')).toBe(false)
    expect(agentEnabled(prefs, 'codex')).toBe(true)
  })
})

import { launchSignature, launchIsYolo } from '../../../shared/agentPrefs'
describe('how an agent was launched', () => {
  it('Yolo is seen from its flag or its variables; the signature changes with the settings', () => {
    const manual = effectiveAgent(claude, {}, 'manual')
    const yolo = effectiveAgent(claude, {}, 'yolo')
    expect(launchIsYolo('claude', manual)).toBe(false)
    expect(launchIsYolo('claude', yolo)).toBe(true)
    expect(launchIsYolo('goose', effectiveAgent(goose, {}, 'yolo'))).toBe(true)
    expect(launchSignature(manual)).not.toBe(launchSignature(yolo))
    expect(launchSignature(yolo)).toBe(launchSignature(effectiveAgent(claude, {}, 'yolo')))
    // Your own arguments replace Yolo's: not Yolo, and a new signature.
    const own = effectiveAgent(claude, { claude: { args: '--model sonnet' } }, 'yolo')
    expect(launchIsYolo('claude', own)).toBe(false)
    expect(launchSignature(own)).not.toBe(launchSignature(yolo))
    // Variables in any order give the same signature.
    expect(launchSignature({ command: 'x', args: '', env: { B: '1', A: '2' } })).toBe(launchSignature({ command: 'x', args: '', env: { A: '2', B: '1' } }))
  })
})
