import { describe, it, expect } from 'vitest'
import { cleanEnv, isSessionVar } from '../cleanEnv'

describe('cleanEnv', () => {
  it('removes the launching agent session markers and secrets', () => {
    const env = cleanEnv({
      Path: 'C:\\Windows',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\x',
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLAUDE_PID: '123',
      ELECTRON_RUN_AS_NODE: '1',
      TESSEL_PTYHOST_TOKEN: 'tok'
    })
    expect(env).toEqual({ Path: 'C:\\Windows' })
  })

  it('keeps your own settings', () => {
    const mine = {
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CONFIG_DIR: 'D:\\cfg',
      HTTPS_PROXY: 'http://proxy',
      OPENAI_API_KEY: 'o'
    }
    expect(cleanEnv(mine)).toEqual(mine)
  })

  it('matches names case-insensitively (Windows env names are)', () => {
    expect(isSessionVar('claudecode')).toBe(true)
    expect(isSessionVar('Claude_Code_Child_Session')).toBe(true)
    expect(isSessionVar('PATH')).toBe(false)
  })
})
