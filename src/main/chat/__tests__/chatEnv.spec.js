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

  it('codex: drops a parent Codex session, keeps the account and user settings, sets the pane identity', () => {
    const projectDir = os.tmpdir()
    const env = buildChatEnv(
      {
        ...base,
        CODEX_HOME: 'C:\\acct',
        CODEX_API_KEY: 'ck',
        OPENAI_API_KEY: 'ok',
        CODEX_CA_CERTIFICATE: 'C:\\ca.pem',
        CODEX_THREAD_ID: 't',
        codex_sandbox: 'seatbelt',
        CODEX_SANDBOX_NETWORK_DISABLED: '1',
        CODEX_WINDOWS_SANDBOX_PROXY_PORTS: '1',
        CODEX_MANAGED_BY_NPM: '1',
        CODEX_MANAGED_PACKAGE_ROOT: 'C:\\npm',
        CODEX_NETWORK_PROXY_ACTIVE: '1',
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'vscode',
        CODEX_EXEC_SERVER_URL: 'ws://x',
        CODEX_PERMISSION_PROFILE: 'p',
        CODEX_SESSION_ID: 's'
      },
      { agent: 'codex', paneId: 'p1', teamSecret: 'b'.repeat(64), projectDir, pathEnv: 'C:\\codex' }
    )
    expect(env).toEqual({
      PATH: 'C:\\codex',
      HOME: 'h',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'acct',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
      CODEX_HOME: 'C:\\acct',
      CODEX_API_KEY: 'ck',
      OPENAI_API_KEY: 'ok',
      CODEX_CA_CERTIFICATE: 'C:\\ca.pem',
      TESSEL_PANE_ID: 'p1',
      TESSEL_TEAM_SECRET: 'b'.repeat(64),
      TESSEL_PROJECT_DIR: projectDir,
      TESSEL_CHAT: '1'
    })
  })

  it('claude keeps the Codex variables as before', () => {
    const env = buildChatEnv({ CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'x' }, { paneId: 'p' })
    expect(env).toMatchObject({ CODEX_THREAD_ID: 't', CODEX_SANDBOX: 'x', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' })
  })

  it('names', () => {
    expect(isDroppedName('Tessel_Anything')).toBe(true)
    expect(isDroppedName('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBe(true)
    expect(isDroppedName('claude_code_use_vertex')).toBe(false)
    expect(isDroppedName('CLAUDE_CONFIG_DIR')).toBe(false)
    expect(isDroppedName('CODEX_THREAD_ID')).toBe(false)
    expect(isDroppedName('codex_thread_id', 'codex')).toBe(true)
    expect(isDroppedName('CODEX_HOME', 'codex')).toBe(false)
    expect(isDroppedName('CODEX_SANDBOX_NETWORK_DISABLED', 'codex')).toBe(true)
    expect(isDroppedName('CLAUDE_CODE_SESSION_ID', 'codex')).toBe(true)
  })
})

describe('buildChatEnv for OpenCode', () => {
  it('drops what the adapter sets itself and what a parent OpenCode sets, keeps the user config', () => {
    const env = buildChatEnv(
      {
        OPENCODE_SERVER_PASSWORD: 'x',
        opencode_server_username: 'y',
        OPENCODE_CONFIG_CONTENT: '{}',
        OPENCODE_PERMISSION: '"allow"',
        OPENCODE_AUTO_SHARE: '1',
        OPENCODE_FAKE_VCS: 'git',
        OPENCODE_CLIENT: 'tui',
        OPENCODE: '1',
        OPENCODE_PID: '5',
        OPENCODE_SESSION_ID: 'ses_x',
        ORCA_TERMINAL: '1',
        OPENCODE_CONFIG: 'C:\c.json',
        OPENCODE_CONFIG_DIR: 'C:\c',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_GIT_BASH_PATH: 'C:\bash.exe',
        OPENROUTER_API_KEY: 'k',
        OPENCODE_DISABLE_AUTOUPDATE: '0'
      },
      { agent: 'opencode', paneId: 'p' }
    )
    expect(env).toEqual({
      OPENCODE_CONFIG: 'C:\c.json',
      OPENCODE_CONFIG_DIR: 'C:\c',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_GIT_BASH_PATH: 'C:\bash.exe',
      OPENROUTER_API_KEY: 'k',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      TESSEL_PANE_ID: 'p',
      TESSEL_CHAT: '1'
    })
  })

  it('the OpenCode names are only dropped for OpenCode', () => {
    expect(isDroppedName('OPENCODE_SERVER_PASSWORD', 'opencode')).toBe(true)
    expect(isDroppedName('OPENCODE_SERVER_PASSWORD', 'claude')).toBe(false)
    expect(isDroppedName('OPENCODE_CONFIG', 'opencode')).toBe(false)
  })
})
