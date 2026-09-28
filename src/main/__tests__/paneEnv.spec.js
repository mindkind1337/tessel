import { describe, it, expect } from 'vitest'
import { paneEnv, checkedEnv } from '../paneEnv'

describe('a pane’s environment', () => {
  it('the account’s variables are kept even when the agent has 50 of its own', () => {
    const extraEnv = {}
    for (let i = 0; i < 50; i++) extraEnv[`V${i}`] = 'x'
    const env = paneEnv({ PATH: 'p' }, { extraEnv, accountEnv: { CODEX_HOME: 'C:\\acct' } })
    expect(env.CODEX_HOME).toBe('C:\\acct')
    expect(env.V49).toBe('x')
  })

  it('the account wins over any spelling of the same name; removed names go', () => {
    const base = { Path: 'p', codex_home: 'C:\\system', OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'a', HOME: 'h' }
    const env = paneEnv(base, {
      extraEnv: { Codex_Home: 'C:\\agent', FOO: '1' },
      accountEnv: { CODEX_HOME: 'C:\\acct' },
      unsetEnv: ['OPENAI_API_KEY', 'HOME']
    })
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'CODEX_HOME')).toEqual(['CODEX_HOME'])
    expect(env.CODEX_HOME).toBe('C:\\acct')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    // Only known sign-in names can be removed.
    expect(env.HOME).toBe('h')
    expect(env.ANTHROPIC_API_KEY).toBe('a')
    expect(env.FOO).toBe('1')
  })

  it('no account: nothing removed, the agent’s variables apply', () => {
    const env = paneEnv({ OPENAI_API_KEY: 'sk' }, { extraEnv: { GOOSE_MODE: 'auto' } })
    expect(env).toEqual({ OPENAI_API_KEY: 'sk', GOOSE_MODE: 'auto' })
  })

  it('refuses bad names, Tessel’s own and oversized values', () => {
    expect(checkedEnv({ 'A B': '1', TESSEL_PANE_ID: 'x', OK: '1', BIG: 'x'.repeat(9000), N: 5 })).toEqual({ OK: '1' })
    expect(checkedEnv(['A=1'])).toEqual({})
  })
})
