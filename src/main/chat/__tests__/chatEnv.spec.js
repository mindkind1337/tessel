// @vitest-environment node
import { describe, it, expect } from 'vitest'
import os from 'os'
import { join } from 'path'
import { buildChatEnv, isDroppedName } from '../chatEnv'

describe('buildChatEnv', () => {
  const base = {
    Path: 'C:\\Windows',
    HOME: 'h',
    ANTHROPIC_API_KEY: 'k',
    TESSEL_PANE_ID: 'other-pane',
    tessel_team_secret: 'stolen',
    TESSEL_AGENT_PROVIDER: 'codex',
    TESSEL_AGENT_LAUNCH: 'tok',
    TESSEL_AGENT_STATE_DIR: 'C:\\s',
    TESSEL_PROJECT_DIR: 'C:\\other',
    CLAUDECODE: '1',
    ClaudeCode: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk',
    CLAUDE_CODE_SESSION_ID: 'x',
    claude_code_sse_port: '1',
    CLAUDE_PID: '1',
    CLAUDE_EFFORT: 'high',
    CLAUDE_PROJECT_DIR: 'C:\\p',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'acct',
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
    NUM: 5
  }

  it('drops inherited Tessel identity and Claude session variables, sets its own', () => {
    const projectDir = os.tmpdir()
    const env = buildChatEnv(base, { paneId: 'p1', teamSecret: 'a'.repeat(64), projectDir })
    expect(env).toEqual({
      Path: 'C:\\Windows',
      HOME: 'h',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'acct',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
      TESSEL_PANE_ID: 'p1',
      TESSEL_TEAM_SECRET: 'a'.repeat(64),
      TESSEL_PROJECT_DIR: projectDir,
      TESSEL_CHAT: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1'
    })
    expect(Object.keys(env).some((k) => /^TESSEL_AGENT_/i.test(k))).toBe(false)
    expect(base.TESSEL_PANE_ID).toBe('other-pane') // base untouched
  })

  it('sets the project folder only when it is an absolute existing folder', () => {
    expect(buildChatEnv({}, { paneId: 'p', projectDir: 'relative' }).TESSEL_PROJECT_DIR).toBeUndefined()
    expect(buildChatEnv({}, { paneId: 'p', projectDir: join(os.tmpdir(), 'no-such-dir-xyz') }).TESSEL_PROJECT_DIR).toBeUndefined()
  })

  it('replaces PATH in any spelling when a path is given', () => {
    const env = buildChatEnv({ Path: 'old', path: 'old2' }, { paneId: 'p', pathEnv: 'C:\\claude;C:\\Windows' })
    expect(env.PATH).toBe('C:\\claude;C:\\Windows')
    expect(env.Path).toBeUndefined()
    expect(env.path).toBeUndefined()
  })

  it('names', () => {
    expect(isDroppedName('Tessel_Anything')).toBe(true)
    expect(isDroppedName('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBe(true)
    expect(isDroppedName('claude_code_use_vertex')).toBe(false)
    expect(isDroppedName('CLAUDE_CONFIG_DIR')).toBe(false)
  })
})
